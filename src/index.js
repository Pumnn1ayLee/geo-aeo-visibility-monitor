import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { normalizeInput, buildSourceInput, readInputFromEnvironment } from './input.js';
import { analyzeSnapshot, extractRecords } from './analysis.js';
import { buildReport } from './report.js';
import { ApifySourceClient, FixtureSourceClient } from './source-client.js';
import { createStorage } from './storage.js';

async function createSourceClient() {
  const fixtureFile = process.env.GEO_FIXTURE_FILE;
  if (fixtureFile) return new FixtureSourceClient(JSON.parse(await readFile(fixtureFile, 'utf8')));
  return new ApifySourceClient();
}

function snapshotKey(item) {
  return `${item.engine}|${item.market.countryCode}|${item.market.languageCode}|${item.query}`;
}

export async function run(rawInput, { sourceClient, storage, logger = console } = {}) {
  const config = normalizeInput(rawInput);
  const client = sourceClient ?? await createSourceClient();
  const output = storage ?? createStorage();
  const previous = (await output.loadJson(config.historyKey)) ?? [];
  const snapshots = [];
  const errors = [];

  for (const market of config.markets) {
    for (const query of config.queries) {
      for (const engine of config.engines) {
        try {
          const sourceInput = buildSourceInput(config, query, market, engine);
          const payload = await client.runActor(engine.actorId, sourceInput, {
            timeoutSeconds: config.sourceTimeoutSeconds,
            maxTotalChargeUsd: config.maxTotalChargeUsd,
          });
          snapshots.push(analyzeSnapshot({
            query,
            market,
            engine: engine.name,
            brand: config.brand,
            competitors: config.competitors,
            records: extractRecords(payload),
            includeRawSource: config.includeRawSource,
          }));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          logger.error?.(`Source Actor ${engine.actorId} failed for ${market.countryCode}/${query}: ${detail}`);
          errors.push({ engine: engine.name, actorId: engine.actorId, market, query, message: detail });
        }
      }
    }
  }

  const report = buildReport({ snapshots, errors, previousSnapshots: Array.isArray(previous) ? previous : [], brand: config.brand, competitors: config.competitors });
  const items = [...snapshots, report, ...errors.map((error) => ({ type: 'source_error', capturedAt: new Date().toISOString(), ...error }))];
  await output.pushItems(items);
  const historyByKey = new Map((Array.isArray(previous) ? previous : []).map((item) => [snapshotKey(item), item]));
  for (const { rawSource: _rawSource, ...summary } of snapshots) historyByKey.set(snapshotKey(summary), summary);
  await output.saveJson(config.historyKey, [...historyByKey.values()]);
  return { config, snapshots, errors, report, items };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const rawInput = await readInputFromEnvironment({ readFile });
    const result = await run(rawInput);
    console.log(JSON.stringify({ report: result.report, snapshots: result.snapshots.length, errors: result.errors.length }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
