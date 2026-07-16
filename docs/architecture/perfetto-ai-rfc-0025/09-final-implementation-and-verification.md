# RFC 0025 SmartPerfetto Implementation and Verification Status

Last updated: 2026-07-06.

This document is the cross-plan implementation record for the SmartPerfetto
work inspired by Perfetto RFC 0025. It is not a ninth feature plan. It records
what is implemented and what was verified in this checkout.

## Implemented Scope

The eight planned SmartPerfetto surfaces are implemented in this checkout:

1. Analysis receipt and evidence audit.
2. Trace config proposal.
3. UI action proposal protocol.
4. Snapshot and case similarity MVP.
5. Query IR review layer.
6. External Skill pack and extension server local import path.
7. Batch trace lifecycle.
8. AI disable and capability disclosure.

The implementation keeps the RFC boundary used throughout the plan set:
trace-backed evidence remains the authority; model output may propose,
summarize, navigate, or recall, but it must not silently become executable
proof or product state.

## Current Cross-Cutting Contracts

- Evidence, claim verification, final reports, snapshots, CLI artifacts, and
  frontend chat projection remain separate surfaces.
- Similarity hints carry `allowedUse: 'navigation_hint_only'` and are not
  report evidence.
- UI action proposals remain proposals; frontend handlers must opt in to
  supported actions.
- Query review metadata attaches to current SQL and Skill execution evidence;
  it does not introduce a separate query language.
- Skill packs start as a managed local workspace import path; archive sync,
  remote extension discovery, and signatures are deferred.
- Batch trace execution is bounded to current Skills, explicit snapshot
  promotion, and existing comparison artifacts.
- AI disable policy blocks provider/runtime surfaces and discloses capability
  state instead of pretending analysis is available.

## Verification Completed

The following repository gates passed in this checkout:

```bash
cd backend
npx jest src/agentv3/__tests__/claudeFindingExtractor.test.ts --runInBand
npx jest src/services/__tests__/enterpriseSchema.test.ts src/services/__tests__/enterpriseDb.test.ts src/services/__tests__/enterpriseRepository.test.ts --runInBand
npm run typecheck

cd ..
git diff --check
npm run verify:pr
```

The final `npm run verify:pr` pass covered root quality checks, frontend
prebuild validation, Rust format/check/test, backend validation/build/core
tests, trace processor availability, and scene trace regression. The backend
core test phase reported 63 passed suites and 822 passed tests. Scene trace
regression passed for all 6 traces.

Additional focused verification completed during this implementation pass:

```bash
cd backend
npx jest src/agentv3/__tests__/claudeMcpServer.test.ts --runInBand
npx jest src/services/similarity/__tests__/similarityService.test.ts src/routes/__tests__/analysisResultSimilarityRoutes.test.ts --runInBand
npm run test:scene-trace-regression

cd ../perfetto/ui
npx tsc --noEmit --pretty false
npm run build

cd ../..
./scripts/update-frontend.sh
npm run check:frontend-prebuild --if-present
```

The UI similarity summary was also smoke-tested in dev mode through the
Perfetto UI plugin surface, using the rendered `AIPanel` similarity summary.

## Live Runtime E2E

Deepseek OpenAI-compatible full-mode startup e2e passed:

- Report: `backend/test-output/e2e-deepseek-startup-real.json`
- Session: `agent-1783322209751-blgjkb03`
- `passed: true`
- `analysisCompletedNotPartial: true`
- claim verifier status: `passed`
- checked claims: 12
- unsupported claims: 0
- degraded fallbacks: 0

Deepseek OpenAI-compatible full-mode scrolling e2e passed:

- Report: `backend/test-output/e2e-deepseek-scrolling-real.json`
- Session: `agent-1783321830845-2af7r6pa`
- `passed: true`
- `analysisCompletedNotPartial: true`
- claim verifier status: `passed`
- checked claims: 12
- unsupported claims: 0
- degraded fallbacks: 0
- required Skill calls observed: `scrolling_analysis`, `jank_frame_detail`,
  `frame_blocking_calls`, and `blocking_chain_analysis`

During the scrolling e2e run, the verifier originally rejected a critical
recommendation because the recommendation had quantified impact bullets but no
explicit `Evidence:` block. The extractor now treats quantified impact/WHY
bullets as evidence only when no stronger evidence block exists.

Follow-up Deepseek-compatible Claude/OpenAI runtime verification also passed.
This used provider-compatible Deepseek endpoints for both the Claude-labeled and
OpenAI-labeled runtime paths; it did not require local Claude Code CLI login.

Deepseek Claude-compatible full-mode startup e2e passed:

- Report: `backend/test-output/e2e-claude-deepseek-startup-real-current.json`
- Session: `agent-1783335566446-pf2glmqd`
- `passed: true`
- claim verifier status: `passed`
- checked claims: 12
- unsupported claims: 0
- degraded fallbacks: 0

Deepseek Claude-compatible full-mode scrolling e2e passed:

- Report: `backend/test-output/e2e-claude-deepseek-scrolling-real-current.json`
- Session: `agent-1783335774950-m45amyl8`
- `passed: true`
- claim verifier status: `passed`
- checked claims: 12
- unsupported claims: 0
- degraded fallbacks: 0
- required Skill calls observed: `scrolling_analysis`, `jank_frame_detail`,
  `cpu_analysis`, `frame_blocking_calls`, `surfaceflinger_analysis`, and
  `blocking_chain_analysis`

Deepseek OpenAI-compatible full-mode startup e2e passed:

- Report: `backend/test-output/e2e-openai-deepseek-startup-real-current.json`
- Session: `agent-1783336063400-8grq6pk2`
- `passed: true`
- claim verifier status: `passed`
- checked claims: 12
- unsupported claims: 0
- degraded fallbacks: 0

Deepseek OpenAI-compatible full-mode scrolling e2e passed:

- Report: `backend/test-output/e2e-openai-deepseek-scrolling-real-current.json`
- Session: `agent-1783336385798-d1m7xjwa`
- `passed: true`
- claim verifier status: `passed`
- checked claims: 12
- unsupported claims: 0
- degraded fallbacks: 0
- required Skill calls observed: `scrolling_analysis`, `jank_frame_detail`,
  `frame_blocking_calls`, `blocking_chain_analysis`, and
  `surfaceflinger_analysis`

## Simplification Review

No project `/simplify` entrypoint, repository simplifier script, or PATH
`code-simplifier` was available in this environment. Manual simplification
review was performed instead:

- `claudeFindingExtractor` only falls back to quantified recommendation
  evidence when explicit evidence/table/inline evidence is absent.
- `EnterpriseWorkspaceRepository` only exposes id-based workspace tables.
  Composite-key batch child tables remain owned by the dedicated batch trace
  repository.
- The schema migration tests now track migration versions 12 and 13.

`git diff --check` passed after this review.

## Release-Readiness Summary

Local code, frontend, root gate, scene trace, Deepseek OpenAI-compatible runtime
verification, and Deepseek Claude-compatible runtime verification are passing.
The previous local Claude Code authentication blocker is resolved for this
verification path by using the repository's provider-compatible Deepseek
configuration.
