import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

async function readJson(response) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const error = new Error(`Apify API request failed (${response.status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    error.httpStatus = response.status;
    throw error;
  }
  return body?.data ?? body;
}

export class ApifySourceClient {
  constructor({ token = process.env.APIFY_API_TOKEN ?? process.env.APIFY_TOKEN, baseUrl = process.env.APIFY_API_BASE_URL ?? 'https://api.apify.com', fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.now = now;
  }

  async request(path, options = {}) {
    return readJson(await this.fetch(`${this.baseUrl}${path}`, {
      ...options, headers: { authorization: `Bearer ${this.token}`, ...options.headers }, signal: AbortSignal.timeout(15000),
    }));
  }

  async runActor(actorId, input, options = {}) {
    if (!this.token) {
      const error = new Error('APIFY_API_TOKEN or APIFY_TOKEN is required to run a source Actor');
      error.definitiveRejection = true;
      throw error;
    }
    const params = new URLSearchParams({ timeout: String(Math.max(1, Math.floor(options.timeoutSeconds ?? 300))) });
    if (options.maxTotalChargeUsd !== undefined) params.set('maxTotalChargeUsd', String(options.maxTotalChargeUsd));
    let sourceRun;
    try {
      sourceRun = await this.request(`/v2/actors/${encodeURIComponent(String(actorId).trim().replace(/\//g, '~'))}/runs?${params}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      if (!sourceRun?.id) throw new Error('Source launch response did not include a run ID');
    } catch (error) {
      error.definitiveRejection = error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408;
      error.launchUncertain = !error.definitiveRejection;
      throw error;
    }
    return this.finishRun(sourceRun, options, true);
  }

  async resumeRun(runId, options = {}) {
    let sourceRun;
    try { sourceRun = await this.request(`/v2/actor-runs/${encodeURIComponent(runId)}`); }
    catch (error) {
      error.run = { id: runId, status: 'UNKNOWN' };
      try { error.run = await this.abortRun(runId); } catch (abortError) { error.abortError = abortError.message; }
      throw error;
    }
    return this.finishRun(sourceRun, options, false);
  }

  async abortRun(runId) {
    return this.request(`/v2/actor-runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' });
  }

  async finishRun(initial, { timeoutSeconds = 300, onStarted, onFinished } = {}, isNew) {
    let current = initial;
    try {
      if (isNew) await onStarted?.(current);
      const deadline = this.now() + timeoutSeconds * 1000;
      while (!TERMINAL.has(current.status)) {
        if (this.now() >= deadline) throw new Error(`Source Actor run ${current.id} exceeded its local deadline`);
        await this.sleep(Math.min(2000, Math.max(1, deadline - this.now())));
        const next = await this.request(`/v2/actor-runs/${encodeURIComponent(initial.id)}`);
        if (!next?.id) throw new Error('Source status response did not include a run ID');
        current = next;
      }
      await onFinished?.(current);
      if (current.status !== 'SUCCEEDED') throw new Error(`Source Actor run ${current.id} ended with status ${current.status}${current.statusMessage ? `: ${current.statusMessage}` : ''}`);
      if (!current.defaultDatasetId) throw new Error(`Source Actor run ${current.id} did not return a dataset`);
      const items = await this.request(`/v2/datasets/${encodeURIComponent(current.defaultDatasetId)}/items?clean=true`);
      if (!Array.isArray(items)) throw new Error('Source dataset response must be an array');
      return { items, run: current };
    } catch (error) {
      if (!TERMINAL.has(current.status)) {
        try { current = await this.abortRun(initial.id); }
        catch (abortError) { error.abortError = abortError.message; }
      }
      error.run = { ...current, id: initial.id };
      throw error;
    }
  }
}

export class FixtureSourceClient {
  constructor(fixture = {}) { this.fixture = fixture; }

  async runActor(_actorId, input, { onStarted, onFinished } = {}) {
    const sourceRun = { id: `fixture-${randomUUID()}`, status: 'SUCCEEDED', usageTotalUsd: 0 };
    await onStarted?.(sourceRun);
    await onFinished?.(sourceRun);
    const query = Array.isArray(input?.queries) ? input.queries[0] : input?.queries;
    const marketKey = `${input?.countryCode ?? ''}:${input?.languageCode ?? ''}`;
    return { items: this.fixture[`${marketKey}:${query}`] ?? this.fixture[query] ?? this.fixture.default ?? [], run: sourceRun };
  }
}
