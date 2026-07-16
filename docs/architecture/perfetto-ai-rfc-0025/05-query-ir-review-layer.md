# Query IR Review Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reviewable query-intent layer for SQL and Skill evidence so
users and reviewers can inspect why a query ran, which tables/fields it read,
which filters it relied on, what warnings apply, and which evidence artifact it
produced before trusting the result.

**Architecture:** Do not build a new query language and do not compile a new
IR into SQL in the first milestone. Instead, add a bounded `queryReview`
sidecar to existing executed-query surfaces: tool responses, DataEnvelope
metadata, artifacts, evidence contracts, reports, and optional frontend cards.
The first milestone observes and annotates what SmartPerfetto already executed.

**Tech Stack:** TypeScript strict mode, existing MCP tools, SmartPerfetto Skill
metadata, Perfetto SQL schema/docs lookup, SQL guardrail analyzer, raw SQL
normalization helpers, DataEnvelope, ArtifactStore, generated frontend types,
Jest.

## Global Constraints

- Query review is audit metadata, not a replacement for PerfettoSQL.
- Existing YAML Skills remain the primary deterministic evidence collection
  primitive.
- Generated SQL must still be validated by trace processor execution and
  evidence contracts.
- The first release must not let model-authored JSON approve or execute SQL.
- Prompt content belongs in strategies/templates, not TypeScript.
- Query review must not hide raw SQL from expert users.
- Query review must not become evidence by itself; evidence remains the
  executed DataEnvelope/artifact row set plus claim verification.

---

## Current State

Code-grounded review update, 2026-07-06:

- `backend/src/agentv3/claudeMcpServer.ts` already gates `execute_sql`,
  `execute_sql_on`, and `invoke_skill` behind submitted plan phases. Tool
  outputs include `sourceToolCallId`, `paramsHash`, `planPhaseId`,
  `executableSql`, `traceProvenance`, `evidenceRefId`, `queryHash`,
  `stdlibInjectedModules`, and SQL rewrite metadata where applicable.
- `execute_sql` and `execute_sql_on` already run through `normalizeRawSql(...)`
  and `injectStdlibIncludes(...)`, reject artifact pseudo-table misuse through
  `artifactSqlMisuseHint(...)`, and emit `processIdentityWarning` when raw SQL
  filters by process/package identity.
- Large SQL results already go through `storeSqlResultArtifact(...)` and
  paginated `fetch_artifact`, while live tables are emitted as DataEnvelope
  `sql_result` outputs.
- `invoke_skill` already stores display results and synthesize data in
  `ArtifactStore`, emits Skill DataEnvelopes, and attaches plan/tool
  provenance to the model-visible compact artifact summaries.
- `backend/src/types/dataContract.ts` is the single source of truth for
  backend, frontend, and report data envelopes. `DataEnvelopeMeta` already
  carries evidence refs, trace side/id, query hash, source tool call id,
  artifact ids, identity sidecars, plan phase binding, producer narration, and
  intent.
- `backend/src/services/evidence/evidenceContractBuilder.ts` already derives
  producer kind, trace context, artifact id, query hash, plan phase id, and
  identity warnings from DataEnvelopes when building claim-support anchors.
- `backend/src/services/sqlGuardrailAnalyzer.ts` already exists and is used by
  the CLI validator. It reports Perfetto-specific SQL review issues such as
  unsafe duration handling, span-join safety, idempotent creates, and direct
  args table parsing. Runtime SQL tools do not yet attach these issues.
- `backend/src/agentv3/rawSqlNormalizer.ts` already has reusable SQL masking
  and table-token reading logic. Any SQL introspection should reuse or extract
  from this style of parser, not ad hoc regex over quoted strings/comments.
- `lookup_sql_schema` merges stdlib docs and legacy schema index results; it is
  discovery support, not an execution gate.
- `query_perfetto_source` exists as a stdlib source search tool, and
  `McpToolRegistry` is the source of tool exposure/registration truth.

Relevant existing files:

- `backend/src/agentv3/claudeMcpServer.ts`
  - SQL/Skill tool execution, plan binding, DataEnvelope emission, artifact
    storage, schema lookup, and comparison SQL.
- `backend/src/agentv3/rawSqlNormalizer.ts`
  - SQL normalization and safe scanning helpers.
- `backend/src/agentv3/sqlIncludeInjector.ts`
  - Stdlib include injection for raw SQL tools.
- `backend/src/services/sqlGuardrailAnalyzer.ts`
  - Existing SQL review warnings.
- `backend/src/types/dataContract.ts`
  - DataEnvelope contract and generated frontend type source.
- `backend/src/agentv3/artifactStore.ts`
  - Session artifact persistence and compact model summaries.
- `backend/src/services/evidence/evidenceContractBuilder.ts`
  - Evidence anchor generation from DataEnvelope metadata.
- `backend/src/services/skillEngine/types.ts`
  - Skill step, display, input, output, and SQL metadata types.
- `backend/src/services/skillEngine/skillExecutor.ts`
  - Skill execution and display result generation.
- `backend/src/services/htmlReportGenerator.ts`
  - Report rendering for evidence surfaces.
- `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sql_result_table.ts`
  - Frontend SQL/DataEnvelope table rendering.
- `backend/scripts/generateFrontendTypes.ts`
  - Frontend contract generation.

Current known strengths:

- SQL/Skill execution already has provenance, plan phase attribution, trace
  provenance, artifacts, and evidence refs.
- DataEnvelope already spans backend, frontend, reports, and snapshots.
- Guardrail analysis exists and can be reused as review metadata.
- Skill YAML already has structured step definitions, display config, inputs,
  outputs, and SQL for deterministic paths.

Current gap:

- Raw SQL and Skill outputs do not have a compact, durable review card that
  explains intent, reads, filters, output shape, guardrail warnings, SQL
  rewrites, and limitations.
- SQL guardrail findings are available in CLI validation but are not surfaced
  beside executed runtime SQL evidence.
- Evidence anchors preserve producer metadata, but they do not point to a
  query-review sidecar that a report or reviewer can inspect.

## Proposed Contract

Add `QueryReviewV1`:

```ts
export interface QueryReviewV1 {
  schemaVersion: 1;
  id: string;
  producer: {
    kind: 'execute_sql' | 'execute_sql_on' | 'invoke_skill';
    sourceToolCallId?: string;
    paramsHash?: string;
    planPhaseId?: string;
    planPhaseTitle?: string;
    traceSide?: 'current' | 'reference';
    traceId?: string;
  };
  title: string;
  purpose: string;
  source: {
    skillId?: string;
    stepId?: string;
    artifactId?: string;
    evidenceRefId?: string;
    queryHash?: string;
  };
  reads: Array<{
    table: string;
    columns?: string[];
    confidence: 'declared' | 'observed' | 'partial';
  }>;
  filters: Array<{
    expression: string;
    confidence: 'declared' | 'observed' | 'partial';
  }>;
  outputShape: Array<{
    name: string;
    type?: string;
    required?: boolean;
  }>;
  guardrails: Array<{
    ruleId: string;
    message: string;
    line?: number;
    severity: 'info' | 'warning';
  }>;
  limitations: string[];
  observedExecution: {
    executed: true;
    executableSql?: string;
    sqlRewrites?: string[];
    stdlibInjectedModules?: string[];
    durationMs?: number;
    rowCount?: number;
    truncated?: boolean;
  };
  allowedUse: 'review_metadata_only';
}
```

Attach to existing surfaces:

```ts
export interface DataEnvelopeMeta {
  queryReview?: QueryReviewV1;
}

export interface StoredArtifact {
  queryReview?: QueryReviewV1;
}
```

Design notes:

- Prefer `QueryReviewV1` as the first contract name. A later true IR compiler
  can introduce `QueryPlanIRV2`; the MVP should not imply bidirectional SQL
  fidelity.
- `observedExecution.executed` is always `true` for first-release objects.
  Proposed/unexecuted model plans are explicitly out of scope.
- `reads` and `filters` may be partial. Complex SQL must add limitations rather
  than pretending the extractor fully understood it.
- For Skills, `reads` and output shape should be derived from Skill YAML and
  display metadata when possible. Do not duplicate durable Skill definitions in
  TypeScript.
- Query review can include `executableSql`, but the raw SQL remains available
  in the existing tool response/artifact/report path.

## Implementation Update 2026-07-06

Implemented the first milestone as an observed-execution review sidecar:

- Added `QueryReviewV1` in `backend/src/types/queryReviewContract.ts` with
  fail-closed sanitization, bounded fields, and compact tool-response
  projection that strips `observedExecution.executableSql`.
- Added SQL and Skill builders under `backend/src/services/queryReview/`.
  SQL review extracts best-effort reads, filters, output shape, existing SQL
  guardrail warnings, stdlib injections, rewrites, and limitations. Skill
  review uses observed `DisplayResult` SQL/output metadata; direct YAML
  definition mining remains deferred.
- Attached review sidecars to successful `execute_sql`, `execute_sql_on`, and
  `invoke_skill` DataEnvelopes/artifacts. SQL failures now return compact
  review metadata when the attempted executable SQL is available, but do not
  create evidence refs.
- Added `queryReviewId` to Evidence Anchor context. Evidence support still
  cites DataEnvelope rows/artifacts; query review remains review metadata only.
- Rendered collapsed Query Review details in HTML reports near evidence tables.
- Regenerated frontend contract types and preserved `queryReview` through SSE
  DataEnvelope table messages.
- Added a collapsed AI Assistant "Query review" disclosure beside SQL/Skill
  evidence tables. It shows purpose, reads, filters, output fields, guardrails,
  limitations, and expert-accessible executable SQL while labeling the payload
  as `review_metadata_only`.

## Files and Responsibilities

- Created: `backend/src/types/queryReviewContract.ts`
  - `QueryReviewV1` types, schema guards, and small sanitizers.
- Created: `backend/src/services/queryReview/queryReviewBuilder.ts`
  - Builds review sidecars for executed SQL and Skill outputs.
- Created: `backend/src/services/queryReview/sqlReviewIntrospector.ts`
  - Best-effort SQL read/filter/output extraction for simple SQL, using the
    same masking/scanning discipline as `rawSqlNormalizer.ts`.
- Created: `backend/src/services/queryReview/skillQueryReviewBuilder.ts`
  - Builds Skill review sidecars from display results, source SQL when present,
    and artifact/evidence metadata.
- Modified: `backend/src/types/dataContract.ts`
  - Add optional `queryReview` to `DataEnvelopeMeta` and
    `createDataEnvelope(...)` options.
- Modified: `backend/src/agentv3/artifactStore.ts`
  - Store optional `queryReview` and include compact query-review id/summary in
    artifact summaries when useful.
- Modified: `backend/src/agentv3/claudeMcpServer.ts`
  - Attach query review to `execute_sql`, `execute_sql_on`, and `invoke_skill`
    responses/DataEnvelopes/artifacts after execution.
- Modified: `backend/src/services/evidence/evidenceContractBuilder.ts`
  - Preserve `queryReview.id` in evidence anchor context when available, without
    treating review metadata as evidence.
- Modified: `backend/src/services/htmlReportGenerator.ts`
  - Render compact query review cards beside SQL/Skill evidence.
- Modified: `backend/scripts/generateFrontendTypes.ts`
  - Regenerate frontend contract after DataEnvelope changes.
- Deferred: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sse_event_handlers.ts`
  - No change needed for this milestone; generated `DataEnvelopeMeta` now
    carries `queryReview`.
- Deferred: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sql_result_table.ts`
  - Optional first UI disclosure remains a separate frontend pass.
- Added tests:
  - `backend/src/types/__tests__/queryReviewContract.test.ts`
  - `backend/src/services/queryReview/__tests__/sqlReviewIntrospector.test.ts`
  - `backend/src/services/queryReview/__tests__/queryReviewBuilder.test.ts`
  - `backend/src/services/queryReview/__tests__/skillQueryReviewBuilder.test.ts`
  - `backend/src/services/evidence/__tests__/evidenceContractBuilder.test.ts`
  - `backend/src/services/__tests__/htmlReportGenerator.test.ts`

## Implementation Tasks

### Task 1: Define Query Review Contract

**Interfaces:**

- Produces:

```ts
export function sanitizeQueryReview(value: unknown): QueryReviewV1 | undefined;
export function compactQueryReviewForToolResponse(review: QueryReviewV1): unknown;
```

- Consumes: executed SQL/Skill metadata.

- [x] Add `QueryReviewV1` in a backend type file that can be imported by
  DataEnvelope and report code without circular dependencies.
- [x] Enforce `allowedUse: 'review_metadata_only'`.
- [x] Require `producer.kind`, `title`, `purpose`, `observedExecution`, and at
  least one output-shape field or limitation.
- [x] Cap strings and arrays so review metadata cannot balloon report/chat
  payloads.
- [x] Reject unexecuted or model-proposed reviews in the first release.

Validation:

```bash
cd backend
npx jest src/types/__tests__/queryReviewContract.test.ts --runInBand
```

Expected result: invalid or unbounded query-review payloads fail closed.

### Task 2: Add SQL Review Builder

**Interfaces:**

- Produces:

```ts
export function buildSqlQueryReview(input: {
  toolName: 'execute_sql' | 'execute_sql_on';
  sql: string;
  executableSql: string;
  columns: string[];
  rowCount: number;
  durationMs?: number;
  truncated?: boolean;
  traceProvenance: TraceProcessorQueryProvenance;
  producer: EvidenceProducerContext;
  evidenceRefId?: string;
  artifactId?: string;
  sqlRewrites?: string[];
  stdlibInjectedModules?: string[];
  processIdentityWarning?: string;
}): QueryReviewV1;
```

- Consumes: normalized/final SQL execution metadata, result columns, guardrail
  analyzer output, and plan producer context.

- [x] Run `analyzeSqlGuardrails(...)` against executable SQL and attach findings
  as warnings, not blockers.
- [x] Extract tables, rough filters, and output aliases for simple SELECTs.
- [x] Add explicit limitations for joins, CTEs, subqueries, window functions,
  virtual table creation, or partial extraction.
- [x] Include SQL rewrites and injected stdlib modules from the existing tool
  path.
- [x] Carry `processIdentityWarning` as a guardrail/limitation.
- [x] Never rewrite or re-execute SQL based on the review builder.

Validation:

```bash
cd backend
npx jest src/services/queryReview/__tests__/sqlReviewIntrospector.test.ts --runInBand
npx jest src/services/queryReview/__tests__/queryReviewBuilder.test.ts --runInBand
```

Expected result: simple queries get useful reads/filters/output shape; complex
queries are marked partial with limitations.

### Task 3: Attach Review to SQL Tool Outputs

**Interfaces:**

- Produces: query review on SQL tool JSON, SQL DataEnvelope metadata, and SQL
  artifacts.
- Consumes: `execute_sql` and `execute_sql_on` success/failure paths.

- [x] On successful SQL with columns, build `QueryReviewV1` after
  `runRawSqlWithIncludeInjection(...)`.
- [x] Attach compact review metadata to the tool response.
- [x] Pass full review metadata into `emitSqlDataEnvelope(...)` and
  `emitSqlSummaryDataEnvelope(...)`.
- [x] Store review metadata in SQL artifacts created by
  `storeSqlResultArtifact(...)`.
- [x] On SQL failure, return review metadata only if it can be built from the
  attempted executable SQL and mark output shape as unknown with limitations.
- [x] Keep existing `executableSql`, `traceProvenance`, `evidenceRefId`, and
  artifact response fields unchanged.

Validation:

```bash
cd backend
npx jest src/agentv3/__tests__/claudeMcpServer.test.ts --runInBand
```

Expected result: existing SQL tool assertions keep passing, and new assertions
prove query review is attached without changing execution semantics.

### Task 4: Build Review for Skill Outputs

**Interfaces:**

- Produces:

```ts
export function buildSkillQueryReviews(input: {
  skillId: string;
  params: Record<string, unknown>;
  displayResults: SkillDisplayResult[];
  artifactsByStepId: Map<string, string>;
  evidenceRefsByStepId: Map<string, string>;
  producer: EvidenceProducerContext;
  traceProvenance: TraceProcessorQueryProvenance;
}): Map<string, QueryReviewV1>;
```

- Consumes: Skill definitions, Skill step metadata, display columns, artifact
  ids, and evidence refs.

- [x] Build one review per displayed step when observed display metadata
  provides enough step metadata.
- [x] Use Skill `DisplayResult` SQL, display config, and output columns where
  available. Direct YAML definition mining is deferred.
- [x] Mark composite/iterator/diagnostic/AI summary steps with limitations when
  they cannot be represented as a single SQL-like read.
- [x] Attach review ids to Skill artifact summaries and DataEnvelopes.
- [x] Do not copy complete Skill SQL into chat for every step; keep full detail
  in artifacts/report surfaces.

Validation:

```bash
cd backend
npx jest src/services/queryReview/__tests__/skillQueryReviewBuilder.test.ts --runInBand
npx jest src/agentv3/__tests__/claudeMcpServer.test.ts --runInBand
```

Expected result: representative atomic and composite Skills produce bounded
review sidecars without changing Skill execution.

### Task 5: Preserve Review Through Evidence and Reports

- [x] Add `queryReviewId` or equivalent bounded reference to evidence anchor
  context when the referenced DataEnvelope carries `queryReview`.
- [x] Render query review cards in HTML report near the evidence table/card.
- [x] Keep raw SQL available in the appendix or existing SQL section.
- [x] Ensure final claim support still cites evidence anchors, not query review
  alone.
- [x] Add report/evidence tests for SQL query-review metadata and anchor
  references.

Validation:

```bash
cd backend
npx jest \
  src/services/__tests__/htmlReportGenerator.test.ts \
  src/services/__tests__/agentResultNormalizer.test.ts \
  --runInBand
```

Expected result: report readers can inspect query intent and warnings without
losing evidence provenance.

### Task 6: Optional Frontend Review Card

- [x] Generate frontend types after DataEnvelope contract changes.
- [x] Preserve query review metadata through SSE message handling.
- [x] Add a collapsed "Query review" disclosure near SQL/Skill result tables.
- [x] Show purpose, reads, filters, output fields, guardrail warnings, and
  limitations.
- [x] Keep raw SQL available for expert users.
- [x] Avoid making this card look like a verified conclusion.

Validation:

```bash
cd backend
npm run generate:frontend-types
```

Then run the current plugin unit/browser checks available in this checkout.

### Task 7: Integration Gates

- [x] Focused backend query-review tests.
- [x] `cd backend && npm run typecheck`.
- [x] Frontend contract type generation completed.
- [x] Plugin UI tests, browser smoke, and `./scripts/update-frontend.sh`.
- [x] `git diff --check`.
- [ ] Before release-ready implementation under the parent project goal, run
  Claude and Deepseek-backed OpenAI Agent SSE e2e and inspect that query review
  appears without changing evidence or final-claim behavior.

## Implementation Standard Checklist

This feature is not implementation-ready until a reviewer can answer "yes" to
all of these:

- Is the first milestone an observed-execution review sidecar, not a new SQL
  compiler or model-controlled execution contract?
- Does every review say `allowedUse: 'review_metadata_only'`?
- Are raw SQL, DataEnvelope evidence, artifacts, query review, and final claims
  still separate surfaces?
- Does SQL review reuse current normalization/include/guardrail behavior instead
  of adding a second execution path?
- Are complex SQL reads/filters marked partial with limitations?
- Are guardrail findings warnings unless a separate existing validation gate
  already blocks them?
- Do Skill reviews derive from Skill YAML/display metadata rather than
  duplicated TypeScript prompt content?
- Are frontend types regenerated from `dataContract.ts` if query review reaches
  the UI?

## Risks and Mitigations

- Risk: this becomes a new query language.
  - Mitigation: first release observes executed SQL/Skill outputs only; no
    model-proposed execution and no compiler.
- Risk: SQL introspection lies about complex queries.
  - Mitigation: partial extraction, explicit limitations, and raw SQL remains
    visible.
- Risk: review metadata is mistaken for evidence.
  - Mitigation: `review_metadata_only`, report wording, and evidence-contract
    tests that still require DataEnvelope/artifact anchors.
- Risk: report/chat payloads grow too large.
  - Mitigation: compact tool response projection and full detail only in
    bounded report/artifact surfaces.
- Risk: duplicated Skill metadata drifts.
  - Mitigation: derive from Skill definitions and display metadata at runtime.
- Risk: runtime guardrail warnings disrupt existing flows.
  - Mitigation: surface them as warnings in the first release; keep execution
    semantics unchanged.

## Reviewer Questions

- Should SQL guardrail findings remain warnings in the runtime path, or should
  any existing validate-only rules become blockers later?
  - Decision: keep guardrail findings as warnings in this feature. Only rules
    that already block through an existing validation gate may remain blockers.
- Should `queryReview` live directly in `DataEnvelopeMeta`, or should
  DataEnvelope carry only `queryReviewId` while artifacts/reports hold the full
  sidecar?
  - Decision: attach a compact `queryReview` sidecar directly to
    `DataEnvelopeMeta`, and allow artifacts/reports to retain the fuller detail
    when size or raw SQL makes the UI payload too large.
- Should Skill query reviews include full SQL in report surfaces, or only
  step/table/output summaries with artifact links?
  - Decision: default reports show step/table/output summaries with artifact
    links. Full SQL remains in raw artifact/expert surfaces, not the normal
    report prose.
- Should frontend query review be included in the first implementation, or
  should the first milestone remain backend/report-only?
  - Decision: first implementation is backend/report/API sidecar only. Frontend
    disclosure can follow once the sidecar shape has survived e2e runs.
