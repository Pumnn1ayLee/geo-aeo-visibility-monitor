import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/report.js';

const base = {
  type: 'visibility_snapshot',
  query: 'best tool',
  market: { countryCode: 'US', languageCode: 'en' },
  engine: 'google',
  brandMentioned: true,
  ownedCitation: false,
  visibilityScore: 60,
  competitorCount: 1,
  brandMentionedInAiResponse: true,
  citations: [{ domain: 'review.example.org' }],
  recommendation: 'Improve evidence',
};

test('builds aggregate report and historical score deltas', () => {
  const current = { ...base, visibilityScore: 85, ownedCitation: true };
  const report = buildReport({ snapshots: [current], previousSnapshots: [base], errors: [], brand: { name: 'Example' }, competitors: [{ name: 'Competitor' }] });
  assert.equal(report.status, 'succeeded');
  assert.equal(report.visibilityScore, 85);
  assert.equal(report.ownedCitationRate, 100);
  assert.equal(report.changes[0].scoreDelta, 25);
  assert.equal(report.changes[0].changed, true);
  assert.match(report.changes[0].key, /^google\|US\|en\|best tool$/);
});

test('keeps AI brand mention and owned-citation rates separate', () => {
  const report = buildReport({
    snapshots: [
      { ...base, aiOwnedCitation: false },
      { ...base, query: 'another query', brandMentionedInAiResponse: false, aiOwnedCitation: true },
      { ...base, query: 'search only', brandMentionedInAiResponse: null, aiOwnedCitation: null },
    ],
    brand: { name: 'Example' }, competitors: [],
  });
  assert.equal(report.aiBrandMentionRate, 50);
  assert.equal(report.aiOwnedCitationRate, 50);
});

test('does not compare scores produced by different analysis versions', () => {
  const report = buildReport({
    snapshots: [{ ...base, analysisVersion: 2 }],
    previousSnapshots: [{ ...base, visibilityScore: 100 }],
    brand: { name: 'Example' }, competitors: [],
  });
  assert.equal(report.changes[0].previousVisibilityScore, null);
  assert.equal(report.changes[0].scoreDelta, null);
  assert.equal(report.changes[0].changed, false);
});

test('reports AI mention/citation and competitor gains/losses without converting missing AI data to false', () => {
  const previous = { ...base, analysisVersion: 2, brandMentionedInAiResponse: true, aiOwnedCitation: false, competitorMentions: ['Old'], citedDomains: ['old.org'], baselineRunId: 'baseline' };
  const report = buildReport({ snapshots: [{ ...previous, brandMentionedInAiResponse: false, aiOwnedCitation: true, competitorMentions: ['New'], citedDomains: ['new.org'] }], previousSnapshots: [previous], brand: { name: 'Example' }, competitors: [] });
  assert.equal(report.changes[0].aiMentionChange, 'lost');
  assert.equal(report.changes[0].aiOwnedCitationChange, 'gained');
  assert.deepEqual(report.changes[0].competitorsGained, ['New']);
  assert.deepEqual(report.changes[0].competitorsLost, ['Old']);
  assert.equal(report.changes[0].changed, true);
  const missing = buildReport({ snapshots: [{ ...previous, brandMentionedInAiResponse: null, aiOwnedCitation: null }], previousSnapshots: [previous], brand: { name: 'Example' }, competitors: [] });
  assert.equal(missing.changes[0].aiMentionChange, null);
  assert.equal(missing.changes[0].aiOwnedCitationChange, null);
});
