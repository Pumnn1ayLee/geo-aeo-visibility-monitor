export class MemoryStorage {
  constructor({ stores = new Map(), name = 'default' } = {}) {
    this.stores = stores;
    this.storeId = name;
    this.actorId = 'test-actor';
    if (!stores.has(name)) stores.set(name, new Map());
    this.records = stores.get(name);
    this.items = [];
  }
  async openNamedStore(name) { return new MemoryStorage({ stores: this.stores, name }); }
  async loadJson(key) { return structuredClone(this.records.get(key) ?? null); }
  async saveJson(key, value) { this.records.set(key, structuredClone(value)); }
  async deleteJson(key) { this.records.delete(key); }
  async listKeys() { return [...this.records.keys()]; }
  async pushItems(items) { this.items.push(...structuredClone(items)); }
  async hasSnapshot(runId, comparisonKey) { return this.items.some((item) => item.runId === runId && item.comparisonKey === comparisonKey); }
}

export const exampleInput = { brand: { name: 'Example brand', domains: ['example.com'] }, queries: ['best tool'], maxTotalChargeUsd: 0.5 };
export const evidence = [{ organicResults: [{ position: 1, title: 'Example brand', url: 'https://example.com', snippet: 'Example brand is recommended.' }] }];
export const quiet = { error() {} };

export class TestClient {
  calls = [];
  resumes = [];
  constructor({ items = evidence, cost = 0.1, status = 'SUCCEEDED' } = {}) { this.items = items; this.cost = cost; this.status = status; }
  async runActor(actorId, input, options = {}) {
    this.calls.push({ actorId, input, options });
    const run = { id: `child-${this.calls.length}`, status: this.status };
    if (this.cost !== null) run.usageTotalUsd = this.cost;
    await options.onStarted?.(run);
    await options.onFinished?.(run);
    if (this.status !== 'SUCCEEDED') { const error = new Error('Source failed'); error.run = run; throw error; }
    return { items: this.items, run };
  }
  async resumeRun(id, options) {
    this.resumes.push(id);
    const run = { id, status: this.status, usageTotalUsd: this.cost };
    await options.onFinished?.(run);
    return { items: this.items, run };
  }
}
