import { toUnits, toUsd } from './budget.js';

export const RESULT_EVENT = 'apify-default-dataset-item';
const START_EVENT = 'apify-actor-start';

function amount(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
  return toUnits(value, { charge: true });
}

/** The default dataset contains ONLY successful snapshots. Apify charges them automatically. */
export class SnapshotBilling {
  constructor({ storage, env = {}, runId } = {}) {
    this.storage = storage;
    this.env = env;
    this.runId = runId;
    this.mode = typeof storage.getRunInfo === 'function' ? 'platform' : 'local';
    this.prices = {};
    this.counts = {};
    this.limitUnits = Infinity;
  }

  async refresh() {
    if (this.mode === 'local') return;
    const run = await this.storage.getRunInfo();
    if (!run || run.id !== this.runId) throw new Error('Unable to verify pricing for the current Actor run; no paid source will be launched');
    const model = run.pricingInfo?.pricingModel;
    if (model && !['PAY_PER_EVENT', 'FREE'].includes(model)) throw new Error('This build supports FREE or PAY_PER_EVENT pricing with the default-dataset-item event');
    this.model = model ?? 'FREE';
    this.prices = {};
    for (const [name, event] of Object.entries(run.pricingInfo?.pricingPerEvent?.actorChargeEvents ?? {})) {
      // Run pricing is the price snapshot applicable to this customer, not the Actor's latest public price.
      this.prices[name] = amount(event.eventPriceUsd, `run price for ${name}; a resolved eventPriceUsd is required`);
    }
    if (model === 'PAY_PER_EVENT' && !(RESULT_EVENT in this.prices)) {
      throw new Error(`Pricing configuration is missing ${RESULT_EVENT}. Enable it before using this build; summaries and errors are stored outside the dataset.`);
    }
    this.counts = {};
    for (const [name, count] of Object.entries(run.chargedEventCounts ?? {})) {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid charged event count for ${name}`);
      if (!(name in this.prices) && count) throw new Error(`Cannot account for unknown charged event ${name}`);
      this.counts[name] = count;
    }
    // The startup event can lag in run metadata. Reserve it before the first source call.
    if (this.prices[START_EVENT]) {
      const memory = Number(run.options?.memoryMbytes ?? this.env.ACTOR_MEMORY_MBYTES ?? this.env.APIFY_MEMORY_MBYTES ?? 1024);
      if (!Number.isFinite(memory) || memory <= 0) throw new Error('Invalid Actor memory for startup charge accounting');
      this.counts[START_EVENT] = Math.max(this.counts[START_EVENT] ?? 0, Math.ceil(memory / 1024));
    }
    const limits = [run.options?.maxTotalChargeUsd, this.env.ACTOR_MAX_TOTAL_CHARGE_USD]
      .filter((value) => value != null && value !== '').map((value) => {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) throw new Error('Invalid parent maximum total charge');
        return toUnits(number);
      });
    this.limitUnits = limits.length ? Math.min(...limits) : Infinity;
  }

  summary(deliveredCount = 0, pendingCount = 0) {
    const resultCount = Math.max(this.counts[RESULT_EVENT] ?? 0, deliveredCount + pendingCount);
    const chargedUnits = Object.entries(this.prices).reduce((sum, [name, price]) =>
      sum + price * (name === RESULT_EVENT ? resultCount : (this.counts[name] ?? 0)), 0);
    const price = this.prices[RESULT_EVENT] ?? 0;
    const remaining = Math.max(0, this.limitUnits - chargedUnits);
    return {
      mode: this.mode === 'local' ? 'local_unbilled' : this.model === 'PAY_PER_EVENT' ? 'per_successful_snapshot' : 'unbilled',
      eventName: RESULT_EVENT,
      unitPriceUsd: toUsd(price),
      maxParentChargeUsd: Number.isFinite(this.limitUnits) ? toUsd(this.limitUnits) : null,
      accountedEventChargeUsd: toUsd(chargedUnits),
      remainingEventBudgetUsd: Number.isFinite(remaining) ? toUsd(remaining) : null,
      remainingSnapshotCapacity: price && Number.isFinite(remaining) ? Math.floor(remaining / price) : null,
      deliveredSnapshotCount: deliveredCount,
      pendingSnapshotCount: pendingCount,
      eventChargeLimitReached: remaining === 0 || (price > 0 && remaining < price),
      summariesAndErrorsCharged: false,
    };
  }

  canProduce(deliveredCount) {
    return !this.summary(deliveredCount).eventChargeLimitReached;
  }
}
