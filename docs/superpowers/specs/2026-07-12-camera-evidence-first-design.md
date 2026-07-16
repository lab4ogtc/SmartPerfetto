# Camera Evidence-First Analysis Design

## Context

The article [Camera 性能分析：Perfetto 与延迟拆解实战](https://mp.weixin.qq.com/s/ozvWDCh9exIfqQ2v0vypdA)
contains a useful workflow—capture, quantify, decompose, and compare—but mixes
portable Android Camera contracts with device-specific trace names, illustrative
timings, and SQL that is not safe across cameras, sessions, tracks, or partial
results.

SmartPerfetto already has four adjacent capabilities:

- deterministic Android capture presets and capture proposal routing;
- a `CAMERA_PIPELINE` teaching/detection definition;
- DMA-BUF analysis through Perfetto's `android.memory.dmabuf` module;
- raw-trace and persisted-result comparison contracts.

The missing product layer is a fact-checked Camera capture path plus a
deterministic evidence-coverage Skill. Without a representative Camera trace
fixture, the product must not claim portable Open/First-Frame stage timing.

## Goals

1. Add a first-class `camera` capture intent and preset to the existing CLI and
   deterministic proposal flow.
2. Correct Camera runtime knowledge that currently overstates generic Android
   guarantees or treats vendor slice names as semantic facts.
3. Add a portable `camera_trace_evidence` Skill that reports which Camera
   evidence is actually present before any interpretation.
4. Reuse existing DataEnvelope, reports, snapshots, CLI artifacts, and
   `compare_skill` behavior without adding a Camera-only output channel.
5. Keep every conclusion evidence-scoped and return `N/A` when the trace cannot
   support a metric.

## Non-Goals

- No fixed Camera Open, first-frame, or pipeline-stage thresholds.
- No claim that `processCaptureRequest`, `processCaptureResult`,
  `CameraService::connect`, or similar names exist on every device.
- No generic computation of request-to-result latency from unpartitioned slice
  timestamps.
- No leak conclusion from PSS growth alone.
- No dedicated Camera UI, generated frontend contract, Perfetto submodule
  change, or committed frontend rebuild.
- No automatic sensor pre-open, 3A reuse, dummy requests, or HAL tuning advice.

## Fact-Checked Metric Boundaries

SmartPerfetto will preserve these distinct concepts:

| Metric | Start | End | Availability |
| --- | --- | --- | --- |
| Camera device open | `openCamera` invocation | `CameraDevice.StateCallback.onOpened` | Requires app/framework anchors; not inferred from arbitrary vendor slices |
| Session configuration | session creation request | `CameraCaptureSession.StateCallback.onConfigured` | Requires explicit anchors |
| Request-to-result metadata | submitted capture request | matching final `TotalCaptureResult` | Requires request/frame identity and must not mix partial results |
| First output buffer | first request for a Surface | first image/buffer available on that Surface | Surface-specific; distinct from display |
| Camera launch/startup | camera open start | first preview image available | CTS-compatible conceptual scope; includes open, configure, and preview start |
| First preview presented | camera open or request start | corresponding preview buffer presented | Requires buffer/frame identity through the display pipeline |

The evidence Skill does not manufacture these metrics. It reports whether the
anchors and identities required for each one are present.

## Authoritative Technical Rules

- Camera2 is an ordered, multi-request pipeline. Each request produces result
  metadata plus one or more output buffers.
- `onOpened` means the device is ready for capture-session configuration; it is
  not equivalent to first preview.
- Camera CTS launch measurement includes device open, stream configuration,
  and first preview image availability.
- Camera 3A starts inactive when a device opens. Stream reconfiguration within
  the same open device does not reset 3A, but previous-device-session reuse is
  not a portable guarantee.
- `CameraCaptureSession.prepare()` trades later steadiness for delayed first
  output and potentially higher memory use; it is not a universal first-frame
  optimization.
- `ImageReader` can stall its producer when acquired images reach `maxImages`
  and are not closed.
- DMA-BUF allocation data comes from `dmabuf_heap/dma_heap_stat`; legacy ION
  data may require `ion/ion_stat`. Binder tracing improves gralloc attribution.
- ATrace categories and vendor slice names vary by Android version and device.
  `atrace_apps` uses an exact app name or the documented global `*`; partial
  package wildcards are not part of the product contract.

Primary references:

- https://developer.android.com/topic/performance/tracing
- https://developer.android.com/reference/android/hardware/camera2/package-summary
- https://android.googlesource.com/platform/cts/+/c0dd022/tests/tests/hardware/src/android/hardware/camera2/cts/PerformanceTest.java
- https://developer.android.com/reference/android/hardware/camera2/CameraCaptureSession
- https://source.android.com/docs/core/camera/camera3_3Amodes
- https://developer.android.com/reference/android/media/ImageReader
- https://perfetto.dev/docs/getting-started/atrace
- https://perfetto.dev/docs/getting-started/memory-profiling
- https://perfetto.dev/docs/analysis/stdlib-docs

## Architecture

### 1. Capture Contract

Extend `TraceIntent` and `CapturePresetId` with `camera`. The built-in preset is
a deterministic, portable superset for Camera investigation:

- ATrace categories: `camera`, `hal`, `gfx`, `view`, `binder_driver`, `freq`,
  and `sched`;
- ftrace: existing scheduler/frequency and Binder events plus
  `dmabuf_heap/dma_heap_stat` and `ion/ion_stat`;
- data sources: existing process/system/log sources and SurfaceFlinger
  FrameTimeline;
- default duration: 20 seconds;
- minimum buffer: 96 MiB.

Unsupported optional ftrace events remain a trace capability issue rather than
a reason to invent data. The analysis Skill reports absence explicitly.

The deterministic proposal classifier adds a Camera rule before generic
startup and scrolling rules. Camera-domain tokens such as `camera`, `相机`,
`camera2`, `cameraserver`, `camera HAL`, and `取景器` select the Camera preset.
Ambiguous `preview` / `预览` terms increase Camera-rule relevance but do not
establish the Camera domain by themselves. Generic `first frame`, `首帧`, or UI
preview requests without a Camera-domain token continue to select the startup
preset.

### 2. Runtime Knowledge Correction

Update the committed Camera pipeline doc and YAML definition so they describe
observable contracts rather than implementation assumptions:

- distinguish request activity from sensor exposure;
- describe SurfaceView/TextureView and zero-copy paths as common or preferred,
  not universal;
- make ZSL capability-dependent;
- remove the claim that a Camera request slice proves a sensor trigger;
- describe callback timestamps and callback delivery separately;
- preserve the existing warning that Camera trace visibility is OEM- and
  configuration-dependent.

The rendering-pipeline signal remains a heuristic named
`camera_request_activity`; it must not be labeled `camera_sensor_trigger`.

### 3. `camera_trace_evidence` Skill

Create a composite YAML Skill with four deterministic layers.

#### L0: Coverage

Return one row per evidence family:

- Camera process/thread identity;
- Camera-related slices;
- Binder transactions;
- scheduler and CPU-frequency context;
- SurfaceFlinger FrameTimeline;
- DMA-BUF allocation events;
- Pixel Camera stdlib rows.

Each row contains `evidence_family`, `status`, `row_count`, `source`, and
`limitation`. Status is one of `available`, `vendor_specific`, or `missing`.

#### L1: Generic Camera Inventory

List Camera-related processes, threads, and candidate slices with timestamp,
duration, process, thread, and slice name. Matching is intentionally broad and
the output is labeled `candidate`; names alone do not assign stage semantics.

#### L2: Memory Evidence

Reuse the `android.memory.dmabuf` module to summarize Camera-related DMA-BUF
allocation/release totals by process. Do not duplicate the existing deep
`dmabuf_analysis` lifecycle workflow. The new Skill exposes only the Camera
coverage and correlation entry point and recommends `dmabuf_analysis` for deep
investigation.

#### L3: Pixel Camera Evidence

Include `pixel.camera` and summarize `pixel_camera_frames` by camera id, node,
and port group when rows exist. Empty results are normal on non-Pixel traces and
must not generate an error or a generic Camera conclusion.

The Skill does not emit Open/First-Frame timings. Its conclusion is limited to
what evidence exists and what can be analyzed next.

### 4. Comparison

No new comparison implementation is needed. `compare_skill` can execute
`camera_trace_evidence` against current and reference traces. Because the Skill
has a stable schema, capability and evidence-count differences can be compared
without pretending that missing vendor data is a performance delta.

### 5. Public Projection and Documentation

The new Skill is portable and belongs in `backend/skills/public-export.yaml`.
Update Chinese and English CLI reference documentation and README capture
examples for the `camera` preset. Correct the existing runtime-read Camera
pipeline document in place.

## Data Flow

```text
Natural-language capture request
  -> deterministic Camera-aware classifier
  -> camera capture preset
  -> Perfetto trace with portable Camera context
  -> camera_trace_evidence
       -> coverage matrix
       -> generic candidate inventory
       -> Camera DMA-BUF correlation
       -> optional Pixel frame/node evidence
  -> DataEnvelope
  -> chat / report / CLI artifact / snapshot / compare_skill
```

## Error and Uncertainty Handling

- Missing evidence is a successful Skill result with `status=missing`, not a
  fabricated zero-duration metric.
- Vendor-named candidates use `status=vendor_specific` until a stable module or
  explicit user-provided mapping establishes semantics.
- Empty `pixel_camera_frames` means the Pixel branch is unavailable, not that
  Camera activity was absent.
- No single-trace PSS or DMA-BUF increase is labeled a leak.
- Capture documentation calls DMA-BUF and ION events optional by device/kernel.
- Generic startup routing remains unchanged unless Camera-domain context is
  present.

## Testing Strategy

Implementation follows red-green-refactor.

1. Add failing unit tests for the `camera` preset, Camera-domain routing, and
   generic first-frame routing preservation.
2. Add failing config assertions for Camera categories, FrameTimeline,
   DMA-BUF, ION, scheduler, and Binder coverage.
3. Add a failing Skill contract test that loads `camera_trace_evidence`, checks
   its stable coverage schema, and exercises safe empty results on an existing
   non-Camera canonical trace.
4. Validate the Pixel branch SQL against the vendored Perfetto v57.2 stdlib
   schema; no Pixel performance claim is asserted without fixture rows.
5. Run Skill and Strategy validators, scene regression, public Skill export
   verification, focused capture tests, TypeScript checks, build, and the root
   `npm run verify:pr` gate.

## Files Expected to Change

- `backend/src/services/traceConfigGenerator.ts`
- `backend/src/services/traceCaptureConfig.ts`
- `backend/src/services/traceConfigProposal.ts`
- focused tests under `backend/src/services/__tests__/` and
  `backend/src/cli-user/services/__tests__/`
- `backend/src/cli-user/bin.ts`
- `backend/src/services/renderingPipelineDetectionSkillGenerator.ts`
- `backend/src/tests/renderingPipelineDetectionGenerator.test.ts`
- `backend/skills/atomic/pipeline_4feature_scoring.skill.yaml`
- `backend/skills/pipelines/android_view_mixed.skill.yaml`
- `backend/skills/pipelines/surfaceview_blast.skill.yaml`
- `backend/skills/pipelines/camera_pipeline.skill.yaml`
- `backend/skills/composite/camera_trace_evidence.skill.yaml`
- `backend/skills/public-export.yaml`
- `docs/rendering_pipelines/camera_pipeline.md`
- `README.md`, `README.zh-CN.md`
- `docs/reference/cli.md`, `docs/reference/cli.en.md`

No frontend, Perfetto submodule, release, provider, session, or API contract
files should change.

## Acceptance Criteria

- Camera capture requests route to a dedicated preset without breaking generic
  startup first-frame requests.
- The generated Camera config contains the fact-checked evidence sources.
- Runtime Camera knowledge contains no universal vendor slice assumption, no
  fixed stage threshold, and no first-frame/3A conflation.
- `camera_trace_evidence` runs safely on a trace with no Camera evidence and
  returns an explicit coverage result.
- Pixel Camera evidence is optional and schema-backed.
- The Skill is available through normal invocation, reports, snapshots, CLI,
  and comparison without a Camera-specific adapter.
- All project-defined verification gates required by the touched surfaces pass.
