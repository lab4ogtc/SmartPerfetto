# UI Action Proposal Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let SmartPerfetto analysis results propose safe UI actions such as
timeline navigation, range highlighting, table opening, and evidence pinning,
while keeping the user in control of execution.

**Architecture:** First derive action proposals from existing DataEnvelope
display metadata and evidence/source context, not free-form model JSON. The
backend can expose sanitized proposal metadata, and the frontend validates it
again against the same whitelist before rendering click-to-execute buttons. No
model output directly drives the Perfetto UI.

**Tech Stack:** TypeScript, SSE `analysis_completed` metadata, DataEnvelope
display metadata, generated frontend types, Mithril-based Perfetto plugin,
existing timeline/navigation helpers, Jest/front-end unit tests.

## Global Constraints

- All actions are proposals until the user clicks or confirms.
- The frontend must validate every action kind and payload before execution.
- Model output must not execute arbitrary commands, SQL, shell, network calls,
  or code edits.
- UI action proposals are not evidence. They point users back to evidence.
- The first release should reuse current `ColumnDefinition.clickAction`
  semantics and must not introduce arbitrary UI commands.
- Plugin source changes require dev-mode browser verification and committed
  frontend prebuild refresh before landing.

---

## Current State

Code-grounded review update, 2026-07-06:

- `backend/src/types/dataContract.ts` already defines `ClickAction` and
  `ColumnDefinition.clickAction`. Valid click actions are `none`,
  `navigate_timeline`, `navigate_range`, `copy`, `expand`, `filter`, and
  `link`.
- `SqlResultTable` already executes timestamp navigation from table cells using
  `trace.scrollTo`, and emits focus-tracking `UserInteraction` events on
  timestamp/entity clicks.
- `renderers/formatters.ts` already marks `navigate_timeline` and
  `navigate_range` columns as clickable.
- `track_overlay.ts` is a DataEnvelope stepId-to-overlay registry for known
  overlay types. It is not a generic "highlight arbitrary track" command
  surface.
- `assistant_command_bus.ts` currently only supports `clear-chat` and
  `open-settings`; using it as a generic action bus would require extending the
  command taxonomy, which is not necessary for a first milestone.
- `AIPanel` already has `jumpToTimestamp(...)`, `/goto` tests, copy helpers,
  table source metadata rendering, pinning callbacks, and overlay replay.
- `sse_event_handlers.ts` already carries DataEnvelope source context and
  structured SQL result metadata into messages.
- There is no current `uiActionProposals` field in backend result types,
  `analysis_completed`, frontend generated types, or `Message`.

Relevant existing files:

- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sql_result_table.ts`
  - Supports `clickAction` such as `navigate_timeline` and `navigate_range`.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/renderers/formatters.ts`
  - Formats display metadata for interactive values.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`
  - Captures selection context and sends it to backend.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers.ts`
  - Handles final events and structured result metadata.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/index.ts`
  - Registers plugin commands.
- `backend/scripts/generateFrontendTypes.ts`
  - Owns frontend contract generation.
- `backend/src/agent/core/orchestratorTypes.ts`
  - Central place for analysis result payload types.
- `backend/src/types/dataContract.ts`
  - Source of truth for `ClickAction`, `ColumnDefinition`, and
    `AnalysisCompletedEvent`.

Current known strengths:

- The UI already supports table-cell navigation based on typed column metadata.
- The backend already emits structured DataEnvelope output and selection
  context.
- The plugin has timeline interaction points, source-context chips, table
  pin/copy behavior, and overlay creation for known DataEnvelope steps.

Current gap:

- AI cannot provide a small set of structured next-step UI proposals in the
  final result. Users must manually translate text into UI navigation.
- Existing clickable table cells are useful but hidden inside tables; there is
  no compact "next actions" row on the final assistant message that points to
  the most relevant evidence-backed locations.

## Implementation Update, 2026-07-06

Plan 3 is implemented as a deterministic, evidence-backed proposal layer.

- Backend contract now exposes `UiActionProposalV1` on analysis results,
  `analysis_completed`, snapshots, HTML reports, report data, multi-trace
  summaries, CLI reports, and CLI turn sidecars.
- `uiActionProposalSanitizer` strictly accepts only
  `navigate_timeline`, `navigate_range`, `open_evidence_table`, and
  `pin_evidence`, rejects extra executable payload keys, rejects invalid or
  mismatched trace ids, dedupes proposals, and caps output at five proposals.
- `uiActionProposalDeriver` derives first-release proposals from existing
  DataEnvelope source context and `ColumnDefinition.clickAction` metadata. It
  does not trust model-authored free-form JSON.
- Frontend generated types, SSE handlers, message state, AIPanel rendering, and
  `ui_action_proposals.ts` execute proposals only after a user click. Timeline
  navigation validates bounds against the active trace; evidence-table and pin
  proposals operate on existing assistant messages/tables.
- HTML reports persist proposal metadata for provenance only. Report output does
  not execute proposals.
- Strategy/prompt guidance remains out of scope for this milestone; model
  authored proposals are intentionally not enabled.

Verification completed:

```bash
cd backend && npx jest src/services/__tests__/uiActionProposalSanitizer.test.ts src/services/__tests__/uiActionProposalDeriver.test.ts src/services/__tests__/agentResultNormalizer.test.ts src/services/__tests__/analysisResultSnapshotPipeline.test.ts src/services/__tests__/htmlReportGenerator.test.ts src/cli-user/services/__tests__/turnPersistence.test.ts src/routes/__tests__/agentRoutesRbac.test.ts --runInBand
cd backend && npm run generate:frontend-types
cd perfetto/ui && npx vitest run --config vitest.config.mjs src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers_unittest.ts src/plugins/com.smartperfetto.AIAssistant/ui_action_proposals_unittest.ts
cd backend && npm run typecheck
cd backend && npm run build
cd perfetto/ui && npm run build
./scripts/update-frontend.sh
npm run check:frontend-prebuild
./scripts/start-dev.sh --quick
cd backend && npm run verify:e2e:quick
cd backend && npm run verify:e2e:deepseek-startup
```

Artifact inspection confirmed the generated reports contain a `UI 动作提案`
section with evidence-backed `pin_evidence`, `navigate_range`, and
`open_evidence_table` entries.

## Proposed Contract

Add `UiActionProposalV1`:

```ts
export type UiActionKind =
  | 'navigate_timeline'
  | 'navigate_range'
  | 'open_evidence_table'
  | 'pin_evidence';

export interface UiActionProposalV1 {
  schemaVersion: 1;
  id: string;
  kind: UiActionKind;
  title: string;
  reason: string;
  source: {
    evidenceRefId?: string;
    artifactId?: string;
    skillId?: string;
    sourceToolCallId?: string;
    reportSection?: string;
  };
  payload:
    | { ts: string; traceId?: string }
    | { startNs: string; endNs: string; traceId?: string }
    | { artifactId: string; evidenceRefId?: string }
    | { evidenceRefId: string };
  requiresConfirmation: true;
}
```

Payload validation by kind:

- `navigate_timeline`: `{ ts: string; traceId?: string }`
- `navigate_range`: `{ startNs: string; endNs: string; traceId?: string }`
- `open_evidence_table`: `{ artifactId: string; evidenceRefId?: string }`
- `pin_evidence`: `{ evidenceRefId: string }`

Design notes:

- Use stringified nanoseconds, matching existing frontend/backend JSON practice
  for timestamp precision. The frontend converts to `BigInt` only after
  validation.
- Do not include `highlight_track` in the first release. Existing overlay tracks
  are created from known DataEnvelope step ids, not arbitrary model proposals.
- Do not include `copy_sql` in the first release. SQL copy behavior should stay
  tied to existing table/query artifacts until SQL provenance is stronger.
- The first implementation should derive proposals from DataEnvelope
  `ColumnDefinition.clickAction`, source context, and claim/evidence refs. A
  later model can request proposals only through this sanitizer and only with
  evidence pointers.

## Files and Responsibilities

- Modify: `backend/src/agent/core/orchestratorTypes.ts`
  - Add `UiActionProposalV1` and optional result field.
- Modify: `backend/src/types/dataContract.ts`
  - Add optional `uiActionProposals` to `AnalysisCompletedEvent.data` and
    generated frontend contract source.
- Modify: `backend/src/services/agentResultNormalizer.ts`
  - Preserve action proposals from runtime/final result metadata.
- Modify: `backend/src/routes/agentRoutes.ts`
  - Attach proposals to `analysis_completed` after validation/sanitization.
- Create: `backend/src/services/uiActionProposalSanitizer.ts`
  - Validate backend-side proposal shape and remove unsupported actions.
- Create: `backend/src/services/uiActionProposalDeriver.ts`
  - Derive first-pass proposals from DataEnvelope tables, display column
    metadata, and evidence/source context.
- Modify: `backend/scripts/generateFrontendTypes.ts`
  - Generate frontend contract.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/types.ts`
  - Add message-side `uiActionProposals` field if local UI types are still
    maintained separately from generated types.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers.ts`
  - Store action proposals on the final assistant message.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`
  - Render proposal buttons or menu entries.
- Create: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ui_action_proposals.ts`
  - Frontend whitelist validation and execution helpers.
- Test: `backend/src/services/__tests__/uiActionProposalSanitizer.test.ts`
- Test: `backend/src/services/__tests__/uiActionProposalDeriver.test.ts`
- Test: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ui_action_proposals_unittest.ts`
- Test: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers_unittest.ts`
- Test: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel_navigation_unittest.ts`

## Implementation Tasks

### Task 1: Define and Sanitize Backend Proposal Shape

**Interfaces:**

- Produces:

```ts
export function sanitizeUiActionProposals(
  value: unknown,
  options?: { maxItems?: number; traceId?: string },
): UiActionProposalV1[];
```

- Consumes: optional runtime result metadata.

- [x] Add contract type.
- [x] Implement sanitizer that rejects unknown `kind`, missing title/reason,
  invalid stringified nanoseconds, invalid ranges, mismatched trace ids, and
  unsupported payload keys.
- [x] Limit proposal count per message, for example maximum 5.
- [x] Ensure proposals keep evidence pointers but not raw artifact rows.
- [x] Reject `highlight_track`, `copy_sql`, `shell`, `sql`, URL, arbitrary
  command, and unknown action kinds.

Validation:

```bash
cd backend
npx jest src/services/__tests__/uiActionProposalSanitizer.test.ts --runInBand
```

Expected result: invalid or over-broad proposals are dropped.

### Task 2: Derive Proposals From Existing Evidence Metadata

**Interfaces:**

- Produces:

```ts
export function deriveUiActionProposals(input: {
  dataEnvelopes: DataEnvelope[];
  claimSupport?: ClaimSupportV1[];
  maxItems?: number;
  traceId?: string;
}): UiActionProposalV1[];
```

- Consumes: DataEnvelope display metadata, column definitions, evidence refs,
  and source context.

- [x] Derive `navigate_timeline` proposals from timestamp columns whose
  `clickAction` is `navigate_timeline`.
- [x] Derive `navigate_range` proposals from timestamp + duration columns whose
  `clickAction` is `navigate_range`.
- [x] Derive `open_evidence_table` proposals from DataEnvelope source context
  only when an artifact/evidence ref exists.
- [x] Derive `pin_evidence` proposals only for evidence refs that already exist
  in claim support or DataEnvelope source metadata.
- [x] Prefer high-signal current-trace evidence tables and cap the final list.

Validation:

```bash
cd backend
npx jest src/services/__tests__/uiActionProposalDeriver.test.ts --runInBand
```

Expected result: proposals are deterministic and evidence-backed.

### Task 3: Thread Proposals Through Completion Payload

**Interfaces:**

- Produces: `analysis_completed.uiActionProposals`.
- Consumes: derived proposals and sanitized runtime proposals.

- [x] Preserve proposals in `agentResultNormalizer` if runtimes later provide
  them.
- [x] In `agentRoutes.ts`, derive proposals from `session.dataEnvelopes` and
  quality artifacts at completion time.
- [x] Merge derived and sanitized runtime proposals, dedupe by id, cap count,
  and attach the result to `analysis_completed`.
- [x] Keep missing proposals as an empty/absent field for compatibility.
- [x] Add route test proving unsupported action kinds are removed.

Validation:

```bash
cd backend
npx jest src/services/__tests__/agentResultNormalizer.test.ts --runInBand
```

Expected result: valid proposals survive normalization without affecting final
text conclusion.

### Task 4: Add Frontend Proposal Rendering

**Interfaces:**

- Produces: proposal buttons on completed assistant message.
- Consumes: generated `UiActionProposalV1`.

- [x] Generate frontend types.
- [x] Add `ui_action_proposals.ts` with whitelist validation.
- [x] Render proposal buttons with concise labels.
- [x] Execute only after user click.
- [x] Execute `navigate_timeline` and `navigate_range` through the same
  `trace.scrollTo` semantics as `SqlResultTable`/`AIPanel.jumpToTimestamp`.
- [x] Execute `open_evidence_table` by focusing or scrolling to an existing
  assistant message/table, not by issuing a new SQL query.
- [x] Execute `pin_evidence` through the existing table/message pin behavior if
  the evidence table is present; otherwise render disabled with a reason.
- [x] If payload cannot be executed in the current trace/session/UI state, show
  a disabled state with reason.

Validation:

```bash
cd backend && npm run generate:frontend-types
```

Then run the frontend unit test command available for the plugin in the
current checkout.

### Task 5: Add Optional Strategy Guidance Without Hardcoding Prompt Text

**Interfaces:**

- Produces: strategy/template instructions for action proposal formatting.
- Consumes: `backend/strategies/*.template.md` or shared final-report template.

- [x] Keep this task out of the first milestone unless reviewers explicitly want
  model-authored proposals.
- [x] If included later, add a small template section that asks the model to
  propose UI actions only when it can cite evidence.
- [x] Forbid proposals without evidence pointers.
- [x] Validate strategies.

Validation:

```bash
cd backend
npm run validate:strategies
```

Expected result: strategy validation passes and no TypeScript prompt strings
were added.

### Task 6: Run Integration Gates

- [x] Backend focused tests.
- [x] Frontend proposal tests.
- [x] `cd backend && npm run typecheck`.
- [x] `git diff --check`.
- [x] If plugin UI changed, browser verification in dev mode.
- [x] If committed frontend output is needed, run `./scripts/update-frontend.sh`.
- [x] Before release-ready implementation under the parent project goal, run
  Claude and Deepseek-backed OpenAI Agent SSE e2e and inspect the generated
  action proposals for evidence support.

## Implementation Standard Checklist

This feature is not implementation-ready until a reviewer can answer "yes" to
all of these:

- Are first-release proposals derived from current DataEnvelope/evidence
  metadata rather than free-form model JSON?
- Does backend sanitization reject every unsupported action kind and every
  payload with extra executable behavior?
- Does frontend validation repeat the backend whitelist instead of trusting SSE?
- Do navigation actions reuse existing `trace.scrollTo` bounds checks and
  timestamp precision behavior?
- Are `highlight_track` and `copy_sql` explicitly out of scope for the first
  release?
- Does chat stay compact while reports/snapshots retain provenance?
- Are generated frontend types regenerated rather than edited manually?

## Risks and Mitigations

- Risk: model controls UI directly.
  - Mitigation: first release derives actions deterministically; proposals only,
    frontend whitelist, user click required.
- Risk: action payloads become arbitrary JSON with hidden behavior.
  - Mitigation: strict payload schema per action kind.
- Risk: final answers become cluttered with buttons.
  - Mitigation: cap count and render as a compact action row.
- Risk: proposals point to stale evidence after trace/session switch.
  - Mitigation: validate trace id/session id before enabling execution.
- Risk: overlay/highlight work duplicates existing `track_overlay.ts`.
  - Mitigation: leave track overlays on the existing DataEnvelope stepId
    registry and exclude arbitrary `highlight_track`.

## Reviewer Questions

- Should action proposals be generated by the model or derived deterministically
  from DataEnvelope click metadata in the first pass?
  - Decision: derive them deterministically from current DataEnvelope and
    evidence metadata in the first pass. Model-authored proposals stay out of
    scope until evidence-cited proposal formatting is separately reviewed.
- Which action kinds are safe enough for the first milestone?
  - Decision: `navigate_timeline`, `navigate_range`, `open_evidence_table`,
    and `pin_evidence`.
- Should `copy_sql` and `highlight_track` stay omitted until SQL provenance and
  overlay command surfaces are stronger?
  - Decision: yes. Keep both omitted from the first milestone.
- Should action proposals be persisted into reports, or only live in the UI?
  - Decision: persist sanitized proposal metadata with snapshots/reports for
    provenance, but keep execution state UI-local and user-click driven.
- Should `open_evidence_table` scroll to the existing table, or should it create
  a separate evidence drawer in a later UI milestone?
  - Decision: scroll/focus the existing table first. A separate evidence drawer
    is a later UI feature.
