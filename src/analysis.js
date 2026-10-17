const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const AI_FIELD_NAMES = new Set([
  'aioverview',
  'aimodesearch',
  'perplexitysearch',
  'chatgptsearch',
  'copilotsearch',
  'geminisearch',
  'airesponsetext',
  'airesponse',
  'answer',
  'response',
]);
const AI_TEXT_KEYS = new Set(['text', 'answer', 'response', 'content', 'markdown', 'summary', 'snippet', 'result']);

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function cleanUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(URL_PATTERN);
  if (!match) return null;
  try {
    const url = new URL(match[0].replace(/[),.;]+$/, ''));
    return url.href;
  } catch {
    return null;
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function valuesToText(value, depth = 0) {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => valuesToText(item, depth + 1)).join(' ');
  if (typeof value === 'object') return Object.entries(value).slice(0, 200).map(([key, item]) => `${key}: ${valuesToText(item, depth + 1)}`).join(' ');
  return '';
}

function collectUrls(value, output = new Set(), depth = 0) {
  if (depth > 8 || value == null) return output;
  if (typeof value === 'string') {
    for (const match of value.matchAll(URL_PATTERN)) {
      const url = cleanUrl(match[0]);
      if (url) output.add(url);
    }
  } else if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item) => collectUrls(item, output, depth + 1));
  } else if (typeof value === 'object') {
    Object.values(value).slice(0, 200).forEach((item) => collectUrls(item, output, depth + 1));
  }
  return output;
}

function collectNamedText(value, output = [], depth = 0) {
  if (depth > 8 || value == null) return output;
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item) => collectNamedText(item, output, depth + 1));
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      if (AI_FIELD_NAMES.has(key.toLowerCase())) output.push(extractAiText(item));
      collectNamedText(item, output, depth + 1);
    }
  }
  return output;
}

function extractAiText(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => extractAiText(item, depth + 1)).join(' ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([key]) => AI_TEXT_KEYS.has(key.toLowerCase()))
      .map(([, item]) => extractAiText(item, depth + 1))
      .join(' ');
  }
  return '';
}

function collectPositions(value, terms, output = [], depth = 0) {
  if (depth > 8 || value == null) return output;
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item) => collectPositions(item, terms, output, depth + 1));
    return output;
  }
  if (typeof value !== 'object') return output;

  const text = valuesToText(value, 1).toLowerCase();
  if (terms.some((term) => text.includes(term))) {
    for (const key of ['position', 'rank', 'index', 'order']) {
      const number = Number(value[key]);
      if (Number.isFinite(number) && number > 0) output.push(number);
    }
  }
  Object.values(value).slice(0, 200).forEach((item) => collectPositions(item, terms, output, depth + 1));
  return output;
}

function asTerms(entity) {
  return [entity.name, ...(entity.aliases ?? []), ...(entity.domains ?? [])]
    .map((term) => term.toLowerCase().trim())
    .filter(Boolean);
}

export function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['items', 'data', 'results', 'organicResults']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [payload];
}

function recommendationFor({ brandMentioned, ownedCitation, competitorMentions, query }) {
  if (!brandMentioned) return `Create authoritative content answering “${query}” and earn citations from sources that already influence this result.`;
  if (!ownedCitation) return `Improve the evidence path for “${query}”: publish a focused source and pursue citations from the observed referring domains.`;
  if (competitorMentions.length) return `Compare the claims made by ${competitorMentions.join(', ')} for “${query}” and strengthen the brand's differentiating proof.`;
  return `Maintain the source and update the answer coverage for “${query}” as the result changes.`;
}

export function analyzeSnapshot({ query, market, engine, brand, competitors, records, includeRawSource = false }) {
  const brandTerms = asTerms(brand);
  const competitorTerms = competitors.map((competitor) => ({ entity: competitor, terms: asTerms(competitor) }));
  const text = valuesToText(records).slice(0, 500_000).toLowerCase();
  const aiText = collectNamedText(records).join(' ').slice(0, 250_000).toLowerCase();
  const urls = [...collectUrls(records)];
  const domains = new Set(urls.map(domainOf).filter(Boolean));
  const brandMentioned = brandTerms.some((term) => text.includes(term));
  const brandMentionedInAiResponse = aiText ? brandTerms.some((term) => aiText.includes(term)) : null;
  const competitorMentions = competitorTerms.filter(({ terms }) => terms.some((term) => text.includes(term))).map(({ entity }) => entity.name);
  const competitorsInAiResponse = aiText
    ? competitorTerms.filter(({ terms }) => terms.some((term) => aiText.includes(term))).map(({ entity }) => entity.name)
    : [];
  const ownedCitation = urls.some((url) => {
    const domain = domainOf(url);
    return domain && (brand.domains ?? []).some((owned) => domain === owned || domain.endsWith(`.${owned}`));
  });
  const positions = collectPositions(records, brandTerms);
  const bestPosition = positions.length ? Math.min(...positions) : null;
  const rankBonus = bestPosition == null ? 0 : bestPosition <= 3 ? 15 : bestPosition <= 10 ? 8 : 3;
  const visibilityScore = clamp((brandMentioned ? 60 : 0) + (ownedCitation ? 25 : 0) + rankBonus);
  const evidenceConfidence = clamp((brandMentioned ? 40 : 0) + (urls.length ? 30 : 0) + (bestPosition != null ? 30 : 0));
  const citationList = urls.map((url) => ({ url, domain: domainOf(url), ownedByBrand: (brand.domains ?? []).some((owned) => domainOf(url) === owned || domainOf(url)?.endsWith(`.${owned}`)) }));
  const recommendation = recommendationFor({ brandMentioned, ownedCitation, competitorMentions, query });

  const result = {
    type: 'visibility_snapshot',
    capturedAt: new Date().toISOString(),
    query,
    market,
    engine,
    brand: brand.name,
    brandMentioned,
    brandMentionedInAiResponse,
    ownedCitation,
    bestPosition,
    visibilityScore,
    evidenceConfidence,
    competitorMentions,
    competitorsInAiResponse,
    competitorCount: competitorMentions.length,
    citationCount: urls.length,
    citedDomains: [...domains],
    citations: citationList,
    recommendation,
    sourceRecordCount: records.length,
  };
  if (includeRawSource) result.rawSource = records;
  return result;
}
