const DEFAULT_SOURCE_ACTOR = 'apify/google-search-scraper';
const MAX_QUERIES = 100;
const MAX_RESULTS = 100;
export const MONITORING_PRESETS = ['google_ai_mode', 'google_ai_overview', 'google_ai_full', 'web_search', 'custom'];

function objectInput(value, field) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function asString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function asStringArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
  return [...new Set(value.map((item, index) => asString(item, `${field}[${index}]`)))];
}

function boundedNumber(value, field, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a number`);
  return Math.min(Math.max(number, min), max);
}

function normalizeEntity(value, field) {
  if (typeof value === 'string') return { name: asString(value, field), aliases: [], domains: [] };
  if (!value || typeof value !== 'object') throw new Error(`${field} must be a string or object`);

  const name = asString(value.name, `${field}.name`);
  return {
    name,
    aliases: asStringArray(value.aliases, `${field}.aliases`),
    domains: asStringArray(value.domains, `${field}.domains`).map((domain) => domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')),
  };
}

function normalizeMarket(value, index) {
  if (!value || typeof value !== 'object') throw new Error(`markets[${index}] must be an object`);
  const countryCode = asString(value.countryCode ?? 'US', `markets[${index}].countryCode`).toUpperCase();
  const languageCode = asString(value.languageCode ?? 'en', `markets[${index}].languageCode`).toLowerCase();
  return {
    countryCode,
    languageCode,
    location: typeof value.location === 'string' ? value.location.trim() : undefined,
  };
}

function normalizeEngine(value, index) {
  if (typeof value === 'string') {
    return { name: value, actorId: value, inputOverrides: {} };
  }
  if (!value || typeof value !== 'object') throw new Error(`engines[${index}] must be a string or object`);
  return {
    name: asString(value.name ?? value.actorId, `engines[${index}].name`),
    actorId: asString(value.actorId ?? DEFAULT_SOURCE_ACTOR, `engines[${index}].actorId`),
    inputOverrides: value.inputOverrides && typeof value.inputOverrides === 'object' ? value.inputOverrides : {},
  };
}

export function normalizeInput(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Input must be a JSON object');

  const brand = normalizeEntity(raw.brand, 'brand');
  const competitors = Array.isArray(raw.competitors)
    ? raw.competitors.map((item, index) => normalizeEntity(item, `competitors[${index}]`))
    : [];
  const queries = asStringArray(raw.queries, 'queries');
  if (queries.length === 0) throw new Error('queries must contain at least one query');

  const markets = (raw.markets ?? [{ countryCode: 'US', languageCode: 'en' }]).map(normalizeMarket);
  if (markets.length === 0) throw new Error('markets must contain at least one market');

  const engines = (raw.engines ?? [{ name: 'google', actorId: DEFAULT_SOURCE_ACTOR }]).map(normalizeEngine);
  if (engines.length === 0) throw new Error('engines must contain at least one source Actor');
  const sourceActorInput = objectInput(raw.sourceActorInput, 'sourceActorInput');
  // Keep older saved inputs and API clients on their explicitly configured collection settings.
  // New Console inputs prefill google_ai_mode; the platform default remains custom for older clients.
  const monitoringPreset = raw.monitoringPreset ?? 'custom';
  if (!MONITORING_PRESETS.includes(monitoringPreset)) throw new Error(`monitoringPreset must be one of: ${MONITORING_PRESETS.join(', ')}`);
  if (monitoringPreset !== 'custom' && engines.some((engine) => engine.actorId.replace('~', '/') !== DEFAULT_SOURCE_ACTOR)) {
    throw new Error('Google monitoring presets require apify/google-search-scraper. Select custom for other source Actors.');
  }
  if (monitoringPreset !== 'custom' && [sourceActorInput, ...engines.map((engine) => engine.inputOverrides)]
    .some((options) => ['perplexitySearch', 'chatGptSearch', 'copilotSearch', 'geminiSearch'].some((key) => key in options))) {
    throw new Error('Other AI add-ons require monitoringPreset: custom so their additional charges are explicit.');
  }

  const maxQueries = Math.floor(boundedNumber(raw.maxQueries, 'maxQueries', queries.length, 1, MAX_QUERIES));
  const maxResultsPerQuery = Math.floor(boundedNumber(raw.maxResultsPerQuery, 'maxResultsPerQuery', 10, 1, MAX_RESULTS));
  const maxTotalChargeUsd = raw.maxTotalChargeUsd == null ? undefined : Number(raw.maxTotalChargeUsd);
  if (maxTotalChargeUsd !== undefined && (!Number.isFinite(maxTotalChargeUsd) || maxTotalChargeUsd < 0)) {
    throw new Error('maxTotalChargeUsd must be a non-negative number');
  }

  const maxSourceBudgetUsd = Number(raw.maxSourceBudgetUsd ?? 2);
  if (!Number.isFinite(maxSourceBudgetUsd) || maxSourceBudgetUsd < 0 || maxSourceBudgetUsd > 1_000_000) throw new Error('maxSourceBudgetUsd must be between 0 and 1000000');
  const maxSourceRuns = Number(raw.maxSourceRuns ?? 20);
  if (!Number.isInteger(maxSourceRuns) || maxSourceRuns < 0 || maxSourceRuns > 1000) throw new Error('maxSourceRuns must be an integer between 0 and 1000');
  const historyRetentionDays = Number(raw.historyRetentionDays ?? 90);
  if (!Number.isInteger(historyRetentionDays) || historyRetentionDays < 1 || historyRetentionDays > 3650) throw new Error('historyRetentionDays must be an integer between 1 and 3650');
  if (raw.historyEnabled != null && typeof raw.historyEnabled !== 'boolean') throw new Error('historyEnabled must be a boolean');

  return {
    brand,
    competitors,
    queries: queries.slice(0, maxQueries),
    markets,
    engines,
    monitoringPreset,
    maxQueries,
    maxResultsPerQuery,
    maxTotalChargeUsd,
    maxSourceBudgetUsd,
    maxSourceRuns,
    monitorId: asString(raw.monitorId ?? 'default', 'monitorId'),
    historyEnabled: raw.historyEnabled ?? true,
    historyRetentionDays,
    historyKey: asString(raw.historyKey ?? 'GEO_HISTORY', 'historyKey'),
    includeRawSource: Boolean(raw.includeRawSource),
    sourceActorInput,
    sourceTimeoutSeconds: boundedNumber(raw.sourceTimeoutSeconds, 'sourceTimeoutSeconds', 300, 5, 900),
  };
}

export function buildSourceInput(config, query, market, engine) {
  const input = {
    queries: query,
    countryCode: market.countryCode.toLowerCase(),
    languageCode: market.languageCode,
    maxPagesPerQuery: Math.max(1, Math.ceil(config.maxResultsPerQuery / 10)),
    ...(market.location ? { location: market.location } : {}),
    ...config.sourceActorInput,
    ...engine.inputOverrides,
  };
  if (config.monitoringPreset !== 'custom') {
    // The selected preset owns the two Google switches; advanced options cannot silently disable it.
    input.aiModeSearch = { ...input.aiModeSearch, enableAiMode: ['google_ai_mode', 'google_ai_full'].includes(config.monitoringPreset) };
    input.aiOverview = { ...input.aiOverview, scrapeFullAiOverview: ['google_ai_overview', 'google_ai_full'].includes(config.monitoringPreset) };
  }
  return input;
}

export async function readInputFromEnvironment({ fetchImpl = globalThis.fetch, readFile = null, env = process.env } = {}) {
  const inline = env.GEO_INPUT_JSON ?? env.APIFY_INPUT ?? env.APIFY_ACTOR_INPUT;
  if (inline) return JSON.parse(inline);

  const inputFile = env.GEO_INPUT_FILE;
  if (inputFile && readFile) return JSON.parse(await readFile(inputFile, 'utf8'));

  const token = env.APIFY_API_TOKEN ?? env.APIFY_TOKEN;
  const storeIds = [...new Set([
    env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID,
    env.APIFY_INPUT_KEY_VALUE_STORE_ID,
    env.APIFY_DEFAULT_KEY_VALUE_STORE_ID,
  ].filter(Boolean))];
  const inputKey = env.ACTOR_INPUT_KEY ?? env.APIFY_INPUT_KEY ?? 'INPUT';
  if (token && storeIds.length && fetchImpl) {
    const baseUrl = (env.APIFY_API_BASE_URL ?? 'https://api.apify.com').replace(/\/$/, '');
    for (const storeId of storeIds) {
      const response = await fetchImpl(`${baseUrl}/v2/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(inputKey)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return response.json();
      if (response.status !== 404) throw new Error(`Unable to read Apify INPUT record (${response.status})`);
    }
  }

  if (readFile && env.GEO_USE_EXAMPLE === '1') {
    try {
      return JSON.parse(await readFile(new URL('../examples/input.json', import.meta.url), 'utf8'));
    } catch {
      // The helpful error below is preferable when the example file is absent.
    }
  }
  const reason = !token
    ? 'Apify API token is missing'
    : !storeIds.length
      ? 'ACTOR_DEFAULT_KEY_VALUE_STORE_ID is missing'
      : `record ${JSON.stringify(inputKey)} was not found in the configured input stores`;
  throw new Error(`No input found (${reason}). Open the Actor Input tab and provide brand and queries, or set GEO_INPUT_JSON/GEO_INPUT_FILE.`);
}
