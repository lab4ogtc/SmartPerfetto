# Quick-Mode Frame-Count Routing Code Review

Scope reviewed:
- `backend/src/agentRuntime/quickTraceFactEvidence.ts`
- `backend/src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts`
- relevant routing/direct-answer call sites in `quickModeResolution`, runtimes, and classifier code

Status: BLOCK
Recommendation: REQUEST_CHANGES

## Skill Perspective Check

- `omo:remove-ai-slops`: ran by reading the skill instructions and applying its overfit/slop review pass to the production and test slice.
- `omo:programming`: ran by reading the skill instructions plus the TypeScript reference and applying its TypeScript strictness/test-shape perspective.
- Violations found:
  - Production file size is 3003 pure LOC and the test file is 5646 pure LOC, far above the 250 pure LOC programming threshold.
  - The test fixture mirrors implementation constants and column shapes instead of locking the real SQL behavior against canonical traces.
  - The production catch path uses a type assertion in a catch block instead of narrowing.

## CRITICAL

None.

## HIGH

1. `backend/src/agentRuntime/quickTraceFactEvidence.ts:2476` undercounts trace-wide FrameTimeline frames on a canonical trace.

The new `runtime_trace_frame_count` SQL groups only by a derived `frame_id`:

- `COALESCE(NULLIF(name, ''), surface_frame_token, display_frame_token, id)` at `backend/src/agentRuntime/quickTraceFactEvidence.ts:2478`
- `GROUP BY frame_id` at `backend/src/agentRuntime/quickTraceFactEvidence.ts:2488`

Existing project guidance in `backend/src/services/traceSummaryV2.ts:117` documents that FrameTimeline totals should aggregate by `(upid, name)` because raw rows can duplicate frames. On `test-traces/launch_light.pftrace`, I verified:

- current new grouping returns `248`
- existing `(upid, name)` convention returns `291`
- raw `actual_frame_timeline_slice` rows are `417`

This means the current trace-wide direct answer can report the wrong total frame count on a canonical fixture, even though the customer-scroll e2e case reports `697`.

2. `backend/src/agentRuntime/quickTraceFactEvidence.ts:631` redirects mixed FPS questions to trace-wide frame count and drops the FPS request.

`matchesTraceWideFrameCountFactPattern()` excludes app-scoped wording but does not exclude frame-rate/FPS wording. Runtime probe:

- `trace frame count and FPS?` -> `trace_frame_count`, `skip=true`, SQL marker `runtime_trace_frame_count`, no FPS SQL
- `what is this trace total frame count and fps?` -> same

That violates the stated requirement that FPS questions must not be redirected to trace-wide frame-count facts. The focused tests cover bare `total frame count?` but do not cover trace-scoped mixed metric wording.

## MEDIUM

1. `backend/src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts:1620` mocks away the SQL semantics that matter for this bug.

The trace-wide frame-count test checks that the SQL contains expected strings and then returns a mocked row with `697`. It does not run the SQL on a canonical trace or assert the grouping convention from `traceSummaryV2`, so it cannot catch the `launch_light` undercount.

2. `backend/src/agentRuntime/quickTraceFactEvidence.ts` is oversized for a new production module.

Measured pure LOC: `3003`. The file owns query intent detection, SQL generation, result usability checks, display titles, column schemas, envelope creation, and prompt context formatting. From the programming/remove-ai-slops perspectives, this is a maintainability and reviewability defect for an untracked production file.

3. `backend/src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts` is oversized and mirrors implementation data.

Measured pure LOC: `5646`. The `traceFactEnvelope()` fixture duplicates long per-kind column/row definitions, which creates brittle implementation-mirroring coverage and makes it harder to see missing behavior cases like mixed FPS routing and canonical SQL grouping.

## LOW

1. `backend/src/agentRuntime/quickTraceFactEvidence.ts:3255` uses `(error as Error).message` in a catch block.

The TypeScript review perspective rejects catch-block type assertions without narrowing. This is not the frame-count behavior blocker, but it should be cleaned up if this file lands.

## Verification Performed

Passed:
- `cd backend && npm test -- --runInBand src/agentRuntime/__tests__/quickTraceFactEvidence.test.ts src/agentv3/__tests__/queryComplexityClassifier.followup.test.ts src/agentRuntime/__tests__/quickModeResolution.test.ts`
  - 3 suites passed, 230 tests passed.
- `cd backend && npx tsc --noEmit --pretty false`
- `git diff --check` on the reviewed slice

Additional runtime probes:
- `total frame count?`, `frame count?`, and `total frames?` route to `trace_frame_count`, skip focus detection, and use `runtime_trace_frame_count` without FPS.
- Mixed FPS probes route incorrectly as described in HIGH finding 2.
- Canonical trace grouping check over the six scene traces exposed the `launch_light.pftrace` undercount described in HIGH finding 1.

Not rerun:
- `npm run build`
- `npm run test:scene-trace-regression`
- DeepSeek provider e2e

Reason: the local SQL fixture probe already found a blocking correctness issue, and the provider e2e evidence supplied in the prompt did not include artifact paths to inspect.

## Blockers

- Fix `runtime_trace_frame_count` grouping so it matches the project’s established FrameTimeline frame identity convention and add a regression that exercises at least `test-traces/launch_light.pftrace`.
- Prevent trace-scoped mixed FPS/frame-count questions from taking the trace-wide frame-count-only direct path; add tests for mixed FPS wording.
- Provide inspectable e2e artifact paths or rerun the provider e2e after the fixes if that evidence is used for acceptance.
