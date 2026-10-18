const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const AI_FIELDS = new Map([
  ['aioverview', 'ai_overview'],
  ['aimoderesult', 'ai_mode'],
  ['aimodesearch', 'ai_mode'],
  ['perplexitysearch', 'perplexity'],
  ['chatgptsearch', 'chatgpt'],
  ['copilotsearch', 'copilot'],
  ['geminisearch', 'gemini'],
  ['airesponsetext', 'generic'],
  ['airesponse', 'generic'],
  ['answer', 'generic'],
  ['response', 'generic'],
]);
const AI_TEXT_KEYS = new Set(['text', 'answer', 'response', 'content', 'markdown', 'summary', 'snippet', 'result']);
const SEARCH_RESULT_FIELDS = ['organicResults', 'paidResults', 'paidProducts', 'suggestedResults'];
const NON_AI_FIELDS = new Set([
  ...SEARCH_RESULT_FIELDS.map((field) => field.toLowerCase()),
  'searchquery', 'relatedqueries', 'peoplealsoask', 'customdata',
  'sources', 'citations', 'references', 'htmlsnapshoturl', 'url',
]);

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

function collectAiBlocks(value, output = [], depth = 0) {
  if (depth > 8 || value == null) return output;
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item) => collectAiBlocks(item, output, depth + 1));
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      const field = key.toLowerCase();
      if (AI_FIELDS.has(field)) {
        if (item != null) output.push({ sourceField: key, channel: AI_FIELDS.get(field), value: item });
      } else if (!NON_AI_FIELDS.has(field)) {
        collectAiBlocks(item, output, depth + 1);
      }
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

function collectSourceLinks(value, citations, attachedSources, attached = false, depth = 0) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    collectUrls(value, attached ? attachedSources : citations);
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item) => collectSourceLinks(item, citations, attachedSources, attached, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const isAttached = attached || String(value.section ?? '').toLowerCase() === 'attached';
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      if (['url', 'href', 'link'].includes(key.toLowerCase())) {
        collectUrls(item, isAttached ? attachedSources : citations);
      } else if (item && typeof item === 'object') {
        collectSourceLinks(item, citations, attachedSources, isAttached, depth + 1);
      }
    }
  }
}

function searchDocuments(records) {
  const output = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    for (const field of SEARCH_RESULT_FIELDS) {
      if (Array.isArray(record[field])) output.push(...record[field].slice(0, 200));
    }
    if (Array.isArray(record.peopleAlsoAsk)) {
      for (const item of record.peopleAlsoAsk.slice(0, 200)) {
        if (typeof item.answer === 'string' && item.answer.trim()) output.push({ answer: item.answer, url: item.url });
      }
    }
    // An unwrapped result is evidence; a SERP envelope's query URL is metadata.
    if (!record.searchQuery && !SEARCH_RESULT_FIELDS.some((field) => field in record)
      && (typeof record.title === 'string' || typeof record.snippet === 'string' || typeof record.description === 'string')) {
      output.push(record);
    }
  }
  return output.filter((item) => item && typeof item === 'object');
}

function documentText(document) {
  return ['title', 'websiteTitle', 'description', 'snippet', 'text', 'content', 'answer', 'url']
    .map((key) => typeof document[key] === 'string' ? document[key] : '')
    .join(' ');
}

function hasMention(text, terms) {
  // Rendered AI snippets can join a brand and a heading, e.g. "NotionBest for".
  const spacedText = text.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
  return terms.some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\p{Script=Latin}\\p{N}_])${escaped}(?![\\p{Script=Latin}\\p{N}_])`, 'iu');
    if (pattern.test(text)) return true;
    const spacedTerm = term.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{Script=Latin}\\p{N}_])${spacedTerm}(?![\\p{Script=Latin}\\p{N}_])`, 'iu').test(spacedText);
  });
}

function citationList(urls, brand) {
  return [...urls].map((url) => {
    const domain = domainOf(url);
    return {
      url,
      domain,
      ownedByBrand: (brand.domains ?? []).some((owned) => domain === owned || domain?.endsWith(`.${owned}`)),
    };
  });
}

function asTerms(entity) {
  return [entity.name, ...(entity.aliases ?? []), ...(entity.domains ?? [])]
    .map((term) => term.trim())
    .filter(Boolean);
}

export function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['items', 'data', 'results']) {
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
  const documents = searchDocuments(records);
  const aiBlocks = collectAiBlocks(records);
  const aiTexts = aiBlocks.map(({ value }) => extractAiText(value).slice(0, 250_000).trim());
  const aiText = aiTexts.join(' ').slice(0, 500_000);
  const text = [...documents.map(documentText), aiText].join(' ').slice(0, 1_000_000);
  const aiResponses = aiBlocks.map(({ sourceField, channel, value }, index) => {
    const responseText = aiTexts[index];
    const responsePresent = Boolean(responseText);
    const citations = new Set();
    const attachedSources = new Set();
    collectUrls(responseText, citations);
    if (value && typeof value === 'object') {
      for (const [key, entries] of Object.entries(value)) {
        if (['sources', 'citations', 'references'].includes(key.toLowerCase())) {
          collectSourceLinks(entries, citations, attachedSources);
        }
      }
    }
    const sources = citationList(citations, brand);
    const attached = citationList(attachedSources, brand);
    return {
      channel,
      sourceField,
      responsePresent,
      brandMentioned: responsePresent ? hasMention(responseText, brandTerms) : null,
      competitorMentions: competitorTerms.filter(({ terms }) => hasMention(responseText, terms)).map(({ entity }) => entity.name),
      ownedCitation: sources.some((item) => item.ownedByBrand),
      citationCount: sources.length,
      citations: sources,
      ownedAttachedSource: attached.some((item) => item.ownedByBrand),
      attachedSourceCount: attached.length,
      attachedSources: attached,
    };
  });
  const aiCitations = citationList(new Set(aiResponses.flatMap((item) => item.citations.map(({ url }) => url))), brand);
  const aiAttachedSources = citationList(new Set(aiResponses.flatMap((item) => item.attachedSources.map(({ url }) => url))), brand);
  const searchUrls = new Set();
  for (const document of documents) collectUrls(document.url, searchUrls);
  const citations = citationList(new Set([...searchUrls, ...aiCitations.map(({ url }) => url)]), brand);
  const domains = new Set(citations.map(({ domain }) => domain).filter(Boolean));
  const brandMentioned = hasMention(text, brandTerms);
  const brandMentionedInAiResponse = aiText.trim() ? hasMention(aiText, brandTerms) : null;
  const competitorMentions = competitorTerms.filter(({ terms }) => hasMention(text, terms)).map(({ entity }) => entity.name);
  const competitorsInAiResponse = [...new Set(aiResponses.flatMap((item) => item.competitorMentions))];
  const ownedCitation = citations.some((item) => item.ownedByBrand);
  const aiOwnedCitation = aiResponses.length ? aiCitations.some((item) => item.ownedByBrand) : null;
  const positions = documents.filter((item) => hasMention(documentText(item), brandTerms))
    .flatMap((item) => ['position', 'rank', 'index', 'order'].map((key) => Number(item[key])))
    .filter((position) => Number.isFinite(position) && position > 0);
  const bestPosition = positions.length ? Math.min(...positions) : null;
  const rankBonus = bestPosition == null ? 0 : bestPosition <= 3 ? 15 : bestPosition <= 10 ? 8 : 3;
  const visibilityScore = clamp((brandMentioned ? 60 : 0) + (ownedCitation ? 25 : 0) + rankBonus);
  const evidenceConfidence = clamp((brandMentioned ? 40 : 0) + (citations.length ? 30 : 0) + (bestPosition != null ? 30 : 0));
  const recommendation = recommendationFor({ brandMentioned, ownedCitation, competitorMentions, query });

  const result = {
    type: 'visibility_snapshot',
    analysisVersion: 2,
    capturedAt: new Date().toISOString(),
    query,
    market,
    engine,
    brand: brand.name,
    brandMentioned,
    brandMentionedInAiResponse,
    aiResponses,
    aiResponseCount: aiResponses.filter((item) => item.responsePresent).length,
    aiOwnedCitation,
    aiCitationCount: aiCitations.length,
    aiCitations,
    aiAttachedSourceCount: aiAttachedSources.length,
    aiAttachedSources,
    ownedCitation,
    bestPosition,
    visibilityScore,
    evidenceConfidence,
    competitorMentions,
    competitorsInAiResponse,
    competitorCount: competitorMentions.length,
    citationCount: citations.length,
    citedDomains: [...domains],
    citations,
    recommendation,
    sourceRecordCount: records.length,
  };
  if (includeRawSource) result.rawSource = records;
  return result;
}
