import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.js';
import { MemoryStorage, TestClient, exampleInput, quiet } from './helpers.js';

test('runs every market/query/engine, checkpoints before POST, and persists history separately', async () => {
  const storage = new MemoryStorage();
  const client = new TestClient();
  const original = client.runActor.bind(client);
  client.runActor = async (...args) => {
    const state = [...storage.records.values()][0];
    assert.equal(state.entries.at(-1).status, 'reserved');
    return original(...args);
  };
  const result = await run({ ...exampleInput, queries: ['best tool', 'best alternative'] }, { sourceClient: client, storage, logger: quiet });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].input.queries, 'best tool');
  assert.equal(client.calls[0].input.countryCode, 'us');
  assert.equal(result.report.status, 'succeeded');
  assert.equal(result.report.budget.knownChargeUsd, 0.2);
  assert.equal(result.snapshots.length, 2);
  assert.ok(storage.items.every((item) => item.type === 'visibility_snapshot'));
  assert.equal((await storage.loadJson('RUN_REPORT')).type, 'report_summary');
  assert.equal([...storage.stores.keys()].filter((name) => name.startsWith('geo-history-')).length, 1);
});

test('caps successive runs against the actual aggregate balance', async () => {
  const client = new TestClient({ cost: 0.1 });
  const result = await run({ ...exampleInput, queries: ['a', 'b', 'c', 'd'], maxSourceBudgetUsd: 0.3, maxTotalChargeUsd: 0.2 }, { sourceClient: client, storage: new MemoryStorage(), logger: quiet });
  assert.equal(client.calls.length, 3);
  assert.deepEqual(client.calls.map((c) => c.options.maxTotalChargeUsd), [0.2, 0.2, 0.1]);
  assert.equal(result.report.stopReason, 'budget_exhausted');
  assert.equal(result.report.skippedSourceRuns, 1);
  assert.equal(result.report.status, 'partial');
  assert.equal(result.report.budget.accountedChargeUsd, 0.3);
});

test('unknown charges consume the reserved allowance, including failed source runs', async () => {
  for (const status of ['SUCCEEDED', 'FAILED']) {
    const client = new TestClient({ cost: null, status });
    const result = await run({ ...exampleInput, queries: ['a', 'b', 'c', 'd'], maxSourceBudgetUsd: 0.25, maxTotalChargeUsd: 0.1 }, { sourceClient: client, storage: new MemoryStorage(), logger: quiet });
    assert.deepEqual(client.calls.map((c) => c.options.maxTotalChargeUsd), [0.1, 0.1, 0.05]);
    assert.equal(result.report.budget.knownChargeUsd, 0);
    assert.equal(result.report.budget.reservedUnknownChargeUsd, 0.25);
    assert.equal(result.report.budget.remainingSourceBudgetUsd, 0);
    assert.equal(result.report.stopReason, 'budget_exhausted');
    assert.equal(result.report.errorCount, status === 'FAILED' ? 3 : 0);
  }
});

test('zero budget, sub-micro-dollar budget, zero run count and per-run zero cap launch nothing', async () => {
  for (const limits of [{ maxSourceBudgetUsd: 0 }, { maxSourceBudgetUsd: 0.0000009 }, { maxSourceRuns: 0 }, { maxTotalChargeUsd: 0 }]) {
    const client = new TestClient();
    const result = await run({ ...exampleInput, ...limits }, { sourceClient: client, storage: new MemoryStorage(), logger: quiet });
    assert.equal(client.calls.length, 0);
    assert.equal(result.report.status, 'partial');
    assert.equal(result.report.skippedSourceRuns, 1);
    assert.equal(result.snapshots.length, 0);
  }
});

test('limits the entire query/market/engine fanout and charges failed runs', async () => {
  const client = new TestClient({ status: 'FAILED', cost: 0.1 });
  const result = await run({ ...exampleInput, queries: ['a', 'b'], markets: [{ countryCode: 'US' }, { countryCode: 'GB' }], engines: ['a', 'b'], maxSourceRuns: 2 }, { sourceClient: client, storage: new MemoryStorage(), logger: quiet });
  assert.equal(client.calls.length, 2);
  assert.equal(result.report.plannedSourceRuns, 8);
  assert.equal(result.report.skippedSourceRuns, 6);
  assert.equal(result.report.failedSourceRuns, 2);
  assert.equal(result.report.budget.knownChargeUsd, 0.2);
  assert.equal(result.report.stopReason, 'max_source_runs');
});

test('definite launch rejection has no charge but still consumes a launch attempt', async () => {
  const sourceClient = { async runActor() { const error = new Error('Minimum source charge too high'); error.definitiveRejection = true; throw error; } };
  const result = await run({ ...exampleInput, queries: ['a', 'b'], maxSourceRuns: 1 }, { sourceClient, storage: new MemoryStorage(), logger: quiet });
  assert.equal(result.report.budget.accountedChargeUsd, 0);
  assert.equal(result.report.failedSourceRuns, 1);
  assert.equal(result.report.stopReason, 'max_source_runs');
});

test('a lost launch response stops dispatch and is never retried on resurrection', async () => {
  const storage = new MemoryStorage();
  let calls = 0;
  const sourceClient = { async runActor() { calls++; throw new Error('Connection reset after POST'); } };
  const options = { sourceClient, storage, runId: 'same-run', logger: quiet };
  const first = await run({ ...exampleInput, queries: ['a', 'b'] }, options);
  const second = await run({ ...exampleInput, queries: ['a', 'b'] }, options);
  assert.equal(calls, 1);
  assert.equal(first.report.stopReason, 'ambiguous_launch');
  assert.equal(second.report.budget.reservedUnknownChargeUsd, 0.5);
  assert.equal(storage.items.length, 0);
  assert.equal((await storage.loadJson('RUN_REPORT')).stopReason, 'ambiguous_launch');
});

test('resumes a checkpointed child ID after interruption without another POST', async () => {
  const storage = new MemoryStorage();
  const interrupted = { async runActor(_actor, _input, options) {
    await options.onStarted({ id: 'existing-child', status: 'RUNNING' });
    const error = new Error('simulated parent interruption'); error.checkpointFailure = true; throw error;
  } };
  await assert.rejects(run(exampleInput, { sourceClient: interrupted, storage, runId: 'resume-me', logger: quiet }), /interruption/);
  const client = new TestClient();
  const result = await run(exampleInput, { sourceClient: client, storage, runId: 'resume-me', logger: quiet });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(client.resumes, ['existing-child']);
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.report.budget.sourceRuns, 1);
  assert.equal(result.report.budget.knownChargeUsd, 0.1);
  await run(exampleInput, { sourceClient: client, storage, runId: 'resume-me', logger: quiet });
  assert.equal(client.resumes.length, 1);
  assert.equal(storage.items.length, 1);
});

test('storage failure before reservation never dispatches a child and input changes cannot reuse a checkpoint', async () => {
  const storage = new MemoryStorage();
  const original = storage.saveJson.bind(storage);
  storage.saveJson = async (key, state) => { if (state.entries?.length) throw new Error('disk unavailable'); await original(key, state); };
  const client = new TestClient();
  await assert.rejects(run(exampleInput, { sourceClient: client, storage, runId: 'stable', logger: quiet }), /disk unavailable/);
  assert.equal(client.calls.length, 0);
  await assert.rejects(run({ ...exampleInput, maxSourceBudgetUsd: 1 }, { sourceClient: client, storage, runId: 'stable', logger: quiet }), /checkpoint input differs/);
});

test('parent deadline prevents launch and shortens child timeout', async () => {
  const now = () => Date.parse('2026-10-18T00:00:00Z');
  const noTime = new TestClient();
  const first = await run(exampleInput, { sourceClient: noTime, storage: new MemoryStorage(), now, env: { ACTOR_TIMEOUT_AT: '2026-10-18T00:00:10Z' }, logger: quiet });
  assert.equal(noTime.calls.length, 0);
  assert.equal(first.report.stopReason, 'parent_deadline');
  const time = new TestClient();
  await run(exampleInput, { sourceClient: time, storage: new MemoryStorage(), now, env: { ACTOR_TIMEOUT_AT: '2026-10-18T00:01:00Z' }, logger: quiet });
  assert.equal(time.calls[0].options.timeoutSeconds, 40);
});

test('known unresolved run stops other work and can be reconciled after resurrection', async () => {
  const storage = new MemoryStorage();
  const client = { async runActor(_actor, _input, options) {
    const run = { id: 'still-running', status: 'RUNNING' };
    await options.onStarted(run);
    const error = new Error('abort request could not be confirmed'); error.run = run; throw error;
  } };
  const input = { ...exampleInput, queries: ['a', 'b'] };
  const first = await run(input, { sourceClient: client, storage, runId: 'reconcile', logger: quiet });
  assert.equal(first.report.stopReason, 'source_reconciliation_required');
  const recovered = new TestClient();
  const second = await run(input, { sourceClient: recovered, storage, runId: 'reconcile', logger: quiet });
  assert.deepEqual(recovered.resumes, ['still-running']);
  assert.equal(recovered.calls.length, 1);
  assert.equal(second.report.status, 'succeeded');
  assert.equal(second.report.errorCount, 0);
  assert.equal(second.snapshots.length, 2);
});

test('a slow reservation write cannot dispatch a child after the parent launch window closes', async () => {
  let clock = Date.parse('2026-10-18T00:00:00Z');
  const storage = new MemoryStorage();
  const original = storage.saveJson.bind(storage);
  storage.saveJson = async (key, state) => {
    await original(key, state);
    if (state.entries?.length) clock += 15000;
  };
  const client = new TestClient();
  const result = await run(exampleInput, { sourceClient: client, storage, now: () => clock, env: { ACTOR_TIMEOUT_AT: '2026-10-18T00:00:30Z' }, logger: quiet });
  assert.equal(client.calls.length, 0);
  assert.equal(result.report.stopReason, 'parent_deadline');
  assert.equal(result.report.budget.accountedChargeUsd, 0);
  assert.equal(result.report.budget.sourceRuns, 0);
});
