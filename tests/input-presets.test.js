import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSourceInput, normalizeInput } from '../src/input.js';
import { run } from '../src/index.js';
import { MemoryStorage, TestClient, quiet } from './helpers.js';

const base = { brand: 'Any brand', queries: ['best team knowledge base'] };
function source(extra) {
  const config = normalizeInput({ ...base, ...extra });
  return buildSourceInput(config, config.queries[0], config.markets[0], config.engines[0]);
}

test('new Console input explicitly selects paid web and AI checks while legacy API inputs keep their settings', async () => {
  const actor = JSON.parse(await readFile(new URL('../.actor/actor.json', import.meta.url), 'utf8'));
  const preset = actor.input.properties.monitoringPreset;
  assert.equal(preset.default, 'custom');
  assert.equal(preset.prefill, 'google_web_and_ai');
  assert.match(preset.description, /charges/);
  const config = normalizeInput({ ...base, monitoringPreset: preset.prefill });
  assert.deepEqual(config.engines.map((engine) => buildSourceInput(config, config.queries[0], config.markets[0], engine).aiModeSearch.enableAiMode), [false, true]);
  assert.equal(normalizeInput(base).monitoringPreset, 'custom');
  assert.equal(source({ sourceActorInput: {} }).aiModeSearch, undefined);
  const legacy = { aiModeSearch: { enableAiMode: true }, customField: 'retained' };
  assert.equal(source({ sourceActorInput: legacy }).aiModeSearch.enableAiMode, true);
  assert.equal(source({ sourceActorInput: legacy }).customField, 'retained');
});

test('Google presets set their declared switches even when advanced options conflict', () => {
  for (const [monitoringPreset, mode, overview] of [
    ['google_ai_mode', true, false], ['google_ai_overview', false, true],
    ['google_ai_full', true, true], ['web_search', false, false],
  ]) {
    const input = source({ monitoringPreset, sourceActorInput: {
      aiModeSearch: { enableAiMode: !mode }, aiOverview: { scrapeFullAiOverview: !overview },
      customField: 'keep',
    }, engines: [{ name: 'google', actorId: 'apify/google-search-scraper', inputOverrides: {
      aiModeSearch: { enableAiMode: !mode },
    } }] });
    assert.equal(input.aiModeSearch.enableAiMode, mode);
    assert.equal(input.aiOverview.scrapeFullAiOverview, overview);
    assert.equal(input.customField, 'keep');
  }
});

test('presets reject unsupported sources and unexpected paid channels before launch', () => {
  assert.throws(() => normalizeInput({ ...base, monitoringPreset: 'unknown' }), /monitoringPreset/);
  assert.throws(() => normalizeInput({ ...base, monitoringPreset: 'google_ai_mode', engines: ['other/actor'] }), /require apify/);
  for (const sourceActorInput of [[], 'invalid']) assert.throws(() => normalizeInput({ ...base, sourceActorInput }), /must be an object/);
  assert.throws(() => source({ monitoringPreset: 'web_search', sourceActorInput: { chatGptSearch: { enableChatGpt: true } } }), /Other AI add-ons/);
  const custom = source({ monitoringPreset: 'custom', engines: ['other/actor'], sourceActorInput: { customField: true } });
  assert.equal(custom.customField, true);
  assert.equal(custom.aiModeSearch, undefined);
});

test('official-check example has required prefills and performs bounded web and AI checks', async () => {
  const actor = JSON.parse(await readFile(new URL('../.actor/actor.json', import.meta.url), 'utf8'));
  const fields = actor.input.properties;
  for (const key of actor.input.required) {
    assert.notEqual(fields[key].prefill, undefined, `Official checks require a prefill for ${key}`);
  }
  const input = Object.fromEntries(Object.entries(fields)
    .filter(([, field]) => field.prefill !== undefined || field.default !== undefined)
    .map(([key, field]) => [key, structuredClone(field.prefill ?? field.default)]));
  const config = normalizeInput(input);
  assert.equal(config.brand.name, 'Apify');
  assert.equal(config.queries.length, 1);
  assert.equal(config.queries.length * config.markets.length * config.engines.length, 2);
  assert.equal(config.maxSourceRuns, 2);
  assert.equal(config.maxSourceBudgetUsd, 0.5);
  assert.equal(config.maxTotalChargeUsd, 0.5);
  assert.equal(config.sourceTimeoutSeconds, 90);
  assert.ok(config.maxSourceRuns * config.sourceTimeoutSeconds < 300);
  assert.equal(config.monitoringPreset, 'google_web_and_ai');
  const storage = new MemoryStorage();
  const sourceClient = new TestClient({ items: [{
    organicResults: [{ title: 'Apify', url: 'https://apify.com/', position: 1 }],
    aiModeResult: { text: 'Apify provides web scraping and automation tools.' },
  }] });
  const result = await run(input, { sourceClient, storage, logger: quiet, env: {} });
  assert.equal(result.report.status, 'succeeded');
  assert.equal(sourceClient.calls.length, 2);
  assert.equal(sourceClient.calls[0].input.aiModeSearch.enableAiMode, false);
  assert.equal(sourceClient.calls[1].input.aiModeSearch.enableAiMode, true);
  assert.equal(storage.items.length, 2);
  assert.equal(storage.items[0].brand, 'Apify');
  assert.equal(storage.items[0].observationPresent, true);
  assert.equal((await storage.loadJson('RUN_REPORT')).errorCount, 0);
});
