function keyOf(item) {
  if (item.comparisonKey) return item.comparisonKey;
  const engine = typeof item.engine === 'string' ? item.engine : item.engine?.name;
  return `${engine ?? 'unknown'}|${item.market.countryCode}|${item.market.languageCode}|${item.query}${item.market.location ? `|${item.market.location}` : ''}`;
}

function difference(current = [], previous = []) { return [...new Set(current)].filter((item) => !previous.includes(item)).sort(); }
function transition(previous, current) {
  return typeof previous === 'boolean' && typeof current === 'boolean' ? (previous === current ? 'unchanged' : current ? 'gained' : 'lost') : null;
}

function count(value) { return Number.isInteger(value) && value >= 0 ? value : null; }

function compareCount(previous, current, field) {
  const title = field[0].toUpperCase() + field.slice(1);
  const before = count(previous?.[field]);
  const after = count(current?.[field]);
  return {
    [`previous${title}`]: before,
    [`current${title}`]: after,
    [`${field}Delta`]: before != null && after != null ? after - before : null,
  };
}

function sourceUrls(sources) {
  return Array.isArray(sources) ? sources.map((source) => source?.url).filter((url) => typeof url === 'string' && url) : null;
}

function compareUrls(previous, current) {
  // An absent field in older history is unknown, not an observed empty list.
  const before = sourceUrls(previous);
  const after = sourceUrls(current);
  return {
    gained: before && after ? difference(after, before) : [],
    lost: before && after ? difference(before, after) : [],
  };
}

function ownedAttachedSource(snapshot) {
  if (typeof snapshot?.aiOwnedAttachedSource === 'boolean') return snapshot.aiOwnedAttachedSource;
  // Version 2 history already contains the evidence needed to derive the new field.
  if (!snapshot?.aiResponses?.length || !Array.isArray(snapshot.aiAttachedSources)) return null;
  return snapshot.aiAttachedSources.some((source) => source.ownedByBrand);
}

function channelSummaries(snapshot) {
  if (!Array.isArray(snapshot?.aiResponses)) return null;
  const groups = new Map();
  for (const response of snapshot.aiResponses) {
    if (typeof response.channel !== 'string') continue;
    if (!groups.has(response.channel)) groups.set(response.channel, []);
    groups.get(response.channel).push(response);
  }
  return new Map([...groups].map(([channel, responses]) => {
    const combineSources = (field) => responses.every((response) => Array.isArray(response[field]))
      ? responses.flatMap((response) => response[field]) : null;
    const citations = combineSources('citations');
    const attachedSources = combineSources('attachedSources');
    const observedResponses = responses.filter((response) => response.responsePresent);
    return [channel, {
      present: true,
      responseCount: responses.every((response) => typeof response.responsePresent === 'boolean') ? observedResponses.length : null,
      citationCount: citations ? new Set(sourceUrls(citations)).size : null,
      attachedSourceCount: attachedSources ? new Set(sourceUrls(attachedSources)).size : null,
      brandMentioned: observedResponses.length && observedResponses.every((response) => typeof response.brandMentioned === 'boolean')
        ? observedResponses.some((response) => response.brandMentioned) : null,
      ownedCitation: citations ? citations.some((source) => source.ownedByBrand) : null,
      ownedAttachedSource: attachedSources ? attachedSources.some((source) => source.ownedByBrand) : null,
      competitorMentions: [...new Set(responses.flatMap((response) => response.competitorMentions ?? []))],
      citations,
      attachedSources,
    }];
  }));
}

function compareChannels(previous, current) {
  const before = channelSummaries(previous);
  const after = channelSummaries(current);
  if (!before || !after) return [];
  // A missing channel in an observed aiResponses array is an observed absence.
  const absent = { present: false, responseCount: 0, citationCount: 0, attachedSourceCount: 0,
    brandMentioned: null, ownedCitation: null, ownedAttachedSource: null, competitorMentions: [], citations: [], attachedSources: [] };
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((channel) => {
    const oldChannel = before.get(channel) ?? absent;
    const newChannel = after.get(channel) ?? absent;
    const citations = compareUrls(oldChannel.citations, newChannel.citations);
    const attached = compareUrls(oldChannel.attachedSources, newChannel.attachedSources);
    const brandMentionChange = transition(oldChannel.brandMentioned, newChannel.brandMentioned);
    const ownedCitationChange = transition(oldChannel.ownedCitation, newChannel.ownedCitation);
    const ownedAttachedSourceChange = transition(oldChannel.ownedAttachedSource, newChannel.ownedAttachedSource);
    // Without an answer, competitor mentions are unknown rather than lost.
    const comparableMentions = oldChannel.brandMentioned != null && newChannel.brandMentioned != null;
    const competitorsGained = comparableMentions ? difference(newChannel.competitorMentions, oldChannel.competitorMentions) : [];
    const competitorsLost = comparableMentions ? difference(oldChannel.competitorMentions, newChannel.competitorMentions) : [];
    const changedFields = [];
    if (oldChannel.present !== newChannel.present) changedFields.push('presence');
    for (const field of ['responseCount', 'citationCount', 'attachedSourceCount']) {
      const delta = compareCount(oldChannel, newChannel, field)[`${field}Delta`];
      if (delta != null && delta !== 0) changedFields.push(field);
    }
    if (citations.gained.length || citations.lost.length) changedFields.push('citationUrls');
    if (attached.gained.length || attached.lost.length) changedFields.push('attachedSourceUrls');
    if (['gained', 'lost'].includes(brandMentionChange)) changedFields.push('brandMentioned');
    if (['gained', 'lost'].includes(ownedCitationChange)) changedFields.push('ownedCitation');
    if (['gained', 'lost'].includes(ownedAttachedSourceChange)) changedFields.push('ownedAttachedSource');
    if (competitorsGained.length || competitorsLost.length) changedFields.push('competitorMentions');
    return {
      channel,
      previousPresent: oldChannel.present,
      currentPresent: newChannel.present,
      ...compareCount(oldChannel, newChannel, 'responseCount'),
      ...compareCount(oldChannel, newChannel, 'citationCount'),
      ...compareCount(oldChannel, newChannel, 'attachedSourceCount'),
      brandMentionChange,
      ownedCitationChange,
      previousOwnedAttachedSource: oldChannel.ownedAttachedSource,
      currentOwnedAttachedSource: newChannel.ownedAttachedSource,
      ownedAttachedSourceChange,
      citationUrlsGained: citations.gained,
      citationUrlsLost: citations.lost,
      attachedSourceUrlsGained: attached.gained,
      attachedSourceUrlsLost: attached.lost,
      competitorsGained,
      competitorsLost,
      changedFields,
      changed: changedFields.length > 0,
    };
  });
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

export function buildReport({ snapshots, errors = [], previousSnapshots = [], brand, competitors, execution = {} }) {
  const previousByKey = new Map(previousSnapshots.map((item) => [keyOf(item), item]));
  const changes = snapshots.map((current) => {
    const candidate = previousByKey.get(keyOf(current));
    const previous = candidate?.analysisVersion === current.analysisVersion ? candidate : undefined;
    const domainsGained = previous ? difference(current.citedDomains, previous.citedDomains) : [];
    const domainsLost = previous ? difference(previous.citedDomains, current.citedDomains) : [];
    const competitorsGained = previous ? difference(current.competitorMentions, previous.competitorMentions) : [];
    const competitorsLost = previous ? difference(previous.competitorMentions, current.competitorMentions) : [];
    const aiMentionChange = previous ? transition(previous.brandMentionedInAiResponse, current.brandMentionedInAiResponse) : null;
    const aiOwnedCitationChange = previous ? transition(previous.aiOwnedCitation, current.aiOwnedCitation) : null;
    const previousAiOwnedAttachedSource = ownedAttachedSource(previous);
    const currentAiOwnedAttachedSource = ownedAttachedSource(current);
    const aiOwnedAttachedSourceChange = transition(previousAiOwnedAttachedSource, currentAiOwnedAttachedSource);
    const countFields = ['aiResponseCount', 'citationCount', 'aiCitationCount', 'aiAttachedSourceCount'];
    const counts = Object.assign({}, ...countFields.map((field) => compareCount(previous, current, field)));
    const citations = compareUrls(previous?.citations, current.citations);
    const aiCitations = compareUrls(previous?.aiCitations, current.aiCitations);
    const attached = compareUrls(previous?.aiAttachedSources, current.aiAttachedSources);
    const aiChannelChanges = compareChannels(previous, current);
    const changedFields = [];
    if (previous) {
      if (previous.visibilityScore !== current.visibilityScore) changedFields.push('visibilityScore');
      if (previous.brandMentioned !== current.brandMentioned) changedFields.push('brandMentioned');
      if (['gained', 'lost'].includes(aiMentionChange)) changedFields.push('brandMentionedInAiResponse');
      if (['gained', 'lost'].includes(aiOwnedCitationChange)) changedFields.push('aiOwnedCitation');
      if (['gained', 'lost'].includes(aiOwnedAttachedSourceChange)) changedFields.push('aiOwnedAttachedSource');
      if (domainsGained.length || domainsLost.length) changedFields.push('citedDomains');
      if (competitorsGained.length || competitorsLost.length) changedFields.push('competitorMentions');
      for (const field of countFields) {
        if (counts[`${field}Delta`] != null && counts[`${field}Delta`] !== 0) changedFields.push(field);
      }
      if (citations.gained.length || citations.lost.length) changedFields.push('citationUrls');
      if (aiCitations.gained.length || aiCitations.lost.length) changedFields.push('aiCitationUrls');
      if (attached.gained.length || attached.lost.length) changedFields.push('aiAttachedSourceUrls');
      if (aiChannelChanges.some((channel) => channel.changed)) changedFields.push('aiChannels');
    }
    return {
      key: keyOf(current),
      query: current.query,
      market: current.market,
      engine: current.engine,
      baselineRunId: previous?.baselineRunId ?? null,
      baselineCapturedAt: previous?.baselineCapturedAt ?? null,
      previousVisibilityScore: previous?.visibilityScore ?? null,
      currentVisibilityScore: current.visibilityScore,
      scoreDelta: previous ? current.visibilityScore - previous.visibilityScore : null,
      previousBrandMentioned: previous?.brandMentioned ?? null,
      currentBrandMentioned: current.brandMentioned,
      brandMentionChange: previous ? transition(previous.brandMentioned, current.brandMentioned) : null,
      aiMentionChange,
      aiOwnedCitationChange,
      ...counts,
      previousAiOwnedAttachedSource,
      currentAiOwnedAttachedSource,
      aiOwnedAttachedSourceChange,
      citationUrlsGained: citations.gained,
      citationUrlsLost: citations.lost,
      aiCitationUrlsGained: aiCitations.gained,
      aiCitationUrlsLost: aiCitations.lost,
      aiAttachedSourceUrlsGained: attached.gained,
      aiAttachedSourceUrlsLost: attached.lost,
      citationDomainsGained: domainsGained,
      citationDomainsLost: domainsLost,
      competitorsGained,
      competitorsLost,
      aiChannelChanges,
      changedFields,
      changed: changedFields.length > 0,
    };
  });
  const allCitations = snapshots.flatMap((snapshot) => snapshot.citations ?? []);
  const sourceCounts = new Map();
  for (const citation of allCitations) sourceCounts.set(citation.domain, (sourceCounts.get(citation.domain) ?? 0) + 1);
  const topCitationDomains = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([domain, count]) => ({ domain, count }));
  const mentionRate = snapshots.length ? Math.round((snapshots.filter((item) => item.brandMentioned).length / snapshots.length) * 100) : 0;
  const citationRate = snapshots.length ? Math.round((snapshots.filter((item) => item.ownedCitation).length / snapshots.length) * 100) : 0;
  const recommendations = [...new Set(snapshots.map((item) => item.recommendation).filter(Boolean))].slice(0, 30);
  const aiSnapshots = snapshots.filter((item) => typeof item.brandMentionedInAiResponse === 'boolean');
  const aiCitationSnapshots = snapshots.filter((item) => typeof item.aiOwnedCitation === 'boolean');

  return {
    type: 'report_summary',
    analysisVersion: 2,
    changeDetectionVersion: 2,
    capturedAt: new Date().toISOString(),
    status: errors.length && !snapshots.length ? 'failed' : errors.length || execution.stopReason ? 'partial' : 'succeeded',
    ...execution,
    brand: brand.name,
    competitors: competitors.map((competitor) => competitor.name),
    snapshotCount: snapshots.length,
    errorCount: errors.length,
    visibilityScore: average(snapshots.map((item) => item.visibilityScore)),
    brandMentionRate: mentionRate,
    aiBrandMentionRate: aiSnapshots.length
      ? Math.round((aiSnapshots.filter((item) => item.brandMentionedInAiResponse).length / aiSnapshots.length) * 100)
      : null,
    aiOwnedCitationRate: aiCitationSnapshots.length
      ? Math.round((aiCitationSnapshots.filter((item) => item.aiOwnedCitation).length / aiCitationSnapshots.length) * 100)
      : null,
    ownedCitationRate: citationRate,
    competitorMentionRate: snapshots.length ? Math.round((snapshots.filter((item) => item.competitorCount > 0).length / snapshots.length) * 100) : 0,
    topCitationDomains,
    changes,
    recommendations,
    errors,
  };
}
