# Android 17 Rendering Pipeline Source-of-Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SmartPerfetto's legacy rendering-pipeline teaching corpus with the reviewed Android 17 S01-S14 source while preserving and correctly classifying fine-grained trace detection, then synchronize Perfetto-Skills.

**Architecture:** A catalog binds 14 upstream articles and 13 concrete user-facing rendering types to 31 machine-detectable entries. Entries are explicitly either primary-eligible variants or orthogonal features. A checked sync command imports upstream Markdown and rewrites references; runtime loaders, SQL generation, architecture mapping, teaching API, and the portable generated Skill all consume the same catalog instead of TypeScript inventories.

**Tech Stack:** Node.js 24, TypeScript strict mode, YAML/Markdown runtime assets, Jest, PerfettoSQL, Perfetto UI TypeScript, Python/uv for Perfetto-Skills.

## Global Constraints

- The authoritative content source is `Gracker/rendering_pipelines` commit `043074f775d03551b4f9d068b4296e70258b3571`.
- Imported S01-S14 Markdown is verbatim; SmartPerfetto-specific content must not be inserted into it.
- Android 17 / API 37 uses `android-17.0.0_r1`; kernel references use `android17-6.18-2026-06_r6`.
- Preserve all 31 fine-grained pipeline IDs and backward-compatible teaching API fields.
- Only catalog entries with `classification_role: variant` may participate in primary type ranking; feature entries keep their teaching relationship without becoming a type.
- Materialize detected feature relationships separately as `relatedRenderingTypes` with catalog-backed article paths; do not merge them into the mutually exclusive primary-type ranking.
- Keep `pipeline_4feature_scoring` as a compatibility ID, but describe its four outputs as supporting evidence axes rather than a normative S01 taxonomy or sufficient type proof.
- Do not hardcode pipeline inventories, primary exclusions, feature lists, document maps, or architecture maps in TypeScript.
- Preserve unrelated worktree and public-repository branch history.
- Only project-defined verification commands may be used.

---

### Task 1: Establish the catalog and checked upstream synchronization

**Files:**
- Modify: `backend/skills/pipelines/index.yaml`
- Create: `scripts/sync-rendering-pipelines.mjs`
- Create: `scripts/__tests__/sync-rendering-pipelines.test.mjs`
- Modify: `package.json`
- Replace: `docs/rendering_pipelines/*.md`
- Modify: `backend/skills/pipelines/*.skill.yaml`
- Modify: `backend/scripts/copy-runtime-assets.cjs`
- Modify: `backend/scripts/check-cli-pack.cjs`

**Interfaces:**
- Produces: catalog fields `source`, `documents`, `rendering_types`, `default`, and `pipelines`, including the reviewed 31-entry role/type mapping from the design.
- Produces: `npm run sync:rendering-pipelines -- --source PATH --apply` and `npm run check:rendering-pipelines`.

- [ ] **Step 1: Merge `origin/main` into local `main` and confirm only the reviewed design/plan files remain untracked.**

Run: `git merge --no-edit origin/main && git status --short --branch`

Expected: merge succeeds; local history retains the 12 existing commits,
includes the public-impact rule commit, and introduces no unrelated worktree
change.

- [ ] **Step 2: Write failing Node tests for exact S01-S14 inventory, hash drift, legacy-file rejection, and YAML-reference mismatch.**

The tests create temporary source/target trees and assert that check mode reports a concrete mismatch and apply mode deletes a legacy file while copying exactly 14 documents.

- [ ] **Step 3: Run the focused test and confirm RED.**

Run: `node --test scripts/__tests__/sync-rendering-pipelines.test.mjs`

Expected: FAIL because the synchronization module and catalog contract do not exist.

- [ ] **Step 4: Implement the sync module and catalog.**

The module exports `loadCatalog()`, `validateSource()`, `buildSyncPlan()`, `applySyncPlan()`, and `checkSynchronizedState()`. It validates the remote slug and commit, hashes each imported document, removes all target Markdown not in the 14-file set, and textually replaces each top-level YAML `teaching:` block with:

```yaml
teaching:
  source: "rendering_pipelines/Sxx_name.md"
```

It also validates every catalog pipeline file, classification role, rendering/teaching type, selection flags, and document reference without reformatting unrelated YAML.

- [ ] **Step 5: Apply the reviewed upstream checkout and confirm GREEN.**

Run:

```bash
npm run sync:rendering-pipelines -- \
  --source /tmp/smartperfetto-rendering-pipelines-upstream --apply
node --test scripts/__tests__/sync-rendering-pipelines.test.mjs
npm run check:rendering-pipelines
```

Expected: 14 documents imported; all legacy Markdown removed; focused tests and check mode pass.

- [ ] **Step 6: Copy the checked article set into the compiled runtime and verify the npm package.**

Extend the repository build asset copier to place exactly the 14 documents in
`backend/dist/rendering_pipelines/`. Extend the CLI pack check to compare their
inventory and bytes with the catalog. Docker and portable already carry
`backend/dist`; add focused smoke assertions so those packaging paths cannot
drop the directory.

Run: `cd backend && npm run build && node scripts/check-cli-pack.cjs`

Expected: the packed CLI contains all 14 hash-matching documents.

### Task 2: Make the loader and teaching service catalog-driven

**Files:**
- Modify: `backend/src/services/pipelineSkillLoader.ts`
- Modify: `backend/src/services/pipelineDocService.ts`
- Modify: `backend/src/services/skillEngine/skillExecutor.ts`
- Modify: `backend/src/services/renderingPipelineTeachingService.ts`
- Modify: `backend/src/types/teaching.types.ts`
- Modify: `backend/src/config/teaching.config.ts`
- Modify: `backend/src/routes/__tests__/agentTeachingRoutes.test.ts`
- Create: `backend/src/services/__tests__/pipelineCatalogAndDocService.test.ts`
- Modify: `backend/src/services/__tests__/renderingPipelineTeachingService.test.ts`

**Interfaces:**
- Produces: `PipelineCatalog`, `RenderingTypeDefinition`, `PipelineCatalogEntry`.
- Produces: `getPipelineCatalogEntry(pipelineId)`, `getRenderingType(typeId)`, and catalog-derived document resolution.

- [ ] **Step 1: Write failing tests for complete catalog coverage, imported-doc teaching precedence, and missing/mismatched references.**

Assert all 31 loaded definitions resolve to a teaching type and document; every
`variant` resolves to exactly one concrete rendering type; every `feature` has
no primary rendering type and only its declared related types. Assert the
article title/summary/Mermaid is returned instead of legacy YAML prose.

- [ ] **Step 2: Run tests and confirm RED.**

Run: `cd backend && npx jest src/services/__tests__/pipelineCatalogAndDocService.test.ts src/services/__tests__/renderingPipelineTeachingService.test.ts --runInBand`

Expected: FAIL because the loader has no catalog API and YAML currently wins teaching precedence.

- [ ] **Step 3: Implement catalog validation and document-driven teaching.**

Load `index.yaml` once with the pipeline definitions; reject duplicate/missing IDs, unsafe document paths, invalid architecture values, role/type contradictions, and invalid selection metadata. Remove `PIPELINE_DOC_MAP`; resolve catalog paths through the loader. In both pipeline-step and fallback paths, use parsed Markdown as the teaching source. Derive the fallback pipeline, type, and document from the catalog default rather than `teaching.config.ts` literals.

- [ ] **Step 4: Run tests and confirm GREEN.**

Run: `cd backend && npx jest src/services/__tests__/pipelineCatalogAndDocService.test.ts src/services/__tests__/renderingPipelineTeachingService.test.ts --runInBand`

Expected: PASS with 31 definitions, 13 documented concrete rendering types,
explicit feature roles, and S01 overview.

### Task 3: Derive detection and architecture classification from catalog metadata

**Files:**
- Modify: `backend/src/services/renderingPipelineDetectionSkillGenerator.ts`
- Modify: `backend/src/agent/detectors/architectureDetector.ts`
- Modify: `backend/src/types/teaching.types.ts`
- Modify: `backend/src/tests/renderingPipelineDetectionGenerator.test.ts`
- Modify: `backend/src/tests/architectureDetector.test.ts`
- Modify: `backend/src/services/skillEngine/__tests__/skillExecutor.test.ts`
- Modify: `backend/skills/atomic/pipeline_4feature_scoring.skill.yaml`

**Interfaces:**
- Produces SQL columns `primary_rendering_type_id` and `rendering_type_candidates_list`.
- Produces SQL field `primary_rendering_type_id` and JSON fields
  `primaryRenderingTypeId`, `renderingType`, and `renderingTypeCandidates` while
  keeping pipeline fields unchanged.

- [ ] **Step 1: Write failing tests proving there are no TypeScript pipeline lists/maps and that SQL aggregates variants into rendering types.**

Tests table-drive all 31 catalog entries. They assert PiP/VRR/overlay/ANGLE
feature behavior comes from metadata, no feature can win primary ranking,
`FLUTTER_SURFACEVIEW_IMPELLER` maps to `S10_FLUTTER`, architecture mapping reads
`FLUTTER` from metadata, and the four evidence axes cannot be described as
sufficient type proof.

- [ ] **Step 2: Run tests and confirm RED.**

Run: `cd backend && npx jest src/tests/renderingPipelineDetectionGenerator.test.ts src/tests/architectureDetector.test.ts src/services/skillEngine/__tests__/skillExecutor.test.ts --runInBand`

Expected: FAIL because the new type fields and catalog-driven selection are absent.

- [ ] **Step 3: Replace hardcoded sets/switches with catalog metadata and extend the additive API contract.**

The detector still ranks pipeline IDs. A second SQL aggregation groups only
qualifying `variant` entries by `rendering_type_id` using maximum score and
returns stable ordered type candidates. Feature and global-scope decisions read
catalog flags. Route-contract tests lock the snake_case SQL-to-camelCase JSON
projection and old response fields.

- [ ] **Step 4: Run tests and confirm GREEN.**

Run the same focused Jest command.

Expected: PASS with legacy pipeline fields and new rendering-type fields both present.

### Task 4: Generate the portable detection Skill from the runtime source

**Files:**
- Create: `backend/src/scripts/materializeRenderingPipelineDetectionSkill.ts`
- Modify generated: `backend/skills/atomic/rendering_pipeline_detection.skill.yaml`
- Modify: `backend/package.json`
- Modify: `backend/src/tests/renderingPipelineDetectionGenerator.test.ts`
- Modify: `backend/skills/public-export.yaml`

**Interfaces:**
- Produces: `npm run generate:pipeline-detection` with `--check` support.
- Produces: portable YAML containing only executable portable steps, derived from `generateRenderingPipelineDetectionSkill()`.

- [ ] **Step 1: Add a failing drift test comparing the normalized committed YAML with the portable projection of the runtime generator.**

- [ ] **Step 2: Run the generator test and confirm RED against the old 24-type hand-maintained Skill.**

Run: `cd backend && npx jest src/tests/renderingPipelineDetectionGenerator.test.ts --runInBand`

Expected: FAIL and identify the committed v2.0 detector as stale.

- [ ] **Step 3: Implement the materializer and generate the file.**

The materializer prepends the license/generated warning, keeps trigger metadata, filters the SmartPerfetto-only `pipeline_bundle` step, and serializes portable SQL steps deterministically. `--check` compares bytes and exits nonzero on drift.

- [ ] **Step 4: Run generation/check and Skill validation.**

Run:

```bash
cd backend
npm run generate:pipeline-detection
npm run generate:pipeline-detection -- --check
npm run validate:skills
```

Expected: generated check and Skill validation pass.

### Task 5: Expose rendering type and subpath in the Perfetto teaching UI

**Files:**
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/types.ts`
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel_navigation_unittest.ts`
- Generated: `frontend/index.html`
- Generated: `frontend/v*/frontend_bundle.js`

**Interfaces:**
- Consumes: additive backend rendering-type detection fields.
- Produces: teaching Markdown with rendering type as the headline and fine-grained pipeline as the subpath.

- [ ] **Step 1: Write a failing UI test with `S10_FLUTTER` plus `FLUTTER_SURFACEVIEW_IMPELLER`.**

Assert the rendered Markdown includes both `出图类型` and `检测子路径` and does not label the subpath as the only type.

- [ ] **Step 2: Run the focused Perfetto UI test and confirm RED.**

Run: `npm --prefix perfetto/ui test -- --test-filter "AIPanel teaching pipeline compatibility view"`

Expected: FAIL because the teaching Markdown still labels the fine-grained pipeline as the only type.

- [ ] **Step 3: Implement the additive frontend types and rendering.**

Keep fallbacks so older backends still render the pipeline ID as before.

- [ ] **Step 4: Run focused UI verification, start dev mode, smoke `/teaching-pipeline`, and refresh committed frontend output.**

Run `./scripts/start-dev.sh`, inspect `http://localhost:10000`, then run `./scripts/update-frontend.sh` after the targeted test/typecheck passes.

Expected: the UI shows type + subpath and the committed prebuild contains the change.

### Task 6: Update product and public-export documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/overview.en.md`
- Modify: `docs/architecture/technical-architecture.md`
- Modify: `docs/reference/skill-system.md`
- Modify: `docs/reference/skill-system.en.md`
- Modify: `backend/strategies/pipeline.strategy.md`
- Modify: `backend/strategies/teaching.strategy.md`
- Modify: `backend/strategies/knowledge-rendering-pipeline.template.md`
- Modify: `backend/strategies/knowledge-pipeline-anchors.template.md`
- Modify: `backend/strategies/knowledge-pipeline-fences.template.md`
- Modify: `docs/architecture/deep-dive-qa.md`
- Modify: `docs/README.md`
- Modify: `docs/README.en.md`
- Modify: every additional file reported by the repository-wide stale-reference scan

**Interfaces:**
- Documents: 14-type/31-subpath model, upstream pin, and source-of-truth behavior.

- [ ] **Step 1: Replace legacy counts/links and update teaching methodology.**

The strategies and knowledge templates must tell the agent to explain the rendering type first, then trace-backed subpaths/features, and keep missing evidence distinct from platform knowledge. Replace the stale Android 14 source anchor, mandatory four-feature/17-type wording, unconditional HWC validate sequence, five-pattern inventory, and present-fence-equals-user-visible claims with the current Android 17 S01-S14 boundaries.

- [ ] **Step 2: Add and run a repository-wide stale-reference check.**

The check rejects deleted legacy filenames, old 17/24-type claims, Phase E
placeholders in active teaching assets, `android14-release` as the latest
anchor, and the obsolete normative four-feature/five-bottleneck/present-fence
claims. Historical plans/presentations may be explicitly excluded only when
they do not participate in runtime or public export.

- [ ] **Step 3: Validate docs/strategy paths.**

Run: `git diff --check && cd backend && npm run validate:strategies`

Expected: no whitespace errors and strategy validation passes.

### Task 7: Independent review, SmartPerfetto verification, and corrections

**Files:**
- Review: all changed files

**Interfaces:**
- Produces: reviewer findings classified as valid, invalid, or not applicable.

- [ ] **Step 1: Request an independent read-only architecture/diff review.**

The reviewer checks source-of-truth uniqueness, Android 17 fidelity, YAML/catalog drift, SQL ranking semantics, API compatibility, UI/product surfaces, generated-file boundaries, and public-export completeness. The reviewer must not edit.

- [ ] **Step 2: Fix every confirmed finding with a failing regression test first.**

- [ ] **Step 3: Run simplification and required SmartPerfetto gates.**

Use `/simplify`, a repository-defined simplifier, or `code-simplifier` when present; if none exists, perform manual simplification and run `git diff --check`. Then run:

```bash
npm run check:rendering-pipelines
cd backend && npm run generate:pipeline-detection -- --check
cd backend && npm run validate:skills
cd backend && npm run validate:strategies
cd backend && npm run test:scene-trace-regression
npm run verify:pr
```

Expected: all commands exit 0; inspect scene outputs for pipeline/teaching regressions.

### Task 8: Synchronize and verify Perfetto-Skills

**Files:**
- Generated in sibling repo: `../Perfetto-Skills/catalog/smartperfetto-export.json`
- Generated in sibling repo: `../Perfetto-Skills/skills/perfetto-performance-analysis/references/generated/**`
- Modify as required in sibling repo: native compiler/tests/overlays only when the new generated detector requires it

**Interfaces:**
- Consumes: clean committed SmartPerfetto functional commit.
- Produces: independently valid Perfetto-Skills export and exact paired commit.

- [ ] **Step 1: Inspect and preserve the active public branch, then dry-run the SmartPerfetto sync.**

Run:

```bash
cd /Users/chris/Code/SmartPerfetto/Perfetto-Skills
uv run python tools/sync_smartperfetto.py \
  --source /Users/chris/Code/SmartPerfetto/SmartPerfetto \
  --commit "$(git -C /Users/chris/Code/SmartPerfetto/SmartPerfetto rev-parse HEAD)" \
  --report-dir test-output/sync
```

Expected: dry-run report lists the 14-document replacement and generated detector changes with no unresolved overlay conflict.

- [ ] **Step 2: Apply the approved export and compile generated assets.**

Run:

```bash
cd /Users/chris/Code/SmartPerfetto/Perfetto-Skills
uv run python tools/sync_smartperfetto.py \
  --source /Users/chris/Code/SmartPerfetto/SmartPerfetto \
  --commit "$(git -C /Users/chris/Code/SmartPerfetto/SmartPerfetto rev-parse HEAD)" \
  --report-dir test-output/sync --apply
uv run python tools/compile_skill.py --apply
```

Expected: imported base, generated references, runtime indexes, and upstream lock/provenance update without hand edits.

- [ ] **Step 3: Run the complete public gate.**

Run: `cd ../Perfetto-Skills && uv run python tools/verify.py`

Expected: complete independent gate exits 0, including real-trace semantic assertions.

- [ ] **Step 4: Keep the verified public worktree uncommitted until the paired impact gate passes.**

### Task 9: Paired impact evidence, final audit, commit, and push

**Files:**
- Commit only files from this objective and required generated artifacts.

**Interfaces:**
- Produces: exact remote SHAs for Perfetto fork (if changed), Perfetto-Skills active branch, and SmartPerfetto main.

- [ ] **Step 1: Commit the verified SmartPerfetto functional change locally and run both paired impact gates before committing or pushing Perfetto-Skills.**

Run:

```bash
cd /Users/chris/Code/SmartPerfetto/Perfetto-Skills
uv run python tools/check_cross_repo_impact.py \
  --repository perfetto-skills \
  --base "$(git merge-base HEAD origin/main)" \
  --decision required \
  --reason "Android 17 rendering taxonomy, portable detector, and teaching corpus changed" \
  --paired-path /Users/chris/Code/SmartPerfetto/SmartPerfetto \
  --paired-ref "$(git -C /Users/chris/Code/SmartPerfetto/SmartPerfetto rev-parse HEAD)"

cd /Users/chris/Code/SmartPerfetto/SmartPerfetto
npm run check:perfetto-skills-impact -- \
  --base "$(git merge-base HEAD origin/main)" \
  --decision required \
  --reason "Android 17 rendering taxonomy, portable detector, and teaching corpus changed" \
  --paired-path /Users/chris/Code/SmartPerfetto/Perfetto-Skills \
  --paired-ref "$(git -C /Users/chris/Code/SmartPerfetto/Perfetto-Skills rev-parse HEAD)"
```

Expected: both commands emit `decision: required`, fingerprints, and exact
validated paired refs. The public checker includes its uncommitted generated
change set by rule; save the evidence in commit notes.

- [ ] **Step 2: Perform the requirement-by-requirement completion audit.**

Confirm: old docs absent; 14 upstream hashes exact; every pipeline resolves; teaching reads imported content; runtime and portable detectors share generated SQL; UI shows type/subpath; both repository gates pass; no unreviewed dirty files remain.

- [ ] **Step 3: Commit the verified Perfetto-Skills worktree, re-run its impact gate against the unchanged SmartPerfetto commit, then push in safe order.**

Push Perfetto submodule `fork` first if changed, then SmartPerfetto `main`, then
Perfetto-Skills active branch. Never force-push. The public lock must not point
to a SmartPerfetto SHA that is absent from the source remote.

- [ ] **Step 4: Verify remote state.**

Run `git ls-remote`/`gh` checks proving each pushed branch contains the recorded local SHA and inspect relevant GitHub workflow status when available.
