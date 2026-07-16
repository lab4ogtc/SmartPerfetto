# Batch Trace Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a bounded local batch trace lifecycle that runs existing
SmartPerfetto Skills across many traces, records every per-trace outcome,
summarizes comparable metrics, and can explicitly promote selected results into
analysis-result snapshots for existing comparison flows.

**Architecture:** The first release is a deterministic Skill batch runner, not
a distributed Bigtrace system and not a multi-agent loop. CLI runs accept local
trace paths; workspace API runs accept existing workspace trace IDs. Both
surfaces use the same batch service, metric extractor, result store, HTML/JSON
reporter, and resource limits. AI narration is excluded from the first release;
comparison and snapshot reuse happen only through explicit promotion actions.

**Tech Stack:** Node.js 24 LTS, TypeScript strict mode, Commander CLI,
Express workspace routes, `TraceProcessorService`, trace processor leases,
`SkillExecutor`, DataEnvelope conversion, SQLite enterprise schema,
analysis-result snapshots, comparison services, Jest.

## Global Constraints

- Batch mode is deterministic Skill execution first.
- First release must not execute arbitrary raw SQL across a trace set.
- First release must not create a distributed execution service, remote worker,
  or Bigtrace replacement.
- Per-trace failures must be stored and shown in CLI JSON, API responses, and
  HTML reports.
- Batch runs must have hard trace-count and concurrency limits.
- Batch output must not enter normal single-session chat by default.
- Snapshot promotion must be an explicit user action and must preserve
  deterministic evidence provenance.

---

## Code-Grounded Current State

At the planning/review checkpoint before implementation, the relevant files and
contracts were:

- `backend/src/cli-user/bin.ts`
  - Existing CLI commands include `run`, `analyze`, `query`, `skill`,
    `compare`, and `capture`.
  - There is no `batch` command group.
- `backend/src/cli-user/commands/skill.ts`
  - `runSkillCommand()` loads exactly one local trace path through
    `CliAnalyzeService.loadTrace()`, creates a `SkillExecutor`, registers the
    global built-in `skillRegistry`, executes one Skill, writes machine output,
    and shuts down the CLI service.
  - Reusing this command in a loop would repeatedly initialize and clean up the
    trace processor service. Batch needs its own service lifecycle.
- `backend/src/cli-user/commands/query.ts`
  - `runQueryCommand()` executes one SQL query against one trace. Plan 7 should
    not generalize this into arbitrary batch SQL until Plan 5 query review is
    implemented.
- `backend/src/cli-user/commands/compare.ts`
  - Raw trace comparison is an AI-assisted two-trace session, not an N-trace
    deterministic batch runner.
- `backend/src/services/traceProcessorService.ts`
  - `loadTraceFromFilePath(filePath)` copies a local trace into the upload
    store and processes it.
  - `ensureProcessorForLease()`, `runWithLease()`, `runWithLeases()`, and
    `cleanupProcessorsForTraces()` provide the resource hooks needed by a batch
    runner.
- `backend/src/services/traceProcessorLeaseStore.ts`
  - Holder types currently include `frontend_http_rpc`, `agent_run`,
    `report_generation`, `metric_backfill`, and `manual_register`.
  - Batch should add an explicit `batch_trace_run` holder type rather than
    hiding under `agent_run`.
- `backend/src/services/skillEngine/skillExecutor.ts`
  - `SkillExecutor.execute()` creates an isolated execution context per call and
    returns `displayResults`, `synthesizeData`, `rawResults`, diagnostics,
    identity resolution, and execution time.
  - `SkillExecutor.toDataEnvelopes()` converts Skill output into DataEnvelope
    surfaces with trace provenance hooks.
- `backend/src/agent/core/executors/directSkillExecutor.ts`
  - Existing direct Skill batching is per-trace, task-oriented, and agent
    pipeline-specific. It proves `SkillExecutor` is reentrant but is not a
    multi-trace lifecycle store.
- `backend/src/types/dataContract.ts`
  - DataEnvelope and DisplayResult conversion already exist and should be reused
    for metric extraction instead of introducing a second result shape.
- `backend/src/types/multiTraceComparison.ts`
  - Standard comparison metrics and snapshot/result comparison types already
    exist: `AnalysisResultSnapshot`, `NormalizedMetricValue`,
    `STANDARD_COMPARISON_METRICS`, `MultiTraceComparisonRun`.
- `backend/src/services/comparisonResultService.ts`
  - `buildDeterministicComparisonResult()` builds comparison matrices from
    analysis-result snapshots. Batch should promote selected per-trace results
    into snapshots before using this path.
- `backend/src/services/multiTraceComparisonStore.ts`
  - `MultiTraceComparisonRunRepository` persists comparison runs over snapshot
    IDs. It does not compare raw batch trace results directly.
- `backend/src/routes/comparisonRoutes.ts`
  - Workspace comparison APIs are already mounted under
    `/api/workspaces/:workspaceId/comparisons` and enforce RBAC.
- `backend/src/services/enterpriseSchema.ts`
  - There are no batch trace run tables today. Adding workspace API lifecycle
    support requires new schema tables.
- `docs/reference/cli.md` and `docs/reference/api.md`
  - Current user docs describe single-run CLI and comparison APIs, but no batch
    command or batch route.

## First Release Decisions

- Supported execution: `SkillExecutor.execute(skillId, traceId, params)` over a
  bounded trace set.
- Unsupported execution: arbitrary batch SQL, LLM-driven per-trace analysis,
  distributed workers, remote trace stores, and automatic snapshot promotion.
- CLI input: explicit local trace paths plus `--trace-list <file>` for one path
  per line. Shell glob expansion is allowed by the shell but is not a service
  contract.
- API input: existing workspace `traceId` values only. Uploading trace sets is
  handled by existing trace upload APIs before creating a batch run.
- Default limits: max 100 traces per run, default concurrency 2, max
  concurrency 4 for source/CLI and 2 for workspace API unless configuration
  raises it.
- First supported Skill families: executable Skills that emit numeric
  overview/list metrics through `displayResults`, `synthesizeData`, or
  DataEnvelope columns. `comparison` and `pipeline_definition` Skills are
  rejected because they are metadata-only or not single-trace executable.
- Metric extraction: map known columns and synthesize fields to
  `NormalizedMetricValue`; unrecognized numeric fields remain batch-local
  metrics and are not promoted to standard comparison keys without an explicit
  mapping.
- Persistence:
  - CLI writes local artifacts under the configured CLI session root in
    `batch-runs/<runId>/`.
  - API writes workspace-scoped rows into new enterprise batch tables.
- Promotion: selected completed per-trace batch results can be promoted into
  `AnalysisResultSnapshot` rows with `status = 'ready'` or `partial` and source
  metadata identifying the batch run. Promotion is never automatic.
- UI: no new browser UI in the first release. Existing API and CLI surfaces are
  enough to run and inspect the lifecycle.

## Implementation Update 2026-07-06

Implemented the first release as a deterministic Skill batch lifecycle:

- Added shared `BatchTraceRunV1`, per-trace result, metric, aggregate, limit,
  runner, store, report, and snapshot-promotion services under
  `backend/src/services/batchTrace/`.
- Added `batch_trace_run` trace-processor lease holder semantics. Workspace/API
  runs acquire real per-trace leases; CLI local-path runs reuse the same runner
  but avoid enterprise lease rows because local trace imports are not workspace
  `trace_assets`.
- Added enterprise batch tables and repository support for
  `batch_trace_runs`, `batch_trace_inputs`, `batch_trace_results`, and
  `batch_trace_metrics`.
- Added workspace routes at
  `/api/workspaces/:workspaceId/batch-traces` for create/list/read/export,
  explicit snapshot promotion, and comparison bridge through the existing
  analysis-result comparison path.
- Kept batch run reads workspace-scoped: route RBAC enforces `report:read`,
  while the store does not make batch reports creator-private.
- Added `smp batch skill <skillId> [trace...]` with `--trace-list`,
  `--params`, `--concurrency`, `--format`, `--out`, and `--json-out`.
- Kept batch execution deterministic and LLM-free. Raw batch SQL, remote
  workers, browser UI, and automatic snapshot promotion remain unsupported in
  the first release.
- Tightened metric promotion after real trace smoke: startup `dur_ms` /
  `ttid_ms` outputs from startup contexts now promote to
  `startup.total_ms` / `startup.first_frame_ms`; unmapped numeric fields remain
  batch-local.

Validation completed for this implementation:

- Focused Plan 7 Jest suite passed: 9 suites / 33 tests across aggregation,
  metric extraction, runner, store, snapshot promotion, route/RBAC, request
  context coverage, lease holder behavior, and CLI command behavior.
- `npm run typecheck` passed.
- `npm run validate:skills` passed: 207 / 207 Skill files, with existing
  non-blocking warnings.
- `npm run cli:pack-check` passed, including backend build and CLI package
  manifest validation.
- `npm run test:scene-trace-regression` passed across all 6 canonical traces.
- Real CLI smoke passed on `Trace/real/android-startup-light/trace.pftrace`, wrote JSON/HTML
  artifacts, and produced promotable `startup.total_ms = 301.839437` and
  `startup.first_frame_ms = 299.818888`.
- `git diff --check` passed.

## Proposed Contracts

Create `backend/src/services/batchTrace/batchTraceTypes.ts`:

```ts
export const BATCH_TRACE_RUN_SCHEMA_VERSION = 'batch_trace_run@1' as const;

export type BatchTraceInputSource = 'local_path' | 'workspace_trace';
export type BatchTraceRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';
export type BatchTraceResultStatus = 'completed' | 'failed' | 'unsupported';

export interface BatchTraceInputV1 {
  ordinal: number;
  source: BatchTraceInputSource;
  tracePath?: string;
  traceId?: string;
  label?: string;
  sizeBytes?: number;
}

export interface BatchTraceMetricV1 {
  key: string;
  label: string;
  value: number | string | null;
  numericValue?: number;
  unit?: string;
  source: {
    skillId: string;
    stepId?: string;
    dataEnvelopeId?: string;
    displayResultStepId?: string;
  };
  promotableMetricKey?: import('../../types/multiTraceComparison').ComparisonMetricKey;
  missingReason?: string;
}

export interface BatchTraceResultV1 {
  ordinal: number;
  input: BatchTraceInputV1;
  traceId?: string;
  status: BatchTraceResultStatus;
  metrics: BatchTraceMetricV1[];
  evidenceEnvelopeIds: string[];
  diagnostics: Array<{ severity: string; message: string }>;
  executionTimeMs: number;
  error?: string;
  promotedSnapshotId?: string;
}

export interface BatchTraceAggregateMetricV1 {
  key: string;
  label: string;
  unit?: string;
  count: number;
  missingCount: number;
  min?: number;
  p50?: number;
  p90?: number;
  p95?: number;
  max?: number;
  mean?: number;
  outlierOrdinals: number[];
}

export interface BatchTraceRunV1 {
  schemaVersion: typeof BATCH_TRACE_RUN_SCHEMA_VERSION;
  id: string;
  tenantId?: string;
  workspaceId?: string;
  createdBy?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  status: BatchTraceRunStatus;
  input: {
    skillId: string;
    params: Record<string, unknown>;
    traceInputs: BatchTraceInputV1[];
    maxConcurrency: number;
    traceLimit: number;
  };
  perTrace: BatchTraceResultV1[];
  aggregate?: {
    metrics: BatchTraceAggregateMetricV1[];
    limitations: string[];
  };
  report?: {
    htmlPath?: string;
    jsonPath?: string;
    reportId?: string;
  };
  comparisonId?: string;
}
```

CLI command:

```text
smp batch skill <skillId> <trace...>
smp batch skill <skillId> --trace-list traces.txt --format json --out ./batch.html
```

Workspace routes:

```text
POST   /api/workspaces/:workspaceId/batch-traces
GET    /api/workspaces/:workspaceId/batch-traces/:runId
GET    /api/workspaces/:workspaceId/batch-traces/:runId/report/export
POST   /api/workspaces/:workspaceId/batch-traces/:runId/promote-snapshots
POST   /api/workspaces/:workspaceId/batch-traces/:runId/comparisons
```

The create route requires `agent:run`. Read/export require `report:read`.
Promotion requires `analysis_result:create`. Comparison creation requires
`comparison:create`.

## Files and Responsibilities

- Create: `backend/src/services/batchTrace/batchTraceTypes.ts`
  - Shared batch run, per-trace result, metric, aggregate, and persistence
    contracts.
- Create: `backend/src/services/batchTrace/batchTraceLimits.ts`
  - Trace count, concurrency, file size, and timeout defaults with config env
    parsing.
- Create: `backend/src/services/batchTrace/batchTraceMetricExtractor.ts`
  - Converts Skill execution output, DisplayResults, synthesizeData, and
    DataEnvelopes into `BatchTraceMetricV1` and promotable
    `NormalizedMetricValue` candidates.
- Create: `backend/src/services/batchTrace/batchTraceAggregator.ts`
  - Deterministic percentiles, means, outlier ordinals, and limitation text.
- Create: `backend/src/services/batchTrace/batchTraceRunner.ts`
  - Orchestrates trace loading/resolution, lease acquisition, Skill execution,
    per-trace failure capture, cleanup, and aggregate creation.
- Create: `backend/src/services/batchTrace/batchTraceStore.ts`
  - Workspace API persistence over new enterprise tables.
- Create: `backend/src/services/batchTrace/batchTraceReportService.ts`
  - JSON and HTML report rendering for CLI and API export.
- Create: `backend/src/services/batchTrace/batchTraceSnapshotPromotionService.ts`
  - Promotes selected completed per-trace results into
    `AnalysisResultSnapshot` rows using existing snapshot repository contracts.
- Create: `backend/src/cli-user/commands/batch.ts`
  - CLI command implementation and local artifact layout.
- Modify: `backend/src/cli-user/bin.ts`
  - Register the `batch skill` command group.
- Modify: `backend/src/services/traceProcessorLeaseStore.ts`
  - Add `batch_trace_run` holder type and TTL policy.
- Modify: `backend/src/services/enterpriseSchema.ts`
  - Add batch run, input, result, metric, and report metadata tables for
    workspace API lifecycle.
- Create: `backend/src/controllers/batchTraceController.ts`
  - Workspace route handlers.
- Create: `backend/src/routes/batchTraceRoutes.ts`
  - Workspace-scoped route definitions and RBAC checks.
- Modify: `backend/src/index.ts`
  - Mount `batchTraceRoutes` at `/api/workspaces/:workspaceId/batch-traces`.
- Modify: `docs/reference/cli.md` and `docs/reference/cli.en.md`
  - Document `smp batch skill`.
- Modify: `docs/reference/api.md` and `docs/reference/api.en.md`
  - Document workspace batch trace routes.
- Test: `backend/src/services/batchTrace/__tests__/batchTraceMetricExtractor.test.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceAggregator.test.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceRunner.test.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceStore.test.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceSnapshotPromotionService.test.ts`
- Test: `backend/src/cli-user/commands/__tests__/batch.test.ts`
- Test: `backend/src/routes/__tests__/batchTraceRoutes.test.ts`
- Test: extend `backend/src/routes/__tests__/requestContextRouteCoverage.test.ts`

## Implementation Tasks

### Task 1: Contracts, Limits, and Aggregation

**Files:**

- Create: `backend/src/services/batchTrace/batchTraceTypes.ts`
- Create: `backend/src/services/batchTrace/batchTraceLimits.ts`
- Create: `backend/src/services/batchTrace/batchTraceAggregator.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceAggregator.test.ts`

**Interfaces:**

- Consumes: `BatchTraceResultV1[]`.
- Produces:
  - `resolveBatchTraceLimits(env?: NodeJS.ProcessEnv): BatchTraceLimits`
  - `aggregateBatchTraceResults(results: BatchTraceResultV1[]): BatchTraceRunV1['aggregate']`

- [x] Define `BATCH_TRACE_RUN_SCHEMA_VERSION`, `BatchTraceRunV1`,
  `BatchTraceResultV1`, `BatchTraceMetricV1`, and aggregate types.
- [x] Implement `resolveBatchTraceLimits()` with defaults:
  `maxTraceCount = 100`, `defaultConcurrency = 2`,
  `maxCliConcurrency = 4`, `maxApiConcurrency = 2`.
- [x] Reject invalid env overrides with explicit errors:
  `invalid_batch_trace_limit`, `invalid_batch_trace_concurrency`.
- [x] Implement deterministic percentile calculation over sorted finite numeric
  values using nearest-rank semantics.
- [x] Mark missing metrics in `limitations` with trace ordinals and metric keys.
- [x] Detect outliers with median absolute deviation when at least five numeric
  values exist; otherwise leave `outlierOrdinals` empty and record a limitation
  explaining the sample is too small.

Validation:

```bash
cd backend
npx jest src/services/batchTrace/__tests__/batchTraceAggregator.test.ts --runInBand
```

Expected result: aggregate output is deterministic, trace order stable, and
missing/failed traces are visible in limitations.

### Task 2: Metric Extraction From Skill Output

**Files:**

- Create: `backend/src/services/batchTrace/batchTraceMetricExtractor.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceMetricExtractor.test.ts`

**Interfaces:**

- Consumes:
  - `SkillExecutionResult`
  - `DataEnvelope[]` from `SkillExecutor.toDataEnvelopes()`
  - Skill ID and trace ordinal
- Produces:
  - `extractBatchTraceMetrics(input): BatchTraceMetricV1[]`
  - `toPromotableNormalizedMetrics(input): NormalizedMetricValue[]`

- [x] Extract finite numeric fields from `synthesizeData` where
  `config.role === 'overview'`.
- [x] Extract finite numeric table columns from DataEnvelope payloads with
  `meta.layer === 'overview'` or `meta.level === 'key'`.
- [x] Preserve string environment metrics such as device model only when they
  map to existing `STANDARD_COMPARISON_METRICS`.
- [x] Map known startup and scrolling columns to standard comparison metric
  keys:
  - startup duration fields to `startup.total_ms`,
    `startup.first_frame_ms`, `startup.bind_application_ms`,
    `startup.activity_start_ms`, `startup.main_thread_blocked_ms`
  - scrolling fields to `scrolling.avg_fps`, `scrolling.frame_count`,
    `scrolling.jank_count`, `scrolling.jank_rate_pct`,
    `scrolling.p50_frame_ms`, `scrolling.p95_frame_ms`,
    `scrolling.p99_frame_ms`
- [x] Do not invent metric values. If a standard metric is absent, emit a
  missing reason instead of `0`.
- [x] Carry source references with Skill ID, step ID, DataEnvelope ID, and
  display result step ID.

Validation:

```bash
cd backend
npx jest src/services/batchTrace/__tests__/batchTraceMetricExtractor.test.ts --runInBand
```

Expected result: standard metrics are promoted only from observed Skill output,
and unmapped numeric values remain batch-local metrics.

### Task 3: Runner Over Trace Processor and Skill Executor

**Files:**

- Create: `backend/src/services/batchTrace/batchTraceRunner.ts`
- Modify: `backend/src/services/traceProcessorLeaseStore.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceRunner.test.ts`
- Test: extend `backend/src/services/__tests__/traceProcessorLeaseStore.test.ts`

**Interfaces:**

- Consumes:
  - `runBatchSkill(input: RunBatchSkillInput): Promise<BatchTraceRunV1>`
  - `TraceProcessorService`
  - `SkillRegistry`
  - `BatchTraceLimits`
- Produces:
  - completed or partial `BatchTraceRunV1`
  - per-trace status and metrics

- [x] Add `batch_trace_run` to `TraceProcessorHolderType` with a TTL policy
  matching long-running deterministic backend work.
- [x] Validate Skill existence before loading traces. Reject
  `comparison` and `pipeline_definition` Skill types with
  `unsupported_batch_skill_type`.
- [x] Resolve local path inputs through `loadTraceFromFilePath()` and workspace
  trace inputs through `getOrLoadTrace()`.
- [x] Acquire a trace processor lease per trace with holder type
  `batch_trace_run`, holder ref `batch:<runId>:<ordinal>`, and metadata
  containing skill ID and run ID.
- [x] Use `runWithLease()` for every Skill execution so SQL routing follows the
  acquired lease.
- [x] Register Skills and fragments once per runner instance, then execute each
  trace with isolated per-call Skill contexts.
- [x] Enforce concurrency with an in-file async worker loop; do not add a new
  dependency for concurrency limiting.
- [x] Capture per-trace exceptions as failed results while allowing other traces
  to continue.
- [x] Set run status:
  - `completed` when every trace completed
  - `partial` when at least one trace completed and at least one failed or was
    unsupported
  - `failed` when no trace completed
- [x] Release every lease and call `cleanupProcessorsForTraces()` for batch-only
  local traces after the run finishes.

Validation:

```bash
cd backend
npx jest src/services/batchTrace/__tests__/batchTraceRunner.test.ts --runInBand
npx jest src/services/__tests__/traceProcessorLeaseStore.test.ts --runInBand
```

Expected result: runner records success/failure per trace, respects concurrency,
uses the lease path, and cleans up processors for local batch traces.

### Task 4: Store, API Routes, and Report Export

**Files:**

- Modify: `backend/src/services/enterpriseSchema.ts`
- Create: `backend/src/services/batchTrace/batchTraceStore.ts`
- Create: `backend/src/services/batchTrace/batchTraceReportService.ts`
- Create: `backend/src/controllers/batchTraceController.ts`
- Create: `backend/src/routes/batchTraceRoutes.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceStore.test.ts`
- Test: `backend/src/routes/__tests__/batchTraceRoutes.test.ts`
- Test: extend `backend/src/routes/__tests__/requestContextRouteCoverage.test.ts`

**Interfaces:**

- Consumes:
  - workspace `RequestContext`
  - `runBatchSkill()`
  - enterprise DB
- Produces:
  - persisted batch run rows
  - exported HTML report
  - workspace API responses

- [x] Add enterprise tables:
  - `batch_trace_runs`
  - `batch_trace_inputs`
  - `batch_trace_results`
  - `batch_trace_metrics`
- [x] Keep every table scoped by `tenant_id` and `workspace_id`.
- [x] Implement store methods:
  - `createRun(scope, input)`
  - `updateRunStatus(scope, runId, status, timestamps)`
  - `replaceResults(scope, runId, results, aggregate)`
  - `getRun(scope, runId)`
  - `listRuns(scope, filters)`
- [x] Implement `renderBatchTraceHtmlReport(run)` with per-trace table,
  aggregate metric table, outlier markers, diagnostics, and limitations.
- [x] Add `POST /api/workspaces/:workspaceId/batch-traces` accepting
  `{ skillId, traceIds, params, maxConcurrency }`.
- [x] Run API batch work synchronously in the first release and return the
  completed `BatchTraceRunV1`. If execution exceeds the request timeout in a
  future environment, the same store contract can back an async worker without
  changing the response schema.
- [x] Add `GET /:runId` and `GET /:runId/report/export`.
- [x] Enforce RBAC:
  - create requires `agent:run`
  - read/export require `report:read`
- [x] Add request context coverage for `/api/workspaces/:workspaceId/batch-traces`.

Validation:

```bash
cd backend
npx jest src/services/batchTrace/__tests__/batchTraceStore.test.ts --runInBand
npx jest src/routes/__tests__/batchTraceRoutes.test.ts --runInBand
npx jest src/routes/__tests__/requestContextRouteCoverage.test.ts --runInBand
```

Expected result: workspace batch API is scoped, persisted, readable, and
exportable without using legacy global routes.

### Task 5: Snapshot Promotion and Comparison Bridge

**Files:**

- Create: `backend/src/services/batchTrace/batchTraceSnapshotPromotionService.ts`
- Modify: `backend/src/controllers/batchTraceController.ts`
- Modify: `backend/src/routes/batchTraceRoutes.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceSnapshotPromotionService.test.ts`
- Test: extend `backend/src/routes/__tests__/batchTraceRoutes.test.ts`

**Interfaces:**

- Consumes:
  - completed or partial `BatchTraceRunV1`
  - selected ordinals
  - `AnalysisResultSnapshotRepository`
  - `MultiTraceComparisonRunRepository`
- Produces:
  - promoted snapshot IDs
  - optional comparison ID

- [x] Implement `promoteBatchTraceSnapshots(scope, runId, ordinals)` to create
  one `AnalysisResultSnapshot` for each selected completed result.
- [x] Use a deterministic summary:
  - headline: `Batch Skill result for <label>`
  - details: Skill ID, run ID, trace ordinal, completed metric count
  - partial reasons: diagnostics and missing standard metrics
- [x] Create `NormalizedMetricValue[]` only from metrics with
  `promotableMetricKey`; preserve batch-local metrics in snapshot evidence
  metadata rather than forcing them into standard comparison keys.
- [x] Create `EvidenceRef[]` pointing back to batch run ID, trace ordinal,
  Skill ID, step ID, and DataEnvelope IDs where present.
- [x] Set snapshot `status = 'ready'` when the per-trace result completed
  without diagnostics, otherwise `partial`.
- [x] Add `POST /:runId/promote-snapshots` requiring
  `analysis_result:create`.
- [x] Add `POST /:runId/comparisons` requiring `comparison:create`. It promotes
  selected results when needed, then calls `MultiTraceComparisonRunRepository`
  and `buildDeterministicComparisonResult()` over the promoted snapshot IDs.
- [x] Never promote failed or unsupported per-trace results.

Validation:

```bash
cd backend
npx jest src/services/batchTrace/__tests__/batchTraceSnapshotPromotionService.test.ts --runInBand
npx jest src/routes/__tests__/batchTraceRoutes.test.ts --runInBand
```

Expected result: selected batch results become ordinary analysis-result
snapshots and can flow through the existing comparison API without a private
batch-only comparison format.

### Task 6: CLI Command and Local Artifact Layout

**Files:**

- Create: `backend/src/cli-user/commands/batch.ts`
- Modify: `backend/src/cli-user/bin.ts`
- Test: `backend/src/cli-user/commands/__tests__/batch.test.ts`

**Interfaces:**

- Consumes:
  - local trace paths
  - `--trace-list`
  - `runBatchSkill()`
  - `renderBatchTraceHtmlReport()`
- Produces:
  - `smp batch skill`
  - local `batch-runs/<runId>/result.json`
  - local `batch-runs/<runId>/report.html`

- [x] Register `program.command('batch')` with subcommand
  `skill <skillId> [trace...]`.
- [x] Support `--trace-list <file>`, `--params <json>`, `--concurrency <n>`,
  `--format text|json|ndjson`, `--out <html>`, and `--json-out <json>`.
- [x] Deduplicate trace paths after resolving them to absolute paths.
- [x] Reject an empty trace set with exit code `2` and message
  `batch skill requires at least one trace`.
- [x] Use one `CliAnalyzeService` lifecycle for the entire batch and shut it
  down once.
- [x] Print one progress event per trace in text mode and one NDJSON event per
  trace in `ndjson` mode.
- [x] Write JSON and HTML artifacts under the configured CLI session root when
  explicit output paths are not provided.
- [x] Return exit code `0` for `completed`, `1` for `partial` or `failed`, and
  `2` for invalid CLI input.

Validation:

```bash
cd backend
npx jest src/cli-user/commands/__tests__/batch.test.ts --runInBand
npm run cli:dev -- batch skill startup_analysis ../Trace/real/android-startup-light/trace.pftrace --format json
```

Expected result: CLI batch can run one real trace, emit JSON, and write
artifacts without invoking an LLM provider.

### Task 7: Docs and Verification

**Files:**

- Modify: `docs/reference/cli.md`
- Modify: `docs/reference/cli.en.md`
- Modify: `docs/reference/api.md`
- Modify: `docs/reference/api.en.md`

**Interfaces:**

- Consumes: final CLI and API behavior from Tasks 1 through 6.
- Produces: user-facing reference docs and validation evidence.

- [x] Document `smp batch skill`, examples, exit codes, local artifact paths,
  limits, and the fact that no LLM provider is required.
- [x] Document workspace batch routes, RBAC, trace ID input, report export,
  snapshot promotion, and comparison bridge.
- [x] Document unsupported first-release behavior: raw batch SQL, remote
  workers, browser UI, and automatic snapshot promotion.
- [x] Run focused batch tests.
- [x] Run `cd backend && npm run typecheck`.
- [x] Run `cd backend && npm run validate:skills`.
- [x] Run `cd backend && npm run cli:pack-check` because the CLI command
  surface changes.
- [x] Run a real CLI smoke with `launch_light.pftrace`.
- [x] Run `git diff --check`.

Expected result: CLI, API, docs, TypeScript contracts, and packaging checks
agree on the batch trace lifecycle.

## Security and Quality Review Points

- Batch output is evidence, not a final AI conclusion. Reports and promotion
  records must keep per-trace diagnostics and missing metrics visible.
- Raw batch SQL waits for Plan 5 query review. This avoids shipping an
  unrestricted N-trace query runner before SQL intent and guardrail metadata
  exist.
- Snapshot promotion is explicit so a user can inspect partial or failed traces
  before they affect existing comparison products.
- API batch runs use workspace trace IDs to preserve resource ownership and
  upload lifecycle boundaries.
- CLI local paths are source-machine only and should not be stored in workspace
  enterprise rows.
- Resource limits are part of product behavior. Tests should cover trace-count
  limit rejection and concurrency clamping.

## Reviewer Questions Answered

- Which first Skill should batch mode support?
  - The runner accepts executable Skills, but only startup and scrolling metrics
    have standard comparison mappings in the first release.
- Should trace glob expansion happen in CLI or service tests?
  - Neither service nor tests depend on globs. CLI accepts explicit paths and
    `--trace-list`; shell expansion can supply explicit paths.
- Should batch runs persist in the same session store or a separate batch store?
  - CLI uses local `batch-runs/<runId>` artifacts. Workspace API uses separate
    enterprise batch tables because batch runs are not conversational sessions.
- What default limits are acceptable?
  - Default max trace count is 100, default concurrency is 2, CLI maximum is 4,
    and workspace API maximum is 2 unless configuration raises it.
- Should batch output create analysis-result snapshots automatically?
  - No. Promotion is an explicit route or CLI follow-up action, and failed or
    unsupported traces cannot be promoted.
- Should batch mode call Claude or OpenAI?
  - No. First release is deterministic and requires no LLM provider.
