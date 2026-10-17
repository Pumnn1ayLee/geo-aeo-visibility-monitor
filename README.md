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

`maxTotalChargeUsd` is forwarded to each source Actor run. Use it together with `maxQueries` and `maxResultsPerQuery` to keep source costs bounded.

## Output contract

Every successful snapshot contains the query, market, engine, overall and AI-response brand mention flags, owned-citation flag, best detected position, visibility score, evidence confidence, competitor mentions, citations, and a suggested next action. Raw source records are omitted by default; set `includeRawSource` to `true` when audit-level reproducibility is needed.

## Development checks

```powershell
npm test
npm run lint
```

The implementation intentionally uses Node's built-in `fetch` and test runner, so a local install does not need a dependency cache outside this workspace.
