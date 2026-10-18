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
  if (state && (state.version !== 1 || state.configHash !== configHash)) throw new Error('Run checkpoint input differs from current input; start a new run to change configuration');
  const platformStart = Date.parse(env.ACTOR_STARTED_AT ?? env.APIFY_ACTOR_STARTED_AT ?? '');
  state ??= { version: 1, configHash, runId, startedAt: new Date(Number.isFinite(platformStart) ? platformStart : now()).toISOString(), entries: [], snapshots: [], errors: [] };
  if (state.final?.report.stopReason === 'source_reconciliation_required') {
    delete state.final;
    state.delivered = false;
  }
  const checkpoint = async () => {
    try { await output.saveJson(stateKey, state); }
    catch (error) { error.checkpointFailure = true; throw error; }
  };
  const history = new History(config, output, { runId, startedAt: state.startedAt, actorId: output.actorId ?? env.ACTOR_ID ?? 'geo-visibility-monitor' });

  if (!state.final) {
    const jobs = [];
    const ids = new Set();
    for (const market of config.markets) for (const query of config.queries) for (const engine of config.engines) {
      const sourceInput = buildSourceInput(config, query, market, engine);
      const id = comparisonKey(config, { query, market, engine, sourceInput });
      if (!ids.has(id)) { jobs.push({ id, market, query, engine, sourceInput }); ids.add(id); }
    }
    state.previous ??= await history.load(jobs.map((job) => job.id));
    if (config.historyEnabled && !history.store) await history.load([]);
    state.historyInfo ??= { ...history.info, baselineCount: state.previous.length };
    await checkpoint();
    let stopReason = null;
    const parentDeadline = Date.parse(env.ACTOR_TIMEOUT_AT ?? env.APIFY_TIMEOUT_AT ?? '');
    for (const job of jobs) {
      let entry = state.entries.find((item) => item.jobId === job.id);
      if (entry?.status === 'completed' || entry?.status === 'failed') continue;
      if (entry && !entry.runId) { stopReason = 'ambiguous_launch'; break; }
      const secondsLeft = Number.isFinite(parentDeadline) ? Math.floor((parentDeadline - now()) / 1000) - 20 : Infinity;
      if (!entry && secondsLeft < 1) { stopReason = 'parent_deadline'; break; }
      if (!entry) {
        const allowance = nextAllowance(config, state.entries);
        if (allowance.stopReason) { stopReason = allowance.stopReason; break; }
        entry = { jobId: job.id, actorId: job.engine.actorId, query: job.query, market: job.market,
          status: 'reserved', allowanceUnits: allowance.allowanceUnits, createdAt: new Date(now()).toISOString(),
          timeoutSeconds: Math.min(config.sourceTimeoutSeconds, secondsLeft) };
        state.entries.push(entry);
        await checkpoint();
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
      if (stopReason) break;
    }
    const skipped = jobs.length - state.entries.length;
    const report = buildReport({ snapshots: state.snapshots, errors: state.errors, previousSnapshots: state.previous, brand: config.brand, competitors: config.competitors,
      execution: { runId, startedAt: state.startedAt, plannedSourceRuns: jobs.length, completedSourceRuns: state.entries.filter((e) => e.status === 'completed').length,
        failedSourceRuns: state.entries.filter((e) => e.status === 'failed').length,
        unresolvedSourceRuns: state.entries.filter((e) => !['completed', 'failed'].includes(e.status)).length, skippedSourceRuns: skipped, stopReason,
        budget: budgetSummary(config, state.entries), history: state.historyInfo } });
    state.final = { completedAt: new Date(now()).toISOString(), report,
      items: [...state.snapshots, report, ...state.errors.map((error) => ({ type: 'source_error', capturedAt: new Date(now()).toISOString(), ...error }))] };
    await checkpoint();
  }
  if (config.historyEnabled && !state.historySaved && state.final.report.stopReason !== 'source_reconciliation_required') {
    if (!history.store) await history.load([]);
    await history.save(state.snapshots, state.final.completedAt);
    state.historySaved = true;
    await checkpoint();
  }
  if (!state.delivered) {
    await output.pushItems(state.final.items);
    state.delivered = true;
    await checkpoint();
  }
  return { config, snapshots: state.snapshots, errors: state.errors, report: state.final.report, items: state.final.items };
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
