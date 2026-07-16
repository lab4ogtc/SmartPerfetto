# Camera Evidence-First Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fact-checked Camera capture and analysis path that reports which evidence is present, which evidence is vendor-specific, and which evidence is missing before making Camera latency or memory claims.

**Architecture:** Extend the existing deterministic capture preset/intent registry, then add one composite YAML Skill that consumes stable Perfetto tables and optional Pixel stdlib tables. Keep capture routing, evidence collection, rendering-pipeline classification, reports, snapshots, CLI output, and public Skill projection on their existing boundaries; do not add Camera-specific frontend or agent-runtime branches.

**Tech Stack:** Node.js 24, TypeScript strict mode, Jest, Perfetto TraceConfig textproto, PerfettoSQL stdlib, SmartPerfetto YAML Skills, Markdown documentation.

## Global Constraints

- Treat `openCamera -> onOpened`, first capture result, first output buffer, and first presented preview frame as different milestones. Never collapse them into one metric.
- Do not require 3A convergence for first-frame latency and do not encode `CameraCaptureSession.prepare()` as a universal optimization.
- Treat names such as `processCaptureRequest` and `processCaptureResult` as vendor/app slice candidates, not stable platform contracts.
- Do not emit fixed good/bad thresholds or infer a memory leak from PSS/RSS growth alone.
- Keep `camera_trace_evidence` executable on a non-Camera trace: every optional source must return a typed coverage row or an empty detail list, never a missing-table error.
- Preserve the user's existing `.gitignore` modification and all unrelated worktree changes.
- Do not edit generated files, the `perfetto/` submodule, committed frontend assets, provider/session code, or report/snapshot contracts.

---

### Task 1: Add a deterministic Camera capture contract

**Files:**
- Modify: `backend/src/services/__tests__/traceCaptureConfig.test.ts`
- Modify: `backend/src/services/__tests__/traceConfigProposal.test.ts`
- Modify: `backend/src/cli-user/services/__tests__/captureConfig.test.ts`
- Modify: `backend/src/cli-user/commands/__tests__/captureSuggest.test.ts`
- Modify: `backend/src/cli-user/bin.ts`
- Modify: `backend/src/services/traceConfigGenerator.ts`
- Modify: `backend/src/services/traceCaptureConfig.ts`
- Modify: `backend/src/services/traceConfigProposal.ts`

- [ ] **Step 1: Write the failing preset and routing tests**

Add focused assertions equivalent to:

```ts
it('renders the Camera preset with binder, FrameTimeline, and DMA-BUF evidence', () => {
  const preset = getCapturePreset('camera');
  const config = renderAndroidTraceConfig({
    target: 'android',
    preset: 'camera',
    app: 'com.example.camera',
    durationSeconds: 20,
  });

  expect(preset.intent).toBe('camera');
  expect(config).toContain('atrace_categories: "camera"');
  expect(config).toContain('atrace_categories: "hal"');
  expect(config).toContain('ftrace_events: "dmabuf_heap/dma_heap_stat"');
  expect(config).toContain('ftrace_events: "ion/ion_stat"');
  expect(config).toContain('ftrace_events: "binder/binder_transaction"');
  expect(config).toContain('name: "android.surfaceflinger.frametimeline"');
});

it('routes Camera first-frame requests ahead of generic startup', () => {
  const proposal = buildTraceConfigProposal({
    request: '分析 Camera 打开到首帧预览延迟',
    app: 'com.example.camera',
    outputLanguage: 'zh-CN',
  });
  expect(proposal.preset).toBe('camera');
  expect(proposal.intent).toBe('camera');
});

it('keeps generic app first-frame requests on startup', () => {
  expect(buildTraceConfigProposal({request: 'debug app first frame'}).preset)
    .toBe('startup');
});
```

Mirror the existing CLI service and command style to assert that `camera` is accepted by `capture config --preset`, appears in preset listings, and is selected by `capture suggest` for a Camera-domain request. Update both hardcoded preset lists in `backend/src/cli-user/bin.ts`: the `--preset` help text and `parseCapturePreset` error text.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cd backend
npx jest \
  src/services/__tests__/traceCaptureConfig.test.ts \
  src/services/__tests__/traceConfigProposal.test.ts \
  src/cli-user/services/__tests__/captureConfig.test.ts \
  src/cli-user/commands/__tests__/captureSuggest.test.ts --runInBand
npx tsx src/cli-user/bin.ts capture android --help | grep -q camera
```

Expected: Jest failures because `camera` is not a valid preset/intent and Camera requests currently collide with `startup`/`scrolling` keywords; the CLI help smoke exits non-zero because the preset help does not list `camera` yet.

- [ ] **Step 3: Add the Camera intent and capture preset**

Extend `TraceIntent` with `'camera'`, add `CAMERA_FRAGMENTS`, and handle it in `pickFragmentsForIntent`:

```ts
const CAMERA_FRAGMENTS: PerfettoConfigFragment[] = [
  {
    dataSource: 'linux.ftrace',
    reason: 'camera request activity, scheduler, binder, DMA-BUF/ION allocation events, and vendor atrace slices',
    options: {
      sched_switch: 'true',
      sched_blocked_reason: 'true',
      binder_transaction: 'true',
      dma_heap_stat: 'true',
      ion_stat: 'true',
    },
  },
  {
    dataSource: 'android.surfaceflinger.frametimeline',
    reason: 'presented preview frame correlation when FrameTimeline is available',
  },
];
```

Add a shared `CAMERA_MEMORY_EVENTS` constant and a `camera` preset:

```ts
const CAMERA_MEMORY_EVENTS = [
  'dmabuf_heap/dma_heap_stat',
  'ion/ion_stat',
];

{
  id: 'camera',
  label: 'Android Camera',
  intent: 'camera',
  defaultDurationSeconds: 20,
  bufferSizeKb: 98304,
  atraceCategories: ['camera', 'hal', 'gfx', 'view', 'binder_driver', 'freq', 'sched'],
  ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, ...CAMERA_MEMORY_EVENTS],
  dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline'],
  description: 'Camera request, binder, scheduler, preview presentation, and DMA-BUF/ION allocation evidence.',
},
```

Also add `CAMERA_MEMORY_EVENTS` to the `full` preset so its documented maximum-coverage behavior includes these evidence sources.

- [ ] **Step 4: Make Camera routing domain-aware**

Extend `IntentRule` with `requiredKeywords?: string[]`, add a Camera rule before startup, and calculate a deterministic domain bonus only when at least one required Camera token matches:

```ts
{
  preset: 'camera',
  confidence: 'high',
  rationale: 'Camera investigations need request activity, binder, scheduler, preview presentation, and DMA-BUF/ION allocation evidence.',
  requiredKeywords: [
    'camera', 'camera2', 'camerax', 'cameraserver', 'camera hal',
    '摄像头', '相机', '取景器',
  ],
  keywords: [
    'open camera', 'camera open', 'camera startup', 'first preview',
    'preview frame', 'capture request', 'capture result', 'hal3',
    '打开相机', '相机启动', '首帧预览', '预览首帧', '拍照延迟',
  ],
},
```

In `classifyRequest`, exclude any rule whose `requiredKeywords` do not match; for a matched domain rule add a score larger than the maximum possible generic keyword count. Keep ambiguous `preview` / `预览` as scoring keywords rather than domain anchors so a generic UI preview request is not stolen by Camera routing. This makes `Camera + 首帧` deterministic without reclassifying generic `app first frame` or `preview first frame` requests. Add the Chinese preset rationale and leave all existing fallback behavior intact.

- [ ] **Step 5: Run the focused tests and confirm GREEN**

Run the command from Step 2. Expected: all four suites pass.

- [ ] **Step 6: Commit the capture contract**

```bash
git add \
  backend/src/services/traceConfigGenerator.ts \
  backend/src/services/traceCaptureConfig.ts \
  backend/src/services/traceConfigProposal.ts \
  backend/src/services/__tests__/traceCaptureConfig.test.ts \
  backend/src/services/__tests__/traceConfigProposal.test.ts \
  backend/src/cli-user/services/__tests__/captureConfig.test.ts \
  backend/src/cli-user/commands/__tests__/captureSuggest.test.ts \
  backend/src/cli-user/bin.ts
git commit -m "feat: add evidence-first camera capture preset"
```

---

### Task 2: Correct Camera request-activity semantics

**Files:**
- Modify: `backend/src/tests/renderingPipelineDetectionGenerator.test.ts`
- Modify: `backend/src/services/renderingPipelineDetectionSkillGenerator.ts`
- Modify: `backend/skills/atomic/pipeline_4feature_scoring.skill.yaml`
- Modify: `backend/skills/pipelines/android_view_mixed.skill.yaml`
- Modify: `backend/skills/pipelines/surfaceview_blast.skill.yaml`
- Modify: `backend/skills/pipelines/camera_pipeline.skill.yaml`
- Modify: `docs/rendering_pipelines/camera_pipeline.md`

- [ ] **Step 1: Write the failing generator regression**

Extend the existing generator test:

```ts
const rhythmStep = skill.steps?.find((s) => s.id === 'rhythm_source_signals') as any;
expect(rhythmStep.sql).toContain("THEN 'camera_request_activity'");
expect(rhythmStep.sql).not.toContain('camera_sensor_trigger');
```

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
cd backend
npx jest src/tests/renderingPipelineDetectionGenerator.test.ts --runInBand
```

Expected: failure because the generated SQL still labels a candidate request slice as a sensor trigger.

- [ ] **Step 3: Rename the evidence label at every source location**

Change `camera_sensor_trigger` and `sensor_trigger_not_vsync_aligned` to `camera_request_activity` and `camera_request_activity_not_vsync_aligned` in the generator and affected pipeline Skills. Keep the detection condition as a candidate slice-name match, but change user-facing explanations from “sensor trigger” to “Camera request activity candidate”. Do not rename unrelated pipeline IDs or generated files.

- [ ] **Step 4: Remove overclaims from the Camera pipeline knowledge**

Apply these exact semantic corrections in `camera_pipeline.skill.yaml` and `camera_pipeline.md`:

- Camera2/HAL3 requests are ordered and multiple requests may be in flight; each request can produce partial metadata and one or more buffers.
- `onOpened` proves device-open completion, not first result, first buffer, or first preview presentation.
- First preview timing requires stable session/camera identity plus explicit request/result/buffer/presentation anchors; vendor slice-name inventory alone cannot prove it.
- 3A can still be searching when the first frame arrives; report 3A state separately when trace evidence exists.
- `prepare()` is a buffer preallocation tradeoff that may delay first output and increase memory; it is not a blanket first-frame fix.
- ZSL behavior and buffer topology are capability-, implementation-, and app-dependent.
- ImageReader backpressure is only a supported hypothesis when buffer ownership/acquire-release evidence exists; PSS/RSS growth alone is insufficient to call a leak.
- Pixel `pixel.camera` parsing is an optional vendor-specific fast path, not a portable Android Camera contract.

- [ ] **Step 5: Run the focused generator test and Skill validation**

```bash
cd backend
npx jest src/tests/renderingPipelineDetectionGenerator.test.ts --runInBand
npm run validate:skills
```

Expected: generator regression and all Skill schemas pass.

- [ ] **Step 6: Commit the semantic corrections**

```bash
git add \
  backend/src/tests/renderingPipelineDetectionGenerator.test.ts \
  backend/src/services/renderingPipelineDetectionSkillGenerator.ts \
  backend/skills/atomic/pipeline_4feature_scoring.skill.yaml \
  backend/skills/pipelines/android_view_mixed.skill.yaml \
  backend/skills/pipelines/surfaceview_blast.skill.yaml \
  backend/skills/pipelines/camera_pipeline.skill.yaml \
  docs/rendering_pipelines/camera_pipeline.md
git commit -m "fix: make camera pipeline evidence conditional"
```

---

### Task 3: Add the `camera_trace_evidence` Skill

**Files:**
- Create: `backend/skills/composite/camera_trace_evidence.skill.yaml`
- Create: `backend/src/services/skillEngine/__tests__/cameraTraceEvidenceSchema.test.ts`
- Create: `backend/tests/skill-eval/camera_trace_evidence.eval.ts`

- [ ] **Step 1: Write all failing Skill contract and real-trace tests**

Load the YAML using the same helper/pattern as neighboring Skill schema tests and assert:

```ts
expect(skill).toMatchObject({
  name: 'camera_trace_evidence',
  type: 'composite',
  category: 'rendering',
});
expect(skill.prerequisites.modules).toEqual(expect.arrayContaining([
  'slices.with_context',
  'android.binder',
  'android.frames.timeline',
  'android.memory.dmabuf',
  'linux.cpu.frequency',
  'pixel.camera',
]));
expect(stepIds).toEqual([
  'evidence_coverage',
  'camera_process_candidates',
  'camera_slice_candidates',
  'camera_binder_summary',
  'camera_dmabuf_summary',
  'pixel_camera_stage_summary',
]);
```

Also inspect every `display.columns` definition so coverage includes the approved stable schema `evidence_family`, `status`, `row_count`, `source`, and `limitation`, while detail steps expose typed timestamp/duration/process/thread/source fields where applicable.

Before the Skill exists, also create `camera_trace_evidence.eval.ts` using `describeWithTrace('camera_trace_evidence skill', 'launch_light.pftrace', ...)`. Execute `evidence_coverage`, `camera_process_candidates`, `camera_slice_candidates`, `camera_binder_summary`, `camera_dmabuf_summary`, and `pixel_camera_stage_summary`; assert each succeeds without missing-table errors. Assert the eight required evidence families are present—Camera process/thread identity, Camera candidate slices, Binder, scheduler, CPU frequency, FrameTimeline, DMA-BUF, and optional Pixel Camera—and statuses are one of `available`, `vendor_specific`, or `missing`. Assert that Pixel rows are either a typed detail list or empty.

- [ ] **Step 2: Run the schema test and confirm RED**

```bash
cd backend
npx jest src/services/skillEngine/__tests__/cameraTraceEvidenceSchema.test.ts --runInBand
```

Then run the real trace evaluation as part of the same RED phase:

```bash
npx jest tests/skill-eval/camera_trace_evidence.eval.ts --runInBand
```

Expected: both suites fail because the Skill file does not exist. The schema test proves the static contract, while the real-trace test is written before production SQL so malformed or missing-table SQL cannot reach GREEN without executing successfully.

- [ ] **Step 3: Implement the composite Skill**

Create a tier-B composite Skill with Camera/open/preview/capture/DMA-BUF triggers, no required input, optional `start_ts`, `end_ts`, and `max_rows`, and these modules:

```yaml
prerequisites:
  required_tables: [slice, thread, process]
  modules:
    - slices.with_context
    - android.binder
    - android.frames.timeline
    - android.memory.dmabuf
    - linux.cpu.frequency
    - pixel.camera
```

Use a single-row-per-evidence-family coverage query. Because included Perfetto modules create empty tables when their trace events are absent, query their row counts directly. The query must cover Camera process/thread identity, vendor Camera slices, Camera-related Binder transactions, scheduler rows, CPU-frequency rows, FrameTimeline, DMA-BUF allocations, and optional Pixel Camera rows. The stable row shape is:

```sql
SELECT 'camera_process_thread_identity' AS evidence_family,
       CASE WHEN candidate_count > 0 THEN 'available' ELSE 'missing' END AS status,
       candidate_count AS row_count,
       'process,thread' AS source,
       'Name-based identity candidates are not proof of a specific Camera milestone.' AS limitation
FROM (
  SELECT
    (SELECT COUNT(*) FROM process
     WHERE lower(COALESCE(name, '')) GLOB '*camera*'
        OR lower(COALESCE(name, '')) GLOB '*camx*'
        OR lower(COALESCE(name, '')) GLOB '*mtkcam*')
    +
    (SELECT COUNT(*) FROM thread
     WHERE lower(COALESCE(name, '')) GLOB '*camera*'
        OR lower(COALESCE(name, '')) GLOB '*camx*'
        OR lower(COALESCE(name, '')) GLOB '*mtkcam*') AS candidate_count
)
UNION ALL
SELECT 'camera_slice_candidates' AS evidence_family,
       CASE WHEN COUNT(*) > 0 THEN 'vendor_specific' ELSE 'missing' END,
       COUNT(*),
       'thread_slice',
       'Slice names are implementation-specific candidates and require identity/anchor verification.'
FROM thread_slice
WHERE lower(COALESCE(name, '')) GLOB '*camera*'
   OR lower(COALESCE(name, '')) GLOB '*capture*'
   OR lower(COALESCE(name, '')) GLOB '*preview*'
UNION ALL
SELECT 'binder_transactions' AS evidence_family,
       CASE WHEN COUNT(*) > 0 THEN 'available' ELSE 'missing' END,
       COUNT(*),
       'android_binder_txns',
       'Binder rows provide cross-process correlation; interface names and endpoints must still be verified.'
FROM android_binder_txns
WHERE lower(COALESCE(client_process, '')) GLOB '*camera*'
   OR lower(COALESCE(server_process, '')) GLOB '*camera*'
   OR lower(COALESCE(client_process, '')) GLOB '*camx*'
   OR lower(COALESCE(server_process, '')) GLOB '*camx*'
   OR lower(COALESCE(client_process, '')) GLOB '*mtkcam*'
   OR lower(COALESCE(server_process, '')) GLOB '*mtkcam*'
UNION ALL
SELECT 'scheduler_context',
       CASE WHEN COUNT(*) > 0 THEN 'available' ELSE 'missing' END,
       COUNT(*),
       'sched_slice',
       'Scheduler rows provide execution context only after Camera thread identity is established.'
FROM sched_slice
UNION ALL
SELECT 'cpu_frequency_context',
       CASE WHEN COUNT(*) > 0 THEN 'available' ELSE 'missing' END,
       COUNT(*),
       'cpu_frequency_counters',
       'CPU-frequency rows provide system context and do not by themselves attribute Camera latency.'
FROM cpu_frequency_counters
UNION ALL
SELECT 'frame_timeline',
       CASE WHEN COUNT(*) > 0 THEN 'available' ELSE 'missing' END,
       COUNT(*),
       'actual_frame_timeline_slice',
       'FrameTimeline can support presentation correlation only after preview surface identity is established.'
FROM actual_frame_timeline_slice
UNION ALL
SELECT 'dmabuf_allocations',
       CASE WHEN COUNT(*) > 0 THEN 'available' ELSE 'missing' END,
       COUNT(*),
       'android_dmabuf_allocs',
       'DMA-BUF allocation deltas are memory evidence; they do not alone prove a leak.'
FROM android_dmabuf_allocs
UNION ALL
SELECT 'pixel_camera_frames',
       CASE WHEN COUNT(*) > 0 THEN 'vendor_specific' ELSE 'missing' END,
       COUNT(*),
       'pixel_camera_frames',
       'pixel.camera is an optional Pixel slice parser, not a portable Android Camera contract.'
FROM pixel_camera_frames;
```

For process and slice candidates, use `lower(COALESCE(name, ''))` with Camera/vendor patterns (`camera`, `cameraserver`, `camera.provider`, `camx`, `mtkcam`) and return identity fields. For Binder, include only transactions whose client/server process matches those candidate patterns. For DMA-BUF, aggregate signed `buf_size` by process and report allocation count, allocation bytes, release bytes, observed net delta within the selected window, and peak event size. Never call that windowed net delta retained-at-trace-end memory or a leak: allocations may predate the window and releases may occur after it. For Pixel stages, group by `cam_id`, `node`, and `port_group`, returning frame count plus average/max duration. Clamp `max_rows` to 1–100 and normalize optional time bounds with `trace_start()`/`trace_end()`.

Every step must declare `display.layer`, `display.level`, typed columns, stable source/identity fields, `save_as`, and an evidence-oriented `synthesize` mapping. Do not add diagnostic rules with fixed thresholds.

- [ ] **Step 4: Run both prewritten tests and Skill validation to confirm GREEN**

```bash
cd backend
npx jest src/services/skillEngine/__tests__/cameraTraceEvidenceSchema.test.ts --runInBand
npx jest tests/skill-eval/camera_trace_evidence.eval.ts --runInBand
npm run validate:skills
```

Expected: both tests and Skill validation pass. The Skill executes on `launch_light.pftrace`; absent Camera/Pixel evidence is represented as coverage/empty data, not an exception. If the local fixture is absent, the suite must be explicitly skipped by `describeWithTrace` and the later six-trace regression remains the executable integration gate.

- [ ] **Step 5: Commit the Skill and tests**

```bash
git add \
  backend/skills/composite/camera_trace_evidence.skill.yaml \
  backend/src/services/skillEngine/__tests__/cameraTraceEvidenceSchema.test.ts \
  backend/tests/skill-eval/camera_trace_evidence.eval.ts
git commit -m "feat: add camera trace evidence skill"
```

---

### Task 4: Export and document the Camera workflow

**Files:**
- Modify: `backend/skills/public-export.yaml`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/reference/cli.md`
- Modify: `docs/reference/cli.en.md`

- [ ] **Step 1: Add the public projection policy entry**

Add an exported runtime-skill mapping entry under `skills:` adjacent to the other rendering-pipeline workflows:

```yaml
camera_trace_evidence:
  source: backend/skills/composite/camera_trace_evidence.skill.yaml
  workflow: rendering-pipeline
  disposition: exported
  destination: references/generated/skills/camera_trace_evidence.md
```

- [ ] **Step 2: Document the preset and its evidence limits**

Add `camera` to the preset tables/lists and include one command in each language:

```bash
smp capture suggest --request "分析 Camera 打开到首帧预览延迟" --app com.example.camera
smp capture config --preset camera --app com.example.camera --duration 20
```

State that the preset collects Camera/vendor atrace candidates, Binder, scheduler, FrameTimeline, and DMA-BUF/legacy ION events. Explicitly say that a trace may still lack portable open/result/buffer/presentation anchors, and SmartPerfetto will report that gap instead of fabricating a first-frame number.

- [ ] **Step 3: Commit the SmartPerfetto export policy and docs**

```bash
git add \
  backend/skills/public-export.yaml \
  README.md README.zh-CN.md \
  docs/reference/cli.md docs/reference/cli.en.md
git commit -m "docs: expose camera evidence workflow"
```

- [ ] **Step 4: Regenerate and verify the sibling public projection**

First inspect the sibling `Perfetto-Skills` checkout and preserve any unrelated local changes. If it is clean or its changes do not overlap generated export outputs, run its exporter without `--check`, validate the catalog, and commit only the generated projection/provenance changes:

```bash
PUBLIC_REPO=/Users/chris/Code/SmartPerfetto/Perfetto-Skills
git -C "$PUBLIC_REPO" status --short
python3 "$PUBLIC_REPO/tools/export_from_smartperfetto.py" \
  --source "$PWD"
python3 "$PUBLIC_REPO/tools/validate_catalog.py" \
  --catalog "$PUBLIC_REPO/catalog/smartperfetto-export.json" \
  --skill-root "$PUBLIC_REPO/skills/perfetto-performance-analysis"
git -C "$PUBLIC_REPO" add \
  catalog/smartperfetto-export.json \
  skills/perfetto-performance-analysis
git -C "$PUBLIC_REPO" commit -m "feat: export camera evidence workflow"
PERFETTO_SKILLS_DIR="$PUBLIC_REPO" npm run verify:public-skills
```

If the sibling checkout is absent, missing tools, or has overlapping local changes, record the exact `NOT AVAILABLE` or conflict reason and do not hand-edit generated public files. Do not push either repository.

---

### Task 5: Verify, simplify, and review the complete change

**Files:**
- Review: all files changed in Tasks 1–4

- [ ] **Step 1: Run the complete project-defined verification**

Run from the repository root:

```bash
npm run verify:pr
```

This is the repository's required pre-landing gate and includes Skill validation, backend type/build/tests, CLI checks, trace-processor availability, and the six-trace scene regression. Do not replace it with checks from another repository.

- [ ] **Step 2: Run the configured simplifier or the documented fallback**

Use the first available option in this order:

1. current-environment `/simplify`;
2. a simplification script explicitly defined by the repository;
3. `code-simplifier` on only the files changed by this plan.

If none is available, perform a manual behavior-preserving simplification review of only those files and run:

```bash
git diff --check
```

Record simplifier availability; unavailable simplification tooling is not a blocker.

- [ ] **Step 3: Perform an architecture and evidence audit**

Confirm from the final diff that:

- no Camera prompt prose or SQL was hardcoded in TypeScript;
- capture presets still flow through the shared registry and renderer;
- Camera-domain routing does not steal generic app first-frame requests;
- no metric conflates device-open, capture result, output buffer, or preview presentation;
- vendor slice matches are labeled as candidates;
- no fixed latency threshold, universal `prepare()` recommendation, or PSS/RSS leak verdict was added;
- optional Pixel and DMA-BUF tables are safe on traces with zero rows;
- DataEnvelope metadata remains usable by chat, reports, snapshots, CLI, and comparison;
- no unrelated worktree file, generated frontend artifact, or Perfetto submodule revision changed.

- [ ] **Step 4: Re-run affected checks after any revision**

Run the smallest focused suite for each revision, then repeat `npm run verify:pr` if runtime/Skill behavior changed after the full gate.

- [ ] **Step 5: Record final repository state**

```bash
git status --short
git log --oneline -5
```

Expected: only the user's pre-existing `.gitignore` change remains uncommitted; implementation commits are present locally and nothing has been pushed.
