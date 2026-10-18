import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeSnapshot, extractRecords } from '../src/analysis.js';
import { normalizeInput } from '../src/input.js';

const brand = { name: 'Example brand', aliases: ['Example'], domains: ['example.com'] };
const competitors = [{ name: 'Competitor One', aliases: [], domains: ['competitor.example'] }];

test('normalizes and bounds user input', () => {
  const config = normalizeInput({ brand: 'Example brand', queries: ['  a query  '], maxQueries: 999, maxResultsPerQuery: 999 });
  assert.equal(config.brand.name, 'Example brand');
  assert.deepEqual(config.queries, ['a query']);
  assert.equal(config.maxQueries, 100);
  assert.equal(config.maxResultsPerQuery, 100);
});

test('rejects an empty query set', () => {
  assert.throws(() => normalizeInput({ brand: 'Example brand', queries: [] }), /at least one query/);
});

test('rejects non-numeric run limits', () => {
  assert.throws(() => normalizeInput({ brand: 'Example brand', queries: ['query'], maxQueries: 'many' }), /maxQueries must be a number/);
});

test('extracts records from common Actor response shapes', () => {
  assert.equal(extractRecords({ items: [{ id: 1 }] }).length, 1);
  assert.equal(extractRecords([{ id: 1 }]).length, 1);
  assert.equal(extractRecords({ answer: 'text' }).length, 1);
});

test('calculates visibility, competitor mentions, ranking, and citations', () => {
  const result = analyzeSnapshot({
    query: 'best project management software',
    market: { countryCode: 'US', languageCode: 'en' },
    engine: 'google',
    brand,
    competitors,
    records: [{
      organicResults: [{ position: 2, title: 'Example brand review', url: 'https://example.com/product', snippet: 'Example is useful.' }],
      aiOverview: { text: 'Example brand and Competitor One are listed.', citations: ['https://review.example.org/guide'] },
    }],
  });
  assert.equal(result.brandMentioned, true);
  assert.equal(result.brandMentionedInAiResponse, true);
  assert.deepEqual(result.competitorsInAiResponse, ['Competitor One']);
  assert.equal(result.ownedCitation, true);
  assert.equal(result.bestPosition, 2);
  assert.deepEqual(result.competitorMentions, ['Competitor One']);
  assert.equal(result.citationCount, 2);
  assert.ok(result.visibilityScore >= 85);
});

const notionInput = {
  query: 'best tools for team documentation and knowledge management',
  market: { countryCode: 'US', languageCode: 'en' },
  engine: 'google',
  brand: { name: 'Notion', aliases: [], domains: ['notion.com', 'notion.so'] },
  competitors: [{ name: 'ClickUp', aliases: [], domains: ['clickup.com'] }],
};

test('parses the observed AI Mode shape separately from AI Overview and attached links', async () => {
  // Reduced and sanitized from a successful source Actor response; no signed snapshot URLs.
  const records = JSON.parse(await readFile(new URL('./fixtures/google-ai-mode.json', import.meta.url), 'utf8'));
  const result = analyzeSnapshot({ ...notionInput, records: extractRecords(records[0]) });
  assert.equal(result.sourceRecordCount, 1);
  assert.equal(result.analysisVersion, 2);
  assert.equal(result.aiResponseCount, 2);
  assert.equal(result.brandMentionedInAiResponse, true);
  assert.deepEqual(result.competitorsInAiResponse, ['ClickUp']);
  const overview = result.aiResponses.find((item) => item.channel === 'ai_overview');
  const mode = result.aiResponses.find((item) => item.channel === 'ai_mode');
  assert.equal(overview.brandMentioned, true);
  assert.deepEqual(overview.competitorMentions, []);
  assert.equal(overview.citationCount, 3);
  assert.equal(mode.sourceField, 'aiModeResult');
  assert.equal(mode.brandMentioned, true);
  assert.deepEqual(mode.competitorMentions, ['ClickUp']);
  assert.equal(mode.citationCount, 1);
  assert.equal(mode.attachedSourceCount, 9);
  assert.equal(mode.ownedCitation, false);
  assert.equal(mode.ownedAttachedSource, true);
  assert.equal(result.aiCitationCount, 4);
  assert.equal(result.aiAttachedSourceCount, 9);
  assert.equal(result.aiOwnedCitation, false);
  assert.equal(result.ownedCitation, false);
  assert.equal(result.citationCount, 6);
  assert.equal(result.bestPosition, 5);
  assert.equal(result.visibilityScore, 68);
  assert.ok(!result.citedDomains.includes('google.com'));
  assert.ok(!result.citedDomains.includes('api.apify.com'));
  assert.ok(!result.citedDomains.includes('notion.so'));
});

test('detects AI Mode when no AI Overview is present', () => {
  const result = analyzeSnapshot({ ...notionInput, records: [{
    aiModeResult: {
      text: 'Notion and ClickUp are options for team wikis.',
      sources: [{ url: 'https://review.example.org/comparison', section: 'citations' }],
    },
  }] });
  assert.equal(result.aiResponseCount, 1);
  assert.equal(result.brandMentionedInAiResponse, true);
  assert.deepEqual(result.competitorsInAiResponse, ['ClickUp']);
  assert.equal(result.aiCitationCount, 1);
  assert.equal(result.bestPosition, null);
});

test('ignores brand names and URLs in queries, related searches, and source metadata', () => {
  const result = analyzeSnapshot({ ...notionInput, records: [{
    searchQuery: { term: 'Notion vs ClickUp', url: 'https://google.com/search?q=Notion+ClickUp' },
    url: 'https://google.com/search?q=Notion+ClickUp',
    relatedQueries: [{ title: 'Notion vs ClickUp', url: 'https://google.com/search?q=Notion+ClickUp' }],
    htmlSnapshotUrl: 'https://api.apify.com/v2/key-value-stores/Notion/records/ClickUp.html',
    customData: { response: 'Notion and ClickUp' },
    peopleAlsoAsk: [{ question: 'What is Notion?', answer: null }],
    organicResults: [],
    aiModeResult: { text: 'Confluence is an option.', query: 'Notion and ClickUp', sources: [{
      title: 'Notion and ClickUp comparison', url: 'https://review.example.org/comparison', section: 'citations',
    }] },
  }] });
  assert.equal(result.brandMentioned, false);
  assert.equal(result.brandMentionedInAiResponse, false);
  assert.deepEqual(result.competitorMentions, []);
  assert.deepEqual(result.competitorsInAiResponse, []);
  assert.equal(result.citationCount, 1);
  assert.deepEqual(result.citedDomains, ['review.example.org']);
});

test('ordinary search answer snippets do not count as AI responses', () => {
  const result = analyzeSnapshot({ ...notionInput, records: [{
    organicResults: [],
    peopleAlsoAsk: [{ question: 'What is a wiki?', answer: 'Notion is an example of a team wiki.', url: 'https://review.example.org/wiki' }],
  }] });
  assert.equal(result.brandMentioned, true);
  assert.equal(result.brandMentionedInAiResponse, null);
  assert.equal(result.aiResponseCount, 0);
  assert.equal(result.aiOwnedCitation, null);
});

test('citations without answer text do not become brand mentions', () => {
  const result = analyzeSnapshot({ ...notionInput, records: [{
    aiOverview: { sources: [{ title: 'Notion', url: 'https://www.notion.so/' }] },
  }] });
  assert.equal(result.brandMentioned, false);
  assert.equal(result.brandMentionedInAiResponse, null);
  assert.equal(result.aiResponseCount, 0);
  assert.equal(result.aiOwnedCitation, true);
  assert.equal(result.ownedCitation, true);
});

test('matches complete terms and keeps a generic answer source usable', () => {
  const result = analyzeSnapshot({ ...notionInput, records: [{
    answer: 'A notional example for ClickUpper is not a recommendation.',
  }] });
  assert.equal(result.brandMentionedInAiResponse, false);
  assert.deepEqual(result.competitorsInAiResponse, []);
});

test('handles joined headings in rendered AI text without matching longer words', () => {
  const result = analyzeSnapshot({ ...notionInput, records: [{
    aiOverview: { content: 'Top tools1. NotionBest for: Team wikis.2. ClickUpBest for: Tasks.' },
  }] });
  assert.equal(result.brandMentionedInAiResponse, true);
  assert.deepEqual(result.competitorsInAiResponse, ['ClickUp']);
});

test('supports brand mentions in languages that do not put spaces between words', () => {
  const result = analyzeSnapshot({ ...notionInput,
    brand: { name: '飞书', domains: [] },
    competitors: [{ name: 'Notion', domains: [] }],
    records: [{ aiModeResult: { text: '团队可以使用飞书管理文档，也可以使用Notion搭建知识库。' } }],
  });
  assert.equal(result.brandMentionedInAiResponse, true);
  assert.deepEqual(result.competitorsInAiResponse, ['Notion']);
});
