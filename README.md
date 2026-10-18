# GEO / AEO Visibility Monitor

An Apify Actor that turns search and AI-search results into recurring brand visibility and competitive-intelligence data.

The Actor orchestrates a configurable Apify source Actor and normalizes common SERP/AI-answer response shapes. Output contract version 2 separates billable results from diagnostics:

- The default **Dataset** contains one `visibility_snapshot` per successful query, market, and engine check. Completed snapshots are delivered individually during the run.
- **Run report and historical changes** opens `RUN_REPORT` in the run's key-value store: a `report_summary` with visibility, mention/citation rates, competitors, historical changes, source budgets, and parent event-charge accounting.
- **Source errors** opens `SOURCE_ERRORS` in the same store: a diagnostic array for partial or complete source failures.

The default source is `apify/google-search-scraper`. The source Actor is intentionally configurable so the monitor can later add other engines without changing its output contract.

## Choose a monitoring preset

New Console inputs explicitly prefill **Google AI Mode - extra source charges**, so an empty advanced-options object no longer silently selects ordinary web search. The schema uses `prefill: google_ai_mode` and `default: custom`: the interface suggests AI collection while omitted fields in existing tasks and API requests preserve their current settings. Every preset works with your chosen brand and competitors; Notion in the live example is only sample input.

| `monitoringPreset` | Google collection settings | Source charges |
| --- | --- | --- |
| `google_ai_mode` | Enable Google AI Mode; full AI Overview capture off. | Standard search plus the source's AI Mode add-on. |
| `google_ai_overview` | Full AI Overview capture on; AI Mode off. | Standard search plus the source's captured AI Overview add-on. Google may not show an Overview. |
| `google_ai_full` | Enable both Google AI Mode and full AI Overview capture. | Standard search plus both applicable add-ons. |
| `web_search` | Disable both Google AI switches. | Standard source search charges; this preset is not an AI-answer visibility test. |
| `custom` | Preserve `sourceActorInput` and engine `inputOverrides`. | Depends on the source and enabled options. |

Google presets require `apify/google-search-scraper` and control the two Google switches even when advanced options conflict. Other AI add-ons require `custom`; their response formats still require compatible normalization. For compatibility, saved inputs and API calls **without** `monitoringPreset` retain their existing collection settings (`custom`). Explicitly choose `google_ai_mode` to upgrade an existing task to AI collection. Collection changes establish a new compatible-history baseline.

For a one-query AI check, use [`examples/ai-live-input.json`](examples/ai-live-input.json). For a regular-search check, use [`examples/live-input.json`](examples/live-input.json). Both launch paid sources. See the source's current [pricing](https://apify.com/apify/google-search-scraper/pricing); source budgets do not include this monitor's fee. Presets request AI data but cannot guarantee that an answer is returned. A successful snapshot requires usable search or AI evidence; a valid search-only snapshot is still a billable visibility check and has unknown AI-answer measurements.

For Google, `queries` is sent as a single string according to the source's input contract. To manage the switches manually, choose `custom` and set `sourceActorInput`, for example `{"aiOverview":{"scrapeFullAiOverview":true},"aiModeSearch":{"enableAiMode":true}}`.

## Pricing and parent charge limit

Keep the existing `apify-default-dataset-item` event in Console. Only successful snapshots enter that dataset, so its event now bills successful checks only. **Summaries and error records do not incur per-result charges.** The automatic `apify-actor-start` fee remains separate, and upstream Actors can charge for failed or empty source runs. Ordinary compute/storage costs also apply according to platform pricing.

At $0.01 per snapshot, 10 successful query checks produce 10 billable rows: $0.10 plus startup and upstream charges. Their summary and error diagnostics add zero result events. No-results or all-error runs have zero snapshot events, while startup/upstream costs can still apply.

Before starting each new source run, the monitor reads **that run's** pricing and charged event counts from Apify, reserves the startup fee according to memory, and checks that one additional snapshot fits within the smaller of `ACTOR_MAX_TOTAL_CHARGE_USD` and the run's API maximum. Local delivery receipts cover delayed event counts. If a snapshot does not fit, the run stops with `parent_charge_limit` and saves its report without launching more sources. Malformed or unsupported pricing fails before paid source work. No charge request is sent manually; Apify bills dataset writes automatically. This is an event-charge guard for the parent run, separate from the source-run budget, and is not an account-wide or entire-invoice spending cap.

`report_summary.billing` includes the run-specific unit price, maximum parent charge, accounted event charges, remaining snapshot capacity, confirmed delivery count and pending delivery count. Pending writes reserve their full event price until reconciled; these figures are conservative accounting, not a final invoice. Platform compute/usage charges and downstream spending are not estimated by the parent event guard. Actor memory is limited to 1 GB.

When updating your published Actor, keep the event name and existing unit price. You can rename its **Title** to `Successful visibility check` and its **Description** to `One successful query, market and source-Actor visibility snapshot. Run summaries and source errors are not charged as results.` No new custom event is needed. Start a **new run** after rebuilding; version 1 run checkpoints cannot be resurrected into this output contract.

## Run locally with a fixture

The fixture path keeps local development deterministic and avoids paid Apify calls:

```powershell
$env:GEO_INPUT_FILE = "$PWD/examples/input.json"
$env:GEO_FIXTURE_FILE = "$PWD/examples/source-fixture.json"
$env:GEO_OUTPUT_DIR = "$PWD/test-output"
npm start
```

The run writes `test-output/dataset.jsonl`, keyed checkpoints under `test-output/records/`, and persistent history under `test-output/named-stores/`. Keep that directory for a second local run to verify history; delete it after verification. Fixtures report zero source charges and make no paid calls.

## Run on Apify

Build and run the Actor with an Apify token. The runtime reads the platform `INPUT` record, invokes the configured source Actor with the same token, writes dataset items to the default dataset, and stores checkpoints in the run's default key-value store. Cross-run history uses a separate named store in the running customer's account. Normal limited Actor permissions support creating storage and using storage created by earlier runs; full permissions are not required. Storage authorization failures are surfaced before launching paid sources.

The runtime supports the current `ACTOR_DEFAULT_KEY_VALUE_STORE_ID`, `ACTOR_INPUT_KEY`, and `ACTOR_DEFAULT_DATASET_ID` variables, as well as legacy `APIFY_*` names. Input defaults to the `INPUT` record when the platform does not set a record key.

For a small live smoke test, paste [`examples/live-input.json`](examples/live-input.json) into the Actor's **Input → JSON** editor, save it, and start a new run of the latest successful build. This checks one Google query for Notion without paid AI add-ons. It still incurs source Actor and platform usage charges; the $0.50 source cap does not include this monitor's fee. A successful source call produces one `visibility_snapshot` in the Dataset and a separate `RUN_REPORT`; verify `snapshotCount: 1`, `errorCount: 0`, and `sourceRecordCount > 0`. A regular Google result alone does not verify AI answer visibility.

Remove `GEO_USE_EXAMPLE` when testing Console input. Setting it to `1` explicitly allows the bundled example as a fallback when no input is found, which can hide an input-delivery problem. If a run fails before producing output, inspect that run's **Log** and **Input** tabs. The missing-input error distinguishes missing runtime credentials, missing store IDs, and a missing input record.

## Persistent history

Use a stable `monitorId` such as `notion-us` for recurring runs. `historyEnabled` defaults to `true`; `historyRetentionDays` defaults to 90. The Actor creates/reuses a named key-value store, `geo-history-<actor hash>`, scoped to the running Apify account. The report exposes its name and ID in `history`. It does not use a global developer-owned store.

Each completed run writes its own record. There is no shared mutable "latest" pointer, so concurrent runs cannot overwrite each other's history. Each query uses the latest compatible observation completed before the current run started. Compatibility includes the brand and aliases/domains, competitors, query, country, language, location, engine/source Actor, actual source input (including AI settings), and analysis version. Adding queries preserves existing query baselines. Changing measurement settings starts a new baseline.

History retains successful observations from partial runs. Failed, empty, unresolved, and budget-skipped tasks never replace valid baselines. History omits `rawSource`, including when raw source output is enabled. The first compatible run has `scoreDelta: null` and `baselineRunId: null`. Later `changes` entries include baseline run/time, score delta, brand/AI mention gained/lost, AI owned-citation gained/lost, competitor changes, and citation-domain changes. A missing AI answer remains unknown rather than becoming a false observation.

Reports now include `changeDetectionVersion: 2`. Each `changes` entry also compares AI response counts, total citation counts, AI citation counts, and attached-source counts using `previous...`, `current...`, and `...Delta` fields (for example `previousAiResponseCount`, `currentAiResponseCount`, `aiResponseCountDelta`). Exact URL additions/removals appear in `citationUrlsGained/Lost`, `aiCitationUrlsGained/Lost`, and `aiAttachedSourceUrlsGained/Lost`. URL replacements within the same domain count as changes even when counts and scores stay constant. List order and duplicate URLs do not count as URL changes.

`aiOwnedAttachedSource` on a snapshot indicates whether any AI channel includes a brand-owned attached link. It remains distinct from `aiOwnedCitation`: attached links do not become formal citations or contribute to the visibility score. History reports `previousAiOwnedAttachedSource`, `currentAiOwnedAttachedSource`, and `aiOwnedAttachedSourceChange` (`gained`, `lost`, `unchanged`, or `null` when unavailable).

`aiChannelChanges` compares each AI channel separately: channel and answer availability, counts, formal/attached URLs, brand mention, competitor mentions, and owned-source transitions. Changes cannot cancel out merely because the combined URL sets are unchanged. `changedFields` explains which tracked measurements changed; `changed` becomes true when any aggregate or channel comparison changes. Missing answers can change response availability while their brand-mention transition remains unknown. First runs, incompatible versions, and fields absent from older history do not invent losses or gains. Existing analysis-version-2 baselines remain usable, and the owned-attached flag is derived from their saved evidence when needed. Raw source output is not required.

`changed: false` means these tracked measurements are unchanged. Full answer prose, ranking within AI recommendations, and URL order are not compared; this flag does not assert identical answer text.

`historyKey` remains a supported namespace, combined with `monitorId`. Existing run-local history arrays are not imported because their brand and collection configuration cannot be verified. The first run after this upgrade establishes a fresh baseline.

Expired records are deleted only for the current monitor namespace when it next runs. Named stores otherwise persist indefinitely; an inactive project's history is not cleaned on a background timer. Deleting that named store removes its history. See [Apify storage retention](https://docs.apify.com/platform/storage/key-value-store) and [limited Actor permissions](https://docs.apify.com/platform/actors/development/permissions).

## Source budget and recovery

| Input | Default | Meaning |
| --- | --- | --- |
| `maxSourceBudgetUsd` | `2` | Combined source-run budget for this monitor run. |
| `maxTotalChargeUsd` | Remaining aggregate budget | Optional maximum for each individual source run. |
| `maxSourceRuns` | `20` | Maximum launch attempts across all queries, markets and engines. |
| `sourceTimeoutSeconds` | `300` | Timeout sent to the source platform run, shortened near the parent's deadline. |

Sources run sequentially. Before each launch, the Actor checkpoints a reservation equal to `min(per-run cap, remaining source budget)`. It sends this amount as the source run's **API query parameter** `maxTotalChargeUsd`, together with the platform `timeout`. It never raises a cap to satisfy a source's minimum charge. Zero budget, zero per-run cap or zero source-run limit prevents new launches.

Terminal source runs are accounted using the authenticated run's `usageTotalUsd`, including failed and aborted runs. Missing charges consume the full reserved allowance instead of being treated as free. No provisional running cost or separate event charge is added to `usageTotalUsd`. USD arithmetic uses integer micro-dollars; budget allowances round down and charges round up. For example, with a $0.30 aggregate budget, a $0.20 per-run cap and $0.10 actual charges, the successive caps are $0.20, $0.20 and $0.10.

The aggregate budget covers the source runs launched by this monitor. This monitor's own compute, storage and traffic charges are additional. Platform billing granularity and late settlement also prevent promising an absolute cap on the entire Apify invoice. Separate concurrent monitor runs each have their own source budget; this is not an account-wide monthly spending limit. See [Apify source run cost and timeout parameters](https://docs.apify.com/api/v2/act-runs-post).

`report_summary.budget` exposes known charges, reserved unknown charges, accounted charges, remaining budget, and a per-source ledger with run IDs. The report also includes planned/completed/failed/unresolved/skipped counts and `stopReason` (`budget_exhausted`, `max_source_runs`, `parent_deadline`, `parent_charge_limit`, `ambiguous_launch`, or `source_reconciliation_required`). A budget stop preserves completed results and returns `status: "partial"`. All-source failures produce `status: "failed"` and a nonzero process exit after saving diagnostic output. `RUN_REPORT` is also updated during collection with `status: "running"`, so an interrupted run retains its latest progress.

Checkpoints are saved before launch, after obtaining the child run ID, after settlement, and after analysis. Resurrection of the **same Apify run** reuses its checkpoint and known child IDs instead of relaunching them. A brand-new run has a fresh budget and performs fresh measurements. Do not edit input while resurrecting an existing run. Completed output is not emitted again when its delivery checkpoint is confirmed.

If a launch POST loses its response, a child may already exist. The Actor reserves its full allowance and stops with `ambiguous_launch`; it does not blindly repeat that POST. Inspect the source Actor's run list before starting another monitor run. If a known running child cannot be reconciled or aborted, the Actor stops other launches; resurrection can inspect that same child again. Local timeouts and polling errors request an abort. The child also has a platform timeout, since forced parent termination cannot guarantee cleanup code executes.

Dataset delivery and checkpoint writes are separate API operations. Each snapshot write is checkpointed as pending before delivery and confirmed afterward. On resurrection, an interrupted write is checked against `(runId, comparisonKey)` in the existing dataset. A matching row is confirmed without replaying its paid write. If delivery cannot be confirmed, the run stops with a `dataset_delivery_unconfirmed` report and does not repeat the write or launch more sources; inspect the dataset and diagnostic before starting another run. Reports are overwritten in the run store, never appended as billable rows. Concurrent instances of the same run ID are not supported; separate scheduled runs have separate IDs and independent history records.

## Output contract

The default dataset defines two Console views in [`.actor/dataset_schema.json`](.actor/dataset_schema.json): **Visibility overview** and **AI evidence and competitors**. Both contain successful snapshots only. Select **Visibility overview** in the Dataset schema section when publishing an example task. Open **Run report and historical changes** or **Source errors** in the run's Output tab for the separate diagnostics. API clients that previously read `report_summary` or `source_error` from dataset items must use the output URLs or the `RUN_REPORT` and `SOURCE_ERRORS` records in the run's default key-value store. Views control presentation without changing stored records or the number of dataset items.

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
