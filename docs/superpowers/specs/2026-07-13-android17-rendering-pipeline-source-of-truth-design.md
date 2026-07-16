# Android 17 Rendering Pipeline Source-of-Truth Design

## Context

SmartPerfetto currently has two diverging rendering-pipeline models:

- `docs/rendering_pipelines/` contains 32 legacy Markdown files organized around
  individual implementation variants.
- `backend/skills/pipelines/` contains 31 fine-grained detection definitions,
  each with its own duplicated teaching prose.
- the runtime detection Skill is generated from the 31 YAML definitions, while
  the committed `backend/skills/atomic/rendering_pipeline_detection.skill.yaml`
  exported to Perfetto-Skills is an older hand-maintained implementation.
- TypeScript still hardcodes primary exclusions, feature IDs, global-scope IDs,
  document mappings, and pipeline-to-architecture mappings.

The authoritative upstream is `https://github.com/Gracker/rendering_pipelines`.
At reviewed commit `043074f775d03551b4f9d068b4296e70258b3571`, its public source consists of
14 Markdown articles (`S01` through `S14`), totaling 6,037 lines. The articles
use Android 17 / API 37 (`android-17.0.0_r1`) and kernel
`android17-6.18-2026-06_r6` as their current implementation anchors while
recording Android 12-17 differences.

## Goal

Make the upstream 14-article Android 17 series the single teaching source of
truth while preserving SmartPerfetto's useful fine-grained trace detection.
The product model becomes:

```text
Rendering type (S02-S14, user-facing knowledge)
  -> one or more detectable pipeline variants (machine evidence and pinning)
```

`S01` remains the common overview and classification method. It is not a
detected concrete type.

## Canonical Data Model

`backend/skills/pipelines/index.yaml` is the SmartPerfetto catalog. It records:

- the upstream repository, immutable commit, Android platform tag, and kernel
  tag;
- the 14 imported document paths and hashes;
- the rendering-type IDs and their user-facing document paths;
- every pipeline ID, its YAML filename, classification role, teaching type,
  optional related rendering types, architecture type, detection scope, primary
  eligibility, and feature visibility.

The 31 `*.skill.yaml` files remain the runtime source for signal scoring,
auto-pin instructions, and analysis recommendations. Their teaching block is
reduced to a reference to the catalog-selected upstream document. They no
longer duplicate prose, Mermaid diagrams, Android version claims, or source
anchors.

Rendering type IDs use stable series-derived names:

- `S02_AOSP_STANDARD`
- `S03_SURFACEVIEW`
- `S04_TEXTUREVIEW`
- `S05_MIXED_RENDERING`
- `S06_MULTI_WINDOW`
- `S07_SOFTWARE_OFFSCREEN`
- `S08_NATIVE_GRAPHICS`
- `S09_WEBVIEW`
- `S10_FLUTTER`
- `S11_CAMERA`
- `S12_VIDEO_OVERLAY_HWC`
- `S13_GAME`
- `S14_REACT_NATIVE`

Fine-grained pipeline IDs remain backward compatible, for example
`FLUTTER_SURFACEVIEW_IMPELLER`, `WEBVIEW_GL_FUNCTOR`, and
`ANGLE_GLES_VULKAN`.

The 31 entries are not all concrete rendering-type variants. A catalog entry
has one of two roles:

- `variant`: trace evidence can participate in primary rendering-type ranking;
- `feature`: cross-cutting or system-side evidence that is reported separately
  and can select a teaching article, but cannot become the primary type.

`teaching_type_id` is required for every entry. `rendering_type_id` is present
only for `variant` entries. A feature can instead declare zero or more
`related_rendering_type_ids`. This prevents VRR, PiP, SurfaceControl, ANGLE, or
system composition evidence from being promoted into an app's primary output
type.

Detected feature relationships are materialized separately as
`relatedRenderingTypes`, including confidence and the catalog-backed article
path. Feature-only types such as S06 and S12 therefore remain teachable without
being promoted into primary ranking.

The reviewed mapping is:

| Pipeline ID | Role | Primary rendering type or related teaching type |
|---|---|---|
| `ANDROID_VIEW_STANDARD_BLAST` | variant | `S02_AOSP_STANDARD` |
| `ANDROID_VIEW_STANDARD_LEGACY` | variant | `S02_AOSP_STANDARD` |
| `COMPOSE_STANDARD` | variant | `S02_AOSP_STANDARD` |
| `SURFACEVIEW_BLAST` | variant | `S03_SURFACEVIEW` |
| `TEXTUREVIEW_STANDARD` | variant | `S04_TEXTUREVIEW` |
| `ANDROID_VIEW_MIXED` | variant | `S05_MIXED_RENDERING` |
| `ANDROID_VIEW_MULTI_WINDOW` | feature | `S06_MULTI_WINDOW` |
| `ANDROID_PIP_FREEFORM` | feature | `S06_MULTI_WINDOW` |
| `ANDROID_VIEW_SOFTWARE` | variant | `S07_SOFTWARE_OFFSCREEN` |
| `HARDWARE_BUFFER_RENDERER` | feature | `S07_SOFTWARE_OFFSCREEN` |
| `IMAGEREADER_PIPELINE` | feature | `S07_SOFTWARE_OFFSCREEN` |
| `SURFACE_CONTROL_API` | feature | `S07_SOFTWARE_OFFSCREEN` |
| `OPENGL_ES` | variant | `S08_NATIVE_GRAPHICS` |
| `VULKAN_NATIVE` | variant | `S08_NATIVE_GRAPHICS` |
| `ANGLE_GLES_VULKAN` | feature | `S08_NATIVE_GRAPHICS` |
| `WEBVIEW_GL_FUNCTOR` | variant | `S09_WEBVIEW` |
| `WEBVIEW_SURFACE_CONTROL` | variant | `S09_WEBVIEW` |
| `WEBVIEW_SURFACEVIEW_WRAPPER` | variant | `S09_WEBVIEW` |
| `WEBVIEW_TEXTUREVIEW_CUSTOM` | variant | `S09_WEBVIEW` |
| `CHROME_BROWSER_VIZ` | variant | `S09_WEBVIEW` |
| `FLUTTER_SURFACEVIEW_IMPELLER` | variant | `S10_FLUTTER` |
| `FLUTTER_SURFACEVIEW_SKIA` | variant | `S10_FLUTTER` |
| `FLUTTER_TEXTUREVIEW` | variant | `S10_FLUTTER` |
| `CAMERA_PIPELINE` | variant | `S11_CAMERA` |
| `VIDEO_OVERLAY_HWC` | feature | `S12_VIDEO_OVERLAY_HWC` |
| `GAME_ENGINE` | variant | `S13_GAME` |
| `RN_OLD_ARCH_HWUI` | variant | `S14_REACT_NATIVE` |
| `RN_NEW_ARCH_HWUI` | variant | `S14_REACT_NATIVE` |
| `RN_SKIA_RENDERER` | variant | `S14_REACT_NATIVE` |
| `VARIABLE_REFRESH_RATE` | feature | S01 overview; no related concrete type |
| `SOFTWARE_COMPOSITING` | feature | S01 overview; no related concrete type |

The catalog's explicit default is `ANDROID_VIEW_STANDARD_BLAST` /
`S02_AOSP_STANDARD`; fallback code must derive both IDs and the document path
from that entry.

## Synchronization Boundary

Add a repository-owned synchronization command with check and apply modes. It
must:

1. verify the source checkout is `Gracker/rendering_pipelines` at the requested
   immutable commit;
2. accept exactly the 14 top-level `S01`-`S14` Markdown articles;
3. replace every Markdown file under `docs/rendering_pipelines/`, so no legacy
   article survives;
4. store content hashes in the catalog;
5. rewrite each pipeline YAML's teaching reference and validate that the
   reference agrees with the catalog;
6. fail in check mode if a local document, hash, YAML reference, or generated
   detection Skill drifts.

The imported Markdown remains verbatim. SmartPerfetto-specific notes belong in
the catalog, Skills, strategies, or product docs, never inside the imported
articles.

The repository build copies the checked documents into
`backend/dist/rendering_pipelines/`. Source mode reads the repository docs;
compiled/npm/Docker/portable modes read the copied dist asset. Packaging checks
must fail if any of the 14 documents is absent or differs from the catalog hash.

## Runtime Behavior

### Detection

The generated detector reads catalog metadata instead of TypeScript lists.
It continues to score fine-grained pipeline variants, but also returns:

- `primary_rendering_type_id` / `primaryRenderingTypeId`;
- a backward-compatible `primary_pipeline_id` / `primaryPipelineId`;
- deduplicated rendering-type candidates;
- fine-grained pipeline candidates;
- orthogonal features such as PiP, multi-window, VRR, or overlay evidence.

Classification role, primary eligibility, feature visibility, and app/global
signal scope are data fields. Only `variant` entries participate in primary
type aggregation. No pipeline inventory is duplicated in TypeScript.

The latest S01 does not define the old SmartPerfetto phrase "S01 section 4
four-feature classification" as a normative taxonomy. The existing
`pipeline_4feature_scoring` ID remains for compatibility, but its Producer,
layer, submission-path, and cadence outputs are explicitly supporting evidence
axes. They cannot establish a type without the type article's minimum
Producer/Surface-or-layer/BufferQueue evidence. Knowledge templates must also
adopt the current six bottleneck patterns, HWC present-or-validate branches,
Android 13 latch-unsignaled boundary, and the rule that a present-fence signal
is an Android display-stack time anchor rather than proof of panel optical
completion or user perception.

### Teaching

`PipelineDocService` resolves the selected pipeline through the catalog and
parses the imported article. Markdown provides title, summary, Mermaid blocks,
thread-role tables, key slices, and the document path. YAML is only a fallback
when the referenced document is missing, and a missing committed document is a
validation failure.

The teaching API remains `teaching.pipeline.v2`. Existing fields stay intact;
the new rendering-type fields are additive. SQL uses
`primary_rendering_type_id`; service and route JSON use
`primaryRenderingTypeId`. Candidate objects keep `renderingTypeId`, while the
article metadata is exposed separately as `renderingType`. The Perfetto UI
shows the rendering type as the main classification and the fine-grained
pipeline as the detected subpath, so existing consumers continue to work.

### Architecture Detection

`architectureDetector.ts` obtains `RenderingArchitectureType` from catalog
metadata instead of a pipeline-ID switch. Unknown or invalid catalog entries
fall back to `STANDARD` with explicit low-confidence behavior.

## Portable Perfetto-Skills Projection

The committed portable `rendering_pipeline_detection` Skill is generated from
the same catalog and pipeline YAML definitions used by SmartPerfetto runtime.
The generator omits the SmartPerfetto-only `pipeline` aggregation step but
keeps portable SQL evidence steps. Generated-file checks prevent the public
projection from silently exporting an older hand-maintained detector.

`backend/skills/public-export.yaml` exports only the new S01-S14 documents and
the generated detector/pipeline definitions. The SmartPerfetto catalog itself
is not a public runtime dependency: the generated portable detector fully
materializes and tests the role/type mapping needed by the public Skill. The
sibling Perfetto-Skills checkout is regenerated, compiled, validated with its
complete gate, committed, and pushed on its active branch.

## Product Surfaces

Affected surfaces are:

- backend Skill loading, detection, architecture metadata, and teaching API;
- pipeline/teaching strategies plus rendering-anchor and fence knowledge
  templates that currently restate older article semantics;
- Perfetto AI Assistant teaching command and its committed frontend prebuild;
- runtime-read rendering documentation;
- public Perfetto-Skills export and runtime catalog;
- Chinese and English architecture/reference documentation that describes the
  rendering-pipeline model.

No provider/session/report contract, trace capture preset, or release artifact
version changes are required.

## Failure Handling

- Missing, extra, renamed, or modified upstream articles fail synchronization.
- Unknown pipeline IDs, missing catalog mappings, invalid architecture types,
  invalid selection flags, or doc-path mismatches fail loader validation.
- Detection with no qualifying primary retains the standard AOSP fallback and
  reports low confidence.
- Missing trace signals remain evidence gaps; Android version knowledge must
  never be used as proof that a trace contains a given pipeline.
- Public export or cross-repository impact failure blocks push.

## Verification

Required evidence includes:

- red/green unit tests for catalog loading, doc resolution, type aggregation,
  architecture mapping, API compatibility, and UI rendering;
- synchronization check proving 14 documents and matching hashes;
- generated detector drift check;
- backend Skill validation, targeted tests, scene trace regression, and
  `npm run verify:pr`;
- Perfetto UI targeted tests/typecheck, development-mode browser smoke, and
  `./scripts/update-frontend.sh`;
- Perfetto-Skills export, compile/query validation, complete
  `uv run python tools/verify.py`, and both cross-repository impact gates;
- final remote-SHA verification after push.

## Landing Order

1. incorporate the already-fetched SmartPerfetto `origin/main` commit without
   rewriting the 12 local commits;
2. commit and push any Perfetto UI submodule change to `fork`;
3. commit the SmartPerfetto functional change and generated frontend artifacts;
4. regenerate and verify the Perfetto-Skills worktree without committing it;
5. run paired impact evidence against the exact SmartPerfetto commit and the
   prospective Perfetto-Skills worktree, then commit the public change;
6. push SmartPerfetto `main` first, push the active Perfetto-Skills branch only
   after its pinned source commit is remotely reachable, and verify all refs.
