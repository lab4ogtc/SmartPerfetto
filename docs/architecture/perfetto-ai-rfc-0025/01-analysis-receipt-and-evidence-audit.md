# Analysis Receipt and Evidence Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every completed SmartPerfetto analysis produce a compact,
auditable receipt that distinguishes current-trace evidence, model hypotheses,
memory/context hints, verifier results, and report/snapshot provenance.

**Architecture:** Build a shared receipt contract at the route/result-quality
boundary, then project it into report, CLI artifact, snapshot, and a compact
frontend summary. Do not turn chat into a verbose audit log; chat shows a small
status chip while report/snapshot keep the detailed receipt.

**Tech Stack:** TypeScript, existing `AnalysisResult` and `quickRun` shapes,
`agentResultNormalizer`, `evidenceContractBuilder`, `claimVerificationRunner`,
SSE `analysis_completed`, frontend generated types, HTML reports, CLI turn
files, Jest.

## Global Constraints

- Receipt fields are metadata and audit support; they are not claim evidence by
  themselves.
- Memory hints, reused context, and frontend prequery summaries must remain
  visibly separate from trace evidence.
- Chat projection stays readable. Detailed receipt content belongs in report,
  CLI artifacts, and analysis-result snapshots.
- Existing `quickRun` semantics remain backward compatible.

---

## Current State

Code-grounded review update, 2026-07-06:

- The first draft referenced `buildQuickRunCompletionReceipt`; that helper does
  not exist in the current checkout. The current helper is
  `buildQuickRunReceipt` in `backend/src/agentRuntime/quickBudget.ts`, with
  final enrichment done by `finalizeQuickRunReceipt` in
  `backend/src/routes/agentRoutes.ts`.
- `ensureAnalysisQualityArtifacts` already centralizes claim support, claim
  verification, and identity resolution. The receipt must index those artifacts;
  it must not run or duplicate a second verifier.
- `ensureCompletedAnalysisResultPayload` is the correct completion boundary. It
  already normalizes the conclusion, derives quality artifacts, finalizes
  `quickRun`, generates final artifacts, and returns the data used by SSE and
  status reads.
- `ensureCompletedAnalysisFinalArtifacts` is the output boundary for report and
  snapshot ids. Report generation happens before snapshot persistence, so
  `analysisReceipt.outputs.resultSnapshotId` must remain optional instead of
  forcing report regeneration.
- `ensureCompletedAnalysisSseEvents` persists replayable `analysis_completed`
  events and caches them by run id plus
  `COMPLETED_ANALYSIS_SSE_EVENTS_QUALITY_GATE_VERSION`. Adding receipt fields
  must bump the cached event version or old replay payloads can hide the new
  receipt.
- `AnalysisSession` currently stores `providerId` but not a direct runtime
  kind. `IOrchestrator` also has no runtime getter. Runtime disclosure requires
  a small source-of-truth plumbing change, or the first receipt version must
  treat runtime as optional.
- `QuickRunReceipt` is explicitly documented in
  `backend/src/agent/core/orchestratorTypes.ts` as "metadata only; never claim
  support evidence." `AnalysisReceiptV1` must keep the same rule.
- There is no current `analysisReceipt` symbol in backend or frontend code, so
  this feature is a real contract addition, not a local rendering tweak.

Relevant existing files:

- `backend/src/agent/core/orchestratorTypes.ts`
  - Defines `AnalysisResult` and `QuickRunReceipt`; `quickRun` is metadata only.
- `backend/src/assistant/application/agentAnalyzeSessionService.ts`
  - Session preparation already resolves provider pinning and imports
    `AgentRuntimeKind`, but the managed session does not expose a stable
    runtime field today.
- `backend/src/types/dataContract.ts`
  - Defines `AnalysisCompletedEvent`; today it exposes conclusion, claim
    support, claim verification, identity resolutions, report/snapshot ids, and
    `quickRun`, but not a unified receipt.
- `backend/src/routes/agentRoutes.ts`
  - `ensureAnalysisQualityArtifacts` builds or copies verifier artifacts.
  - `finalizeQuickRunReceipt` enriches quick-run metadata with cited evidence,
    frontend prequery, DataEnvelope counts, elapsed time, stop reason, and
    verifier status.
  - `ensureCompletedAnalysisResultPayload` is the safest place to assemble the
    final receipt once quality artifacts and final artifacts are known.
  - `ensureCompletedAnalysisSseEvents` is the SSE/replay projection boundary.
- `backend/src/services/agentResultNormalizer.ts`
  - Normalizes final result and separates client/report boundaries.
- `backend/src/services/evidence/evidenceContractBuilder.ts`
  - Builds claim-support evidence from DataEnvelope output.
- `backend/src/services/verifier/claimVerificationRunner.ts`
  - Produces deterministic claim verification and identity results.
- `backend/src/services/analysisResultSnapshotPipeline.ts`
  - Persists completed-analysis snapshot metadata.
- `backend/src/services/htmlReportGenerator.ts`
  - Owns detailed HTML report rendering.
- `backend/src/services/persistAgentSession.ts`
  - Persists analysis turn data.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers.ts`
  - Handles `analysis_completed` and hides verifier metadata from visible chat.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`
  - Renders quick-run receipt chips.
- `backend/scripts/generateFrontendTypes.ts`
  - Generates frontend contract types when backend payload shape changes.

Current known strengths:

- Quick mode already has receipt-like fields for mode, profile, target turns,
  evidence counts, injected context counts, and verifier state.
- Full mode already has evidence, claim verification, identity resolution,
  HTML report, CLI artifacts, and snapshots.

Current gap:

- These signals are not presented as one stable audit surface. Reviewers and
  users must infer the boundary across multiple payload sections.
- Replay/status, report, snapshot, CLI, and visible chat can drift because each
  surface decides independently how much quality metadata to show.

## Implementation Update

Implemented 2026-07-06:

- `AnalysisReceiptV1` now lives in `backend/src/types/dataContract.ts` and is
  referenced by backend runtime result types, SSE contract types, generated
  frontend types, reports, snapshots, CLI persistence, and comparison summary
  types.
- `backend/src/services/analysisReceiptBuilder.ts` builds aggregate receipt
  metadata from existing result, quality-artifact, `quickRun`, session, and
  output metadata. It does not execute tools, rerun verification, or emit raw
  SQL/source snippets.
- `backend/src/routes/agentRoutes.ts` attaches the receipt at the completion
  boundary and bumps completed-analysis SSE replay cache versioning. Report
  generation receives a pre-snapshot receipt, snapshot persistence receives the
  same aggregate metadata, and the final SSE/status payload receives the final
  receipt shape.
- HTML reports render a compact "Analysis Receipt" section. CLI persistence
  writes `analysis-receipt.json` plus per-turn receipt JSON sidecars. Snapshot
  summaries store the receipt in metadata JSON without a schema migration.
- The Perfetto AI Assistant stores `analysisReceipt` from
  `analysis_completed` and renders a compact chip row next to the existing
  quick-run receipt chips. Detailed audit content stays out of visible chat.
- Persisted terminal SSE replay is covered by
  `backend/src/routes/__tests__/agentRoutesRbac.test.ts`, which now asserts
  that replayed `analysis_completed` payloads keep `analysisReceipt`.
- A Deepseek OpenAI-compatible startup e2e report was inspected manually and
  contained "分析回执" with aggregate evidence, non-evidence context, claim
  audit, quality gates, and output id fields.

Validation completed for this implementation:

- `cd backend && npx jest src/services/__tests__/analysisReceiptBuilder.test.ts src/services/__tests__/agentResultNormalizer.test.ts src/services/__tests__/htmlReportGenerator.test.ts src/services/__tests__/analysisResultSnapshotPipeline.test.ts src/cli-user/services/__tests__/turnPersistence.test.ts src/services/__tests__/traceCaptureConfig.test.ts src/services/__tests__/traceConfigProposal.test.ts src/cli-user/services/__tests__/captureConfig.test.ts src/routes/__tests__/traceConfigProposalRoutes.test.ts src/cli-user/commands/__tests__/captureSuggest.test.ts src/agentRuntime/__tests__/quickScrollingTriageDirectAnswer.test.ts --runInBand`
- `cd backend && npx jest src/routes/__tests__/agentRoutesRbac.test.ts --runInBand`
- `cd backend && npm run typecheck`
- `cd backend && npm run build`
- `cd backend && npm run test:scene-trace-regression`
- `cd backend && npm run generate:frontend-types`
- `cd perfetto/ui && npx vitest run --config vitest.config.mjs src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers_unittest.ts`
- `cd perfetto/ui && npm run build`
- `./scripts/start-dev.sh --quick` plus HTTP checks for `http://127.0.0.1:10000/`
  and `http://127.0.0.1:3000/health`
- `./scripts/update-frontend.sh`
- `npm run check:frontend-prebuild`
- `cd backend && npm run verify:e2e:quick`
- `cd backend && npm run verify:e2e:deepseek-startup`
- `git diff --check`

Observed e2e notes:

- The Deepseek startup run first omitted required `startup_detail` parameters,
  then self-corrected after tool validation and completed successfully. This is
  a prompt/tool-use improvement opportunity, not a receipt-contract failure.
- Perfetto UI's full `npm test` was also run during implementation and reached
  a pre-existing localStorage trusted-origin failure unrelated to this feature;
  the relevant plugin SSE unit test and full UI build/typecheck passed.

## Proposed Contract

Add an optional `analysisReceipt` object to completed result payloads, persisted
turn metadata, report data, and snapshot metadata:

```ts
export interface AnalysisReceiptV1 {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  traceId: string;
  mode: 'fast' | 'full' | 'auto';
  resolvedMode: 'quick' | 'full';
  runtime?: 'claude-agent-sdk' | 'openai-agents-sdk' | 'pi-agent-core' | 'opencode';
  providerId: string | null;
  generatedAt: number;
  traceEvidence: {
    sqlCount: number;
    skillCount: number;
    dataEnvelopeCount: number;
    artifactCount: number;
    evidenceRefCount: number;
  };
  nonEvidenceContext: {
    frontendPrequeryCount: number;
    memoryHintCount: number;
    conversationContextCount: number;
    strategyHintCount: number;
  };
  claimAudit: {
    totalClaims: number;
    verifiedClaims: number;
    unsupportedClaims: number;
    uncertainClaims: number;
  };
  qualityGates: {
    finalReportContract: 'passed' | 'partial' | 'not_applicable';
    claimVerification: 'passed' | 'partial' | 'not_applicable';
    identityResolution: 'passed' | 'partial' | 'not_applicable';
  };
  outputs: {
    reportId?: string;
    reportUrl?: string;
    resultSnapshotId?: string;
    cliTurnPath?: string;
    reportError?: string;
  };
}
```

Design notes:

- `analysisReceipt` does not replace `quickRun`; quick mode can embed or mirror
  compatible fields and full mode can still report `resolvedMode: 'full'`.
- `nonEvidenceContext` explicitly prevents memory/prequery context from being
  mistaken for evidence.
- `outputs` carries identifiers only, not raw report bodies or source snippets.
- `outputs.resultSnapshotId` is optional because report HTML is generated before
  snapshot persistence in the current route flow.
- `analysisReceipt` should be deterministic for a given completed run. Replay
  and status reads must return the cached receipt rather than silently producing
  different counts.
- `runtime` is optional in the contract because the current session object does
  not store runtime kind. Implementation can make it populated by adding an
  explicit non-secret runtime field at session preparation time.
- The receipt should be serializable into HTML report, CLI JSON/NDJSON, and
  snapshot metadata.
- Receipt fields are audit metadata. They may explain whether evidence exists,
  but they must never be counted as claim-supporting evidence.

## Files and Responsibilities

- Modify: `backend/src/agent/core/orchestratorTypes.ts`
  - Add `AnalysisReceiptV1` type and optional `analysisReceipt` on
    `AnalysisResult`.
- Modify: `backend/src/assistant/application/agentAnalyzeSessionService.ts`
  - Add non-secret runtime kind to the prepared session if the implementation
    chooses to populate `AnalysisReceiptV1.runtime` in the first release.
- Modify: `backend/src/types/dataContract.ts`
  - Add optional `analysisReceipt` to `AnalysisCompletedEvent.data`.
- Create: `backend/src/services/analysisReceiptBuilder.ts`
  - Build receipt counts from session/result/quality/final artifacts.
  - Keep this logic out of `agentRoutes.ts` except for orchestration.
- Test: `backend/src/services/__tests__/analysisReceiptBuilder.test.ts`
  - Prove counts, gate mapping, optional outputs, and non-evidence separation.
- Modify: `backend/src/services/evidence/evidenceContractBuilder.ts`
  - Reuse existing evidence-ref extraction where possible; add helpers only if
    the builder test proves route/session counting would otherwise duplicate
    logic.
- Modify: `backend/src/services/agentResultNormalizer.ts`
  - Preserve `analysisReceipt` when result payloads are normalized.
- Modify: `backend/src/routes/agentRoutes.ts`
  - Build `analysisReceipt` in `ensureCompletedAnalysisResultPayload` after
    `ensureCompletedAnalysisFinalArtifacts`.
  - Attach `analysisReceipt` to `resultForClient`, `CompletedAnalysisResultPayload`,
    and `analysis_completed`.
  - Bump `COMPLETED_ANALYSIS_SSE_EVENTS_QUALITY_GATE_VERSION`.
- Modify: `backend/src/services/htmlReportGenerator.ts`
  - Render a collapsible "Analysis Receipt" section in detailed reports.
- Modify: `backend/src/services/persistAgentSession.ts`
  - Persist receipt metadata with the turn.
- Modify: `backend/src/services/analysisResultSnapshotPipeline.ts`
  - Persist receipt metadata inside snapshot metadata.
- Modify: `backend/scripts/generateFrontendTypes.ts`
  - Generate the new frontend type.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers.ts`
  - Store receipt metadata while keeping visible chat summary compact.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`
  - Reuse existing quick-run chip pattern for a compact receipt indicator.
- Test: `backend/src/services/__tests__/agentResultNormalizer.test.ts`
- Test: `backend/src/services/__tests__/htmlReportGenerator.test.ts`
- Test: `backend/src/services/__tests__/analysisResultSnapshotPipeline.test.ts`
- Test: a new focused route/SSE test if existing route tests are too broad.
- Test: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers_unittest.ts`

## Implementation Tasks

### Task 1: Define the Receipt Contract

**Interfaces:**

- Produces: `AnalysisReceiptV1`
- Consumes: existing `AnalysisResult`, `QuickRunReceipt`, claim verification
  result, evidence contract, report id, snapshot id.

- [x] Add `AnalysisReceiptV1` to `backend/src/types/dataContract.ts` and
  import it into runtime/result consumers.
- [x] Add optional `analysisReceipt?: AnalysisReceiptV1` to `AnalysisResult`.
- [x] Add optional `analysisReceipt` to
  `backend/src/types/dataContract.ts` `AnalysisCompletedEvent.data`.
- [x] Add a unit test that constructs a completed result with and without
  `analysisReceipt`.
- [x] Verify TypeScript accepts old result payloads with no receipt.

Validation:

```bash
cd backend
npx jest src/services/__tests__/agentResultNormalizer.test.ts --runInBand
```

Expected result: tests pass and old payload fixtures remain valid.

### Task 2: Build Receipt From Existing Quality Artifacts

**Interfaces:**

- Produces:

```ts
export function buildAnalysisReceipt(input: {
  session: AnalysisSessionReceiptSource;
  result: AgentRuntimeAnalysisResult;
  runId?: string;
  normalizedConclusionContract?: ConclusionContract;
  qualityArtifacts: {
    claimSupport?: ClaimSupportV1[];
    claimVerificationResult?: ClaimVerificationResult;
    identityResolutions?: IdentityResolutionV1[];
  };
  quickRun?: QuickRunReceipt;
  finalArtifacts: CompletedAnalysisFinalArtifacts;
  runtime?: AgentRuntimeKind;
  providerId?: string | null;
  generatedAt?: number;
}): AnalysisReceiptV1;
```

- Consumes: route session fields, result, quality artifacts, finalized
  `quickRun`, final artifacts, runtime/provider metadata.

- [x] Create `backend/src/services/analysisReceiptBuilder.ts`.
- [x] Count SQL/Skill/DataEnvelope/artifact/evidenceRef from existing payloads.
- [x] Count memory/context/prequery entries separately.
- [x] Map gate states to `passed`, `partial`, or `not_applicable`.
- [x] Keep provider id nullable so env/default fallback sessions remain valid.
- [x] Keep `runtime` optional unless session preparation is updated to expose a
  non-secret runtime kind for every runtime/provider path.
- [x] Treat `quickRun.evidence.frontendPrequeryInjected` and
  `quickRun.contextInjected` as non-evidence context, not trace evidence.
- [x] Unit-test failed/partial runs so the receipt does not claim passed gates
  when the verifier was not applicable or reported issues.

Validation:

```bash
cd backend
npx jest src/services/__tests__/analysisReceiptBuilder.test.ts --runInBand
```

Expected result: builder tests prove stable counts, nullable provider id,
optional output ids, and strict evidence/non-evidence separation.

### Task 3: Attach Receipt At Completion Boundary

**Interfaces:**

- Produces: `CompletedAnalysisResultPayload.analysisReceipt`,
  `AnalysisResult.analysisReceipt`, and SSE `data.analysisReceipt`.
- Consumes: `ensureCompletedAnalysisResultPayload`,
  `ensureCompletedAnalysisFinalArtifacts`, and `ensureCompletedAnalysisSseEvents`.

- [x] Call `buildAnalysisReceipt` in `ensureCompletedAnalysisResultPayload`
  after `ensureCompletedAnalysisFinalArtifacts` returns.
- [x] Assign the receipt to `result.analysisReceipt` and `resultForClient`.
- [x] Include the receipt in `CompletedAnalysisResultPayload`.
- [x] Include `analysisReceipt` in `analysis_completed` event data.
- [x] Bump `COMPLETED_ANALYSIS_SSE_EVENTS_QUALITY_GATE_VERSION`.
- [x] Add persisted route/SSE replay test coverage that proves replayed
  terminal events retain the receipt and do not drop existing completion fields.

Validation:

```bash
cd backend
npx jest src/routes/__tests__/agentRoutesRbac.test.ts --runInBand
```

Expected result: `analysis_completed` includes receipt when an analysis reaches
completion, existing fields remain present, and replay returns the same receipt.

### Task 4: Persist and Render Detailed Receipt

**Interfaces:**

- Produces: receipt section in HTML report and metadata in CLI/snapshot.
- Consumes: `AnalysisReceiptV1`.

- [x] Store the receipt in session turn persistence.
- [x] Add receipt metadata to analysis-result snapshots.
- [x] Render a report section with counts and status labels. Report rendering
  may omit future `resultSnapshotId`; that is valid because snapshot persistence
  runs after report generation.
- [x] Keep raw SQL, full artifacts, and provider secrets out of receipt output.

Validation:

```bash
cd backend
npx jest \
  src/services/__tests__/htmlReportGenerator.test.ts \
  src/services/__tests__/analysisResultSnapshotPipeline.test.ts \
  --runInBand
```

Expected result: report and snapshot tests prove receipt metadata is present
without exposing raw sensitive content.

### Task 5: Add Compact Frontend Projection

**Interfaces:**

- Produces: compact receipt chip or expandable summary on final assistant
  message.
- Consumes: generated frontend `AnalysisReceiptV1`.

- [x] Regenerate frontend types after backend contract changes.
- [x] Extend SSE handler state to store receipt metadata.
- [x] Render only a compact status by default.
- [x] Keep verifier and audit internals out of visible chat body.
- [x] Keep `quickRun` rendering intact; `analysisReceipt` is a broader
  completion receipt, not a replacement for quick-mode chips.

Validation:

```bash
cd backend && npm run generate:frontend-types
cd ../perfetto/ui && npx vitest run --config vitest.config.mjs src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers_unittest.ts
```

If the repository does not expose `vitest` directly in the current checkout,
use the frontend test command documented at the time of implementation.

### Task 6: Run the Relevant Current-Project Gates

- [x] Run focused backend tests listed above.
- [x] Run `cd backend && npm run typecheck`.
- [x] Run `git diff --check`.
- [x] If route/runtime behavior changed, run
  `cd backend && npm run test:scene-trace-regression`.
- [x] If frontend plugin source changed, verify in dev mode, run Perfetto UI
  build/tests, and run
  `./scripts/update-frontend.sh` before landing.
- [x] For user-facing completion behavior, run the relevant Agent SSE e2e from
  `.claude/rules/testing.md` for both Claude and the OpenAI-compatible
  Deepseek-backed runtime before considering the feature release-ready.

## Implementation Standard Checklist

This feature is not implementation-ready until a reviewer can answer "yes" to
all of these:

- Does the builder consume current quality artifacts instead of re-running
  verification?
- Does the route attach the receipt at the existing completion boundary?
- Are replay/status reads deterministic for the same run id?
- Is `quickRun` preserved and still rendered as quick-mode metadata?
- Do report/snapshot/CLI outputs carry detailed receipt metadata while chat
  remains compact?
- Are provider secrets, raw SQL bodies, and source snippets excluded from the
  receipt?
- Is runtime either deliberately optional or populated from the provider/runtime
  selection source of truth, not guessed from provider names?
- Do tests cover unsupported/partial verification states, not only the happy
  path?

## Risks and Mitigations

- Risk: receipt becomes another noisy chat appendix.
  - Mitigation: report/snapshot get detail; chat gets compact status only.
- Risk: context hints are misread as evidence.
  - Mitigation: explicit `nonEvidenceContext` section and tests.
- Risk: backward compatibility break in persisted sessions.
  - Mitigation: optional field, schema version, fixture tests.
- Risk: generated frontend types are hand-edited.
  - Mitigation: update generator and run generation script.
- Risk: report and snapshot receipt outputs disagree because snapshot id is
  known only after report generation.
  - Mitigation: keep output ids optional and test the lifecycle explicitly.
- Risk: replay cache serves stale `analysis_completed` events with no receipt.
  - Mitigation: bump the completed-analysis SSE quality-gate version and add a
    replay/status test.

## Reviewer Questions

- Is the proposed receipt schema still too broad for a first pass, or are the
  counts/statuses here the minimum viable audit surface?
  - Decision: use the current schema as the minimum viable audit surface, but
    keep every field aggregate/status-only. Do not add raw evidence rows, raw
    SQL, source snippets, or provider secrets.
- Should `AnalysisReceiptV1` live in `orchestratorTypes.ts`, or should
  user-facing contract types move closer to `backend/src/types/dataContract.ts`
  before implementation?
  - Decision: define the user-facing contract in
    `backend/src/types/dataContract.ts` and import it where route/report/SSE
    builders need it. Keep `orchestratorTypes.ts` focused on runtime internals.
- Which receipt fields should be visible in chat versus report-only?
  - Decision: chat shows only compact completion/verification status and, for
    quick mode, the existing `quickRun` chip. Reports, snapshots, CLI artifacts,
    and SSE replay can carry the full receipt.
- Should quick mode keep `quickRun` as a separate field indefinitely, or should
  it become a specialized receipt view later?
  - Decision: keep `quickRun` separate in the first implementation. It is a
    quick-path execution summary, while `analysisReceipt` is the broader
    completion/audit receipt.
- Is it acceptable that report HTML can omit `resultSnapshotId` while SSE,
  snapshot metadata, and CLI artifacts include it?
  - Decision: yes. `resultSnapshotId` remains optional because report HTML can
    be generated before snapshot persistence. Tests should cover the optional
    lifecycle rather than forcing a fake id.
