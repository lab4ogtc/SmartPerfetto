# Trace Config Proposal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe "natural language to trace config proposal" flow that
uses existing deterministic capture config support, keeps user confirmation in
the loop, and records why each data source is suggested.

**Architecture:** Build proposals on top of `traceConfigGenerator.ts` and
existing `smp capture config/android` commands. The first release should be
deterministic: natural language maps to a known capture preset, and the final
config is rendered through the same shared renderer used by `smp capture
config`. Optional model-assisted classification can be added later only if it
preserves the deterministic safety boundary.

**Tech Stack:** TypeScript, Express route/controller, existing capture config
services, `traceConfigGenerator.ts`, CLI `smp capture`, Commander, Supertest,
Jest.

## Global Constraints

- Do not auto-run capture from an LLM proposal.
- Do not auto-enable `--kill-stale`, `--no-guardrails`, sideload, or device
  mutation actions.
- The generated pbtxt must be inspectable and editable before execution.
- Deterministic fallback must work without an LLM provider.
- Trace config proposal output is advice, not evidence about an already loaded
  trace.
- The first release must not require Claude/OpenAI/Provider Manager because
  capture suggestion must work before the user has a trace or AI credentials.

---

## Current State

Code-grounded review update, 2026-07-06:

- `backend/src/services/traceConfigGenerator.ts` exists and exports
  `generateTraceConfig(opts)` plus `TraceIntent`. It returns data-source
  fragments, self-description metadata, rationale, and Spark coverage, but it
  does not render Perfetto textproto.
- Android capture presets and textproto rendering currently live in
  `backend/src/cli-user/services/captureConfig.ts`, not in a shared backend
  service. API implementation must not import CLI internals directly; the
  renderer/preset registry should be extracted to a shared service first.
- Current preset ids are `startup`, `scrolling`, `anr`, `game`, `memory`,
  `cpu`, `power`, `overview`, and `full`. These do not exactly match
  `TraceIntent`; for example `game` maps to `gpu`, and `cpu`/`overview`/`full`
  map to `generic`.
- `smp capture config` already renders textproto without starting capture and
  uses `bootstrap({ requireLlm: false })`.
- `smp capture android` is the side-effectful command. It owns `--sideload`,
  `--no-guardrails`, `--kill-stale`, ADB selection, and optional `--analyze`.
  `capture suggest` must stay on the preview side of this boundary.
- CLI command registration lives in `backend/src/cli-user/bin.ts`, but command
  implementations live in `backend/src/cli-user/commands/capture.ts`.
- Existing focused tests are
  `backend/src/services/__tests__/traceConfigGenerator.test.ts`,
  `backend/src/cli-user/services/__tests__/captureConfig.test.ts`, and
  `backend/src/cli-user/services/__tests__/androidCapture.test.ts`.
- There is no current frontend capture-config UI in the Perfetto plugin. UI
  work should remain optional until CLI/API behavior is stable.

Implementation update, 2026-07-06:

- Added shared renderer service
  `backend/src/services/traceCaptureConfig.ts`; the previous CLI renderer path
  is now a re-export shim.
- Added deterministic proposal service
  `backend/src/services/traceConfigProposal.ts`.
- Added workspace-scoped API route
  `POST /api/workspaces/:workspaceId/trace-config/proposals`.
- Added CLI preview command `smp capture suggest`.
- Added focused service, route, CLI, and shared-renderer tests.
- Deferred the optional Perfetto plugin UI entry point until the API/CLI
  contract has been exercised in product workflows.

Relevant existing files:

- `backend/src/services/traceConfigGenerator.ts`
  - Already maps intents such as `scrolling`, `startup`, `anr`, `memory`,
    `gpu`, `power`, `network`, and `generic` to config fragments and
    self-description metadata.
- `backend/src/types/sparkContracts.ts`
  - Defines `TraceConfigGeneratorContract`, `PerfettoConfigFragment`, and
    provenance fields.
- `backend/src/cli-user/bin.ts`
  - Exposes `smp capture presets`, `smp capture config`, and
    `smp capture android`.
- `backend/src/cli-user/commands/capture.ts`
  - Owns capture command execution and text/json/ndjson output.
- `backend/src/cli-user/services/captureConfig.ts`
  - Owns current preset definitions, textproto rendering, template rendering,
    extra atrace category injection, duration extraction, and buffer sizing.
- `backend/src/cli-user/services/androidCapture.ts`
  - Owns side-effectful ADB/Perfetto execution and preflight warnings.
- `docs/reference/cli.md`
  - Documents current capture flows and `--analyze --mode`.
- `docs/reference/cli.en.md`
  - English CLI reference; must stay in sync with the Chinese CLI doc.
- `README.md` and `README.zh-CN.md`
  - Surface high-level CLI capture examples.

Current known strengths:

- There is already a deterministic config baseline per intent.
- Capture can render config without starting Web UI.
- Capture with `--analyze` already records session config metadata.
- Android capture has existing tests around config rendering, stale process
  cleanup, sideload behavior, and duration extraction.

Current gap:

- Users cannot ask "I need to debug X, what should I record?" and receive a
  reviewable capture proposal with data-source rationale, expected Skill
  coverage, and missing-data warnings.
- The current renderer is CLI-scoped, so shared API/CLI proposal work first
  needs a small extraction to avoid duplicating textproto generation.

## Proposed Contract

Add `TraceConfigProposalV1` as an API/CLI response contract:

```ts
export interface TraceConfigProposalV1 {
  schemaVersion: 1;
  proposalId: string;
  createdAt: number;
  target: 'android';
  input: {
    prompt: string;
    packageName?: string;
    cuj?: string;
    durationSeconds?: number;
  };
  resolvedIntent: TraceIntent;
  preset: CapturePresetId;
  confidence: 'low' | 'medium' | 'high';
  rationale: string[];
  deterministicBaseline: TraceConfigGeneratorContract;
  warnings: Array<{
    code: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
  }>;
  render: {
    textproto: string;
    durationMs: number;
    bufferSizeKb: number;
    commandPreview: string;
    commandArgs: string[];
  };
  approvalRequired: true;
}
```

Design notes:

- `approvalRequired` is always true in the first implementation.
- `commandPreview` is a string for display only. Execution uses structured CLI
  arguments, not shell evaluation of this string.
- `commandArgs` is the structured execution recipe for a future explicit
  `capture android` handoff; it must never include `--kill-stale`,
  `--no-guardrails`, `--sideload`, or `--tracebox`.
- `proposalId` can be a deterministic hash of sanitized input plus rendered
  config. It does not need durable storage in the first release.
- The first implementation uses deterministic keyword/rule mapping only. If a
  later model classifier is added, it may choose among existing presets but must
  still route through this contract and renderer.

## Files and Responsibilities

- Create: `backend/src/services/traceCaptureConfig.ts`
  - Shared capture preset registry and Android textproto renderer, extracted
    from `backend/src/cli-user/services/captureConfig.ts`.
  - Exports `CapturePresetDefinition`, `CAPTURE_PRESETS`,
    `getCapturePreset`, `isCapturePresetId`, `listCapturePresets`,
    `renderAndroidTraceConfig`, `readTraceConfigFile`,
    `renderTraceConfigTemplate`, `addAtraceCategories`,
    `calculateCaptureBufferSizeKb`, and `extractDurationMs`.
- Modify: `backend/src/cli-user/services/captureConfig.ts`
  - Keep as a compatibility re-export shim, or update CLI imports to the shared
    service in the same change.
- Modify: `backend/src/services/traceConfigGenerator.ts`
  - Keep as the intent-level fragment generator. Do not add CLI/API proposal
    orchestration here.
- Create: `backend/src/services/traceConfigProposalService.ts`
  - Own deterministic prompt-to-preset classification, warning generation,
    proposal id generation, and calls into the shared renderer.
- Modify: `backend/src/types/sparkContracts.ts`
  - Add proposal contract only if reviewer agrees this belongs with Spark-era
    contracts. Otherwise keep the contract next to
    `traceConfigProposalService.ts` and export it from there.
- Create: `backend/src/routes/traceConfigProposalRoutes.ts`
  - Expose preview endpoint through a factory-style `createTraceConfigProposalRoutes()`.
- Modify: `backend/src/index.ts`
  - Register workspace-scoped and legacy route mounts if API is included in the
    first release.
- Modify: `backend/src/cli-user/bin.ts`
  - Add `smp capture suggest`.
- Modify: `backend/src/cli-user/commands/capture.ts`
  - Add `runCaptureSuggestCommand`, keeping it side-effect free.
- Modify: `docs/reference/cli.md` and `docs/reference/cli.en.md`
  - Document `capture suggest`.
- Modify: `README.md` and `README.zh-CN.md`
  - Add one short capture-suggest example if CLI behavior changes user-facing
    onboarding.
- Test: `backend/src/services/__tests__/traceConfigProposalService.test.ts`
- Test: `backend/src/services/__tests__/traceCaptureConfig.test.ts`
- Test: `backend/src/cli-user/services/__tests__/captureConfig.test.ts` or
  update imports if this becomes a shim.
- Test: `backend/src/cli-user/commands/__tests__/captureSuggest.test.ts`
- Test: `backend/src/routes/__tests__/traceConfigProposalRoutes.test.ts`

## Implementation Tasks

### Task 1: Extract Shared Capture Config Renderer

**Interfaces:**

- Produces: `backend/src/services/traceCaptureConfig.ts`.
- Consumes: current `backend/src/cli-user/services/captureConfig.ts`.

- [x] Move preset definitions and rendering helpers from
  `backend/src/cli-user/services/captureConfig.ts` into
  `backend/src/services/traceCaptureConfig.ts`.
- [x] Keep exports identical so existing CLI behavior remains unchanged.
- [x] Update CLI imports or leave `cli-user/services/captureConfig.ts` as a
  pure re-export shim.
- [x] Move or duplicate focused tests so shared rendering behavior is covered
  under `backend/src/services/__tests__/traceCaptureConfig.test.ts`.

Validation:

```bash
cd backend
npx jest \
  src/services/__tests__/traceCaptureConfig.test.ts \
  src/cli-user/services/__tests__/captureConfig.test.ts \
  --runInBand
```

Expected result: every existing built-in preset still renders the same
textproto, template rendering still works, and extra atrace category injection
still works.

### Task 2: Create Deterministic Proposal Service

**Interfaces:**

- Consumes:

```ts
export interface TraceConfigProposalInput {
  prompt: string;
  packageName?: string;
  cuj?: string;
  durationSeconds?: number;
}
```

- Produces:

```ts
export function buildTraceConfigProposal(
  input: TraceConfigProposalInput,
  now?: () => number,
): TraceConfigProposalV1;
```

- [x] Implement `inferCapturePresetFromPrompt(prompt): {
  preset: CapturePresetId;
  intent: TraceIntent;
  confidence: 'low' | 'medium' | 'high';
  rationale: string[];
}` with explicit keyword rules.
- [x] Map startup/cold launch to `startup`; scroll/jank/frame drops to
  `scrolling`; ANR/main-thread blocked/input timeout to `anr`; memory/GC/LMK
  to `memory`; GPU/game/render to `game`; power/battery/wakelock to `power`;
  CPU/scheduler/thread state to `cpu`; broad/unknown to `overview`.
- [x] Call `generateTraceConfig({ intent, packageName, cuj })` for baseline
  rationale and coverage.
- [x] Render textproto with `renderAndroidTraceConfig({ target: 'android',
  preset, app: packageName ?? '*', durationSeconds, cuj })`.
- [x] Add warnings for unsupported or unsafe user requests such as automatic
  stale-process killing, disabling guardrails, forced sideload, tracing every
  category, root-only operations, or Linux host tracing.
- [x] Generate `commandArgs` as structured args for `capture android`, excluding
  all dangerous flags and leaving `--out` as an explicit placeholder-free
  suggested filename such as `smartperfetto-capture.perfetto-trace`.

Validation:

```bash
cd backend
npx jest src/services/__tests__/traceConfigProposalService.test.ts --runInBand
```

Expected result: prompt-to-intent and warnings are deterministic.

### Task 3: Add API Preview Endpoint

**Interfaces:**

- Route: `POST /api/workspaces/:workspaceId/trace-config/proposals`
- Legacy route if kept for source compatibility:
  `POST /api/trace-config/proposals`
- Response: `{ success: true, proposal: TraceConfigProposalV1 }`

- [x] Add `createTraceConfigProposalRoutes()` with request validation.
- [x] Register route in `backend/src/index.ts`.
- [x] Ensure the route does not require a loaded trace.
- [x] Ensure route returns a preview only and never starts capture.
- [x] Keep auth/workspace context behavior consistent with other workspace
  APIs. If the legacy route is added, mark it as legacy in the same style as
  existing legacy mounts.

Validation:

```bash
cd backend
npx jest src/routes/__tests__/traceConfigProposalRoutes.test.ts --runInBand
```

Expected result: endpoint returns a proposal and rejects invalid duration or
unsafe auto-execution flags.

### Task 4: Add CLI Suggest Command

**Interfaces:**

- CLI: `smp capture suggest "debug startup jank" --app com.example --duration 15`
- Formats: `text`, `json`.

- [x] Add command parser in `backend/src/cli-user/bin.ts`.
- [x] Add `runCaptureSuggestCommand` in
  `backend/src/cli-user/commands/capture.ts`.
- [x] Text output prints chosen preset, rationale, warnings, command preview,
  and textproto.
- [x] JSON output prints full `TraceConfigProposalV1`.
- [x] Do not call `captureAndroidTrace`, ADB, or `CliAnalyzeService`.

Validation:

```bash
cd backend
npm run cli:dev -- capture suggest "debug startup jank" --app com.example --format json
```

Expected result: valid JSON proposal with no capture side effects.

### Task 5: UI Entry Point

Implemented in the AI Assistant panel as a side-effect-free preview surface.

- [x] Add a "Suggest capture config" entry in the AI Assistant connection or
  capture area.
- [x] Show proposal rationale and textproto preview.
- [x] Require explicit user action before capture.
- [x] Keep dangerous flags off by default and visually separated.

Validation:

- [x] Browser smoke in `./scripts/start-dev.sh --quick`.
- [x] Frontend tests for UI payload helpers.
- [x] `./scripts/update-frontend.sh` after UI prebuild changes.

### Task 6: Documentation and Gates

- [x] Update Chinese and English CLI docs.
- [x] Add examples for `startup`, `scrolling`, `power`, and `generic`.
- [x] Run focused tests.
- [x] Run `cd backend && npm run typecheck`.
- [x] Run `git diff --check`.
- [x] Run the command smoke:

```bash
cd backend
npm run cli:dev -- capture suggest "debug startup jank" --app com.example --format json
```

- [x] If route/API behavior lands, run:

```bash
cd backend
npx jest src/routes/__tests__/traceConfigProposalRoutes.test.ts --runInBand
```

- [x] If capture execution behavior changes, run the existing focused capture
  tests from `backend/package.json`: `captureConfig.test.ts`,
  `captureTools.test.ts`, and `androidCapture.test.ts`.
- [x] Before release-ready implementation under the parent project goal, run
  Claude and Deepseek-backed OpenAI Agent SSE e2e as requested, even though
  deterministic `capture suggest` itself must not require an LLM provider.

## Implementation Standard Checklist

This feature is not implementation-ready until a reviewer can answer "yes" to
all of these:

- Does `capture suggest` share the same renderer as `capture config`?
- Does the API avoid importing from `backend/src/cli-user/**`?
- Does every proposal stay side-effect free, with no ADB calls and no trace
  capture?
- Are dangerous execution flags absent from structured command args and called
  out as warnings if the user asks for them?
- Does deterministic prompt classification choose only existing presets?
- Does the output remain useful without AI credentials or a loaded trace?
- Are Chinese and English CLI docs updated together?

## Risks and Mitigations

- Risk: users assume suggested config is optimal.
  - Mitigation: show confidence, rationale, and expected coverage.
- Risk: model proposes unsupported Perfetto data sources.
  - Mitigation: final proposal must pass deterministic renderer/validator.
- Risk: unsafe device operations are hidden inside suggestion.
  - Mitigation: no auto-execution, structured flags, dangerous options off.
- Risk: duplicated config rendering logic.
  - Mitigation: extract shared renderer instead of copying CLI code.
- Risk: route imports CLI internals and creates a backwards dependency from
  backend API to CLI packaging.
  - Mitigation: move preset/rendering helpers into shared `services/` first.
- Risk: "natural language" implies AI/provider dependency.
  - Mitigation: first release is deterministic keyword classification only.

## Reviewer Questions

- Should the first pass be CLI/API only, with UI deferred?
  - Decision: first pass is CLI plus workspace API. UI can follow after the API
    response shape is stable; it is not required for the first implementation.
- Should LLM classification be explicitly out of scope for the first release,
  given that deterministic proposal already covers the main user workflow?
  - Decision: yes. First release uses deterministic keyword/intent mapping to
    existing presets only. Model-assisted classification is a later enhancement.
- Which trace intents need real-device smoke before release?
  - Decision: smoke `startup` and `scrolling` on at least one Android device
    before release. `power` needs device smoke only if the implementation changes
    capture execution flags beyond config rendering; `generic` can stay renderer
    and command-shape tested.
- Should proposal ids be persisted, or should they be transient until capture
  execution creates a normal session artifact?
  - Decision: proposal ids are transient. Persistence starts only when a user
    executes capture and the normal capture/session artifacts exist.
- Should the API be workspace-scoped only, or should a legacy
  `/api/trace-config/proposals` route be kept for local/source compatibility?
  - Decision: first API is workspace-scoped. CLI covers local/source workflows;
    add a legacy route only if an existing frontend or portable path cannot use
    workspace context.
