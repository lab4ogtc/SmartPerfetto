# Snapshot and Case Similarity MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight Trace-Shazam-style MVP that answers "have we
seen something like this before?" by matching the current completed analysis
snapshot against readable historical snapshots, with optional curated-case
context when the current evidence is structured enough. Similarity remains a
navigation hint, not evidence and not root-cause proof.

**Architecture:** First ship deterministic snapshot-to-snapshot similarity over
the existing `AnalysisResultSnapshot` store. Reuse `CaseLibrary` and
`caseRecommendationRetriever` only as a bounded case-context adapter when a
snapshot can produce a valid case recommendation query. Keep the MCP
`recall_similar_case` tool as an agent-side recall surface; do not use it as
the product API for snapshot similarity.

**Tech Stack:** TypeScript, SQLite-backed analysis-result snapshot repository,
case evolution recommendation retriever, scoped knowledge store, Express
workspace routes, Jest.

## Global Constraints

- Similarity is a navigation hint only.
- Current trace evidence always wins over historical case/snapshot matches.
- Do not inject similarity hints into final root-cause claims, claim support,
  or report evidence sections.
- Preserve tenant, workspace, private-snapshot, and knowledge-scope boundaries.
- Start with deterministic signatures; no embedding, ML model, or external
  vector service in the first milestone.
- Do not expose raw user queries, raw artifact rows, or unrelated workspace
  case data in similarity reasons.

---

## Current State

Code-grounded review update, 2026-07-06:

- `backend/src/types/multiTraceComparison.ts` defines
  `AnalysisResultSnapshot`, `AnalysisResultVisibility`,
  `AnalysisResultSceneType`, `TraceComparisonMetadata`, and standard comparison
  metrics. Snapshot metadata already includes `appPackage`, `processName`,
  `deviceModel`, `androidVersion`, `buildFingerprint`, capture summary, trace
  duration/size, and trace bounds.
- `backend/src/services/analysisResultSnapshotStore.ts` persists snapshots and
  exposes `getSnapshot(scope, snapshotId)` and `listSnapshots(scope, filters)`.
  The readable clause already restricts results to the current tenant,
  workspace, workspace-visible snapshots, null-owner snapshots, or snapshots
  owned by the current user.
- `backend/src/routes/analysisResultRoutes.ts` is mounted at
  `/api/workspaces/:workspaceId/analysis-results` and already enforces
  `analysis_result:read` for list/read operations.
- `backend/src/routes/comparisonRoutes.ts` already performs explicit
  multi-result comparisons at `/api/workspaces/:workspaceId/comparisons`; the
  similarity MVP should not duplicate comparison-run creation or AI comparison
  reports.
- `backend/src/services/caseEvolution/caseRecommendationRetriever.ts` provides
  the reusable structured case retrieval service. It requires `scene`,
  `domainPack`, `rootCause`, `audiences`, and `evidenceSignatures`; it returns
  `strong`, `partial`, or `background` hits with matched and missing evidence
  signatures.
- `backend/src/agentv3/claudeMcpServer.ts` exposes `recall_similar_case`. The
  tool supports the legacy tag path and an optional evidence-signature path,
  but it is an MCP agent tool over `CaseLibrary`, not a workspace product API
  for historical analysis snapshots.
- `backend/src/routes/caseRoutes.ts` is operator-side case-library management
  under `/api/cases`; the comment explicitly keeps recall on the MCP side.

Relevant existing files:

- `backend/src/types/multiTraceComparison.ts`
  - Snapshot, metadata, metric, and visibility contracts.
- `backend/src/services/analysisResultSnapshotPipeline.ts`
  - Builds completed-analysis snapshots and normalized metrics.
- `backend/src/services/analysisResultSnapshotStore.ts`
  - Workspace-scoped snapshot reads/lists and snapshot audit logging.
- `backend/src/routes/analysisResultRoutes.ts`
  - Existing workspace analysis-result API surface.
- `backend/src/routes/comparisonRoutes.ts`
  - Explicit N-snapshot comparison runs.
- `backend/src/services/caseLibrary.ts`
  - Durable case-library store.
- `backend/src/services/caseEvolution/caseRecommendationRetriever.ts`
  - Evidence-gated case recommendation engine.
- `backend/src/types/caseKnowledge.ts`
  - Case evidence signature and match-strength contracts.
- `backend/src/agentv3/claudeMcpServer.ts`
  - Existing MCP-only `recall_similar_case` tool.
- `backend/src/agentv3/__tests__/claudeMcpServer.test.ts`
  - Existing coverage for legacy and structured `recall_similar_case`.
- `backend/src/routes/__tests__/analysisResultRoutes.test.ts`
  - Existing route-scope test pattern for analysis results.
- `backend/src/services/__tests__/analysisResultSnapshotStore.test.ts`
  - Existing repository test pattern for snapshot visibility.
- `backend/src/services/caseEvolution/__tests__/caseRecommendationRetriever.test.ts`
  - Existing case retrieval test pattern.

Current known strengths:

- Completed analyses already produce rich snapshots with normalized metrics and
  evidence references.
- Workspace-scoped snapshot access already exists.
- Case-library recall and evidence-signature matching already exist.
- Multi-result comparison already handles explicit baseline/candidate analysis.

Current gap:

- There is no lightweight "similar past results" preview for a single current
  analysis result.
- `recall_similar_case` can help an agent recall curated cases, but it cannot
  rank historical analysis snapshots and should not become the user-facing
  product API for this feature.
- Case recommendation requires structured root-cause/evidence inputs. Many
  snapshots may only have enough metadata for snapshot-to-snapshot similarity,
  so case matching must be optional and clearly limited.

## Implementation Update 2026-07-06

Implemented backend MVP scope:

- Added `SimilarityHintV1`, `TraceSimilaritySignatureV1`, and
  `TraceSimilarityCaseQuery` in `backend/src/types/multiTraceComparison.ts`.
- Added deterministic signature extraction in
  `backend/src/services/similarity/traceSimilaritySignature.ts`.
- Added weighted snapshot matcher in
  `backend/src/services/similarity/similarityMatcher.ts`.
- Added workspace-scoped aggregation service in
  `backend/src/services/similarity/similarityService.ts`.
- Added `POST /api/workspaces/:workspaceId/analysis-results/:snapshotId/similarity`
  in `backend/src/routes/analysisResultRoutes.ts`.
- Added focused service and route coverage:
  - `backend/src/services/similarity/__tests__/traceSimilaritySignature.test.ts`
  - `backend/src/services/similarity/__tests__/similarityMatcher.test.ts`
  - `backend/src/services/similarity/__tests__/similarityService.test.ts`
  - `backend/src/routes/__tests__/analysisResultSimilarityRoutes.test.ts`

Implementation decisions preserved:

- Similarity hints always carry `allowedUse: 'navigation_hint_only'`.
- The route reuses existing `analysis_result:read`, workspace context, and
  `AnalysisResultSnapshotRepository` scoped reads.
- `includeCases` defaults to `false`; case-library hints are opt-in and require
  a structured `caseQuery`.
- Snapshot hints and case hints are grouped as `snapshotHints` and `caseHints`;
  the response also keeps a convenience `hints` array for clients that only
  need the shared `SimilarityHintV1` item contract.
- MCP and UI surfaces remain deferred for this milestone.

Validation completed in this implementation pass so far:

```bash
cd backend
npx jest src/services/similarity/__tests__/traceSimilaritySignature.test.ts src/services/similarity/__tests__/similarityMatcher.test.ts src/services/similarity/__tests__/similarityService.test.ts src/routes/__tests__/analysisResultSimilarityRoutes.test.ts --runInBand
npm run typecheck
npm run build
node <temporary API smoke against dist/routes/analysisResultRoutes>
npm run verify:e2e:quick
DEEPSEEK_API_KEY=<redacted> npm run verify:e2e:deepseek-startup
git diff --check
```

Result: 4 Jest suites / 6 tests passed; backend typecheck and build passed.
HTTP smoke returned one `analysis_result_snapshot` hint and one `case_library`
hint, both with `allowedUse: 'navigation_hint_only'`. Claude quick e2e passed
for `mixed-trace-scrolling`, `trace-fact`, `process-identity`, and
`scrolling-triage`. Deepseek OpenAI-compatible startup e2e passed with claim
verification status `passed`; the run still surfaced the existing
`blocking_chain_analysis` undeclared-parameter warning, but the final e2e gate
passed.

## Proposed Contract

Add `SimilarityHintV1`:

```ts
export interface SimilarityHintV1 {
  schemaVersion: 1;
  id: string;
  source: 'analysis_result_snapshot' | 'case_library';
  sourceId: string;
  score: number;
  band: 'strong' | 'partial' | 'background';
  matchReasons: Array<{
    feature: string;
    currentValue?: string | number | boolean;
    matchedValue?: string | number | boolean;
    weight: number;
  }>;
  limitations: string[];
  allowedUse: 'navigation_hint_only';
}
```

Add `TraceSimilaritySignatureV1`:

```ts
export interface TraceSimilaritySignatureV1 {
  schemaVersion: 1;
  sceneType?: AnalysisResultSceneType;
  appPackage?: string;
  processName?: string;
  deviceModel?: string;
  androidVersion?: string;
  buildFingerprintPrefix?: string;
  traceDurationMs?: number;
  traceSizeBytes?: number;
  metrics: Record<string, number>;
  categoricalSignals: Record<string, string | boolean>;
  caseEvidenceSignatures: Record<string, unknown>;
  caseQuery?: {
    scene: string;
    domainPack: string;
    rootCause: string;
    secondaryRootCauses?: string[];
    responsibility?: CaseKnowledgeResponsibility;
    audiences?: Array<'app' | 'oem'>;
  };
}
```

Design notes:

- Build signatures from `AnalysisResultSnapshot`, not from raw trace artifacts
  or free-form model text.
- Use `traceMetadata`, `metrics`, `evidenceRefs`, `claimSupport`,
  `claimVerificationResult`, and `identityResolutions` only through bounded
  extracted features.
- Do not include raw `userQuery`, raw summary prose, raw artifact rows, full
  build fingerprints, or unbounded text tokens in first-release signatures.
- Missing features remain absent. Do not synthesize zeroes or placeholder root
  causes.
- `caseQuery` is optional. If the snapshot cannot derive a real root cause and
  domain pack, skip case-library hints instead of forcing `unknown`.

## Files and Responsibilities

- Create: `backend/src/services/similarity/traceSimilaritySignature.ts`
  - Extract bounded deterministic signatures from `AnalysisResultSnapshot`.
- Create: `backend/src/services/similarity/similarityMatcher.ts`
  - Score current and candidate snapshot signatures.
- Create: `backend/src/services/similarity/similarityService.ts`
  - Coordinate scoped snapshot matching and optional case recommendation
    matching.
- Modify: `backend/src/routes/analysisResultRoutes.ts`
  - Add `POST /:snapshotId/similarity` under the existing workspace-scoped
    analysis-result route.
- Modify: `backend/src/index.ts`
  - No new route mount should be required if the endpoint lives under
    `analysisResultRoutes`.
- Test: `backend/src/services/similarity/__tests__/traceSimilaritySignature.test.ts`
- Test: `backend/src/services/similarity/__tests__/similarityMatcher.test.ts`
- Test: `backend/src/services/similarity/__tests__/similarityService.test.ts`
- Test: `backend/src/routes/__tests__/analysisResultSimilarityRoutes.test.ts`

Deferred surfaces:

- Modify: `backend/src/agentv3/claudeMcpServer.ts`
  - Add a new read-only `recall_similar_result` only after service/route
    behavior is proven. Do not overload `recall_similar_case`.
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`
  - Optional UI summary after backend/API behavior is stable.
- Modify: `docs/reference/api.md`
  - Add endpoint documentation only when the API is implemented.
- Modify: `docs/getting-started/multi-trace-result-comparison.md`
  - Update only if the feature becomes visible next to comparison workflows.

## Implementation Tasks

### Task 1: Build Deterministic Signature Extraction

**Interfaces:**

- Produces:

```ts
export function buildTraceSimilaritySignature(
  snapshot: AnalysisResultSnapshot,
): TraceSimilaritySignatureV1;
```

- Consumes: `AnalysisResultSnapshot`, `TraceComparisonMetadata`, normalized
  metrics, evidence refs, claim support, claim verification, and identity
  resolution artifacts already present on the snapshot.

- [x] Extract `sceneType`, app package, process name, device model, Android
  version, bounded build fingerprint prefix, duration, size, and standard
  numeric metrics.
- [x] Extract categorical signals only from bounded fields such as scene,
  package/process identity, verified claim categories, evidence ref types, and
  domain-specific reason codes when they already exist.
- [x] Derive `caseEvidenceSignatures` only from structured fields compatible
  with `CaseEvidenceSignature` operators.
- [x] Derive `caseQuery` only when scene, domain pack, and root cause can be
  inferred without placeholder values.
- [x] Mark missing features by absence.
- [x] Avoid raw summary text, raw user query text, and raw artifact rows.

Validation:

```bash
cd backend
npx jest src/services/similarity/__tests__/traceSimilaritySignature.test.ts --runInBand
```

Expected result: signature extraction is deterministic, privacy-bounded, and
stable for old snapshots with partial metadata.

### Task 2: Add Snapshot Matcher and Ranking

**Interfaces:**

- Produces:

```ts
export function rankSnapshotSimilarityHints(input: {
  currentSnapshotId: string;
  current: TraceSimilaritySignatureV1;
  candidates: Array<{
    snapshot: AnalysisResultSnapshot;
    signature: TraceSimilaritySignatureV1;
  }>;
  limit?: number;
}): SimilarityHintV1[];
```

- Consumes: current signature and candidate snapshot signatures.

- [x] Implement weighted exact matching for categorical signals.
- [x] Implement conservative numeric matching for metrics and trace metadata,
  using relative thresholds instead of exact equality.
- [x] Return `strong`, `partial`, or `background` bands from score and reason
  quality.
- [x] Include match reasons and limitations for every returned hint.
- [x] Exclude the current snapshot.
- [x] Cap results to a small default, for example 5.
- [x] Never return a hint with no match reasons.

Validation:

```bash
cd backend
npx jest src/services/similarity/__tests__/similarityMatcher.test.ts --runInBand
```

Expected result: obvious overlaps rank above weak background matches, unrelated
snapshots are filtered out, and every hint is marked
`navigation_hint_only`.

### Task 3: Add Workspace-Scoped Similarity Service and Route

**Interfaces:**

- Service:

```ts
export function createTraceSimilarityService(deps: {
  snapshotRepository: AnalysisResultSnapshotRepository;
  caseLibrary?: CaseLibrary;
  ragStore?: RagStore;
}): {
  findSimilarAnalysisResult(input: {
    scope: SnapshotAccessScope;
    knowledgeScope?: KnowledgeScope;
    snapshotId: string;
    includeCases?: boolean;
    limit?: number;
  }): TraceSimilarityResultV1 | null;
};
```

- Route:

```http
POST /api/workspaces/:workspaceId/analysis-results/:snapshotId/similarity
```

- Response:

```ts
{
  success: true;
  schemaVersion: 1;
  snapshotId: string;
  signature: TraceSimilaritySignatureV1;
  snapshotHints: SimilarityHintV1[];
  caseHints: SimilarityHintV1[];
  hints: SimilarityHintV1[];
  count: number;
}
```

- [x] Read the current snapshot through `getSnapshot(scope, snapshotId)`.
- [x] Read candidate snapshots through `listSnapshots(scope, filters)` with
  same-workspace scope and a conservative limit.
- [x] Default candidate filtering to the same scene type when present, but
  allow the service to fall back to readable workspace snapshots when scene is
  missing.
- [x] Enforce `analysis_result:read` in `analysisResultRoutes.ts`.
- [x] Preserve private snapshot visibility through the existing repository
  readable scope.
- [x] Use `knowledgeScopeFromRequestContext` for optional case matching.
- [x] Return 404 when the current snapshot is not readable.
- [x] Validate request options such as `limit` and `includeCases`.

Validation:

```bash
cd backend
npx jest src/routes/__tests__/analysisResultSimilarityRoutes.test.ts --runInBand
```

Expected result: private snapshots from other users/workspaces do not appear,
and unreadable current snapshots return 404.

### Task 4: Add Optional Case-Library Adapter

**Interfaces:**

- Produces: `SimilarityHintV1[]` with `source: 'case_library'`.
- Consumes: `TraceSimilaritySignatureV1.caseQuery`,
  `caseEvidenceSignatures`, `CaseLibrary`, `RagStore`, and
  `createCaseRetriever`.

- [x] Call `createCaseRetriever(...).retrieve(...)` only when `caseQuery` is
  present and `caseEvidenceSignatures` is non-empty.
- [x] Pass `includeStatuses: ['published']` by default.
- [x] Map `CaseRecommendationHit.matchStrength` to similarity `band`.
- [x] Map matched/missing signatures to match reasons and limitations.
- [x] Preserve `evidenceGap` as a limitation, not as evidence.
- [x] Keep case hints separated by `source` and source id; do not merge case
  and snapshot scores as if they had the same evidence basis.
- [x] If case matching is skipped, do not fabricate a background case hint.

Validation:

```bash
cd backend
npx jest src/services/similarity/__tests__/similarityService.test.ts --runInBand
```

Expected result: published case hits appear only when structured evidence is
available, and background hits clearly show their evidence gaps.

### Task 5: Defer MCP Tool and UI Until Backend Behavior Is Proven

- [x] Add a read-only `recall_similar_result` MCP tool only after the route and
  service tests pass.
- [x] Keep `recall_similar_case` focused on case-library recall.
- [x] Mark new MCP output as `navigation_hint_only`.
- [x] Add UI summary only after the backend API response shape is stable.
- [x] Do not inject similarity hints into final root-cause claims, report
  evidence, or snapshots as proof.

Validation if MCP is included:

```bash
cd backend
npx jest src/agentv3/__tests__/claudeMcpServer.test.ts --runInBand
```

If frontend changes are included, run the relevant plugin tests, browser smoke,
type generation, and `./scripts/update-frontend.sh` according to current
project rules.

Current implementation adds the public read-only `recall_similar_result` MCP
tool, keeps `recall_similar_case` as case-library recall, and surfaces
row-level result-picker similarity hints in the AI Assistant UI as
`navigation_hint_only`. Similarity hints remain outside final root-cause claims,
report evidence, and persisted snapshots as proof.

Additional validation run on 2026-07-06:

```bash
cd backend
npx jest src/agentv3/__tests__/claudeMcpServer.test.ts --runInBand
npx jest src/services/similarity/__tests__/similarityService.test.ts src/routes/__tests__/analysisResultSimilarityRoutes.test.ts --runInBand
npm run typecheck

cd ../perfetto/ui
npx tsc --noEmit --pretty false
npm run build

cd ../..
./scripts/start-dev.sh --quick
# Browser smoke rendered the similarity summary with navigation_hint_only,
# Snapshot source, match reasons, and "not diagnostic evidence" limitation.
./scripts/update-frontend.sh
```

### Task 6: Documentation and Gates

- [x] Update `docs/reference/api.md` after the endpoint exists.
- [x] Update getting-started docs only if a user-visible UI entry is added.
- [x] Run focused service and route tests.
- [x] Run `cd backend && npm run typecheck`.
- [x] Run `git diff --check`.
- [ ] Before release-ready implementation under the parent project goal, run
  Claude and Deepseek-backed OpenAI Agent SSE e2e and inspect generated
  similarity hints for evidence separation.

## Implementation Standard Checklist

This feature is not implementation-ready until a reviewer can answer "yes" to
all of these:

- Does the first milestone ship deterministic snapshot-to-snapshot similarity
  before MCP/UI expansion?
- Does every hint say `allowedUse: 'navigation_hint_only'`?
- Are current evidence, similarity hints, case recommendations, and final
  root-cause claims kept as separate surfaces?
- Does the route reuse `analysisResultRoutes.ts`, `analysis_result:read`, and
  `AnalysisResultSnapshotRepository` scoped reads instead of adding a bypass?
- Are private snapshots protected by repository scope and route tests?
- Is `recall_similar_case` treated as existing MCP case recall, not as the new
  product API?
- Are case-library hints skipped unless real structured evidence can form a
  `CaseRecommendationQuery`?
- Are raw queries, raw artifact rows, and full build fingerprints excluded from
  signatures and match reasons?

## Risks and Mitigations

- Risk: "similar" is interpreted as "same root cause".
  - Mitigation: `allowedUse: navigation_hint_only`, explicit limitations, and
    tests that keep hints out of final claim support.
- Risk: private result leakage across workspaces or users.
  - Mitigation: reuse scoped snapshot repository reads and add route tests for
    workspace, owner, and private visibility.
- Risk: weak matching produces noisy suggestions.
  - Mitigation: reason-count minimum, conservative score bands, and a small
    default result cap.
- Risk: case-library matches get treated as trace proof.
  - Mitigation: case hints require structured evidence and preserve evidence
    gaps as limitations.
- Risk: overbuilding ML too early.
  - Mitigation: deterministic signatures only in MVP.
- Risk: duplicating multi-trace comparison.
  - Mitigation: similarity returns lightweight hints only; explicit comparison
    runs stay in `comparisonRoutes.ts`.

## Reviewer Questions

- Are the first-release match weights conservative enough for snapshot hints?
  - Decision: yes, with a minimum reason-count threshold and score bands kept in
    the response so callers can distinguish weak hints from stronger matches.
- Should `includeCases` default to `false` for the first API release, or can it
  default to `true` when a structured `caseQuery` exists?
  - Decision: default `includeCases` to `false`. Case hints are opt-in until the
    response wording and evidence-gap behavior have production usage.
- Should snapshot hints and case hints be returned in a single list sorted by
  score, or grouped by source in the response while retaining the same
  `SimilarityHintV1` item contract?
  - Decision: group by source in the response and retain a shared
    `SimilarityHintV1` item contract. Do not interleave curated cases with
    trace-backed snapshots as if they were the same evidence type.
- Should similarity hints remain computed on demand, or should a later version
  cache signatures in the snapshot store?
  - Decision: compute on demand in the first implementation. Add cached
    signatures only after query volume proves it is needed.
