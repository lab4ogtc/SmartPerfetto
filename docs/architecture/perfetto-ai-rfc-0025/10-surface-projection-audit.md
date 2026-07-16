# RFC 0025 Surface Projection Audit

Last updated: 2026-07-07.

This note audits how the RFC-0025-inspired work projects into the three user
surfaces that matter most for the current product:

1. Frontend AI panel.
2. HTML Report.
3. CLI.

The main conclusion is: **HTML Report is the most complete human-readable
analysis artifact for a normal AI analysis turn, but it should not become a raw
JSON dump or a copy of the AI panel. CLI owns terminal automation plus
machine-readable sidecars. Some RFC features are not normal analysis-report
features at all and should stay in their own explicit entry points.**

## Surface Contract

| Surface | Product role | Should show | Should avoid |
|---|---|---|---|
| Frontend AI panel | Live analysis and trace interaction | Readable answer, report link, compact analysis receipt chips, actionable UI proposals, SQL/DataEnvelope tables, query-review disclosure, similarity hints, trace-config preview, AI capability status | Full audit appendix, raw sidecar JSON, report-length evidence dumps, automatic execution of model proposals |
| HTML Report | Canonical human-readable analysis record | Execution overview, analysis receipt, UI action proposals, plan/notes/timeline, DataEnvelope tables, query review, findings, case recommendations, conclusion, evidence reference summary, claim verification, identity summary | Live-only controls, automatic UI actions, every raw machine-readable object expanded inline |
| CLI | Automation and terminal workflow | Concise conclusion, claim-verification summary, report/session paths, explicit batch/capture/config commands, JSON output modes | Timeline navigation, clickable UI actions, long interactive report content in terminal |

The important distinction is **human-readable completeness** versus
**machine-readable completeness**:

- The HTML Report should be the fullest readable artifact for a completed AI
  analysis turn.
- The CLI session directory can be more complete as a machine-readable bundle
  because it writes sidecars such as `analysis-receipt.json`,
  `ui-action-proposals.json`, `claim-verification.json`, and
  `identity-resolutions.json`.
- The AI panel should remain compact and operational, then link to the report.

## Feature Projection Matrix

| Feature | Trigger | Frontend AI panel | HTML Report | CLI |
|---|---|---|---|---|
| Analysis receipt and evidence audit | A normal AI analysis completes and `analysis_completed` is emitted or a CLI turn finishes | Renders compact receipt chips: schema, mode, evidence count, non-evidence context count, claim/report gate status | Renders full Analysis Receipt section with trace evidence counts, non-evidence context, claim audit, quality gates, and output IDs/paths | Writes receipt sidecars per session and per turn; terminal prints conclusion plus claim-verification summary and paths |
| Trace config proposal | User explicitly asks for a capture suggestion through AI panel preview, CLI `smp capture suggest`, or workspace trace-config API | Renders a preview-only panel with intent/app/duration/category inputs, rationale, warnings, commands, and textproto preview | Not part of a normal analysis report by design; it is a capture-planning artifact, not trace evidence | `smp capture suggest` prints deterministic proposal; no LLM, ADB, tracebox, or recording starts |
| UI action proposal protocol | Analysis produces DataEnvelope evidence with safe navigation/table metadata | Renders buttons that only execute after user click: navigate time/range, open evidence table, or pin evidence | Renders UI Action Proposals as report provenance: kind, reason, source, payload | Writes `ui-action-proposals.json`; CLI never auto-executes UI actions |
| Snapshot and case similarity MVP | User explicitly requests similarity for an existing analysis-result snapshot | Result picker/panel shows `navigation_hint_only` similarity hints, scores, reasons, and limitations | Normal report can show case recommendations if the conclusion contract carries them; similarity hints are navigation aids, not evidence | No normal terminal projection unless a command/API flow explicitly consumes snapshots; comparison/report artifacts remain separate |
| Query review layer | SQL/Skill execution produces DataEnvelope/query metadata | SQL and DataEnvelope views render a collapsed Query Review disclosure with reads, filters, outputs, guardrails, limitations, and executable SQL when available | Data Details include collapsed Query Review and technical metadata for each envelope | Preserved through the same report pipeline and DataEnvelope artifacts; terminal does not inline it |
| External Skill Pack / local extension path | Workspace admin previews/installs/enables/disables/deletes a local Skill Pack | No ordinary AI-panel management UI in this implementation; enabled packs affect workspace-scoped agent skill availability | Not a per-analysis report section unless a run uses an external Skill and its DataEnvelope metadata appears | No global CLI pack execution surface; runtime integration is workspace/API-scoped |
| Batch trace lifecycle | User explicitly runs `smp batch skill` or workspace batch-traces API | Not supported as browser UI execution in the first release | Has a separate Batch Trace HTML report with per-trace results, aggregate metrics, and limitations; it is not the normal AI analysis report | Primary local surface: deterministic multi-trace Skill run, text/json/ndjson output, `result.json`, and `report.html` |
| AI disable and capability disclosure | `SMARTPERFETTO_AI_ENABLED=false` or equivalent policy disables model-backed features | Header/status, disabled banner, input hint, and provider panel disclose AI disabled; model-backed requests are blocked while deterministic tools remain usable | Not a normal report section because blocked analysis does not produce an analysis report | `smp analyze`, `resume`, `provider test`, and `capture android --analyze` fail early with `AI_DISABLED`; deterministic commands remain available |

## Completeness Judgment

For **normal AI analysis**, the current implementation is aligned with the
intended product split:

- AI panel is concise and interactive.
- HTML Report is the most complete human-readable record.
- CLI terminal is intentionally compact while the CLI session directory keeps
  the report and machine-readable sidecars.

The report is not absolutely the largest artifact in byte-for-byte terms,
because the CLI/session sidecars keep raw JSON and the report summarizes some
evidence references. That is the right tradeoff. If we ever define "Report is
the single portable archive", the report should add an artifact manifest or
download bundle link rather than expanding all raw sidecars inline.

## Current Gaps And Follow-Ups

| Priority | Gap | Recommendation |
|---|---|---|
| P1 | The phrase "HTML Report is the most complete" can be misread as "every raw JSON sidecar must be expanded in HTML" | Use "most complete human-readable analysis artifact" in product/docs language. Keep raw machine contracts in sidecars and snapshots. |
| P1 | Batch Trace has its own HTML report, which can be confused with the normal AI analysis report | Name it explicitly as "Batch Trace Report" wherever surfaced. Do not promise AI-panel parity until browser batch execution exists. |
| P2 | Trace Config Proposal is visible in AI panel/CLI/API but intentionally absent from normal analysis reports | Keep it as preview-only capture planning. Add it to a report only if a future capture+analyze flow needs to record the pre-capture proposal as provenance. |
| P2 | External Skill Pack is API/runtime infrastructure, not a user-facing report feature | Let external Skill usage surface naturally through Skill/DataEnvelope metadata. Avoid adding a static "installed packs" section to every report. |
| P2 | CLI has richer machine-readable artifacts than the report, but users may not know where they are | The existing completion paths are correct; future CLI UX could print a short "artifact bundle" summary when receipt/action sidecars are present. |

## Evidence Checked

- `AGENTS.md` and `.claude/rules/product-surface.md`: separate live chat,
  HTML report, CLI artifacts, snapshots, and generated frontend contracts.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`:
  renders report link, analysis receipt, UI action proposals, Query Review,
  trace-config preview, similarity hints, and AI-disabled state.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers.ts`:
  carries `analysisReceipt` and `uiActionProposals` from terminal
  `analysis_completed` payloads into message state.
- `backend/src/services/htmlReportGenerator.ts`: renders Analysis Receipt,
  UI Action Proposals, Data Details with Query Review, Case Recommendations,
  Evidence Reference Summary, Claim Verification, and identity sidecar summary.
- `backend/src/routes/agentRoutes.ts`: derives UI action proposals and analysis
  receipt before replayable `analysis_completed` SSE events.
- `backend/src/cli-user/services/cliAnalyzeService.ts`: builds CLI reports
  through the shared report normalization/data pipeline.
- `backend/src/cli-user/services/turnPersistence.ts`: writes conclusion,
  report HTML, transcript, and analysis-quality sidecars.
- `docs/reference/api.md`, `docs/reference/cli.md`, and
  `docs/reference/skill-system.md`: document trace-config proposals, batch
  trace lifecycle, similarity, Skill Pack APIs, and AI-disabled behavior.
