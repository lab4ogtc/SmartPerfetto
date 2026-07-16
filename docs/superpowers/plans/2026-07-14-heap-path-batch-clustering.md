# Heap Path Batch Clustering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, evidence-backed cross-trace Java heap dominator-path clustering to SmartPerfetto's batch trace product surface.

**Architecture:** A YAML Skill extracts bounded per-trace dominator rows. `BatchTraceRunner` retains only the declared source step and sends it through a typed post-processor registry to a pure TypeScript TF-IDF/K-Means/Silhouette service. The versioned cross-trace result is persisted and reported on the batch run; per-trace snapshot promotion remains unchanged.

**Tech Stack:** Node.js 24, TypeScript strict mode, Jest, YAML Skills, PerfettoSQL, better-sqlite3, CommonJS trace corpus tools, protobufjs, pinned `trace_processor_shell`.

## Global Constraints

- No pandas, scikit-learn, Python runtime, model call, or ambient randomness.
- Clustering stays outside the single-trace SQL Skill.
- Missing heap data is a limitation, never proof that a leak is absent.
- Bound rows, vocabulary, candidate K, iterations, and matrix cells.
- Skills without `batch_analysis` retain current behavior.
- Preserve every unrelated worktree change.

---

### Task 1: Versioned contract and deterministic clustering engine

**Files:**
- Create: `backend/src/types/heapPathCluster.ts`
- Create: `backend/src/services/batchTrace/heapPathClusterService.ts`
- Test: `backend/src/services/batchTrace/__tests__/heapPathClusterService.test.ts`

**Interfaces:**
- Consumes: `HeapPathClusterInputRow[]`.
- Produces: `clusterHeapPaths(rows, failures?, options?): HeapPathClusterAnalysisV1`.

- [ ] **Step 1: Write the failing deterministic tests**

```ts
const rows = [
  {traceOrdinal: 0, traceId: 'a', upid: 1, sampleTs: '10', processName: 'app', path: '[ROOT_JNI_GLOBAL] Root [1] -> LeakedActivity [2]', className: 'LeakedActivity', rootType: 'ROOT_JNI_GLOBAL', selfSizeBytes: 128, retainedSizeBytes: 4096, evidenceRefId: 'a:1:10:1'},
  {traceOrdinal: 1, traceId: 'b', upid: 1, sampleTs: '20', processName: 'app', path: '[ROOT_JNI_GLOBAL] Root [3] -> LeakedActivity [1]', className: 'LeakedActivity', rootType: 'ROOT_JNI_GLOBAL', selfSizeBytes: 160, retainedSizeBytes: 4200, evidenceRefId: 'b:1:20:1'},
  {traceOrdinal: 2, traceId: 'c', upid: 2, sampleTs: '30', processName: 'app', path: '[ROOT_JAVA_FRAME] Thread [1] -> BitmapCache [5]', className: 'BitmapCache', rootType: 'ROOT_JAVA_FRAME', selfSizeBytes: 512, retainedSizeBytes: 9000, evidenceRefId: 'c:2:30:1'},
  {traceOrdinal: 3, traceId: 'd', upid: 2, sampleTs: '40', processName: 'app', path: '[ROOT_JAVA_FRAME] Thread [2] -> BitmapCache [8]', className: 'BitmapCache', rootType: 'ROOT_JAVA_FRAME', selfSizeBytes: 600, retainedSizeBytes: 9200, evidenceRefId: 'd:2:40:1'},
] as const;

expect(normalizeHeapPath(rows[0].path)).toBe('Root -> LeakedActivity');
expect(clusterHeapPaths([...rows].reverse())).toEqual(clusterHeapPaths([...rows]));
expect(clusterHeapPaths([rows[0]])).toMatchObject({status: 'insufficient_samples', selectedK: null});
```

- [ ] **Step 2: Run RED**

Run: `cd backend && npx jest src/services/batchTrace/__tests__/heapPathClusterService.test.ts --runInBand`

Expected: FAIL because the service and contract do not exist.

- [ ] **Step 3: Add the exact contract**

```ts
export const HEAP_PATH_CLUSTER_SCHEMA_VERSION = 'heap_path_cluster_analysis@1' as const;
export const HEAP_PATH_NORMALIZATION_VERSION = 'heap_path_normalization@1' as const;
export type HeapPathClusterStatus = 'completed' | 'partial' | 'unavailable' | 'insufficient_samples';

export interface HeapPathClusterInputRow {
  traceOrdinal: number; traceId: string; upid: number; sampleTs: string; processName: string;
  path: string; className: string; rootType: string; selfSizeBytes: number;
  retainedSizeBytes: number; evidenceRefId: string;
}

export interface HeapPathClusterFailure {
  traceOrdinal: number;
  traceId?: string;
  reason: string;
}

export interface HeapPathClusterAnalysisV1 {
  schemaVersion: typeof HEAP_PATH_CLUSTER_SCHEMA_VERSION;
  normalizationVersion: typeof HEAP_PATH_NORMALIZATION_VERSION;
  status: HeapPathClusterStatus;
  seedHash: string;
  selectedK: number | null;
  silhouetteScore: number | null;
  input: {traceCount: number; sampleCount: number; rowCount: number; rejectedRowCount: number};
  clusters: Array<{
    id: string; representativePath: string; classNames: string[]; rootTypes: string[];
    traceCount: number; sampleCount: number; rowCount: number; traceSupportPct: number;
    meanRetainedBytes: number; p95RetainedBytes: number; collapsedPaths: string[];
    evidenceRefIds: string[];
  }>;
  failures: HeapPathClusterFailure[];
  limitations: string[];
}
```

- [ ] **Step 4: Implement minimal bounded clustering**

```ts
export interface HeapPathClusterOptions {
  maxRows?: number; maxVocabulary?: number; maxK?: number;
  maxIterations?: number; collapseTolerancePct?: number;
}
export function normalizeHeapPath(path: string): string;
export function clusterHeapPaths(
  rows: HeapPathClusterInputRow[],
  failures?: HeapPathClusterFailure[],
  options?: HeapPathClusterOptions,
): HeapPathClusterAnalysisV1;
```

Sort normalized inputs before hashing. Use SHA-256 as the PRNG seed, sparse
TF-IDF maps, deterministic k-means++ initialization, Euclidean distance,
`K=2..min(maxK,rowCount-1)`, and mean Silhouette. Ties within `1e-12` choose
smaller K. Sort clusters by trace support, retained bytes, then path.

- [ ] **Step 5: Add tests for degenerate vectors, prefix collapse, bounds, rejected rows, and partial failures**

Expected contracts: identical vectors become one signature group with
`degenerate_vectors`; prefix paths within 5% retained bytes collapse;
non-finite/negative sizes are rejected; limit overflow is explicit; failures
change a successful result to `partial`.

- [ ] **Step 6: Run GREEN and commit**

Run: `cd backend && npx jest src/services/batchTrace/__tests__/heapPathClusterService.test.ts --runInBand`

```bash
git add backend/src/types/heapPathCluster.ts backend/src/services/batchTrace/heapPathClusterService.ts backend/src/services/batchTrace/__tests__/heapPathClusterService.test.ts
git commit -m "feat: add deterministic heap path clustering"
```

### Task 2: Extraction Skill and validated batch declaration

**Files:**
- Create: `backend/skills/composite/android_heap_dominator_path_extract.skill.yaml`
- Modify: `backend/src/services/skillEngine/types.ts`
- Create: `backend/src/services/skillEngine/skillBatchAnalysis.ts`
- Modify: `backend/src/services/skillEngine/skillLoader.ts`
- Modify: `backend/src/cli/commands/validate.ts`
- Create: `backend/src/services/skillEngine/__tests__/skillBatchAnalysis.test.ts`
- Test: `backend/src/services/skillEngine/__tests__/customSkillLoader.test.ts`
- Test: `backend/src/services/skillEngine/__tests__/memorySkillSqlSemantics.test.ts`

**Interfaces:**
- Produces: `SkillDefinition.batch_analysis?: SkillBatchAnalysisConfig`.
- Produces step `dominator_paths` with exact clustering source columns.

- [ ] **Step 1: Add failing reusable validator and loader assertions**

```ts
expect(skill.batch_analysis).toEqual({
  operation: 'heap_path_cluster', source_step: 'dominator_paths',
  output_contract: 'HeapPathClusterAnalysisV1', per_trace_row_limit: 500,
  total_row_limit: 5000,
  required_columns: ['upid', 'process_name', 'graph_sample_ts', 'path', 'class_name', 'root_type', 'self_count', 'retained_count', 'self_size_bytes', 'retained_size_bytes'],
});
```

Also assert a missing `source_step`, a source step that does not exist, a
comparison Skill, duplicate/empty columns, and invalid limits fail validation.
The same validator must be called by the runtime loader and CLI contract gate.

- [ ] **Step 2: Run RED**

Run: `cd backend && npx jest src/services/skillEngine/__tests__/skillBatchAnalysis.test.ts src/services/skillEngine/__tests__/customSkillLoader.test.ts src/services/skillEngine/__tests__/memorySkillSqlSemantics.test.ts --runInBand`

- [ ] **Step 3: Add the type and validation**

```ts
export interface SkillBatchAnalysisConfig {
  operation: 'heap_path_cluster';
  source_step: string;
  output_contract: 'HeapPathClusterAnalysisV1';
  per_trace_row_limit: number;
  total_row_limit: number;
  required_columns: string[];
}
```

Implement a pure reusable validator returning structured issues. Require
positive integer limits with `per_trace_row_limit <= total_row_limit`, unique
non-empty columns, an existing source step, and an executable non-comparison
Skill. Built-in load reports the issue; external-pack load rejects it; the CLI
contract gate treats it as an error.

- [ ] **Step 4: Add the bounded extraction Skill**

Use the upstream dominator-class-tree query, then add a bottom-up
`_graph_aggregating_scan!` over `_heap_graph_dominator_class_tree` to compute
`cumulative_count` and `cumulative_size`. Build root-to-node paths with
`WITH RECURSIVE paths`, carrying the root node's `root_type` to every
descendant. A direct `_graph_scan!` string-path accumulator is not compatible
with the data-present heap graph contract.
Partition top-node selection and all identities by `(upid, graph_sample_ts)`.
Expose:

```sql
SELECT COALESCE(pr.name, printf('upid:%d', t.upid)) AS process_name,
       t.upid AS upid,
       printf('%d', t.graph_sample_ts) AS graph_sample_ts,
       COALESCE(p.path, '[unknown]') AS path,
       COALESCE(t.name, '[unknown]') AS class_name,
       COALESCE(p.root_type, '') AS root_type,
       t.self_size AS self_size_bytes,
       c.cumulative_size AS retained_size_bytes
FROM _top_class_nodes n
JOIN _heap_graph_dominator_class_tree t ON n.id = t.id
JOIN _dominator_class_tree_cumulatives c ON n.id = c.id
LEFT JOIN process pr ON t.upid = pr.upid
LEFT JOIN _class_paths p ON n.id = p.id
ORDER BY c.cumulative_size DESC, t.self_size DESC, path
LIMIT MIN(MAX(COALESCE(${max_rows|500}, 500), 1), 500);
```

Add an availability step and successful `no_heap_graph_data` result.

- [ ] **Step 5: Run GREEN, validate, and commit**

Run: `cd backend && npx jest src/services/skillEngine/__tests__/skillBatchAnalysis.test.ts src/services/skillEngine/__tests__/customSkillLoader.test.ts src/services/skillEngine/__tests__/memorySkillSqlSemantics.test.ts --runInBand && npm run validate:skills`

```bash
git add backend/skills/composite/android_heap_dominator_path_extract.skill.yaml backend/src/services/skillEngine/types.ts backend/src/services/skillEngine/skillBatchAnalysis.ts backend/src/services/skillEngine/skillLoader.ts backend/src/cli/commands/validate.ts backend/src/services/skillEngine/__tests__/skillBatchAnalysis.test.ts backend/src/services/skillEngine/__tests__/customSkillLoader.test.ts backend/src/services/skillEngine/__tests__/memorySkillSqlSemantics.test.ts
git commit -m "feat: add heap dominator path extraction skill"
```

### Task 3: Registered batch post-processing

**Files:**
- Create: `backend/src/services/batchTrace/batchTracePostProcessor.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTracePostProcessor.test.ts`
- Modify: `backend/src/services/batchTrace/batchTraceTypes.ts`
- Modify: `backend/src/services/batchTrace/batchTraceRunner.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceRunner.test.ts`

**Interfaces:**
- Produces: `runBatchPostProcessor(input): HeapPathClusterAnalysisV1`.
- Adds: `BatchTraceRunV1.domainAnalysis?: BatchTraceDomainAnalysisV1`.

- [ ] **Step 1: Write failing registry and runner tests**

Assert exact operation dispatch, unknown-operation rejection, object/array row
adaptation, per-trace/total bounds, deterministic row refs, evidence-ref
resolution, and unchanged non-batch Skill results.

- [ ] **Step 2: Run RED**

Run: `cd backend && npx jest src/services/batchTrace/__tests__/batchTracePostProcessor.test.ts src/services/batchTrace/__tests__/batchTraceRunner.test.ts --runInBand`

- [ ] **Step 3: Implement registry and strict adapter**

```ts
const PROCESSORS: Record<SkillBatchAnalysisConfig['operation'], BatchPostProcessor> = {
  heap_path_cluster: input => clusterHeapPaths(adaptHeapRows(input), input.failures, {maxRows: input.config.total_row_limit}),
};
```

Accept object rows and `columns` plus array rows, require configured columns,
attach trace/sample identity, and bound before matrix allocation. Return a
generic envelope:

```ts
interface BatchTraceDomainAnalysisV1 {
  schemaVersion: 'batch_trace_domain_analysis@1';
  operation: 'heap_path_cluster';
  evidence: BatchTraceDomainEvidenceArtifactV1;
  result: HeapPathClusterAnalysisV1;
}
```

The bounded artifact stores canonical source rows under deterministic SHA-256
row refs. Validate that every result evidence ref resolves before returning.

- [ ] **Step 4: Integrate runner without retaining full results**

Keep only the envelope whose `meta.stepId` matches `source_step`. After workers
finish, call the registry once. Persist only the validated bounded evidence
artifact, not the full execution result or unrelated envelopes. Map failed
traces into domain failures and keep existing run status semantics.

- [ ] **Step 5: Run GREEN and commit**

Run: `cd backend && npx jest src/services/batchTrace/__tests__/batchTracePostProcessor.test.ts src/services/batchTrace/__tests__/batchTraceRunner.test.ts --runInBand`

```bash
git add backend/src/services/batchTrace/batchTracePostProcessor.ts backend/src/services/batchTrace/batchTraceTypes.ts backend/src/services/batchTrace/batchTraceRunner.ts backend/src/services/batchTrace/__tests__/batchTracePostProcessor.test.ts backend/src/services/batchTrace/__tests__/batchTraceRunner.test.ts
git commit -m "feat: aggregate heap paths in batch trace runs"
```

### Task 4: Persistence, report, and snapshot boundary

**Files:**
- Modify: `backend/src/services/batchTrace/batchTraceReportService.ts`
- Create: `backend/src/services/batchTrace/__tests__/batchTraceReportService.test.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceSnapshotPromotionService.test.ts`
- Test: `backend/src/services/batchTrace/__tests__/batchTraceStore.test.ts`

- [ ] **Step 1: Write failing round-trip/report/boundary tests**

Require escaped HTML and prove that these tempting but invalid global metrics
are not copied into per-trace snapshots:

```ts
expect(snapshot.metrics.map(metric => metric.key)).not.toEqual(expect.arrayContaining([
  'memory.heap_cluster_count',
  'memory.heap_cluster_top_trace_support_pct',
  'memory.heap_cluster_top_p95_retained_bytes',
]));
```

Per-trace extraction metrics/evidence continue through the existing promotion
path. Keep cross-trace cluster rows and summaries only on the batch run/report.

- [ ] **Step 2: Run RED**

Run: `cd backend && npx jest src/services/batchTrace/__tests__/batchTraceStore.test.ts src/services/batchTrace/__tests__/batchTraceReportService.test.ts src/services/batchTrace/__tests__/batchTraceSnapshotPromotionService.test.ts --runInBand`

- [ ] **Step 3: Implement escaped report and preserve snapshot ownership**

Render status, counts, K, Silhouette, top clusters, limitations, and failures.
Do not change `batchTraceSnapshotPromotionService.ts`; its existing per-trace
ownership is the contract protected by the new regression test.

- [ ] **Step 4: Run GREEN and commit**

Run the same Jest command and expect PASS.

```bash
git add backend/src/services/batchTrace/batchTraceReportService.ts backend/src/services/batchTrace/__tests__/batchTraceStore.test.ts backend/src/services/batchTrace/__tests__/batchTraceReportService.test.ts backend/src/services/batchTrace/__tests__/batchTraceSnapshotPromotionService.test.ts
git commit -m "feat: surface heap clusters in batch reports"
```

### Task 5: Managed heap data-present corpus fixture

**Files:**
- Modify: `Trace/tools/lib/perfetto-proto.cjs`
- Modify: `Trace/tools/lib/generator.cjs`
- Modify: `Trace/tools/__tests__/generator.test.cjs`
- Modify: `Trace/tools/bootstrap-constructed-cases.cjs`
- Modify/regenerate: `Trace/constructed/memory-gc-pressure/`
- Regenerate: `Trace/catalog.json`, `Trace/coverage.json`, `Trace/README.md`, `Trace/constructed/README.md`

- [ ] **Step 1: Add a failing `managed-heap-graph` generator test**

Load `trace.proto` and `third_party/android/art/heap_graph.proto`, emit at least
three typed objects, real reference edges, a root, and same-sequence process
identity, then assert `heap_graph_object` and
`android_heap_graph_class_summary_tree` contain rows and the extraction Skill's
final dominator query returns the expected propagated root and retained size.

- [ ] **Step 2: Run RED**

Run: `node --test Trace/tools/__tests__/generator.test.cjs`

Expected: `unsupported signal type: managed-heap-graph`.

- [ ] **Step 3: Encode validated ART extension packets**

```js
const HEAP_GRAPH_EXTENSION = '.com.android.art.tracing.ArtHeapGraphTracePacket.heapGraph';
dataPackets.push({timestamp, [HEAP_GRAPH_EXTENSION]: {
  pid: process.pid, heapBytesAllocated: signal.heap_bytes_allocated,
  types: signal.types, objects: signal.objects, roots: signal.roots,
  continued: false, index: 0,
}});
```

Validate unique positive ids, known type/root references, non-negative sizes,
and bounded arrays.

- [ ] **Step 4: Add varied heap samples and semantic expectations**

Make `android_memory_v57_ai_diagnostics` semantic, add the extraction Skill,
and remove its graceful-empty override.

- [ ] **Step 5: Build, test, index, validate, and commit**

Run: `node Trace/tools/trace-corpus.cjs build --case memory-gc-pressure && npm run trace:test -- --case memory-gc-pressure && node Trace/tools/trace-corpus.cjs index && npm run trace:validate`

```bash
git add Trace/tools Trace/constructed/memory-gc-pressure Trace/catalog.json Trace/coverage.json Trace/README.md Trace/constructed/README.md
git commit -m "test: add managed heap graph trace evidence"
```

### Task 6: Mapping and SmartPerfetto gates

**Files:**
- Modify: `backend/skills/docs/upstream-perfetto-ai-skill-translation.sop.md`
- Modify: `backend/skills/public-export.yaml`
- Modify: `docs/reference/skill-system.md`

- [ ] **Step 1: Split single-trace heap and cross-trace clustering statuses**

Reference the new Skill, batch operation, and semantic corpus id. Export the
portable extraction Skill; classify the BatchTrace TypeScript service as
product-only. Add the declarative `batch_analysis` boundary and its product-only
post-processor semantics to `docs/reference/skill-system.md`.

- [ ] **Step 2: Run project gates**

Run focused Jest suites, `cd backend && npm run validate:skills`,
`npm run trace:regression`, `cd backend && npm run test:scene-trace-regression`,
`cd backend && npm run typecheck`, `cd backend && npm run build`, and
`npm run verify:pr`.

- [ ] **Step 3: Record paired impact and commit**

Run `npm run check:perfetto-skills-impact` with decision `deferred`, the reason
that portable extraction is handled by the paired governance plan, and handoff
`docs/superpowers/plans/2026-07-14-upstream-skill-gap-governance.md`.

After the configured simplifier or manual simplify review plus
`git diff --check`, commit only task files with message
`docs: record heap clustering implementation boundary`.
