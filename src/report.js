function keyOf(item) {
  const engine = typeof item.engine === 'string' ? item.engine : item.engine?.name;
  return `${engine ?? 'unknown'}|${item.market.countryCode}|${item.market.languageCode}|${item.query}`;
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

export function buildReport({ snapshots, errors = [], previousSnapshots = [], brand, competitors }) {
  const previousByKey = new Map(previousSnapshots.map((item) => [keyOf(item), item]));
  const changes = snapshots.map((current) => {
    const previous = previousByKey.get(keyOf(current));
    return {
      key: keyOf(current),
      previousVisibilityScore: previous?.visibilityScore ?? null,
      currentVisibilityScore: current.visibilityScore,
      scoreDelta: previous ? current.visibilityScore - previous.visibilityScore : null,
      previousBrandMentioned: previous?.brandMentioned ?? null,
      currentBrandMentioned: current.brandMentioned,
      changed: Boolean(previous && (previous.visibilityScore !== current.visibilityScore || previous.brandMentioned !== current.brandMentioned)),
    };
  });
  const allCitations = snapshots.flatMap((snapshot) => snapshot.citations ?? []);
  const sourceCounts = new Map();
  for (const citation of allCitations) sourceCounts.set(citation.domain, (sourceCounts.get(citation.domain) ?? 0) + 1);
  const topCitationDomains = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([domain, count]) => ({ domain, count }));
  const mentionRate = snapshots.length ? Math.round((snapshots.filter((item) => item.brandMentioned).length / snapshots.length) * 100) : 0;
  const citationRate = snapshots.length ? Math.round((snapshots.filter((item) => item.ownedCitation).length / snapshots.length) * 100) : 0;
  const recommendations = [...new Set(snapshots.map((item) => item.recommendation).filter(Boolean))].slice(0, 30);

  return {
    type: 'report_summary',
    capturedAt: new Date().toISOString(),
    status: errors.length && !snapshots.length ? 'failed' : errors.length ? 'partial' : 'succeeded',
    brand: brand.name,
    competitors: competitors.map((competitor) => competitor.name),
    snapshotCount: snapshots.length,
    errorCount: errors.length,
    visibilityScore: average(snapshots.map((item) => item.visibilityScore)),
    brandMentionRate: mentionRate,
    aiBrandMentionRate: snapshots.filter((item) => item.brandMentionedInAiResponse !== null).length
      ? Math.round((snapshots.filter((item) => item.brandMentionedInAiResponse === true).length / snapshots.filter((item) => item.brandMentionedInAiResponse !== null).length) * 100)
      : null,
    ownedCitationRate: citationRate,
    competitorMentionRate: snapshots.length ? Math.round((snapshots.filter((item) => item.competitorCount > 0).length / snapshots.length) * 100) : 0,
    topCitationDomains,
    changes,
    recommendations,
    errors,
  };
}
