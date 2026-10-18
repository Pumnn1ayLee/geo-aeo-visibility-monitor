import { mkdir, readFile, appendFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

async function parseResponse(response, { allowMissing = false } = {}) {
  const text = await response.text();
  if (!response.ok) {
    if (allowMissing && response.status === 404) return null;
    throw new Error(`Apify storage request failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

export class ApifyStorage {
  constructor({ token, baseUrl, datasetId, storeId, fetchImpl = globalThis.fetch, env = process.env } = {}) {
    this.token = token ?? env.APIFY_API_TOKEN ?? env.APIFY_TOKEN;
    this.baseUrl = (baseUrl ?? env.APIFY_API_BASE_URL ?? 'https://api.apify.com').replace(/\/$/, '');
    this.datasetId = datasetId ?? env.ACTOR_DEFAULT_DATASET_ID ?? env.APIFY_DEFAULT_DATASET_ID;
    this.storeId = storeId ?? env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID ?? env.APIFY_DEFAULT_KEY_VALUE_STORE_ID;
    this.fetch = fetchImpl;
    this.actorId = env.ACTOR_ID ?? env.APIFY_ACTOR_ID ?? 'geo-visibility-monitor';
    this.runId = env.ACTOR_RUN_ID ?? env.APIFY_ACTOR_RUN_ID;
  }

  get enabled() {
    return Boolean(this.token && this.fetch);
  }

  async openNamedStore(name) {
    const response = await this.fetch(`${this.baseUrl}/v2/key-value-stores?${new URLSearchParams({ name })}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(15000),
    });
    const body = await parseResponse(response);
    const id = body?.data?.id ?? body?.id;
    if (!id) throw new Error('Named history store did not return an ID');
    return new ApifyStorage({ token: this.token, baseUrl: this.baseUrl, storeId: id, fetchImpl: this.fetch, env: {} });
  }

  async listKeys() {
    const keys = [];
    let cursor = '';
    do {
      const params = new URLSearchParams({ limit: '1000' });
      if (cursor) params.set('exclusiveStartKey', cursor);
      const response = await this.fetch(`${this.baseUrl}/v2/key-value-stores/${encodeURIComponent(this.storeId)}/keys?${params}`, {
        headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15000),
      });
      const body = await parseResponse(response);
      const page = body?.data ?? body;
      if (!Array.isArray(page?.items)) throw new Error('Invalid history keys response');
      keys.push(...page.items.map((item) => item.key));
      if (!page.isTruncated) break;
      if (!page.nextExclusiveStartKey || page.nextExclusiveStartKey === cursor) throw new Error('History pagination did not advance');
      cursor = page.nextExclusiveStartKey;
    } while (true);
    return keys;
  }

  async deleteJson(key) {
    const response = await this.fetch(`${this.baseUrl}/v2/key-value-stores/${encodeURIComponent(this.storeId)}/records/${encodeURIComponent(key)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15000),
    });
    await parseResponse(response, { allowMissing: true });
  }

  async loadJson(key) {
    if (!this.enabled || !this.storeId) return null;
    const response = await this.fetch(`${this.baseUrl}/v2/key-value-stores/${encodeURIComponent(this.storeId)}/records/${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(15000),
    });
    return parseResponse(response, { allowMissing: true });
  }

  async saveJson(key, value) {
    if (!this.enabled || !this.storeId) return;
    const response = await this.fetch(`${this.baseUrl}/v2/key-value-stores/${encodeURIComponent(this.storeId)}/records/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(15000),
    });
    await parseResponse(response);
  }

  async pushItems(items) {
    if (!this.enabled || !this.datasetId || items.length === 0) return;
    const response = await this.fetch(`${this.baseUrl}/v2/datasets/${encodeURIComponent(this.datasetId)}/items`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(items),
      signal: AbortSignal.timeout(15000),
    });
    await parseResponse(response);
  }
}

export class LocalStorage {
  constructor({ directory = process.env.GEO_OUTPUT_DIR ?? 'storage' } = {}) {
    this.directory = directory;
    this.datasetPath = join(directory, 'dataset.jsonl');
    this.storeId = directory;
    this.actorId = 'geo-visibility-monitor-local';
  }

  recordPath(key) { return join(this.directory, 'records', `${encodeURIComponent(key)}.json`); }

  async openNamedStore(name) {
    return new LocalStorage({ directory: join(this.directory, 'named-stores', encodeURIComponent(name)) });
  }

  async listKeys() {
    try { return (await readdir(join(this.directory, 'records'))).filter((name) => name.endsWith('.json')).map((name) => decodeURIComponent(name.slice(0, -5))); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async deleteJson(key) {
    try { await unlink(this.recordPath(key)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async loadJson(key) {
    try {
      return JSON.parse(await readFile(this.recordPath(key), 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async saveJson(key, value) {
    const path = this.recordPath(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await rename(temp, path);
  }

  async pushItems(items) {
    if (!items.length) return;
    await mkdir(dirname(this.datasetPath), { recursive: true });
    await appendFile(this.datasetPath, `${items.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  }
}

export function createStorage(options = {}) {
  const env = options.env ?? process.env;
  const storage = new ApifyStorage(options);
  if (env.APIFY_IS_AT_HOME === '1' || env.ACTOR_RUN_ID || env.APIFY_ACTOR_RUN_ID || storage.datasetId) {
    if (!storage.enabled || !storage.datasetId || !storage.storeId) {
      throw new Error('Apify storage is not configured. APIFY_TOKEN, ACTOR_DEFAULT_DATASET_ID, and ACTOR_DEFAULT_KEY_VALUE_STORE_ID are required (legacy APIFY_DEFAULT_* names are also supported).');
    }
    return storage;
  }
  return new LocalStorage(options);
}
