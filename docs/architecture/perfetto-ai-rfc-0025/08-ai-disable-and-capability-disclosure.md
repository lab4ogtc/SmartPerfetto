# AI Disable and Capability Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide an explicit SmartPerfetto AI disable mode and clear runtime
capability disclosure so users can run trace, SQL, deterministic Skill,
report, provider configuration, and capture flows without accidentally invoking
LLM-backed analysis.

**Architecture:** Add a backend-enforced AI capability policy that fails closed
for LLM/runtime use while leaving deterministic trace processor and
configuration flows available. The first release is an environment-level policy
that is exposed through health, CLI doctor, API errors, and Perfetto UI panels.
Workspace-scoped policy can be added later only after a real persisted workspace
settings surface exists.

**Tech Stack:** TypeScript, Express route helpers, runtime selection,
Provider Manager routes, CLI runtime guard, health endpoint, Perfetto UI plugin,
Jest, existing repository verification commands.

## Global Constraints

- Disable mode must be enforced in backend and CLI paths, not only hidden in
  the UI.
- Do not make provider/runtime configuration disappear. Users should still be
  able to inspect and edit provider profiles while AI is disabled.
- Provider connection tests and model-backed analysis must not make network or
  model calls while AI is disabled.
- Existing Provider Manager runtime pinning and persisted session snapshot
  semantics must remain intact when AI is enabled.
- Deterministic commands should remain available: SQL, trace upload/read,
  capture config rendering, Android capture without analysis, report reads,
  provider list/edit/switch, and deterministic Skill execution.
- Client-side disclosure is advisory only. Every LLM entrypoint must have a
  server-side or CLI guard.

---

## Current State

Relevant existing files:

- `backend/src/config/index.ts`
  - `resolveFeatureConfig()` currently exposes `enterprise` only.
  - `parseFeatureFlag()` already accepts common true/false spellings but is
    private to this module.
- `backend/src/agentRuntime/runtimeSelection.ts`
  - `resolveAgentRuntimeSelection()` chooses explicit provider, active
    Provider Manager profile, runtime override, `SMARTPERFETTO_AGENT_RUNTIME`,
    experimental runtime env, then the Claude default.
  - `createAgentOrchestrator()` currently creates a runtime registry and
    orchestrator without checking a global AI policy.
- `backend/src/agentRuntime/runtimeHealth.ts`
  - `buildRuntimeHealthPayload()` returns `aiEngine.runtime`, model,
    provider mode, configuration status, credential source, active provider,
    auth requirement, and diagnostics.
  - There is no `aiPolicy` field yet.
- `backend/src/index.ts`
  - `GET /health` returns `buildRuntimeHealthPayload()`.
  - Workspace provider routes are mounted at
    `/api/workspaces/:workspaceId/providers`; legacy routes are mounted at
    `/api/v1/providers`.
- `backend/src/routes/agentRoutes.ts`
  - `POST /analyze` and `POST /sessions/:sessionId/runs` both call
    `handleAnalyzeRequest()`.
  - `handleAnalyzeRequest()` prepares an `AnalysisSession`, may start smart
    analysis, may acquire trace processor leases, then calls
    `runAgentDrivenAnalysis()`.
  - `POST /:sessionId/respond` and `POST /sessions/:sessionId/respond` are
    currently compatibility endpoints for continue/abort and do not themselves
    invoke a model, but future continue semantics should still be policy-aware.
- `backend/src/assistant/application/agentAnalyzeSessionService.ts`
  - `prepareSession()` creates or recreates orchestrators for new sessions,
    restored sessions, and provider snapshot changes.
- `backend/src/routes/agentResumeRoutes.ts`
  - `POST /resume` restores persisted sessions and directly creates an
    orchestrator after trace/session validation.
- `backend/src/routes/agentSceneReconstructRoutes.ts`
  - `POST /scene-reconstruct` creates an orchestrator before starting the scene
    story pipeline.
  - Preview and report read endpoints are cheap/deterministic and should remain
    available.
- `backend/src/routes/providerRoutes.ts`
  - Provider list, create, update, delete, activate, runtime switch, and secret
    rotation are route-owned.
  - `POST /:id/test` directly calls `testProviderConnection(provider)`.
- `backend/src/cli-user/services/runtimeGuard.ts`
  - `assertAnalysisRuntimeReady()` is used by CLI analyze/resume/compare,
    REPL, and `capture android --analyze`.
  - `collectDoctorReport()` builds runtime diagnostics and is used by
    `smp doctor`.
- `backend/src/cli-user/commands/provider.ts`
  - `smp provider test` bypasses `assertAnalysisRuntimeReady()` and calls
    `testProviderConnection()` directly.
- `backend/src/services/skillEngine/skillExecutor.ts`
  - `SkillExecutor` supports `ai_decision` and `ai_summary` steps.
  - `executeAIDecisionStep()` and `executeAISummaryStep()` eventually call
    `callAI()` when an AI service is available.
  - Deterministic Skill execution can run without an AI service today, but
    AI-backed Skill steps need an explicit policy guard.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/types.ts`
  - `ServerStatus` reflects the current `/health` `aiEngine` shape.
  - The runtime union currently covers only `claude-agent-sdk` and
    `openai-agents-sdk`, while backend selection can also expose Pi and
    OpenCode runtimes.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`
  - `checkServerStatus()` fetches `/health` and caches `ServerStatus`.
  - Natural language messages and `/analyze` converge through `sendMessage()`.
  - Deterministic slash commands such as `/sql`, `/goto`, `/pins`, `/clear`,
    and `/help` share the same input surface.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/provider_panel.ts`
  - `testConnection(id)` posts to `/:id/test`.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_area_selection_tab.ts`
  - The "AI deep analysis" button can start analysis outside the main chat
    input.

Current known strengths:

- Runtime selection and provider activation already have explicit source
  tracking.
- Health and CLI doctor already expose runtime/provider diagnostics.
- CLI analysis commands already share a single runtime guard.
- Provider tests are isolated enough to block at one HTTP route and one CLI
  command before network calls happen.

Current gap:

- There is no single policy that says "LLM-backed AI is disabled" and no common
  error shape for API, CLI, health, and UI disclosure.
- Some model entrypoints are not obvious from route names: persisted-session
  restore, scene reconstruction start, provider snapshot refresh, and provider
  connection tests can all reach AI/runtime or provider network code.

## Proposed Contract

Add `AiCapabilityPolicyV1`:

```ts
export type AiCapabilityFeature =
  | 'trace_upload'
  | 'execute_sql'
  | 'invoke_deterministic_skill'
  | 'capture_config'
  | 'capture_android'
  | 'report_read'
  | 'provider_config_read'
  | 'provider_config_write'
  | 'provider_switch'
  | 'agent_analyze'
  | 'agent_resume'
  | 'scene_reconstruct_start'
  | 'provider_test'
  | 'cli_provider_test'
  | 'capture_analyze'
  | 'llm_skill_step'
  | 'background_review_agent';

export interface AiCapabilityPolicyV1 {
  schemaVersion: 1;
  aiEnabled: boolean;
  source: 'env' | 'system_default';
  disabledReason?: string;
  env?: {
    key: 'SMARTPERFETTO_AI_ENABLED';
    rawValue?: string;
    valid: boolean;
  };
  allowedDeterministicFeatures: AiCapabilityFeature[];
  blockedFeatures: AiCapabilityFeature[];
  blockingError?: {
    code: 'AI_DISABLED';
    message: string;
    retryable: false;
  };
}
```

Policy input:

- Env: `SMARTPERFETTO_AI_ENABLED`
- Missing env: AI enabled, `source: 'system_default'`.
- Accepted false values: `0`, `false`, `no`, `off`, `disabled`.
- Accepted true values: `1`, `true`, `yes`, `on`, `enabled`.
- Invalid explicit value: fail closed with `aiEnabled: false`,
  `source: 'env'`, `env.valid: false`, and `disabledReason` explaining the
  invalid value.

First milestone:

- Environment-level disable only.
- No workspace-setting implementation until there is a real workspace settings
  persistence contract.
- Backend/CLI enforcement before UI affordances.
- Health and CLI doctor disclosure.
- Frontend banners and disabled LLM actions while deterministic slash commands
  remain available.

Out of scope for first milestone:

- Remote policy management.
- Per-user or per-workspace toggles.
- Canceling already-running model calls when the env value changes at runtime.
  New entrypoints are blocked; long-running processes should be restarted to
  apply env changes predictably.
- Provider test override while disabled.

## Files and Responsibilities

- Create: `backend/src/services/aiCapabilityPolicy.ts`
  - Resolve `AiCapabilityPolicyV1` from env.
  - Export `resolveAiCapabilityPolicy(env)`, `getAiCapabilityPolicy()`,
    `isAiFeatureEnabled(feature)`, and an `AiDisabledError`/error helper.
- Create: `backend/src/routes/aiCapabilityPolicyHttp.ts` or keep equivalent
  helpers near route utilities.
  - Convert `AiDisabledError` into the shared 403 JSON shape.
  - Provide route preflight helpers such as
    `requireAiEnabledForHttp(res, 'agent_analyze')`.
- Modify: `backend/src/agentRuntime/runtimeSelection.ts`
  - Add a defensive policy check in `createAgentOrchestrator()`.
  - Do not block `resolveAgentRuntimeSelection()` because health/doctor still
    need runtime disclosure while AI is disabled.
- Modify: `backend/src/agentRuntime/runtimeHealth.ts`
  - Include top-level `aiPolicy`.
  - Also include `aiEngine.aiEnabled` and `aiEngine.disabledReason` for the UI
    code that already reads `aiEngine`.
- Modify: `backend/src/routes/agentRoutes.ts`
  - Preflight `POST /analyze` and `POST /sessions/:sessionId/runs` before
    `prepareSession()` so disabled requests do not create sessions, acquire
    leases, or touch providers.
  - Keep abort/respond compatibility available, but make future continue
    actions policy-aware.
- Modify: `backend/src/assistant/application/agentAnalyzeSessionService.ts`
  - Rely on the `createAgentOrchestrator()` guard as the final safety net for
    service-level callers.
- Modify: `backend/src/routes/agentResumeRoutes.ts`
  - Preflight `POST /resume` before restoring orchestrator state.
- Modify: `backend/src/routes/agentSceneReconstructRoutes.ts`
  - Block `POST /scene-reconstruct` when AI is disabled.
  - Keep preview and report read endpoints available.
- Modify: `backend/src/routes/providerRoutes.ts`
  - Block `POST /:id/test` before calling `testProviderConnection()`.
  - Keep provider list/create/edit/activate/runtime switch/secret rotation
    available because they are configuration operations, not model calls.
- Modify: `backend/src/cli-user/services/runtimeGuard.ts`
  - Add `aiPolicy` to `DoctorReport`.
  - Make `assertAnalysisRuntimeReady()` throw an `AI_DISABLED` message before
    credential or binary checks.
- Modify: `backend/src/cli-user/commands/provider.ts`
  - Block `smp provider test` before provider network calls.
  - Keep `smp provider list` available.
- Modify: `backend/src/services/skillEngine/skillExecutor.ts`
  - Block `ai_decision`, `ai_summary`, and fallback AI calls with
    `llm_skill_step` while AI is disabled.
  - Keep deterministic SQL/condition/output Skill steps available.
- Modify: `backend/src/cli-user/commands/doctor.ts`
  - Print policy state in text output and include it in JSON/NDJSON.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/types.ts`
  - Add `AiCapabilityPolicy` and attach it to `ServerStatus`.
  - Widen runtime typing to match current backend runtime kinds, including Pi
    and OpenCode values.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`
  - Parse `data.aiPolicy` and `aiEngine.aiEnabled`.
  - Render disabled-state disclosure.
  - Block natural-language and model-backed commands client-side when disabled.
  - Keep deterministic slash commands such as `/sql`, `/goto`, `/pins`,
    `/clear`, and `/help` usable.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/provider_panel.ts`
  - Surface disabled policy state.
  - Disable test buttons and show backend `AI_DISABLED` responses cleanly.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/provider_switcher.ts`
  - Provider switching can remain enabled; label the result as configuration
    that takes effect when AI is enabled if the policy is disabled.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_area_selection_tab.ts`
  - Disable the "AI deep analysis" action when policy is disabled.
- Modify: `docs/getting-started/configuration.md` and
  `docs/getting-started/configuration.en.md`
  - Document `SMARTPERFETTO_AI_ENABLED=false`, affected features, and
    deterministic features that remain available.
- Update reference docs if response shapes are documented:
  - `docs/reference/api.md`
  - `docs/reference/cli.md`

## Implementation Tasks

### Task 1: Add Policy Resolver

**Interfaces:**

- Produces: `AiCapabilityPolicyV1`
- Consumes: `SMARTPERFETTO_AI_ENABLED`

- [x] Implement `backend/src/services/aiCapabilityPolicy.ts`.
- [x] Use explicit accepted true/false value sets.
- [x] Default to enabled only when env is absent.
- [x] Fail closed for invalid explicit env values.
- [x] Add stable blocked and allowed feature lists.
- [x] Add reusable `AI_DISABLED` error helpers.

Validation:

```bash
cd backend
npx jest src/services/__tests__/aiCapabilityPolicy.test.ts --runInBand
```

Expected result: policy resolution is deterministic and does not inspect
provider credentials or runtime state.

### Task 2: Enforce Backend Runtime and Route Boundaries

**Interfaces:**

- Produces: consistent 403 `AI_DISABLED` response for model-backed API calls.
- Consumes: policy resolver and HTTP helper.

- [x] Add the defensive guard to `createAgentOrchestrator()`.
- [x] Preflight `POST /api/agent/v1/analyze`.
- [x] Preflight `POST /api/agent/v1/sessions/:sessionId/runs`.
- [x] Preflight explicit `POST /api/agent/v1/resume`.
- [x] Preflight `POST /api/agent/v1/scene-reconstruct`.
- [x] Keep scene preview/report read routes available.
- [x] Keep deterministic SQL, trace, and report read routes available.
- [x] Add focused route tests that assert no session/run/lease/provider work is
  started after an AI-disabled request.

Validation:

```bash
cd backend
npx jest \
  src/services/__tests__/aiCapabilityPolicy.test.ts \
  src/agentRuntime/__tests__/runtimeSelection.test.ts \
  src/routes/__tests__/agentRoutesRbac.test.ts \
  --runInBand
```

Expected result: disabled mode blocks runtime creation and model-backed routes,
without changing enabled-mode behavior.

### Task 3: Enforce Provider Test Boundaries

**Interfaces:**

- Produces: `AI_DISABLED` for provider connection tests.
- Consumes: Provider Manager routes and CLI provider command.

- [x] Block HTTP `POST /api/workspaces/:workspaceId/providers/:id/test`.
- [x] Block legacy HTTP `POST /api/v1/providers/:id/test`.
- [x] Block `smp provider test`.
- [x] Keep provider list/create/edit/activate/runtime switch/secret rotation
  available.
- [x] Ensure test failures never include provider secrets.

Validation:

```bash
cd backend
npx jest \
  src/services/providerManager/__tests__/providerRoutes.test.ts \
  src/cli-user/commands/__tests__/provider.test.ts \
  --runInBand
```

Expected result: no provider network test can run while AI is disabled, but
configuration remains editable.

### Task 4: Expose Policy in Health and CLI Doctor

**Interfaces:**

- Produces: `/health.aiPolicy`, `/health.aiEngine.aiEnabled`, and
  `DoctorReport.aiPolicy`.
- Consumes: health payload, CLI doctor, and runtime guard.

- [x] Add `aiPolicy` to `buildRuntimeHealthPayload()`.
- [x] Preserve existing `aiEngine` fields for compatibility.
- [x] Add `aiEngine.aiEnabled` and `aiEngine.disabledReason`.
- [x] Add `aiPolicy` to `collectDoctorReport()`.
- [x] Print AI policy in `smp doctor --format text`.
- [x] Make `assertAnalysisRuntimeReady()` fail before credential checks when
  disabled.
- [x] Verify `smp analyze`, `smp resume`, `smp compare`, REPL turns, and
  `smp capture android --analyze` share the same failure.
- [x] Verify `smp query`, `smp skill` deterministic paths, `smp capture config`,
  `smp capture presets`, and `smp capture android` without `--analyze` remain
  available.

Validation:

```bash
cd backend
npx jest \
  src/agentRuntime/__tests__/runtimeHealth.test.ts \
  src/cli-user/services/__tests__/runtimeGuard.test.ts \
  src/cli-user/commands/__tests__/compare.test.ts \
  --runInBand
SMARTPERFETTO_AI_ENABLED=false npm run cli:dev -- doctor --format json
```

Expected result: health/doctor disclose disabled AI without requiring runtime
credentials, and analysis commands fail with a clear policy message.

### Task 5: Guard AI-Backed Skill Steps

**Interfaces:**

- Produces: `AI_DISABLED` for `ai_decision`, `ai_summary`, and fallback AI
  Skill calls.
- Consumes: `SkillExecutor` and policy resolver.

- [x] Check policy before `callAI()` can invoke an injected AI service.
- [x] Return a deterministic Skill step error with `code: 'AI_DISABLED'`.
- [x] Keep deterministic Skill steps and Skills without AI steps available.
- [x] Add focused tests for `ai_decision`, `ai_summary`, and a deterministic
  Skill in disabled mode.

Validation:

```bash
cd backend
npx jest src/services/skillEngine/__tests__/skillExecutor.test.ts --runInBand
```

Expected result: AI-backed Skill steps cannot call a model while disabled, and
deterministic Skills still execute.

### Task 6: Add Frontend Disclosure Without Breaking Deterministic Commands

**Interfaces:**

- Produces: policy-aware `ServerStatus` and visible disabled state.
- Consumes: `/health.aiPolicy` and existing `aiEngine` fields.

- [x] Add `AiCapabilityPolicy` types to `types.ts`.
- [x] Parse policy in `AIPanel.checkServerStatus()`.
- [x] Render disabled-state disclosure near the backend/runtime status.
- [x] Block natural-language sends and model-backed slash commands when AI is
  disabled.
- [x] Keep deterministic slash commands available.
- [x] Disable `/analyze` buttons and selection deep analysis actions.
- [x] Show provider panel policy state and disable provider connection tests.
- [x] Keep provider switching visible and explain that the selected provider
  applies when AI is enabled.

Validation:

- Frontend unit tests where the plugin already has coverage.
- Browser smoke in dev mode for AI panel, provider panel, and area-selection
  analysis controls.
- `./scripts/update-frontend.sh` before landing committed plugin UI changes.

Expected result: the UI makes AI disabled mode obvious without hiding
deterministic trace workflows.

### Task 7: Documentation and Final Gates

- [x] Update Chinese and English configuration docs.
- [x] Update API and CLI reference docs if the response shape is documented.
- [x] Run focused tests above.
- [x] Run `cd backend && npm run typecheck`.
- [x] Run `cd backend && npm run test:scene-trace-regression` because runtime
  and agent routes are policy-aware.
- [x] Run `git diff --check`.
- [x] For UI changes, verify dev mode and run `./scripts/update-frontend.sh`.
- [ ] Before PR/landing, run `npm run verify:pr` from repository root when the
  environment can support the full gate.

Verification notes:

- Focused Jest set passed with 9 suites and 212 tests.
- CLI disabled-mode smoke covered `doctor`, `provider test`, `analyze`,
  `compare`, and `capture android --analyze`.
- CLI deterministic smoke covered `provider list`, `capture presets`,
  `capture config`, `query`, and deterministic `skill` execution.
- Browser smoke loaded `Trace/real/android-startup-light/trace.pftrace` in dev mode and
  verified the AI Assistant disabled disclosure, disabled input/send controls,
  and zero analyze requests.
- `perfetto/ui` production build and `./scripts/update-frontend.sh` passed for
  `frontend/v57.1-651867f25`.

## Risks and Mitigations

- Risk: UI shows disabled but API still allows model calls.
  - Mitigation: route and CLI preflight plus `createAgentOrchestrator()` as the
    final runtime guard.
- Risk: disabled mode prevents useful deterministic workflows.
  - Mitigation: keep provider configuration, SQL, capture config, report reads,
    and deterministic slash commands explicitly allowed and tested.
- Risk: provider tests leak network calls while disabled.
  - Mitigation: block both HTTP provider test and `smp provider test` before
    `testProviderConnection()`.
- Risk: persisted sessions recreate orchestrators through restore paths.
  - Mitigation: preflight explicit resume and rely on runtime factory guard for
    service-level restore paths.
- Risk: invalid env values silently enable AI.
  - Mitigation: invalid explicit values fail closed and are disclosed in
    health/doctor.
- Risk: frontend runtime typing drifts from backend runtime kinds.
  - Mitigation: update `ServerStatus` runtime type when adding policy fields.

## Reviewer Questions

- Are invalid `SMARTPERFETTO_AI_ENABLED` values acceptable as fail-closed, or
  should server startup fail hard instead?
  - Decision: fail closed in the first implementation and disclose the invalid
    env value through health/doctor. Server-start hard failure can be revisited
    after deployment packaging expectations are clearer.
- Should `POST /scene-reconstruct/preview` remain available when cached reports
  exist but the start route is disabled? This plan keeps preview/report reads
  available because they do not create a runtime.
  - Decision: yes. Preview/report reads remain available; only the start route
    is blocked.
- Should provider activation remain enabled while AI is disabled? This plan
  keeps it enabled as configuration only, with provider tests blocked.
  - Decision: yes. Activation is configuration, not a model call.
- Which direct Skill execution paths can invoke an LLM today, if any, and do
  they need a finer-grained `llm_skill_step` guard in the first implementation?
  - Decision: `ai_decision`, `ai_summary`, and fallback AI calls in
    `SkillExecutor` can invoke an injected AI service. Add the
    `llm_skill_step` guard in the first implementation.
- Should a future workspace-scoped policy override env, or should env always
  remain the strongest global kill switch?
  - Decision: env remains the strongest global kill switch. A future workspace
    policy may only disable more narrowly or disclose effective state; it must
    not re-enable AI when env disables it.
