# GPU Compute Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add vendor-neutral compute-kernel and launch-configuration evidence without claiming unsupported NVIDIA counter analysis.

**Architecture:** A new composite YAML Skill performs capability detection, kernel timing summary, and launch-argument projection from `gpu_slice` and `gpu_track`. The constructed trace generator emits genuine compute-category `GpuRenderStageEvent` packets with typed launch arguments, so corpus coverage is semantic.

**Tech Stack:** PerfettoSQL, YAML Skills, Node.js 24, Jest, Node test runner, protobufjs, Perfetto GPU trace protos, SmartPerfetto trace corpus.

## Global Constraints

- Keep vendor-neutral compute evidence separate from NVIDIA Speed-of-Light and counter-derived occupancy.
- Never infer compute-bound or memory-bound behavior without throughput counters.
- Distinguish no kernels from kernels whose producer omitted launch arguments.
- A named atrace slice is not semantic GPU compute coverage.
- Preserve every unrelated worktree change.

---

### Task 1: Vendor-neutral GPU compute Skill

**Files:**
- Create: `backend/skills/composite/gpu_compute_kernel_analysis.skill.yaml`
- Create: `backend/src/services/skillEngine/__tests__/gpuComputeKernelAnalysisSchema.test.ts`

**Interfaces:**
- Consumes: optional `start_ts`, `end_ts`, `ugpu`, `max_rows`.
- Produces: `data_check`, `kernel_summary`, `launch_configuration`, `no_compute_contract`, `missing_launch_args_contract`.

- [ ] **Step 1: Write the failing contract/safety test**

```ts
expect(skill.name).toBe('gpu_compute_kernel_analysis');
expect(stepIds).toEqual(expect.arrayContaining([
  'data_check', 'kernel_summary', 'launch_configuration',
  'no_compute_contract', 'missing_launch_args_contract',
]));
expect(allSql).toContain('render_stage_category = 2');
expect(allSql).toContain("EXTRACT_ARG(s.arg_set_id, 'launch.workgroup_size.x')");
expect(allSql).not.toMatch(/compute[_ -]?bound|memory[_ -]?bound/i);
```

- [ ] **Step 2: Run RED**

Run: `cd backend && npx jest src/services/skillEngine/__tests__/gpuComputeKernelAnalysisSchema.test.ts --runInBand`

Expected: FAIL because the Skill is absent.

- [ ] **Step 3: Implement bounded kernel summary SQL**

```sql
WITH kernels AS (
  SELECT s.id, s.ts, s.dur, s.arg_set_id,
         ROW_NUMBER() OVER (ORDER BY s.ts, s.id) AS launch_id,
         IFNULL(EXTRACT_ARG(t.dimension_arg_set_id, 'ugpu'), 0) AS ugpu,
         COALESCE(EXTRACT_ARG(s.arg_set_id, 'kernel_demangled_name'),
                  EXTRACT_ARG(s.arg_set_id, 'kernel_name'), s.name) AS kernel
  FROM gpu_slice s JOIN gpu_track t ON s.track_id = t.id
  WHERE s.render_stage_category = 2 AND s.dur > 0
    AND (${start_ts} IS NULL OR s.ts >= ${start_ts})
    AND (${end_ts} IS NULL OR s.ts < ${end_ts})
    AND (${ugpu} IS NULL OR IFNULL(EXTRACT_ARG(t.dimension_arg_set_id, 'ugpu'), 0) = ${ugpu})
)
SELECT launch_id, kernel, ugpu, printf('%d', ts) AS ts, dur AS dur_ns,
       ROUND(100.0 * dur / NULLIF(SUM(dur) OVER (), 0), 2) AS compute_time_pct
FROM kernels ORDER BY dur_ns DESC, launch_id
LIMIT MIN(MAX(COALESCE(${max_rows|50}, 50), 1), 200);
```

The launch step reads `launch.workgroup_size.{x,y,z}` and
`launch.grid_size.{x,y,z}`, derives thread count only when all required
dimensions are positive, and projects typed register/shared-memory/barrier/wave
arguments by their exact producer-provided names. Availability counts compute
rows and argument-bearing rows separately. The two no-data steps are mutually
exclusive and emit status text, not zero performance values.

- [ ] **Step 4: Run GREEN, validate, and commit**

Run: `cd backend && npx jest src/services/skillEngine/__tests__/gpuComputeKernelAnalysisSchema.test.ts --runInBand && npm run validate:skills`

```bash
git add backend/skills/composite/gpu_compute_kernel_analysis.skill.yaml backend/src/services/skillEngine/__tests__/gpuComputeKernelAnalysisSchema.test.ts
git commit -m "feat: add vendor neutral GPU compute evidence"
```

### Task 2: Genuine GPU compute trace fixture

**Files:**
- Modify: `Trace/tools/lib/perfetto-proto.cjs`
- Modify: `Trace/tools/lib/generator.cjs`
- Modify: `Trace/tools/__tests__/generator.test.cjs`
- Modify/regenerate: `Trace/constructed/gpu-workload/`
- Regenerate: `Trace/catalog.json`, `Trace/coverage.json`, `Trace/README.md`, `Trace/constructed/README.md`

**Interfaces:**
- Consumes: scenario signal `gpu-compute-kernel`.
- Produces: `graphicsContexts`, `gpuSpecifications`, GPU interned-data
  extension fields, and `gpuRenderStageEvent` packets.

- [ ] **Step 1: Add a failing generator test**

```js
{
  type: 'gpu-compute-kernel', at_ns: '150000000', duration_ns: '12000000',
  process: 'app', gpu_id: 0, context: '1001',
  kernel: 'SyntheticComputeKernel',
  demangled_kernel: 'SyntheticComputeKernel(float*)',
  grid: {x: 64, y: 1, z: 1}, workgroup: {x: 32, y: 1, z: 1},
  args: {registers_per_thread: 24, shared_mem_static: 1024, shared_mem_dynamic: 2048},
}
```

Query `gpu_slice` and assert category 2, duration, demangled name, workgroup,
grid, registers, and shared-memory args.

- [ ] **Step 2: Run RED**

Run: `node --test Trace/tools/__tests__/generator.test.cjs`

Expected: `unsupported signal type: gpu-compute-kernel`.

- [ ] **Step 3: Emit deterministic interned data and event packets**

Extend the proto loader to load
`protos/perfetto/trace/gpu/gpu_interned_data.proto` with the Trace proto so
protobufjs preserves the extension fields.
Before the event, emit `graphicsContexts`, two `gpuSpecifications` rows for the
queue and compute stage, and the exact protobufjs extension keys
`.perfetto.protos.GpuInternedData.computeKernels` and
`.perfetto.protos.GpuInternedData.computeArgNames`. The stage specification
uses category `COMPUTE`. Emit:

```js
{
  timestamp,
  gpuRenderStageEvent: {
    eventId, duration, hwQueueIid: queueIid, stageIid, gpuId: signal.gpu_id,
    context: signal.context, kernelIid,
    launch: {
      gridSize: signal.grid,
      workgroupSize: signal.workgroup,
      args: sortedArgs,
    },
  },
}
```

Use IIDs derived from signal index and validate dimensions/values as bounded
non-negative integers.

- [ ] **Step 4: Add two varied kernels and semantic expectation**

Require `data_check`, `kernel_summary`, and `launch_configuration`, with
`kernel_summary` as the semantic step.

- [ ] **Step 5: Build, test, validate, and commit**

Run: `node Trace/tools/trace-corpus.cjs build --case gpu-workload && npm run trace:test -- --case gpu-workload && node Trace/tools/trace-corpus.cjs index && npm run trace:validate`

```bash
git add Trace/tools/lib/perfetto-proto.cjs Trace/tools/lib/generator.cjs Trace/tools/__tests__/generator.test.cjs Trace/constructed/gpu-workload Trace/catalog.json Trace/coverage.json Trace/README.md Trace/constructed/README.md
git commit -m "test: add GPU compute trace evidence"
```

### Task 3: Mapping, public disposition, and gates

**Files:**
- Modify: `backend/skills/docs/upstream-perfetto-ai-skill-translation.sop.md`
- Modify: `backend/skills/public-export.yaml`

- [ ] **Step 1: Split generic GPU compute from NVIDIA workflows**

Map the vendor-neutral Skill to `gpu_compute_kernel_analysis` and the semantic
`gpu-workload` case. Keep NVIDIA counter workflows Deferred with the missing
fixture/schema prerequisite.

- [ ] **Step 2: Export only portable Skill content**

Add the YAML/SQL candidate to `public-export.yaml`; keep product provider,
session, report, and frontend behavior SmartPerfetto-only.

- [ ] **Step 3: Run SmartPerfetto gates**

Run the focused Jest test, `cd backend && npm run validate:skills`,
`npm run trace:regression`, `cd backend && npm run test:scene-trace-regression`,
`cd backend && npm run typecheck`, `cd backend && npm run build`, and
`npm run verify:pr`.

- [ ] **Step 4: Record paired impact, simplify, and commit**

Run `check:perfetto-skills-impact` with `deferred`, reason that the portable
projection follows the SmartPerfetto source commit, and handoff
`docs/superpowers/plans/2026-07-14-upstream-skill-gap-governance.md`.

After configured simplification or manual review plus `git diff --check`,
commit only the SOP/export files with message
`docs: split generic and NVIDIA GPU compute coverage`.
