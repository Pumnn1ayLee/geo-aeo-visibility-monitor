# GEO / AEO Visibility Monitor

An Apify Actor that turns search and AI-search results into recurring brand visibility and competitive-intelligence data.

The Actor orchestrates a configurable Apify source Actor, normalizes common SERP/AI-answer response shapes, and emits:

- one `visibility_snapshot` per query, market, and engine;
- one `report_summary` with visibility, mention rate, owned-citation rate, competitor rate, top citation domains, and historical changes;
- `source_error` items for partial failures.

The default source is `apify/google-search-scraper`. The source Actor is intentionally configurable so the monitor can later add other engines without changing its output contract.

For the default Google source, `queries` is sent as a single string because that is the source Actor's input contract. Add-ons are passed through `sourceActorInput`, for example `{"aiOverview":{"scrapeFullAiOverview":true},"aiModeSearch":{"enableAiMode":true}}`. These add-ons can incur additional source-Actor charges, so keep `maxTotalChargeUsd` set when testing.

## Run locally with a fixture

The fixture path keeps local development deterministic and avoids paid Apify calls:

```powershell
$env:GEO_INPUT_FILE = "$PWD/examples/input.json"
$env:GEO_FIXTURE_FILE = "$PWD/examples/source-fixture.json"
$env:GEO_OUTPUT_DIR = "$PWD/test-output"
npm start
```

The run writes `test-output/dataset.jsonl` and `test-output/history.json`. Delete that directory after local verification.

## Run on Apify

Build and run the Actor with an Apify token. The runtime reads the platform `INPUT` record, invokes the configured source Actor with the same token, writes dataset items to the default dataset, and stores the previous snapshot in the default key-value store.

The runtime supports the current `ACTOR_DEFAULT_KEY_VALUE_STORE_ID`, `ACTOR_INPUT_KEY`, and `ACTOR_DEFAULT_DATASET_ID` variables, as well as legacy `APIFY_*` names. Input defaults to the `INPUT` record when the platform does not set a record key.

For a small live smoke test, paste [`examples/live-input.json`](examples/live-input.json) into the Actor's **Input → JSON** editor, save it, and start a new run of the latest successful build. This checks one Google query for Notion without paid AI add-ons. It still incurs source Actor and platform usage charges; the $0.50 source cap does not include this monitor's compute usage. A successful source call produces one `visibility_snapshot` and one `report_summary`; verify `snapshotCount: 1`, `errorCount: 0`, and `sourceRecordCount > 0`. A regular Google result alone does not verify AI answer visibility.

Remove `GEO_USE_EXAMPLE` when testing Console input. Setting it to `1` explicitly allows the bundled example as a fallback when no input is found, which can hide an input-delivery problem. If a run fails before producing output, inspect that run's **Log** and **Input** tabs. The missing-input error distinguishes missing runtime credentials, missing store IDs, and a missing input record.

`maxTotalChargeUsd` is forwarded to each source Actor run. Use it together with `maxQueries` and `maxResultsPerQuery` to keep source costs bounded.

## Output contract

Every successful snapshot contains the query, market, engine, overall and AI-response brand mention flags, owned-citation flag, best detected position, visibility score, evidence confidence, competitor mentions, citations, and a suggested next action. Raw source records are omitted by default; set `includeRawSource` to `true` when audit-level reproducibility is needed.

`aiResponses` separates AI Overview (`aiOverview`) and AI Mode (`aiModeResult`) with their own brand mentions, competitors, and source lists. `aiCitations` contains AI source citations; `aiAttachedSources` contains links that the source labels `section: "attached"`. Attached links do not count toward `aiOwnedCitation` or citation totals. The combined `citations` list includes search result URLs and AI citations, while excluding query/navigation URLs and snapshot metadata. `bestPosition` measures a matching search result's position, not the order of brand recommendations in AI prose.

Brand mentions are detected in result text and AI answer text, excluding the user's query, related queries, source titles, and runtime metadata. A missing AI answer yields `brandMentionedInAiResponse: null`; a captured answer without the brand yields `false`. `aiOwnedCitationRate` reports the rate of snapshots with brand-owned AI citations separately from brand mentions. These are observed references and text matches, not an assessment of endorsement or citation quality. The visibility score is a heuristic, not a Google metric.

Analysis version 2 corrects AI Mode detection and citation classification. Snapshots include `analysisVersion: 2`; historical score deltas require matching analysis versions. The test fixture in `tests/fixtures/google-ai-mode.json` is a reduced, sanitized representation of a successful source response and contains no signed snapshot links.

## Development checks

```powershell
npm test
npm run lint
```

The implementation intentionally uses Node's built-in `fetch` and test runner, so a local install does not need a dependency cache outside this workspace.
