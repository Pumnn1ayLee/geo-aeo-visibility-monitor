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
