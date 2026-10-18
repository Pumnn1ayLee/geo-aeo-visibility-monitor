function keyOf(item) {
  if (item.comparisonKey) return item.comparisonKey;
  const engine = typeof item.engine === 'string' ? item.engine : item.engine?.name;
  return `${engine ?? 'unknown'}|${item.market.countryCode}|${item.market.languageCode}|${item.query}${item.market.location ? `|${item.market.location}` : ''}`;
}

function difference(current = [], previous = []) { return [...new Set(current)].filter((item) => !previous.includes(item)).sort(); }
function transition(previous, current) {
  return typeof previous === 'boolean' && typeof current === 'boolean' ? (previous === current ? 'unchanged' : current ? 'gained' : 'lost') : null;
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
      citationDomainsGained: domainsGained,
      citationDomainsLost: domainsLost,
      competitorsGained,
      competitorsLost,
      changed: Boolean(previous && (previous.visibilityScore !== current.visibilityScore || previous.brandMentioned !== current.brandMentioned
        || ['gained', 'lost'].includes(aiMentionChange) || ['gained', 'lost'].includes(aiOwnedCitationChange)
        || domainsGained.length || domainsLost.length || competitorsGained.length || competitorsLost.length)),
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
