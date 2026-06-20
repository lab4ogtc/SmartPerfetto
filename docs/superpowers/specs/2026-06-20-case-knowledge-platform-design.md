# Case Knowledge Platform Design

Date: 2026-06-20
Status: Approved design, implementation not started

## Context

SmartPerfetto already has the foundations for a case and knowledge system:

- `CaseLibrary` stores curated case records and enforces the publish gate.
- `CaseGraph` stores directional relations between cases.
- `RagStore` supports `case_library` chunks and scoped knowledge storage.
- `recall_similar_case` exists as a read-only MCP tool over the case library.
- Strategy and Skill rules require durable analysis knowledge to live in
  strategy, Skill, docs, or knowledge assets instead of hardcoded TypeScript
  prompt strings.

The product gap is not only that reports need more text. Reports need a
structured way to connect trace evidence, prior cases, and role-specific
optimization guidance. For mixed problems such as a long scroll containing
many dropped frames with several causes, the system must cluster problems,
quantify their proportions, and attach App-side and OEM/vendor-side actions
with evidence boundaries.

## Goals

1. Build a generic case knowledge platform that can support scrolling,
   startup, ANR, power, memory, and future domains.
2. Use human-maintained Markdown/YAML files as the source of truth for curated
   cases so changes can be reviewed, diffed, and rebuilt.
3. Reuse existing runtime stores:
   `CaseLibrary`, `CaseGraph`, and `RagStore(kind=case_library)`.
4. Support both App and OEM/vendor recommendations for each applicable problem.
5. Make report recommendations evidence-bound, citation-backed, and explicit
   about applicability and risks.
6. Keep domain-specific logic in domain packs, not in the generic platform
   kernel or report generator.

## Non-Goals For V1

- No bulk historical report import.
- No embedding/vector database requirement. Existing keyword retrieval is
  acceptable for the first version.
- No full knowledge graph UI.
- No automatic generation of publishable cases from raw trace analysis.
- No complete domain-pack coverage across every SmartPerfetto scene.
- No private report-only prompt path that bypasses DataEnvelope, snapshots, or
  evidence contracts.

## Architecture

The platform has four layers.

### 1. Source Layer

Curated cases live as Markdown files with YAML frontmatter:

```text
backend/knowledge/cases/**/*.md
```

Markdown is the authoritative source. Runtime stores are rebuildable indexes.
The source layer is optimized for human curation, code review, and version
control.

### 2. Validation And Ingest Layer

The ingester parses frontmatter and body, validates common schema, validates
domain-pack rules, normalizes fields, and writes derived records to the
runtime stores.

```text
Markdown case files
  -> common schema validation
  -> domain pack validation
  -> recommendation quality gate
  -> CaseLibrary
  -> CaseGraph
  -> RagStore(kind=case_library)
```

V1 should expose local commands:

```bash
cd backend
npm run validate:cases
npm run ingest:cases
```

### 3. Retrieval Layer

Retrieval is two-stage:

1. Structured filtering by scene, root cause, audience, pipeline, vendor,
   architecture, status, and evidence signatures.
2. Text retrieval/ranking with `RagStore` over title, body chunks, finding text,
   recommendation text, and evidence summary.

This prevents a semantically similar but evidence-incompatible case from being
used as strong guidance.

### 4. Report Integration Layer

Reports consume case knowledge through problem clusters, not through raw user
query text. A domain pack converts analysis output into clusters, then the case
retriever attaches matching cases and App/OEM recommendations to each cluster.

```text
Analysis DataEnvelope/artifacts
  -> domain problem clusters
  -> evidence signatures
  -> case retrieval
  -> recommendation selection
  -> report sections and citations
```

## Core Case Schema

The common schema defines stable fields shared by all domains.

```yaml
case_id: scroll_shader_compile_pixel8_001
title: 滑动中 RenderThread shader 编译导致连续掉帧
status: draft | reviewed | published
quality: curated | imported | weak
scene: scrolling
domain_pack: scrolling.v1

taxonomy:
  primary_root_cause: shader_compile
  secondary_root_causes: [render_thread_heavy]
  responsibility: app | oem | mixed | unknown
  severity: critical | warning | info

context:
  app_architecture: android_view_standard
  device_vendor: pixel
  os_version: Android 15
  refresh_rate_hz: 120
  workload: list_scroll

evidence_signatures:
  required:
    - field: reason_code
      op: eq
      value: shader_compile
    - field: render_slices
      op: contains_any
      value: ["compileShader", "makePipeline", "Shader"]
  supportive:
    - field: render_thread_heavy_pct
      op: gte
      value: 70
    - field: vsync_missed
      op: gte
      value: 1

findings:
  - id: f1
    title: Shader 编译落在关键帧路径内
    evidence_refs: []
    confidence: high

recommendations:
  app:
    - id: app_precompile_shader
      priority: P0
      action: 提前 warm-up / precompile shader，避免首次滑动时同步编译
      applies_when: RenderThread 出现 shader/makePipeline 编译且与掉帧帧窗口重叠
      risks: 预热会增加启动或首屏内存/CPU，需要选择低影响窗口
  oem:
    - id: oem_gpu_freq_floor
      priority: P1
      action: 检查 GPU/CPU 频率响应和 RenderThread 调度优先级
      applies_when: shader 编译不可完全消除，且同帧存在低频、小核或调度延迟证据
      risks: 频率策略会影响功耗，需要按场景白名单或短时 boost

relations:
  similar_cases: []
  contradicts: []
```

The Markdown body should use stable headings:

```md
## Symptom

## Evidence Chain

## Critical Path

## App Guidance

## OEM Guidance

## Anti-patterns
```

These headings are not the only content the report can use. They are the
curation format for humans and the text source for RAG chunks.

## Domain Packs

A domain pack defines how a scene extends the common case platform. It owns:

- Accepted root-cause taxonomy for the domain.
- Evidence signature fields and operators.
- Cluster extraction rules from DataEnvelope/artifact output.
- Structured retrieval weights.
- Required report sections.
- Domain-specific validation rules.

The platform kernel must not know scrolling-specific fields such as
`reason_code`, `frame_id`, or `vsync_missed`. Those belong in `scrolling.v1`.

### V1 Domain Pack

V1 implements the generic platform with one minimal domain pack:

```text
scrolling.v1
```

The pack should support the current `scrolling_analysis` output, especially:

- `batch_frame_root_cause`
- `reason_code`
- `jank_responsibility`
- `primary_cause`
- `dur_ms`
- `vsync_missed`
- `top_slice_name`
- `main_slices_json`
- `render_slices_json`
- `freq_timeline_json`
- representative frame metadata

The pack should group frames into problem clusters:

```yaml
cluster:
  scene: scrolling
  root_cause: shader_compile
  responsibility: app
  frame_count: 18
  percentage: 25.0
  severity: critical
  representative_frame:
    frame_id: "59668095"
    dur_ms: 58.87
    vsync_missed: 3
  evidence_signatures:
    reason_code: shader_compile
    render_slices: ["makePipeline"]
```

## Validation Rules

### Schema Gate

The common schema gate requires:

- `case_id`
- `title`
- `status`
- `quality`
- `scene`
- `domain_pack`
- `taxonomy.primary_root_cause`
- `taxonomy.responsibility`
- `recommendations.app`
- `recommendations.oem`

`case_id` must be globally unique. `status=published` cannot be created by
direct save from Markdown. Published promotion must keep using
`CaseLibrary.publishCase()` so redaction and curator signoff stay auditable.

### Domain Pack Gate

Each domain pack validates fields it owns. For `scrolling.v1`, V1 should
require at least one required evidence signature that can be matched against
analysis output, such as `reason_code`, `render_slices`, `main_slices`,
`jank_responsibility`, or critical-path fields.

### Recommendation Gate

Each recommendation must include:

- `id`
- `priority`
- `action`
- `applies_when`
- `risks`

Recommendations missing applicability or risk boundaries must not be emitted as
strong report guidance. They can remain in draft or review status.

## Runtime Storage Mapping

### CaseLibrary

Store the structured case node:

- `caseId`
- `title`
- `status`
- `key` when available
- `tags`
- `findings`
- curation metadata
- provenance

V1 may need a compatibility layer because the source schema is richer than the
current `CaseNode` type. Extra platform fields should be stored through a typed
extension object rather than lossy string concatenation.

### CaseGraph

Store relations from the source frontmatter:

- `similar_root_cause`
- `before_after_fix`
- `derived_pattern`
- `contradicts`

Graph edges are useful for report citations and follow-up exploration, but V1
retrieval should still work without graph traversal.

### RagStore

Chunk the Markdown body plus selected structured summaries under
`kind=case_library`. The chunk text should include:

- title
- scene
- root causes
- evidence chain
- App guidance
- OEM guidance
- anti-patterns

The chunk metadata should preserve `case_id`, scene, root cause tags, and
domain pack identity where the current contract supports it.

## Retrieval Contract

The report path should call a case-retrieval service with structured input:

```ts
interface CaseRecommendationQuery {
  scene: string;
  domainPack: string;
  rootCause: string;
  secondaryRootCauses?: string[];
  responsibility?: 'app' | 'oem' | 'mixed' | 'unknown';
  audiences: Array<'app' | 'oem'>;
  context?: Record<string, unknown>;
  evidenceSignatures: Record<string, unknown>;
  textQuery?: string;
  topK?: number;
}
```

The output should separate strong and weak matches:

```ts
interface CaseRecommendationHit {
  caseId: string;
  title: string;
  matchStrength: 'strong' | 'partial' | 'background';
  matchedSignatures: string[];
  missingRequiredSignatures: string[];
  recommendations: {
    app: Recommendation[];
    oem: Recommendation[];
  };
}
```

Only `strong` matches can be used as direct optimization guidance. `partial` or
`background` matches may be cited as context, with an explicit evidence gap.

## Report Output

For each major problem cluster, the report should include:

```md
### 问题簇：shader_compile / RenderThread

- 影响：18/72 帧，25.0%
- 代表帧：frame_id=59668095
- 证据链：RenderThread shader compile 与掉帧窗口重叠
- 相似案例：scroll_shader_compile_pixel8_001

App 侧建议：
1. P0: 提前 warm-up / precompile shader，避免首次滑动时同步编译
   适用条件：RenderThread 出现 shader/makePipeline 编译且与掉帧帧窗口重叠
   风险：预热会增加启动或首屏内存/CPU，需要选择低影响窗口
   来源：case scroll_shader_compile_pixel8_001

OEM/厂商侧建议：
1. P1: 检查 GPU/CPU 频率响应和 RenderThread 调度优先级
   适用条件：shader 编译不可完全消除，且同帧存在低频、小核或调度延迟证据
   风险：频率策略会影响功耗，需要按场景白名单或短时 boost
   来源：case scroll_shader_compile_pixel8_001
```

If required signatures do not match, the report must not present the case as a
direct recommendation. It should say that a similar background case exists but
current trace evidence is insufficient.

## First Version Scope

V1 includes:

- Common Markdown case schema.
- `scrolling.v1` domain pack as the first working pack.
- `validate:cases`.
- `ingest:cases`.
- Runtime writes into `CaseLibrary`, `CaseGraph`, and
  `RagStore(kind=case_library)`.
- Structured enhancement to `recall_similar_case` or a new read-only retrieval
  path that supports scene/root-cause/audience filtering.
- Report output for problem clusters with App/OEM recommendations and case ids.
- At least two curated scrolling example cases.

V1 does not include:

- Bulk import from historical report artifacts.
- Embedding service or vector index.
- UI for editing cases.
- Automatic case promotion from weak/imported to curated.
- Complete domain-pack coverage beyond the initial scrolling pack.

## Verification

For implementation that touches runtime code, run the project-defined commands
that are executable in the current environment:

```bash
cd backend
npm run build
npm run validate:strategies
npm run validate:skills
npm run validate:cases
npm run test:scene-trace-regression
```

Focused tests should cover:

- Markdown parser and schema validation.
- Domain pack validation.
- Ingest idempotency.
- Runtime store writes.
- Structured retrieval by scene/root cause/audience.
- Recommendation gating by evidence signatures.
- Report output includes source case id, applies_when, and risks.
- Partial/background matches cannot become strong recommendations.

If trace regression is unavailable in a future environment, record
`NOT CONFIGURED`. In this repository, `npm run test:scene-trace-regression`
is already an expected verification path.

## Risks And Mitigations

- Risk: Weak or over-broad cases pollute recommendations.
  Mitigation: V1 prioritizes curated Markdown cases and requires recommendation
  applicability/risk fields.

- Risk: Generic platform becomes a lowest-common-denominator schema.
  Mitigation: Keep the kernel small and move domain-specific fields into domain
  packs.

- Risk: Report generator hardcodes case logic.
  Mitigation: Use a retrieval service and domain-pack cluster contract. Report
  rendering should consume structured recommendation hits.

- Risk: Evidence does not match a retrieved case.
  Mitigation: Required signatures must be checked before a case can contribute
  strong guidance.

- Risk: Case source and runtime indexes drift.
  Mitigation: Treat Markdown as source of truth and make runtime stores
  rebuildable via `ingest:cases`.

## Future Extensions

- Add bulk import for historical reports as `quality=imported` or `weak`.
- Add promotion workflow from imported case to curated case.
- Add vector retrieval when keyword search no longer scales.
- Add domain packs for startup, ANR, power, memory, and interaction.
- Add `cite_case_in_report` when report write-back semantics are clear.
- Add before/after case bundles for verified optimizations.
