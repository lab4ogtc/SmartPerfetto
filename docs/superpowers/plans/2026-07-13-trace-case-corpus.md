# Trace Case Corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manifest-driven real and constructed Perfetto trace corpus under `Trace/`, migrate the six existing fixtures, enforce exact Skill/Strategy coverage, and provide reproducible build and release-regression commands.

**Architecture:** A Git-native catalog is the source of truth. Real cases retain captured binaries and evidence; constructed cases store declarative scenarios and small protobuf overlays that are composed with a real base trace into ignored build outputs. Generated indexes, a catalog resolver, and executable coverage expectations eliminate hard-coded fixture lists.

**Tech Stack:** Node.js 24 CommonJS tooling, `node:test`, JSON Schema-compatible validation, the repository's `protobufjs` and YAML dependencies, pinned `trace_processor_shell`, existing TypeScript Skill evaluator, Markdown/JSON generated indexes.

## Global Constraints

- The root directory is exactly `Trace/`, with separate `real/` and `constructed/` libraries.
- Existing unrelated changes remain untouched.
- Prompt content stays in strategies and deterministic SQL stays in Skills.
- No generated file is hand-edited; generators own `Trace/README.md`, sub-indexes, `catalog.json`, `coverage.json`, and overlay binaries.
- Public real cases require explicit license, consent/source, privacy review, and sanitization review.
- New real traces stage under ignored `Trace/real/.private/`; tracked private binaries are invalid.
- Coverage inventory is derived from current Skill YAML and Strategy frontmatter; counts are never hard-coded.
- Constructed output records Android compatibility, base hash, generator version, and trace-processor version.
- The existing project verification commands in `.claude/rules/testing.md` remain authoritative.

---

### Task 1: Corpus schemas and catalog validator

**Files:**
- Create: `Trace/schema/case.schema.json`
- Create: `Trace/schema/scenario.schema.json`
- Create: `Trace/tools/lib/catalog.cjs`
- Create: `Trace/tools/lib/hash.cjs`
- Create: `Trace/tools/__tests__/catalog.test.cjs`

**Interfaces:**
- Produces: `loadCatalog(repoRoot)`, `validateCatalog(repoRoot, options)`, `discoverCoverageTargets(repoRoot)`, and `resolveCaseTrace(repoRoot, selector)`.
- Consumes: `case.json` files under `Trace/real/*` and `Trace/constructed/*`.

- [ ] **Step 1: Write failing catalog tests**

Use `node:test` fixtures to assert duplicate ids, path traversal, missing files,
hash drift, invalid public provenance, stale coverage ids, missing Skill/Strategy
coverage, and legacy filename resolution. The positive fixture must contain one
real and one constructed case.

- [ ] **Step 2: Verify the tests fail for the missing module**

Run: `node --test Trace/tools/__tests__/catalog.test.cjs`

Expected: FAIL with `Cannot find module '../lib/catalog.cjs'`.

- [ ] **Step 3: Implement schemas, hashing, discovery, and validation**

Implement exact runtime inventory by parsing YAML `name` fields and Strategy
frontmatter ids/names. Validate explicit expectations, safe relative paths,
files/hashes, globally unique ids, case kind/directory agreement, construction
references, Android API/range consistency, and the public publication gate.

- [ ] **Step 4: Verify catalog tests pass**

Run: `node --test Trace/tools/__tests__/catalog.test.cjs`

Expected: PASS with zero failed tests.

### Task 2: Deterministic Perfetto overlay generator

**Files:**
- Create: `Trace/tools/lib/perfetto-proto.cjs`
- Create: `Trace/tools/lib/generator.cjs`
- Create: `Trace/tools/__tests__/generator.test.cjs`
- Create: `Trace/constructed/_templates/scenario.example.json`

**Interfaces:**
- Consumes: `buildCase(repoRoot, caseManifest, options)` and scenario JSON signal definitions.
- Produces: valid `trace.overlay.pftrace`, materialized base-plus-overlay trace, and `build-provenance.json`.

- [ ] **Step 1: Write failing generator tests**

Cover deterministic byte output, base-plus-overlay protobuf concatenation,
lossless 64-bit timestamps, non-conflicting identity allocation, incremental
state isolation, process/thread and slice packets, scheduler rows,
frame-timeline rows, counter rows, malformed scenario rejection, and changed
base/scenario hash detection.

- [ ] **Step 2: Verify generator tests fail**

Run: `node --test Trace/tools/__tests__/generator.test.cjs`

Expected: FAIL with missing generator module.

- [ ] **Step 3: Implement proto loading and signal builders**

Load `perfetto/protos/perfetto/trace/trace.proto` through `protobufjs` with a
repository-root import resolver. Implement focused builders for process trees,
ftrace/atrace, scheduler and blocked-reason events, Binder, TrackEvent slices,
frame timeline, counters, GPU, memory, power/thermal, input, Android logs,
media/network, and named pipeline tags.

- [ ] **Step 4: Implement materialization and parse verification**

Probe base bounds and existing identities with the pinned trace processor, place
scenario events inside the bounds, allocate deterministic non-conflicting ids,
encode isolated overlay sequences, concatenate protobuf bytes, reload the
combined trace, and emit hashes plus tool versions.

- [ ] **Step 5: Verify generator tests pass**

Run: `node --test Trace/tools/__tests__/generator.test.cjs`

Expected: PASS and the test-created trace contains the asserted SQL rows.

### Task 3: CLI, generated indexes, and safe real-case import

**Files:**
- Create: `Trace/tools/trace-corpus.cjs`
- Create: `Trace/tools/lib/indexer.cjs`
- Create: `Trace/tools/lib/import-real.cjs`
- Create: `Trace/tools/__tests__/cli.test.cjs`
- Generate: `Trace/README.md`
- Generate: `Trace/real/README.md`
- Generate: `Trace/constructed/README.md`
- Generate: `Trace/catalog.json`
- Generate: `Trace/coverage.json`

**Interfaces:**
- Produces CLI commands `validate`, `index`, `build`, `import-real`, `promote-real`, `resolve`, and `coverage`.
- Consumes catalog and generator interfaces from Tasks 1-2.

- [ ] **Step 1: Write failing CLI/import/index tests**

Assert deterministic index order, Android matrix rendering, ignored
private-by-default imports, explicit promotion gates, rejection of tracked
private cases, copied result/log files, atomic failure cleanup, trace metadata
probe, and `index --check` stale-file detection.

- [ ] **Step 2: Verify CLI tests fail**

Run: `node --test Trace/tools/__tests__/cli.test.cjs`

Expected: FAIL with missing CLI/helper modules.

- [ ] **Step 3: Implement the CLI and staged import**

Use an adjacent temporary directory, compute hashes, probe the trace, write a
private draft manifest under `Trace/real/.private/`, validate, and rename.
Promotion is a second explicit operation and never fills approval fields from
implicit defaults.

- [ ] **Step 4: Implement generated indexes and check mode**

Render links, scenes, Android/API ranges, publication state, base case,
coverage targets, results, and logs. Put a generated-file banner in every owned
artifact and compare bytes in `--check` mode.

- [ ] **Step 5: Verify CLI tests pass**

Run: `node --test Trace/tools/__tests__/cli.test.cjs`

Expected: PASS with zero failed tests.

### Task 4: Migrate the six real traces without losing evidence

**Files:**
- Move: `test-traces/launch_light.pftrace` and report into `Trace/real/android-startup-light/`
- Move: `test-traces/lacunh_heavy.pftrace` and report into `Trace/real/android-startup-heavy/`
- Move: `test-traces/scroll_Standard-AOSP-App-Without-PreAnimation.pftrace` and report into `Trace/real/android-scroll-standard/`
- Move: `test-traces/scroll-demo-customer-scroll.pftrace` and report into `Trace/real/android-scroll-customer/`
- Move: `test-traces/Scroll-Flutter-327-TextureView.pftrace` and report into `Trace/real/flutter-scroll-texture-view/`
- Move: `test-traces/Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace` and report into `Trace/real/flutter-scroll-surface-view/`
- Create: one `case.json` per directory

**Interfaces:**
- Produces six real case ids and legacy filename aliases.
- Consumes `import-real`/catalog metadata rules.

- [ ] **Step 1: Add a failing migration fixture test**

Extend catalog tests to require all six legacy filenames to resolve, all six
trace hashes to match their manifests, and each historical FPS report to be
listed as an analysis result.

- [ ] **Step 2: Verify the migration test fails against the flat directory**

Run: `node --test Trace/tools/__tests__/catalog.test.cjs`

Expected: FAIL because the six manifests do not exist.

- [ ] **Step 3: Probe metadata and move files with Git history**

Use `git mv`, keep original binary filenames as `trace.pftrace`, retain the
original report basename under `analysis/`, and write factual metadata only.
Unknown capture metadata remains `null`; logs remain `[]`.

- [ ] **Step 4: Generate indexes and verify migration tests**

Run: `node Trace/tools/trace-corpus.cjs index && node --test Trace/tools/__tests__/catalog.test.cjs`

Expected: PASS; the generated real index contains six entries.

### Task 5: Constructed scenario families and exact coverage assignment

**Files:**
- Create under `Trace/constructed/`: case directories for scheduler contention, startup, frame/jank, input latency, Binder/I/O, memory pressure, power/thermal, GPU, system state, Linux runtime, media/network/camera, and framework rendering pipelines.
- Create per directory: `case.json`, `scenario.json`, `trace.overlay.pftrace`, `analysis/expected.json`.

**Interfaces:**
- Produces explicit assignment for every discovered runtime Skill and Strategy.
- Consumes generator signal families and case expectation schema.

- [ ] **Step 1: Add a failing 100% coverage assertion**

The test computes current inventory and asserts `missing.skills`,
`missing.strategies`, `stale.skills`, and `stale.strategies` are empty and every
target has an executable expectation.

- [ ] **Step 2: Verify the coverage assertion reports the complete missing set**

Run: `node --test Trace/tools/__tests__/catalog.test.cjs --test-name-pattern='coverage'`

Expected: FAIL and list the current uncovered ids without a hard-coded count.

- [ ] **Step 3: Add scenarios and explicit target assignments by evidence family**

Each case gets a single diagnostic purpose, stable fixture process/thread ids,
Android compatibility, required parameters, and predicates that distinguish a
real signal from graceful-empty execution. Strategy cases include routing query
fixtures and required trace evidence.

- [ ] **Step 4: Build all constructed cases**

Run: `node Trace/tools/trace-corpus.cjs build --all`

Expected: every overlay and combined trace is parseable; provenance hashes are
written under `Trace/.generated/`.

- [ ] **Step 5: Verify exact 100% inventory coverage**

Run: `node Trace/tools/trace-corpus.cjs coverage --check`

Expected: PASS with no missing/stale target and all expectations executable.

### Task 6: Execute Skill and Strategy regression expectations

**Files:**
- Create: `backend/tests/trace-corpus/trace_corpus_regression.ts`
- Create: `backend/tests/trace-corpus/trace_corpus_strategy_regression.test.ts`
- Modify: `backend/tests/skill-eval/runner.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Produces `npm run trace:validate`, `trace:build`, `trace:test`, and `trace:regression`.
- Consumes case selectors, per-Skill parameters, and predicates from `case.json`.

- [ ] **Step 1: Write failing runner tests**

Assert catalog resolution, one-load/many-Skill execution, parameter token
resolution, required-step checks, row/value predicates, graceful-empty checks,
strategy routing fixtures, and per-case result/log persistence.

- [ ] **Step 2: Verify runner tests fail**

Run: `cd backend && npx jest --runInBand tests/trace-corpus/trace_corpus_strategy_regression.test.ts`

Expected: FAIL because the corpus runner is absent.

- [ ] **Step 3: Implement the deterministic regression runner**

Reuse `SkillEvaluator`; load each materialized trace once, execute all assigned
Skills, evaluate manifest predicates, and write evidence without changing chat,
report, or snapshot contracts. Strategy tests use the real loader/classifier.

- [ ] **Step 4: Run the full corpus regression**

Run: `cd backend && npm run trace:regression`

Expected: PASS for all catalog cases and expectations.

### Task 7: Remove legacy path coupling and integrate repository gates

**Files:**
- Modify: all non-archived source/test/script files that directly reference `test-traces/`
- Modify: `scripts/e2e/dual-trace-e2e-paths.cjs`
- Modify: `.github/workflows/backend-agent-regression-gate.yml`
- Modify: `package.json`
- Modify: `backend/package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces one catalog-based fixture resolver for TS/CJS/shell callers.
- Consumes real case ids and legacy aliases from Task 4.

- [ ] **Step 1: Add a failing no-legacy-reference check**

Catalog validation scans maintained source paths and rejects new direct
`test-traces/` references, excluding archived historical documentation.

- [ ] **Step 2: Verify it fails and lists current callers**

Run: `node Trace/tools/trace-corpus.cjs validate`

Expected: FAIL with the maintained files that still use legacy paths.

- [ ] **Step 3: Migrate callers and package scripts**

Replace filename arrays with catalog selectors/resolution. Add root wrappers and
backend commands without changing existing scene regression behavior.

- [ ] **Step 4: Add gate and path-filter integration**

Run fast catalog validation in backend `verify:pr`. Trigger the regression
workflow for `Trace/**`, Skills, Strategies, corpus tools, and resolver changes.

- [ ] **Step 5: Verify legacy coupling is gone**

Run: `node Trace/tools/trace-corpus.cjs validate`

Expected: PASS with no maintained direct `test-traces/` references.

### Task 8: Documentation, build, regression, and completion audit

**Files:**
- Modify: `docs/getting-started/quick-start.md`
- Modify: `docs/getting-started/quick-start.en.md`
- Modify: `.claude/rules/testing.md`
- Regenerate: all Trace indexes and reports

**Interfaces:**
- Documents real-case ingest, constructed-case authoring, Android versioning,
  privacy/publication gates, CI/release commands, and result/log locations.

- [ ] **Step 1: Generate and check all owned artifacts**

Run: `node Trace/tools/trace-corpus.cjs index && node Trace/tools/trace-corpus.cjs validate --check-generated`

Expected: PASS with no stale generated file.

- [ ] **Step 2: Run focused corpus tests and existing six-case regressions**

Run: `node --test Trace/tools/__tests__/*.test.cjs`

Run: `cd backend && npm run test:scene-trace-regression && npm run test:state-timeline-regression && npm run trace:regression`

Expected: all commands exit 0 and preserve per-case evidence.

- [ ] **Step 3: Run project build and PR verification**

Run: `cd backend && npm run build`

Run: `npm run verify:pr`

Expected: both commands exit 0.

- [ ] **Step 4: Simplify and review only changed code**

Use the available project simplifier; if unavailable, perform an architectural
self-review, then run `git diff --check`. Confirm there is no duplicated catalog,
hard-coded inventory count, generated-file hand edit, or unrelated rewrite.

- [ ] **Step 5: Audit every original requirement against current evidence**

Check dual `Trace/` libraries, six migrated real cases, future atomic import,
results/log preservation, generated README indexes, reproducible constructed
traces, exact Skill/Strategy coverage, extension/version mechanics, Android
matrix, release regression, build, and tests. Any missing or indirect evidence
keeps the goal active.
