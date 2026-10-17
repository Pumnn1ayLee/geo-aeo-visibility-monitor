import test from 'node:test';
import assert from 'node:assert/strict';
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
