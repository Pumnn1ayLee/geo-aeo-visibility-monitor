import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { normalizeInput, buildSourceInput, readInputFromEnvironment } from './input.js';
import { analyzeSnapshot, extractRecords } from './analysis.js';
import { buildReport } from './report.js';
import { ApifySourceClient, FixtureSourceClient } from './source-client.js';
import { createStorage } from './storage.js';
import { History, fingerprint, comparisonKey } from './history.js';
import { budgetSummary, nextAllowance, settleEntry, toUsd } from './budget.js';
import { SnapshotBilling } from './billing.js';

async function createSourceClient() {
  const fixtureFile = process.env.GEO_FIXTURE_FILE;
  if (fixtureFile) return new FixtureSourceClient(JSON.parse(await readFile(fixtureFile, 'utf8')));
  return new ApifySourceClient();
}

export async function run(rawInput, { sourceClient, storage, logger = console, env = process.env, runId: requestedId, now = () => Date.now() } = {}) {
  const config = normalizeInput(rawInput);
  const client = sourceClient ?? await createSourceClient();
  const output = storage ?? createStorage({ env });
  const runId = requestedId ?? output.runId ?? env.ACTOR_RUN_ID ?? env.APIFY_ACTOR_RUN_ID ?? randomUUID();
  const stateKey = `GEO_STATE_V1-${fingerprint(runId).slice(0, 24)}`;
  const configHash = fingerprint(config);
  let state = await output.loadJson(stateKey);
  if (state && (state.version !== 2 || state.configHash !== configHash)) throw new Error('Run checkpoint input differs from current input or build contract; start a new run to change configuration');
  const platformStart = Date.parse(env.ACTOR_STARTED_AT ?? env.APIFY_ACTOR_STARTED_AT ?? '');
  state ??= { version: 2, configHash, runId, startedAt: new Date(Number.isFinite(platformStart) ? platformStart : now()).toISOString(), entries: [], snapshots: [], errors: [], deliveries: {} };
  if (state.final?.report.stopReason === 'source_reconciliation_required') {
    delete state.final;
  }
  const checkpoint = async () => {
    try { await output.saveJson(stateKey, state); }
    catch (error) { error.checkpointFailure = true; throw error; }
  };
  const history = new History(config, output, { runId, startedAt: state.startedAt, actorId: output.actorId ?? env.ACTOR_ID ?? 'geo-visibility-monitor' });
  const billing = new SnapshotBilling({ storage: output, env, runId });
  await billing.refresh();
  const deliveredCount = () => Object.values(state.deliveries).filter((delivery) => delivery.status === 'confirmed').length;
  const pendingCount = () => Object.values(state.deliveries).filter((delivery) => delivery.status === 'pending').length;
  const jobs = [];
  const ids = new Set();
  for (const market of config.markets) for (const query of config.queries) for (const engine of config.engines) {
    const sourceInput = buildSourceInput(config, query, market, engine);
    const id = comparisonKey(config, { query, market, engine, sourceInput });
    if (!ids.has(id)) { jobs.push({ id, market, query, engine, sourceInput }); ids.add(id); }
  }
  const makeReport = (stopReason = null) => ({ ...buildReport({ snapshots: state.snapshots, errors: state.errors,
    previousSnapshots: state.previous ?? [], brand: config.brand, competitors: config.competitors,
    execution: { runId, startedAt: state.startedAt, plannedSourceRuns: jobs.length,
      completedSourceRuns: state.entries.filter((entry) => entry.status === 'completed').length,
      failedSourceRuns: state.entries.filter((entry) => entry.status === 'failed').length,
      unresolvedSourceRuns: state.entries.filter((entry) => !['completed', 'failed'].includes(entry.status)).length,
      skippedSourceRuns: jobs.length - state.entries.length, stopReason,
      budget: budgetSummary(config, state.entries), history: state.historyInfo,
      billing: billing.summary(deliveredCount(), pendingCount()),
    } }), outputContractVersion: 2,
    collection: { monitoringPreset: config.monitoringPreset,
      snapshotsWithoutAiAnswer: state.snapshots.filter((snapshot) => snapshot.aiResponseCount === 0).length },
  });
  const saveReports = async (report) => {
    await output.saveJson('RUN_REPORT', report);
    await output.saveJson('SOURCE_ERRORS', state.errors.map((error) => ({ type: 'source_error', ...error })));
  };
  const deliveryFailure = async (message, cause) => {
    try { await saveReports({ ...makeReport('dataset_delivery_unconfirmed'), status: 'partial', outputError: message }); }
    catch (error) { logger.error?.(`Could not save the delivery diagnostic: ${error.message}`); }
    throw new Error(message, { cause });
  };
  const deliverSnapshot = async (snapshot) => {
    const previous = state.deliveries[snapshot.comparisonKey];
    if (previous?.status === 'confirmed') return true;
    if (previous?.status === 'pending') {
      if (!await output.hasSnapshot?.(runId, snapshot.comparisonKey)) {
        return deliveryFailure('Snapshot delivery is unconfirmed. No dataset write was repeated and no more sources were launched. Inspect the default dataset before starting a new run; resurrect this run to check delivery again.');
      }
    } else {
      if (!billing.canProduce(deliveredCount())) return false;
      state.deliveries[snapshot.comparisonKey] = { status: 'pending', startedAt: new Date(now()).toISOString() };
      await checkpoint();
      // Save an accessible, nonbillable report before the dataset write can trigger platform shutdown.
      await saveReports({ ...makeReport(), status: 'running' });
      try { await output.pushItems([snapshot]); }
      catch (error) { return deliveryFailure('Snapshot dataset delivery failed or is unconfirmed; dispatch stopped to avoid duplicate billing. Resurrect this run to reconcile the write.', error); }
    }
    state.deliveries[snapshot.comparisonKey] = { status: 'confirmed' };
    await checkpoint();
    return true;
  };

  if (!state.final) {
    state.previous ??= await history.load(jobs.map((job) => job.id));
    if (config.historyEnabled && !history.store) await history.load([]);
    state.historyInfo ??= { ...history.info, baselineCount: state.previous.length };
    await checkpoint();
    let stopReason = null;
    for (const snapshot of state.snapshots) {
      if (!await deliverSnapshot(snapshot)) { stopReason = 'parent_charge_limit'; break; }
    }
    await saveReports({ ...makeReport(stopReason), status: 'running' });
    if (config.monitoringPreset.startsWith('google_ai_')) {
      logger.warn?.(`Monitoring preset ${config.monitoringPreset} enables paid Google AI add-ons. Source Actor charges are additional to this monitor's per-snapshot fee.`);
    }
    const parentDeadline = Date.parse(env.ACTOR_TIMEOUT_AT ?? env.APIFY_TIMEOUT_AT ?? '');
    for (const job of jobs) {
      if (stopReason) break;
      let entry = state.entries.find((item) => item.jobId === job.id);
      if (entry?.status === 'completed' || entry?.status === 'failed') continue;
      if (entry && !entry.runId) { stopReason = 'ambiguous_launch'; break; }
      const secondsLeft = Number.isFinite(parentDeadline) ? Math.floor((parentDeadline - now()) / 1000) - 20 : Infinity;
      if (!entry && secondsLeft < 1) { stopReason = 'parent_deadline'; break; }
      if (!entry) {
        const allowance = nextAllowance(config, state.entries);
        if (allowance.stopReason) { stopReason = allowance.stopReason; break; }
        await billing.refresh();
        if (!billing.canProduce(deliveredCount())) { stopReason = 'parent_charge_limit'; break; }
        entry = { jobId: job.id, actorId: job.engine.actorId, query: job.query, market: job.market,
          status: 'reserved', allowanceUnits: allowance.allowanceUnits, createdAt: new Date(now()).toISOString(),
          timeoutSeconds: Math.min(config.sourceTimeoutSeconds, secondsLeft) };
        state.entries.push(entry);
        await checkpoint();
      }
      if (entry.runId) {
        // Reconcile an existing child even when no new work fits the parent's charge limit.
        await billing.refresh();
      }
      const onRun = async (sourceRun) => { settleEntry(entry, sourceRun); entry.status = 'running'; await checkpoint(); };
      const freshSecondsLeft = Number.isFinite(parentDeadline) ? Math.floor((parentDeadline - now()) / 1000) - 20 : Infinity;
      if (!entry.runId && freshSecondsLeft < 1) {
        // Reservation succeeded, but no launch was sent: release it before stopping.
        state.entries = state.entries.filter((item) => item !== entry);
        await checkpoint();
        stopReason = 'parent_deadline';
        break;
      }
      const elapsed = (now() - Date.parse(entry.createdAt)) / 1000;
      const options = { timeoutSeconds: Math.max(0, Math.min(entry.timeoutSeconds - elapsed, freshSecondsLeft)),
        maxTotalChargeUsd: toUsd(entry.allowanceUnits), onStarted: onRun, onFinished: onRun };
      try {
        const payload = entry.runId
          ? await client.resumeRun(entry.runId, options)
          : await client.runActor(job.engine.actorId, job.sourceInput, options);
        settleEntry(entry, payload?.run);
        const snapshot = analyzeSnapshot({ query: job.query, market: job.market, engine: job.engine.name,
          brand: config.brand, competitors: config.competitors, records: extractRecords(payload?.items ?? payload), includeRawSource: config.includeRawSource });
        if (!snapshot.observationPresent) throw new Error('Source returned no usable search or AI evidence; previous baseline is preserved');
        state.snapshots.push({ ...snapshot, capturedAt: new Date(now()).toISOString(), comparisonKey: job.id, sourceActorId: job.engine.actorId, sourceRunId: entry.runId ?? null, runId });
        entry.status = 'completed';
        entry.terminal = true;
        state.errors = state.errors.filter((item) => item.jobId !== job.id);
      } catch (error) {
        if (error.checkpointFailure) throw error;
        settleEntry(entry, error.run);
        if (error.definitiveRejection) { entry.actualUnits = 0; entry.terminal = true; }
        const uncertain = !entry.terminal && !error.definitiveRejection;
        entry.status = uncertain ? 'unresolved' : 'failed';
        const detail = error instanceof Error ? error.message : String(error);
        state.errors = state.errors.filter((item) => item.jobId !== job.id);
        state.errors.push({ jobId: job.id, engine: job.engine.name, actorId: job.engine.actorId, market: job.market, query: job.query, sourceRunId: entry.runId ?? null, message: detail });
        logger.error?.(`Source Actor ${job.engine.actorId} failed for ${job.market.countryCode}/${job.query}: ${detail}`);
        if (uncertain) stopReason = entry.runId ? 'source_reconciliation_required' : 'ambiguous_launch';
      }
      await checkpoint();
      if (entry.status === 'completed') {
        const snapshot = state.snapshots.find((item) => item.comparisonKey === job.id);
        if (!await deliverSnapshot(snapshot)) stopReason = 'parent_charge_limit';
      }
      await saveReports({ ...makeReport(stopReason), status: 'running' });
      if (stopReason) break;
    }
    state.final = { completedAt: new Date(now()).toISOString(), report: makeReport(stopReason) };
    await checkpoint();
  }
  if (config.historyEnabled && !state.historySaved && state.final.report.stopReason !== 'source_reconciliation_required') {
    if (!history.store) await history.load([]);
    await history.save(state.snapshots, state.final.completedAt);
    state.historySaved = true;
    await checkpoint();
  }
  await saveReports(state.final.report);
  return { config, snapshots: state.snapshots, errors: state.errors, report: state.final.report,
    items: state.snapshots.filter((snapshot) => state.deliveries[snapshot.comparisonKey]?.status === 'confirmed') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const rawInput = await readInputFromEnvironment({ readFile });
    const result = await run(rawInput);
    console.log(JSON.stringify({ report: result.report, snapshots: result.snapshots.length, errors: result.errors.length }, null, 2));
    if (result.report.status === 'failed') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
