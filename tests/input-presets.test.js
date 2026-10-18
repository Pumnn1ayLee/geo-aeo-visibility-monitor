import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSourceInput, normalizeInput } from '../src/input.js';

const base = { brand: 'Any brand', queries: ['best team knowledge base'] };
function source(extra) {
  const config = normalizeInput({ ...base, ...extra });
  return buildSourceInput(config, config.queries[0], config.markets[0], config.engines[0]);
}

test('new Console input explicitly selects paid AI Mode while legacy API inputs keep their settings', async () => {
  const actor = JSON.parse(await readFile(new URL('../.actor/actor.json', import.meta.url), 'utf8'));
  const preset = actor.input.properties.monitoringPreset;
  assert.equal(preset.default, 'custom');
  assert.equal(preset.prefill, 'google_ai_mode');
  assert.match(preset.description, /charges/);
  assert.equal(source({ monitoringPreset: preset.prefill }).aiModeSearch.enableAiMode, true);
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
