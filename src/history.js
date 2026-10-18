import { createHash } from 'node:crypto';

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function entityIdentity(entity) {
  return { name: entity.name.toLowerCase(), aliases: entity.aliases.map((s) => s.toLowerCase()).sort(), domains: [...entity.domains].sort() };
}

// Hash the actual source input, not the entire query set: adding a query keeps old baselines usable.
export function comparisonKey(config, { query, market, engine, sourceInput }) {
  return fingerprint({ version: 1, analysisVersion: 2, brand: entityIdentity(config.brand),
    competitors: config.competitors.map(entityIdentity).sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
    query, market, engine: { name: engine.name, actorId: engine.actorId }, sourceInput });
}

export class History {
  constructor(config, storage, { runId, startedAt, actorId }) {
    this.config = config;
    this.storage = storage;
    this.runId = runId;
    this.startedAt = startedAt;
    this.storeName = `geo-history-${fingerprint(actorId).slice(0, 24)}`;
    this.prefix = `H1-${fingerprint([config.monitorId, config.historyKey]).slice(0, 24)}-`;
    this.info = { enabled: config.historyEnabled, monitorId: config.monitorId, retentionDays: config.historyRetentionDays,
      storeId: null, storeName: config.historyEnabled ? this.storeName : null, baselineCount: 0, prunedRecords: 0 };
  }

  async load(keys) {
    if (!this.config.historyEnabled) return [];
    this.store = await this.storage.openNamedStore(this.storeName);
    this.info.storeId = this.store.storeId;
    const start = Date.parse(this.startedAt);
    const cutoff = start - this.config.historyRetentionDays * 86400000;
    const candidates = [];
    for (const key of await this.store.listKeys()) {
      if (!key.startsWith(this.prefix)) continue;
      const timestamp = Number(key.slice(this.prefix.length).split('-')[0]);
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
      if (timestamp < cutoff) {
        await this.store.deleteJson(key);
        this.info.prunedRecords++;
      } else if (timestamp <= start) candidates.push({ key, timestamp });
    }
    candidates.sort((a, b) => b.timestamp - a.timestamp || a.key.localeCompare(b.key));
    const wanted = new Set(keys);
    const found = new Map();
    for (const candidate of candidates) {
      if (found.size === wanted.size) break;
      const record = await this.store.loadJson(candidate.key);
      const completed = Date.parse(record?.completedAt);
      if (!record || record.schemaVersion !== 1 || typeof record.runId !== 'string' || record.runId === this.runId
        || !Number.isFinite(completed) || completed !== candidate.timestamp || completed > start || !Array.isArray(record.snapshots)) continue;
      for (const snapshot of record.snapshots ?? []) {
        if (!wanted.has(snapshot.comparisonKey) || found.has(snapshot.comparisonKey) || snapshot.analysisVersion !== 2 || !snapshot.observationPresent) continue;
        found.set(snapshot.comparisonKey, { ...snapshot, baselineRunId: record.runId, baselineCapturedAt: snapshot.capturedAt });
      }
    }
    this.info.baselineCount = found.size;
    return [...found.values()];
  }

  async save(snapshots, completedAt) {
    if (!this.store || !snapshots.length) return;
    const key = `${this.prefix}${Date.parse(completedAt)}-${fingerprint(this.runId).slice(0, 24)}`;
    await this.store.saveJson(key, { schemaVersion: 1, runId: this.runId, monitorId: this.config.monitorId,
      startedAt: this.startedAt, completedAt,
      snapshots: snapshots.filter((s) => s.observationPresent).map(({ rawSource: _raw, ...summary }) => summary) });
  }
}
