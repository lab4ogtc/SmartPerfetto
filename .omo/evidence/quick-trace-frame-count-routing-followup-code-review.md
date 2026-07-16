# Quick Trace Frame-Count Routing Follow-Up Code Review

Review date: 2026-07-01

Scope reviewed:
- `backend/src/agentRuntime/quickTraceFactEvidence.ts`
- `backend/src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts`
- `backend/test-output/e2e-quick-total-frame-count-claude-keyed-after-review.json`
- `backend/test-output/e2e-quick-total-frame-count-openai-keyed-after-review.json`
- Referenced session logs:
  - `backend/logs/sessions/session_agent-1782903112586-vb91lzqg_2026-07-01T10-51-52-601Z.jsonl`
  - `backend/logs/sessions/session_agent-1782903114314-fiv94dkp_2026-07-01T10-51-54-315Z.jsonl`

Review constraints:
- Read-only code review. No production or test code edits were made.
- The requested report artifact is the only file written.
- Full diff was not provided. The two target source/test files are currently untracked, so `git diff`/`git diff --stat` does not show a normal tracked-file diff for them.

Skill-perspective check:
- `omo:remove-ai-slops` was loaded and applied as a review lens for overfit/slop tests, deletion-only tests, tautological tests, implementation-mirroring tests, broad catches, and needless production complexity.
- `omo:programming` plus its TypeScript README were loaded and applied as a review lens for strict TS, error narrowing, brittle prompt tests, untyped escape hatches, needless abstraction, and file-size/maintainability.
- Result: the specific blocker fixes do not violate the slop perspective in a way that blocks approval. The target production/test files do violate the programming size perspective by concentration/size, called out under MEDIUM as a non-blocking risk for this narrowly scoped follow-up.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

1. `backend/src/agentRuntime/quickTraceFactEvidence.ts` and `backend/src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts` are oversized for the loaded programming perspective.
   - Evidence: `quickTraceFactEvidence.ts` is about 3,004 pure LOC; `quickTraceFactEvidence.test.ts` is about 5,744 pure LOC.
   - Impact: this is a real maintainability risk for future quick-fact work, and the test helper fixture is large enough that additions can become implementation-mirroring by inertia.
   - Why not blocking this follow-up: the user explicitly limited this review to whether the prior frame-count routing blockers are fixed and asked not to request broad refactors outside the slice unless correctness-blocking. The blocker-specific tests include a real trace-processor execution test, so this size issue does not invalidate the fixes.

### LOW

1. The Claude-named e2e receipt does not explicitly record the runtime/provider in the artifact body.
   - Evidence: `backend/test-output/e2e-quick-total-frame-count-claude-keyed-after-review.json` records quick success, one data envelope, zero turns, and claim verifier pass, but has no explicit runtime/provider field. The OpenAI session log records `runtime:"openai-agents-sdk"` in its progress event.
   - Impact: future reviewers must infer the Claude runtime from the artifact name or invocation context. This is evidence-quality friction, not a code correctness issue.

## Previous Blockers

1. `runtime_trace_frame_count` undercounted trace-wide frames by grouping only on derived `frame_id`.
   - Status: CLOSED.
   - Production SQL now groups trace-wide frame count by `upid, frame_id` in `buildTraceWideFrameCountSql` at `backend/src/agentRuntime/quickTraceFactEvidence.ts:2471`.
   - Trace-wide jank uses the same `GROUP BY upid, frame_id` pattern in `buildTraceWideJankPresenceSql` at `backend/src/agentRuntime/quickTraceFactEvidence.ts:2428`.
   - Test coverage includes a mocked SQL-shape assertion at `backend/src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts:1687` and a real `trace_processor_shell` execution on `test-traces/launch_light.pftrace` at `backend/src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts:1757`.
   - Independent verification run during review reproduced the old/new split on `launch_light`: `(upid, frame_id)` count `291`; `frame_id`-only count `248`.

2. Mixed FPS/frame-count questions like `trace frame count and FPS?` routed to `trace_frame_count`.
   - Status: CLOSED.
   - Detection now skips trace-wide frame count when `asksForFrameRate` is true at `backend/src/agentRuntime/quickTraceFactEvidence.ts:585`.
   - The same query keeps focus detection enabled at `backend/src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts:879`.
   - The evidence-builder test asserts `trace frame count and FPS?` emits `runtime_frame_metrics`, includes `AS fps`, and does not include `runtime_trace_frame_count` at `backend/src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts:1066`.

3. Catch block logged an unknown error without narrowing.
   - Status: CLOSED.
   - `buildQuickTraceFactEvidence` now narrows with `error instanceof Error ? error.message : String(error)` before logging at `backend/src/agentRuntime/quickTraceFactEvidence.ts:3254`.

## Evidence Reviewed

- `git status --short` showed a broad dirty tree; the two scoped source/test files are untracked.
- `git diff --check -- backend/src/agentRuntime/quickTraceFactEvidence.ts backend/src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts` passed.
- Secret scan over the two scoped files, the two e2e receipts, and referenced session logs had no matches for the scanned key/token patterns.
- E2E receipt summaries:
  - Claude-named receipt: `passed: true`, one data envelope, quick resolved mode, `actualTurns: 0`, claim verifier passed, answer cites 697 frames.
  - OpenAI-named receipt: `passed: true`, one data envelope, quick resolved mode, `actualTurns: 0`, claim verifier passed, answer cites 697 frames.
- Session logs for both receipts contain a `runtime_trace_fact:trace_frame_count` data envelope with row `["trace",697,...,"actual_frame_timeline_slice"]`, followed by direct conclusion and finalized result with `claimVerifierStatus:"passed"`.

## Status

codeQualityStatus: WATCH

recommendation: APPROVE

reportPath: `.omo/evidence/quick-trace-frame-count-routing-followup-code-review.md`

blockers: []
