import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function parseResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Apify storage request failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

export class ApifyStorage {
  constructor({ token = process.env.APIFY_API_TOKEN ?? process.env.APIFY_TOKEN, baseUrl = process.env.APIFY_API_BASE_URL ?? 'https://api.apify.com', datasetId = process.env.APIFY_DEFAULT_DATASET_ID, storeId = process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID, fetchImpl = globalThis.fetch } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.datasetId = datasetId;
    this.storeId = storeId;
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
    return parseResponse(response);
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
  if (process.env.APIFY_DEFAULT_DATASET_ID && (process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN)) return new ApifyStorage(options);
  return new LocalStorage(options);
}
