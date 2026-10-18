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

const source = (url, ownedByBrand = false) => ({ url, domain: new URL(url).hostname, ownedByBrand });
const review = source('https://review.example.org/old');
const attached = source('https://tools.example.org/tool');
const mode = {
  channel: 'ai_mode', sourceField: 'aiModeResult', responsePresent: true, brandMentioned: true,
  competitorMentions: [], ownedCitation: false, citationCount: 1, citations: [review],
  ownedAttachedSource: false, attachedSourceCount: 1, attachedSources: [attached],
};
const observed = {
  ...base, analysisVersion: 2, competitorCount: 0, competitorMentions: [], competitorsInAiResponse: [],
  citedDomains: ['review.example.org'], citations: [review], citationCount: 1,
  aiResponseCount: 1, aiCitationCount: 1, aiCitations: [review], aiOwnedCitation: false,
  aiAttachedSourceCount: 1, aiAttachedSources: [attached], aiResponses: [mode],
};

function changes(previous, current) {
  return buildReport({ snapshots: [current], previousSnapshots: previous ? [previous] : [],
    brand: { name: 'Example' }, competitors: [] }).changes[0];
}

test('tracks response and source count deltas even when the visibility score stays unchanged', () => {
  const overview = { ...mode, channel: 'ai_overview', sourceField: 'aiOverview', attachedSources: [], attachedSourceCount: 0 };
  const current = { ...observed, aiResponseCount: 2, citationCount: 2, aiCitationCount: 2, aiAttachedSourceCount: 2,
    aiResponses: [mode, overview] };
  const change = changes(observed, current);
  assert.equal(change.scoreDelta, 0);
  assert.equal(change.previousAiResponseCount, 1);
  assert.equal(change.currentAiResponseCount, 2);
  for (const field of ['aiResponseCount', 'citationCount', 'aiCitationCount', 'aiAttachedSourceCount']) {
    assert.equal(change[`${field}Delta`], 1);
    assert.ok(change.changedFields.includes(field));
  }
  assert.equal(change.changed, true);
  const added = change.aiChannelChanges.find((channel) => channel.channel === 'ai_overview');
  assert.equal(added.previousPresent, false);
  assert.equal(added.currentPresent, true);
  assert.equal(added.responseCountDelta, 1);
  assert.equal(added.brandMentionChange, null);
});

test('detects exact citation URL replacement within the same domain and count', () => {
  const replacement = source('https://review.example.org/new');
  const current = { ...observed, citations: [replacement], aiCitations: [replacement], aiResponses: [{ ...mode, citations: [replacement] }] };
  const change = changes(observed, current);
  assert.equal(change.citationCountDelta, 0);
  assert.equal(change.aiCitationCountDelta, 0);
  assert.deepEqual(change.citationDomainsGained, []);
  assert.deepEqual(change.citationDomainsLost, []);
  assert.deepEqual(change.citationUrlsGained, [replacement.url]);
  assert.deepEqual(change.citationUrlsLost, [review.url]);
  assert.deepEqual(change.aiCitationUrlsGained, [replacement.url]);
  assert.deepEqual(change.aiCitationUrlsLost, [review.url]);
  assert.equal(change.changed, true);
});

test('compares attached sources and derives owned-source transitions from existing version 2 history', () => {
  const ownSite = source('https://example.com/', true);
  const current = { ...observed, aiOwnedAttachedSource: true, aiAttachedSources: [ownSite],
    aiResponses: [{ ...mode, attachedSources: [ownSite], ownedAttachedSource: true }] };
  const change = changes(observed, current);
  assert.equal(change.previousAiOwnedAttachedSource, false);
  assert.equal(change.currentAiOwnedAttachedSource, true);
  assert.equal(change.aiOwnedAttachedSourceChange, 'gained');
  assert.equal(change.aiAttachedSourceCountDelta, 0);
  assert.deepEqual(change.aiAttachedSourceUrlsGained, [ownSite.url]);
  assert.deepEqual(change.aiAttachedSourceUrlsLost, [attached.url]);
  assert.equal(change.aiOwnedCitationChange, 'unchanged');
  assert.equal(current.aiOwnedCitation, false);
  assert.equal(change.aiChannelChanges[0].ownedAttachedSourceChange, 'gained');
  assert.equal(change.changed, true);
  const lost = changes(current, observed);
  assert.equal(lost.aiOwnedAttachedSourceChange, 'lost');
  assert.equal(lost.changed, true);
});

test('attached URL replacements are detected when counts and owned flags are unchanged', () => {
  const replacement = source('https://tools.example.org/another-tool');
  const current = { ...observed, aiAttachedSources: [replacement], aiResponses: [{ ...mode, attachedSources: [replacement] }] };
  const change = changes(observed, current);
  assert.equal(change.aiAttachedSourceCountDelta, 0);
  assert.equal(change.aiOwnedAttachedSourceChange, 'unchanged');
  assert.deepEqual(change.aiAttachedSourceUrlsGained, [replacement.url]);
  assert.deepEqual(change.aiAttachedSourceUrlsLost, [attached.url]);
  assert.equal(change.changed, true);
});

test('channel-specific citation changes remain visible when combined URL sets stay the same', () => {
  const secondReview = source('https://review.example.org/second');
  const overview = { ...mode, channel: 'ai_overview', sourceField: 'aiOverview', citations: [secondReview] };
  const previous = { ...observed, aiResponseCount: 2, aiCitationCount: 2, citationCount: 2,
    citations: [review, secondReview], aiCitations: [review, secondReview], aiResponses: [mode, overview] };
  const current = { ...previous, aiResponses: [{ ...mode, citations: [secondReview] }, { ...overview, citations: [review] }] };
  const change = changes(previous, current);
  assert.equal(change.aiResponseCountDelta, 0);
  assert.deepEqual(change.aiCitationUrlsGained, []);
  assert.deepEqual(change.aiCitationUrlsLost, []);
  assert.equal(change.aiChannelChanges.length, 2);
  assert.ok(change.aiChannelChanges.every((channel) => channel.changed));
  assert.deepEqual(change.changedFields, ['aiChannels']);
  assert.equal(change.changed, true);
});

test('formal citations moving to attached sources remain distinct changes', () => {
  const previous = { ...observed, aiCitationCount: 2, aiCitations: [review, attached], citationCount: 2, citations: [review, attached],
    aiAttachedSourceCount: 0, aiAttachedSources: [], aiResponses: [{ ...mode, citations: [review, attached], attachedSources: [] }] };
  const change = changes(previous, observed);
  assert.deepEqual(change.aiCitationUrlsLost, [attached.url]);
  assert.deepEqual(change.aiAttachedSourceUrlsGained, [attached.url]);
  assert.equal(change.aiCitationCountDelta, -1);
  assert.equal(change.aiAttachedSourceCountDelta, 1);
  assert.equal(change.changed, true);
});

test('channel removal records missing availability without inventing a brand mention loss', () => {
  const current = { ...observed, aiResponses: [], aiResponseCount: 0, aiCitations: [], aiCitationCount: 0,
    aiAttachedSources: [], aiAttachedSourceCount: 0, aiOwnedCitation: null, aiOwnedAttachedSource: null,
    brandMentionedInAiResponse: null };
  const change = changes(observed, current);
  assert.equal(change.aiMentionChange, null);
  assert.equal(change.aiOwnedCitationChange, null);
  assert.equal(change.aiOwnedAttachedSourceChange, null);
  assert.equal(change.aiChannelChanges[0].previousPresent, true);
  assert.equal(change.aiChannelChanges[0].currentPresent, false);
  assert.equal(change.aiChannelChanges[0].brandMentionChange, null);
  assert.equal(change.aiChannelChanges[0].responseCountDelta, -1);
  assert.equal(change.changed, true);
});

test('answer availability can change within an existing channel without fabricating a mention transition', () => {
  const previous = { ...observed, aiResponseCount: 0, brandMentionedInAiResponse: null,
    aiResponses: [{ ...mode, responsePresent: false, brandMentioned: null }] };
  const change = changes(previous, observed);
  assert.equal(change.aiMentionChange, null);
  assert.equal(change.aiResponseCountDelta, 1);
  assert.equal(change.aiChannelChanges[0].brandMentionChange, null);
  assert.equal(change.aiChannelChanges[0].responseCountDelta, 1);
  assert.equal(change.changed, true);
});

test('list order, duplicates, timestamps, and raw data do not create changes', () => {
  const secondReview = source('https://review.example.org/second');
  const overview = { ...mode, channel: 'ai_overview', sourceField: 'aiOverview', citations: [secondReview] };
  const previous = { ...observed, citations: [review, secondReview], aiCitations: [review, secondReview],
    citationCount: 2, aiCitationCount: 2, aiResponseCount: 2, aiResponses: [mode, overview] };
  const current = { ...previous, capturedAt: '2099-01-01T00:00:00Z', rawSource: [{ ignored: true }],
    citations: [secondReview, review, review], aiCitations: [secondReview, review], aiAttachedSources: [attached, attached],
    aiResponses: [overview, { ...mode, citations: [review, review], attachedSources: [attached, attached] }] };
  const change = changes(previous, current);
  assert.equal(change.changed, false);
  assert.deepEqual(change.changedFields, []);
  assert.ok(change.aiChannelChanges.every((channel) => !channel.changed));
});

test('first runs and incompatible analysis versions have no invented count or URL changes', () => {
  for (const previous of [undefined, { ...observed, analysisVersion: 1 }]) {
    const change = changes(previous, observed);
    assert.equal(change.previousAiResponseCount, null);
    assert.equal(change.aiResponseCountDelta, null);
    assert.equal(change.aiCitationCountDelta, null);
    assert.equal(change.aiAttachedSourceCountDelta, null);
    assert.equal(change.previousAiOwnedAttachedSource, null);
    assert.equal(change.aiOwnedAttachedSourceChange, null);
    assert.deepEqual(change.citationUrlsGained, []);
    assert.deepEqual(change.aiAttachedSourceUrlsGained, []);
    assert.deepEqual(change.aiChannelChanges, []);
    assert.equal(change.changed, false);
  }
});

test('absent fields in older history remain unknown rather than empty or zero', () => {
  const { aiResponseCount, aiCitationCount, aiAttachedSourceCount, aiCitations, aiAttachedSources, aiResponses, ...previous } = observed;
  const change = changes(previous, observed);
  assert.equal(change.previousAiResponseCount, null);
  assert.equal(change.aiResponseCountDelta, null);
  assert.equal(change.aiCitationCountDelta, null);
  assert.equal(change.aiAttachedSourceCountDelta, null);
  assert.equal(change.aiOwnedAttachedSourceChange, null);
  assert.deepEqual(change.aiCitationUrlsGained, []);
  assert.deepEqual(change.aiAttachedSourceUrlsGained, []);
  assert.equal(change.changed, false);
});
