import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
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
  }

  get enabled() {
    return Boolean(this.token && this.fetch);
  }

  async loadJson(key) {
    if (!this.enabled || !this.storeId) return null;
    const response = await this.fetch(`${this.baseUrl}/v2/key-value-stores/${encodeURIComponent(this.storeId)}/records/${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    return parseResponse(response, { allowMissing: true });
  }

  async saveJson(key, value) {
    if (!this.enabled || !this.storeId) return;
    const response = await this.fetch(`${this.baseUrl}/v2/key-value-stores/${encodeURIComponent(this.storeId)}/records/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    await parseResponse(response);
  }

  async pushItems(items) {
    if (!this.enabled || !this.datasetId || items.length === 0) return;
    const response = await this.fetch(`${this.baseUrl}/v2/datasets/${encodeURIComponent(this.datasetId)}/items`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(items),
    });
    await parseResponse(response);
  }
}

export class LocalStorage {
  constructor({ directory = process.env.GEO_OUTPUT_DIR ?? 'storage' } = {}) {
    this.directory = directory;
    this.datasetPath = join(directory, 'dataset.jsonl');
    this.historyPath = join(directory, 'history.json');
  }

  async loadJson(_key) {
    try {
      return JSON.parse(await readFile(this.historyPath, 'utf8'));
    } catch {
      return null;
    }
  }

  async saveJson(_key, value) {
    await mkdir(dirname(this.historyPath), { recursive: true });
    await writeFile(this.historyPath, JSON.stringify(value, null, 2), 'utf8');
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
