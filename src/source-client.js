function actorPath(actorId) {
  return encodeURIComponent(String(actorId).trim().replace(/\//g, '~'));
}

function ensureFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  return fetchImpl;
}

async function readJson(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`Apify API request failed (${response.status}): ${detail}`);
  }
  return body;
}

export class ApifySourceClient {
  constructor({ token = process.env.APIFY_API_TOKEN ?? process.env.APIFY_TOKEN, baseUrl = process.env.APIFY_API_BASE_URL ?? 'https://api.apify.com', fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = ensureFetch(fetchImpl);
    this.sleep = sleep;
  }

  async runActor(actorId, input, { timeoutSeconds = 300, maxTotalChargeUsd } = {}) {
    if (!this.token) throw new Error('APIFY_API_TOKEN or APIFY_TOKEN is required to run a source Actor');
    const params = new URLSearchParams();
    if (maxTotalChargeUsd !== undefined) params.set('maxTotalChargeUsd', String(maxTotalChargeUsd));
    const query = params.toString();
    const url = `${this.baseUrl}/v2/actors/${actorPath(actorId)}/runs${query ? `?${query}` : ''}`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    const run = await readJson(response);
    const runData = run?.data ?? run;
    const finalRun = await this.waitForRun(runData, timeoutSeconds);
    if (finalRun?.status && finalRun.status !== 'SUCCEEDED') {
      throw new Error(`Source Actor ${actorId} ended with status ${finalRun.status}${finalRun.statusMessage ? `: ${finalRun.statusMessage}` : ''}`);
    }
    const datasetId = finalRun?.defaultDatasetId;
    if (!datasetId) throw new Error(`Source Actor ${actorId} did not return a dataset`);

    const datasetResponse = await this.fetch(`${this.baseUrl}/v2/datasets/${encodeURIComponent(datasetId)}/items?clean=true`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    const items = await readJson(datasetResponse);
    return Array.isArray(items) ? items : (items?.data ?? []);
  }

  async waitForRun(runData, timeoutSeconds) {
    if (!runData?.id || ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(runData.status)) return runData;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let current = runData;
    while (Date.now() < deadline) {
      await this.sleep(Math.min(2000, Math.max(250, deadline - Date.now())));
      const response = await this.fetch(`${this.baseUrl}/v2/actor-runs/${encodeURIComponent(runData.id)}`, {
        headers: { authorization: `Bearer ${this.token}` },
      });
      const body = await readJson(response);
      current = body?.data ?? body;
      if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(current.status)) return current;
    }
    throw new Error(`Source Actor run ${runData.id} exceeded ${timeoutSeconds}s`);
  }
}

export class FixtureSourceClient {
  constructor(fixture = {}) {
    this.fixture = fixture;
  }

  async runActor(_actorId, input) {
    const query = Array.isArray(input?.queries) ? input.queries[0] : input?.queries;
    const marketKey = `${input?.countryCode ?? ''}:${input?.languageCode ?? ''}`;
    return this.fixture[`${marketKey}:${query}`] ?? this.fixture[query] ?? this.fixture.default ?? [];
  }
}
