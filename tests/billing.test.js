import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SnapshotBilling, RESULT_EVENT } from '../src/billing.js';
import { run } from '../src/index.js';
import { MemoryStorage, TestClient, exampleInput, quiet } from './helpers.js';

function cloudStorage({ limit = 1, price = 0.01, startup = 0.00005, memory = 1024, staleCounts = false } = {}) {
  const storage = new MemoryStorage();
  storage.runId = 'paid-run';
  storage.getRunInfo = async () => ({ id: storage.runId, options: { maxTotalChargeUsd: limit, memoryMbytes: memory },
    pricingInfo: { pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: {
      [RESULT_EVENT]: { eventPriceUsd: price }, 'apify-actor-start': { eventPriceUsd: startup },
    } } }, chargedEventCounts: { [RESULT_EVENT]: staleCounts ? 0 : storage.items.length },
  });
  return storage;
}

test('parent fee cap reserves startup, respects zero, and stops before the first source if one result cannot fit', async () => {
  for (const limit of [0, 0.00005, 0.01, 0.0100499]) {
    const storage = cloudStorage({ limit });
    const client = new TestClient();
    const result = await run(exampleInput, { sourceClient: client, storage, env: {}, logger: quiet });
    assert.equal(client.calls.length, 0, `limit ${limit}`);
    assert.equal(result.report.stopReason, 'parent_charge_limit');
    assert.equal(storage.items.length, 0);
    assert.equal((await storage.loadJson('RUN_REPORT')).billing.summariesAndErrorsCharged, false);
  }
});

test('a complete result is delivered before the next source and only affordable checks are launched despite stale counts', async () => {
  const storage = cloudStorage({ limit: 0.02005, staleCounts: true });
  const client = new TestClient();
  const original = client.runActor.bind(client);
  client.runActor = async (...args) => {
    assert.equal(storage.items.length, client.calls.length, 'each prior result must already be accessible');
    return original(...args);
  };
  const result = await run({ ...exampleInput, queries: ['a', 'b', 'c'] }, { sourceClient: client, storage, env: {}, logger: quiet });
  assert.equal(client.calls.length, 2);
  assert.equal(result.report.stopReason, 'parent_charge_limit');
  assert.equal(result.report.skippedSourceRuns, 1);
  assert.equal(result.report.billing.accountedEventChargeUsd, 0.02005);
  assert.equal(result.report.billing.remainingSnapshotCapacity, 0);
  assert.equal(storage.items.length, 2);
  assert.ok(storage.items.every((item) => item.type === 'visibility_snapshot'));
});

test('the smaller runtime/API cap wins, and the run-specific price is used', async () => {
  const storage = cloudStorage({ limit: 10, price: 0.03, memory: 2048 });
  const client = new TestClient();
  const result = await run({ ...exampleInput, queries: ['a', 'b'] }, {
    sourceClient: client, storage, env: { ACTOR_MAX_TOTAL_CHARGE_USD: '0.0301' }, logger: quiet,
  });
  assert.equal(client.calls.length, 1);
  assert.equal(result.report.billing.accountedEventChargeUsd, 0.0301);
  assert.equal(result.report.billing.unitPriceUsd, 0.03);
  assert.equal(result.report.billing.maxParentChargeUsd, 0.0301);
});

test('failed and empty sources never create billable rows; diagnostics remain accessible', async () => {
  for (const client of [new TestClient({ status: 'FAILED' }), new TestClient({ items: [] })]) {
    const storage = cloudStorage();
    const result = await run(exampleInput, { sourceClient: client, storage, env: {}, logger: quiet });
    assert.equal(result.report.status, 'failed');
    assert.equal(storage.items.length, 0);
    assert.equal(result.report.billing.deliveredSnapshotCount, 0);
    assert.equal(result.report.billing.accountedEventChargeUsd, 0.00005);
    assert.equal((await storage.loadJson('SOURCE_ERRORS')).length, 1);
    assert.equal((await storage.loadJson('RUN_REPORT')).errorCount, 1);
    assert.equal(result.report.budget.knownChargeUsd, 0.1, 'upstream charges still count toward source budget');
  }
});

test('partial source failures produce only the successful snapshot in the default dataset', async () => {
  const storage = cloudStorage();
  const client = new TestClient();
  const original = client.runActor.bind(client);
  client.runActor = async (...args) => { client.status = client.calls.length === 1 ? 'FAILED' : 'SUCCEEDED'; return original(...args); };
  const result = await run({ ...exampleInput, queries: ['a', 'b'] }, { sourceClient: client, storage, env: {}, logger: quiet });
  assert.equal(result.report.status, 'partial');
  assert.equal(storage.items.length, 1);
  assert.equal(result.report.billing.accountedEventChargeUsd, 0.01005);
  assert.equal((await storage.loadJson('SOURCE_ERRORS')).length, 1);
});

test('a lost dataset acknowledgement is reconciled without repeating a billable write or paid source', async () => {
  const storage = cloudStorage();
  const original = storage.pushItems.bind(storage);
  let writes = 0;
  storage.pushItems = async (items) => {
    writes++;
    await original(items);
    if (writes === 1) throw new Error('acknowledgement lost');
  };
  const client = new TestClient();
  const options = { sourceClient: client, storage, env: {}, logger: quiet };
  await assert.rejects(run({ ...exampleInput, queries: ['a', 'b'] }, options), /delivery failed or is unconfirmed/);
  assert.equal(client.calls.length, 1);
  assert.equal((await storage.loadJson('RUN_REPORT')).snapshotCount, 1);
  const recovered = await run({ ...exampleInput, queries: ['a', 'b'] }, options);
  assert.equal(writes, 2);
  assert.equal(client.calls.length, 2);
  assert.equal(storage.items.length, 2);
  assert.equal(recovered.report.billing.accountedEventChargeUsd, 0.02005);
  await run({ ...exampleInput, queries: ['a', 'b'] }, options);
  assert.equal(writes, 2);
});

test('an unconfirmed missing dataset write fails closed on resurrection', async () => {
  const storage = cloudStorage();
  let writes = 0;
  storage.pushItems = async () => { writes++; throw new Error('connection reset'); };
  const client = new TestClient();
  const options = { sourceClient: client, storage, env: {}, logger: quiet };
  const input = { ...exampleInput, queries: ['a', 'b'] };
  await assert.rejects(run(input, options), /dispatch stopped/);
  await assert.rejects(run(input, options), /delivery is unconfirmed/);
  assert.equal(writes, 1);
  assert.equal(client.calls.length, 1);
});

test('checkpoint interruption after dataset acceptance does not create a second billable result', async () => {
  const storage = cloudStorage();
  const save = storage.saveJson.bind(storage);
  let interrupted = false;
  storage.saveJson = async (key, value) => {
    if (!interrupted && value.deliveries && Object.values(value.deliveries).some((delivery) => delivery.status === 'confirmed')) {
      interrupted = true;
      throw new Error('checkpoint interrupted after delivery');
    }
    await save(key, value);
  };
  const client = new TestClient();
  const options = { sourceClient: client, storage, env: {}, logger: quiet };
  await assert.rejects(run(exampleInput, options), /checkpoint interrupted/);
  const result = await run(exampleInput, options);
  assert.equal(storage.items.length, 1);
  assert.equal(client.calls.length, 1);
  assert.equal(result.report.billing.deliveredSnapshotCount, 1);
});

test('invalid pricing, unavailable run metadata and malformed cap fail before paid work', async () => {
  for (const mutate of [
    (info) => { delete info.pricingInfo.pricingPerEvent.actorChargeEvents[RESULT_EVENT]; },
    (info) => { info.pricingInfo.pricingPerEvent.actorChargeEvents[RESULT_EVENT].eventPriceUsd = undefined; },
    (info) => { info.id = 'another-run'; },
    (info) => { info.options.maxTotalChargeUsd = -1; },
    (info) => { info.chargedEventCounts[RESULT_EVENT] = -1; },
  ]) {
    const storage = cloudStorage();
    const info = await storage.getRunInfo(); mutate(info);
    storage.getRunInfo = async () => info;
    const client = new TestClient();
    await assert.rejects(run(exampleInput, { sourceClient: client, storage, env: {}, logger: quiet }));
    assert.equal(client.calls.length, 0);
  }
});

test('local fixtures do not fetch platform pricing or generate paid charge calls', async () => {
  const billing = new SnapshotBilling({ storage: new MemoryStorage(), env: { ACTOR_MAX_TOTAL_CHARGE_USD: '0' } });
  await billing.refresh();
  assert.equal(billing.summary().mode, 'local_unbilled');
  assert.equal(billing.canProduce(10), true);
});

test('the AI live preset processes captured Google AI evidence and bills a single accessible snapshot', async () => {
  const input = JSON.parse(await readFile(new URL('../examples/ai-live-input.json', import.meta.url), 'utf8'));
  const items = JSON.parse(await readFile(new URL('./fixtures/google-ai-mode.json', import.meta.url), 'utf8'));
  const storage = cloudStorage({ limit: 0.01005 });
  const client = new TestClient({ items });
  const result = await run(input, { sourceClient: client, storage, env: {}, logger: quiet });
  assert.equal(client.calls[0].input.aiModeSearch.enableAiMode, true);
  assert.equal(client.calls[0].input.aiOverview.scrapeFullAiOverview, false);
  assert.equal(result.report.status, 'succeeded');
  assert.ok(result.snapshots[0].aiResponseCount > 0);
  assert.equal(storage.items.length, 1);
  assert.equal(result.report.billing.accountedEventChargeUsd, 0.01005);
  assert.equal((await storage.loadJson('RUN_REPORT')).outputContractVersion, 2);
  assert.deepEqual(await storage.loadJson('SOURCE_ERRORS'), []);
});

test('unexpected charged events and pricing API failures stop dispatch instead of using a guessed price', async () => {
  for (const fail of [false, true]) {
    const storage = cloudStorage();
    const info = await storage.getRunInfo();
    info.chargedEventCounts.unconfigured = 1;
    storage.getRunInfo = async () => { if (fail) throw new Error('pricing API unavailable'); return info; };
    const client = new TestClient();
    await assert.rejects(run(exampleInput, { sourceClient: client, storage, env: {}, logger: quiet }), /unknown charged event|pricing API unavailable/);
    assert.equal(client.calls.length, 0);
  }
});
