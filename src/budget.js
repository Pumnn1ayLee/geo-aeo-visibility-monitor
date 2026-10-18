const SCALE = 1_000_000;

export function toUnits(usd, { charge = false } = {}) {
  const scaled = Number(usd) * SCALE;
  if (!Number.isFinite(scaled) || scaled < 0 || scaled > Number.MAX_SAFE_INTEGER) throw new Error('Invalid USD amount');
  return charge ? Math.ceil(scaled - 1e-8) : Math.floor(scaled + 1e-8);
}

export function toUsd(units) { return units / SCALE; }

export function settleEntry(entry, sourceRun) {
  if (!sourceRun) return;
  if (sourceRun.id) entry.runId = sourceRun.id;
  entry.sourceStatus = sourceRun.status ?? entry.sourceStatus;
  const terminal = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(sourceRun.status);
  entry.terminal = terminal;
  // An active run's usage is provisional. Reserve its entire allowance until termination.
  if (terminal && typeof sourceRun.usageTotalUsd === 'number' && Number.isFinite(sourceRun.usageTotalUsd) && sourceRun.usageTotalUsd >= 0) {
    entry.actualUnits = toUnits(sourceRun.usageTotalUsd, { charge: true });
  }
}

export function budgetSummary(config, entries) {
  const limit = toUnits(config.maxSourceBudgetUsd);
  const known = entries.reduce((sum, e) => sum + (e.actualUnits ?? 0), 0);
  const reserved = entries.reduce((sum, e) => sum + (e.actualUnits == null ? e.allowanceUnits : 0), 0);
  return { maxSourceBudgetUsd: config.maxSourceBudgetUsd, maxSourceRuns: config.maxSourceRuns,
    knownChargeUsd: toUsd(known), reservedUnknownChargeUsd: toUsd(reserved),
    accountedChargeUsd: toUsd(known + reserved), remainingSourceBudgetUsd: toUsd(Math.max(0, limit - known - reserved)),
    overBudget: known + reserved > limit, sourceRuns: entries.length,
    runs: entries.map((e) => ({ jobId: e.jobId, actorId: e.actorId, query: e.query, market: e.market, runId: e.runId ?? null, status: e.status,
      sourceStatus: e.sourceStatus ?? null, allowanceUsd: toUsd(e.allowanceUnits),
      actualChargeUsd: e.actualUnits == null ? null : toUsd(e.actualUnits),
      accountedChargeUsd: toUsd(e.actualUnits ?? e.allowanceUnits) })) };
}

export function nextAllowance(config, entries) {
  const budget = budgetSummary(config, entries);
  if (entries.length >= config.maxSourceRuns) return { stopReason: 'max_source_runs' };
  const remaining = toUnits(budget.remainingSourceBudgetUsd);
  const allowanceUnits = Math.min(remaining, config.maxTotalChargeUsd == null ? remaining : toUnits(Math.min(config.maxTotalChargeUsd, config.maxSourceBudgetUsd)));
  if (allowanceUnits <= 0) return { stopReason: 'budget_exhausted' };
  return { allowanceUnits };
}
