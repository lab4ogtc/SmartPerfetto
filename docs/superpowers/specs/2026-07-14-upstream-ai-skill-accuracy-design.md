# Upstream AI Skill Accuracy Design

## Context

Perfetto's official Agent Skill contains useful Android heap-dump and GPU
compute workflows, but SmartPerfetto must not copy the upstream Markdown and
Python runtime into the product. SmartPerfetto's runtime source of truth is the
YAML Skill evidence layer, with batch trace analysis, DataEnvelope provenance,
claim verification, reports, snapshots, and comparison as distinct consumers.

The current repository already translates the upstream single-trace memory and
GPU inventory/occupancy/frequency workflows. Three accuracy gaps remain:

1. the upstream cross-trace Java heap-path clustering workflow has no product
   implementation even though the translation SOP currently marks the broader
   clustering family as implemented;
2. vendor-neutral GPU compute kernel and launch analysis is grouped with
   NVIDIA-counter-specific analysis and therefore remains unavailable;
3. the public upstream gap checker can classify an entire path family as
   `already_covered` without file-level implementation and test evidence.

## Goals

1. Add deterministic cross-trace heap-path clustering to SmartPerfetto's
   existing batch trace product surface.
2. Add vendor-neutral GPU compute kernel and launch evidence without promoting
   unsupported NVIDIA counter conclusions.
3. Make upstream-to-local coverage decisions evidence-backed and resistant to
   path-prefix false positives.
4. Improve analysis accuracy, completeness, explainability, and verifiability
   across Web/API, CLI, and reports while preserving per-trace evidence for
   snapshots and comparison.
5. Preserve a strict missing-data boundary: unavailable heap or GPU signals are
   limitations, never proof that a problem is absent.

## Non-Goals

- Do not add a dedicated heap-cluster or GPU-compute frontend page in the first
  version. Reuse batch trace, comparison, report, and artifact surfaces.
- Do not add pandas, scikit-learn, or a separately managed Python environment to
  the SmartPerfetto product runtime.
- Do not run clustering inside a single-trace SQL Skill.
- Do not claim NVIDIA Speed-of-Light, occupancy-counter, or workload-counter
  support without a representative trace fixture and schema validation.
- Do not treat directory membership, prose similarity, or a copied upstream
  script as proof that a SmartPerfetto capability is implemented.
- Do not make SmartPerfetto depend on a sibling Perfetto-Skills checkout at
  runtime.

## Considered Approaches

### Embed the upstream Python workflow

This is the shortest route to TF-IDF, K-Means, and Silhouette scoring, but it
adds pandas/scikit-learn dependency and environment drift to source, Docker,
npm CLI, and portable packages. It would also bypass SmartPerfetto's Skill,
evidence, lease, and reporting contracts. This approach is rejected.

### Add only single-trace YAML Skills

This preserves the current Skill engine but cannot implement fleet- or
multi-dump clustering. It would improve GPU coverage while leaving the most
important memory capability absent. This approach is insufficient.

### Selected: product-native deterministic batch analysis

Single-trace YAML Skills extract bounded, self-describing evidence. The
existing batch trace runner executes those Skills across traces. A typed,
registered batch post-processor performs deterministic aggregation and returns
a domain result with evidence references and limitations. GPU compute remains
a normal single-trace composite Skill. This approach reuses current product
boundaries: batch aggregates stay on batch/API/CLI/report surfaces, while
per-trace extraction evidence remains consumable by snapshots and comparison.

## Architecture

### 1. Heap-path extraction Skill

Add a composite Skill named `android_heap_dominator_path_extract`. It performs
an availability query before reading managed heap graph data and emits a
bounded row set containing:

- process name plus required stable `upid` identity;
- heap graph sample timestamp;
- class name and root type;
- raw dominator class path;
- self size and cumulative retained size;
- object/count context needed to distinguish repeated objects from retained
  memory impact.

The SQL remains inside the Skill. It uses the vendored Perfetto stdlib where
available and explicit raw-table columns where the stdlib does not expose the
required path. Missing heap graph input returns a successful no-data envelope.
The extraction Skill does not cluster or infer a leak.

### 2. Declarative batch post-processing boundary

Extend the Skill definition with an optional batch-analysis declaration. The
first supported operation is heap-path clustering, but the batch runner must
not contain a heap-specific conditional. It resolves operations through a
post-processor registry.

The declaration identifies:

- operation id;
- source step id;
- output contract id and version;
- per-trace and total row bounds;
- required source columns.

The batch runner already owns trace loading, processor leases, concurrency,
per-trace execution, cleanup, and partial-failure accounting. It will preserve
only the declared source rows until post-processing completes, then discard
the unbounded execution object. Normal batch metrics continue to use the
existing path.

The public `BatchTraceRunV1` contract gains an optional discriminated domain
analysis envelope with `operation`, `schemaVersion`, `result`, and a bounded
source-evidence artifact. Existing consumers that ignore it remain compatible.
The artifact assigns deterministic row references and preserves the source
step, trace identity, `(upid, graph_sample_ts)` sample identity, declared
columns, bounded rows, and truncation counts. Every cluster evidence reference
must resolve inside this artifact. The envelope is stored with the batch run
and included in JSON/HTML report export.

### 3. Deterministic heap clustering engine

Implement the clustering engine as a pure TypeScript service with no runtime
model calls and no global mutable state.

Processing stages:

1. Validate and bound inputs before allocating a vocabulary or matrix.
2. Normalize paths by removing dynamic instance counts and root annotations,
   preserving ordered class-chain tokens.
3. Sort rows by trace identity, sample timestamp, path, class, and size to make
   input ordering irrelevant.
4. Build a sparse TF-IDF representation from normalized class-chain tokens.
5. Evaluate candidate `K` values over a bounded range using deterministic
   seeded K-Means and mean Silhouette score.
6. Select the highest score; ties choose the smaller `K` to avoid artificial
   fragmentation.
7. Collapse parent/child attribution chains within a cluster only when their
   normalized paths have a prefix relationship and retained sizes are within a
   configured tolerance.
8. Summarize each cluster with its representative path, contributing traces
   and samples, retained-size distribution, support percentage, collapsed
   members, and evidence references.

The seed is derived from a stable hash of the normalized bounded input. Empty
input returns `unavailable`. One or two usable samples return an explicit
`insufficient_samples` result rather than a mathematically meaningless
cluster. Degenerate identical vectors produce one deterministic signature
group and a limitation explaining that Silhouette selection was not possible.

### 4. Heap cluster result contract

Add a versioned `HeapPathClusterAnalysisV1` result inside a generic
`BatchTraceDomainAnalysisV1` envelope containing:

- status: `completed`, `partial`, `unavailable`, or `insufficient_samples`;
- input trace/sample/row counts and rejected-row counts;
- selected `K`, Silhouette score, normalization version, seed hash, and size
  tolerance;
- cluster summaries with representative path, class/root context, average and
  percentile retained sizes, trace support, sample support, and collapsed
  members;
- evidence references back to the per-trace Skill rows;
- limitations and per-trace failures.

The evidence artifact is not an unbounded copy of `SkillExecutionResult` or
every DataEnvelope. It stores only validated, bounded source rows. Its row ids
are stable hashes of source step, trace/sample identity, and canonical row
content, so a result cannot cite an empty or transient envelope id.

This is deterministic evidence, not an agent conclusion. Claim verification
may support statements such as "this retaining signature appears in 8 of 10
traces" from the contract. A leak/root-cause statement still requires a
separate verified claim or an explicit hypothesis label.

### 5. Vendor-neutral GPU compute Skill

Add a separate composite Skill named `gpu_compute_kernel_analysis`; do not
expand the existing v57 inventory/occupancy/DVFS Skill into a mixed vendor
contract.

The new Skill has four layers:

- availability: compute-category GPU slices, compatible GPU tracks, and launch
  argument availability;
- kernel summary: demangled/fallback name, GPU identity, launch order,
  timestamp, duration, and share of compute time;
- launch configuration: block/workgroup size, grid size, thread count,
  registers, shared memory, barriers, waves per multiprocessor, and cache
  configuration when present;
- no-data/partial contract: distinguish no compute kernels from kernels whose
  producer omitted launch arguments.

The Skill may identify duration hotspots and describe launch parameters. It
must not classify kernels as compute-bound or memory-bound without throughput
counters. NVIDIA Speed-of-Light and counter-derived occupancy remain a
separate deferred capability.

### 6. Product surface integration

The first version reuses existing surfaces:

- API and CLI submit the extraction Skill through the batch trace workflow;
- the batch run persists the typed cluster result;
- JSON and HTML batch reports render a cluster summary and limitations;
- promoted snapshots keep only their own per-trace extraction metrics and
  evidence links; the cross-trace cluster aggregate remains owned by the batch
  run and must not be copied into each single-trace snapshot;
- comparison can compare per-trace extraction metrics independently, while the
  cross-trace cluster result is consumed from the batch run/report;
- live raw two-trace analysis can continue to use `compare_skill` for the
  extraction and GPU Skills, while true clustering uses the batch operation.

No provider/runtime-specific branch is allowed. Claude, OpenAI, Pi Agent Core,
and OpenCode consume the same Skill and evidence contracts through the shared
registry.

### 7. Upstream coverage governance

Correct the SmartPerfetto translation SOP so heap dump extraction/caching and
cross-trace clustering have separate statuses. After implementation and
semantic tests, vendor-neutral GPU compute can move to implemented while
NVIDIA counter workflows remain deferred.

The paired Perfetto-Skills gap checker must stop deriving unchanged-file
coverage from broad directory prefixes. A reviewed decision is keyed by the
upstream path and SHA-256 and records:

- outcome;
- local implementation path or explicit non-applicability reason;
- SmartPerfetto test/fixture id;
- review timestamp or source commit.

Files without a matching reviewed decision remain `pending_review`. The paired
public projection is updated only after the SmartPerfetto source commit exists
and both repositories pass their independent gates.

## Data Flow

```text
Batch trace request
  -> BatchTraceRunner loads each trace and holds its processor lease
  -> android_heap_dominator_path_extract runs per trace
  -> bounded declared source rows + evidence identities
  -> registered heap-path post-processor
       -> normalize
       -> TF-IDF
       -> deterministic K-Means / Silhouette selection
       -> parent-child retained-size collapse
  -> BatchTraceDomainAnalysisV1<HeapPathClusterAnalysisV1>
  -> BatchTraceRun persistence
  -> JSON/HTML report
  -> per-trace snapshot promotion preserves only per-trace metrics/evidence

Single trace GPU request
  -> gpu_compute_kernel_analysis
  -> availability + kernel summary + launch configuration
  -> DataEnvelope
  -> chat / report / CLI artifact / snapshot / compare_skill
```

## Error, Resource, and Uncertainty Handling

- Per-trace query failure produces a partial batch result with the failed trace
  identity and error; successful traces remain usable if minimum sample bounds
  are met.
- Source rows, vocabulary size, candidate `K`, iterations, and total matrix
  cells are bounded. Limit violations return an explicit limitation rather
  than risking backend memory exhaustion.
- Missing columns fail validation before clustering. Numeric values must be
  finite and non-negative; rejected rows are counted.
- Missing heap graphs, compute slices, or launch arguments are availability
  states, not zero-valued performance measurements.
- Cluster ids are stable only for the exact normalized input and algorithm
  version. Reports expose both rather than implying ids are globally stable.
- Representative paths and support are observations. Leak/root-cause labels
  remain hypotheses until the claim verifier has supporting evidence.
- NVIDIA-specific data is ignored by the vendor-neutral Skill unless a future
  separately versioned Skill and fixture promote that contract.

## Testing Strategy

Implementation follows red-green-refactor.

1. Add pure unit tests for path normalization, input-order independence,
   deterministic seed behavior, K selection, degenerate vectors, insufficient
   samples, parent-child collapse, bounds, rejected rows, and partial inputs.
2. Add batch runner tests proving declarative post-processor selection, bounded
   source-row retention, partial trace failures, persistence, and no behavior
   change for Skills without a batch declaration.
3. Add contract/repository/report tests for `HeapPathClusterAnalysisV1` and
   batch JSON/HTML output.
4. Add a data-present managed heap graph fixture. The clustering capability is
   not considered semantically implemented while only graceful-empty coverage
   exists.
5. Extend the constructed trace generator with a real GPU render-stage compute
   signal and launch arguments. Tag-only atrace slices do not count as semantic
   GPU compute coverage.
6. Add semantic corpus expectations for both new Skills plus explicit no-data
   behavior on traces that lack the required signals.
7. Add gap-checker tests where an unreviewed file under a previously covered
   directory remains pending and where a path/SHA decision with local evidence
   is accepted.
8. Run focused tests throughout TDD, then Skill validation, trace regression,
   scene regression, typecheck/build, public Skill impact review, paired public
   verification when required, and the repository `verify:pr` gate.

## Expected Files and Components

SmartPerfetto changes are expected in:

- `backend/skills/atomic/` or `backend/skills/composite/` for heap extraction;
- `backend/skills/composite/gpu_compute_kernel_analysis.skill.yaml`;
- `backend/src/services/skillEngine/types.ts` and validation for the optional
  batch declaration;
- `backend/src/services/batchTrace/` for the registry boundary, typed result,
  persistence, and reports;
- a focused heap clustering domain service and tests;
- `backend/src/types/` for the versioned cluster contract;
- `Trace/constructed/`, its generator, manifests, and corpus expectations;
- `backend/skills/docs/upstream-perfetto-ai-skill-translation.sop.md`;
- `backend/skills/public-export.yaml` when portable evidence changes.

The paired public review is expected in:

- `../Perfetto-Skills/tools/sync_official_skill.py` and its tests;
- reviewed decision data and regenerated upstream gap reports;
- regenerated SmartPerfetto projection after the source commit is available.

## Acceptance Criteria

1. Re-running clustering with the same bounded logical input produces the same
   normalized rows, seed hash, selected `K`, cluster memberships, and summary.
2. Every cluster summary and GPU row links to a Skill step and trace identity.
3. A missing signal produces an explicit availability/limitation contract and
   cannot be rendered as proof of health or absence of a leak.
4. Heap clustering has a data-present semantic fixture; GPU compute has a real
   compute-category/launch-argument semantic fixture.
5. API, CLI, and reports preserve the batch cluster result; snapshots and
   comparison preserve per-trace evidence without duplicating the cross-trace
   aggregate into single-trace records.
6. No provider runtime receives a private implementation path or different
   analytical behavior.
7. The upstream gap report cannot mark a file covered solely because its path
   has a known prefix.
8. SmartPerfetto and any required paired Perfetto-Skills change pass their
   project-defined verification gates without including unrelated worktree
   changes.
