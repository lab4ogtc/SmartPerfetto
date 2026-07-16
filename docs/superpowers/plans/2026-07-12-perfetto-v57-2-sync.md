# Perfetto v57.2 Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the SmartPerfetto Perfetto fork, runtime pin, committed prebuilts, and committed frontend metadata from official `v57.1` to official stable `v57.2`, then push the submodule and root repository in reachability-safe order.

**Architecture:** Treat the upgrade as one product-level version alignment across the forked source, native trace processor runtime, and committed user/Docker frontend. Merge the official stable tag into the fork without rebasing or rewriting SmartPerfetto history, regenerate only artifacts whose source or version identity changes, and preserve the AI Assistant plugin and provider/runtime semantics.

**Tech Stack:** Git submodules, Google Perfetto, Node.js 24, TypeScript, shell scripts, Perfetto bundled pnpm/build tooling.

## Global Constraints

- Official target is the fetched annotated tag `v57.2`, which resolves to `da1d152cff27890903d158fe96751de3aab883cc`; the tag has no GPG signature, so verify it by fetched upstream ref and exact object ID. Do not merge unpublished `origin/main` commits.
- Preserve all SmartPerfetto AI Assistant plugin entry points and Provider Manager/runtime pinning behavior.
- Never push SmartPerfetto changes to the submodule `origin`; push the fork commit to `fork` first.
- Do not hand-edit generated frontend bundles or committed native binaries.
- Keep unrelated root and submodule changes untouched. The observed starting worktrees were clean, but concurrent changes appeared under `backend/skills/**`, `backend/src/services/skillEngine/**`, and `.gitignore` after baseline verification; exclude them from this sync commit.
- Run only verification commands defined by this repository's rules and scripts.

---

### Task 1: Merge Official Perfetto v57.2 Into the Fork

**Files:**
- Modify through merge: `perfetto/CHANGELOG`
- Modify through merge: `perfetto/src/trace_processor/util/descriptors.cc`
- Modify through merge: `perfetto/src/trace_processor/util/descriptors_unittest.cc`

**Interfaces:**
- Consumes: current `perfetto/main` at `1248e1f41b6f4411294b39baa0e881f4a1dc28d4` and official tag `v57.2`.
- Produces: a merge commit on `perfetto/main` that contains `v57.2` and all existing SmartPerfetto fork commits.

- [ ] **Step 1: Reconfirm clean state and immutable target**

Run:

```bash
git status --short --branch
git -C perfetto status --short --branch
git -C perfetto rev-parse 'v57.2^{commit}'
git -C perfetto ls-remote origin 'refs/tags/v57.2' 'refs/tags/v57.2^{}'
git -C perfetto log -3 --oneline v57.1..v57.2
```

Expected: both worktrees clean, the peeled tag resolves locally and remotely to `da1d152cff27890903d158fe96751de3aab883cc`, and the range contains exactly three official commits.

- [ ] **Step 2: Merge the official stable tag**

Run:

```bash
git -C perfetto merge --no-ff v57.2 -m "Merge Perfetto v57.2"
```

Expected: a merge commit; the preflight `merge-tree` check predicts no textual conflicts. If Git reports conflicts, resolve each as a dual-intent merge, preserving upstream behavior and SmartPerfetto custom behavior, then inspect every resolution before committing.

- [ ] **Step 3: Verify merge ancestry and SmartPerfetto plugin presence**

Run:

```bash
git -C perfetto merge-base --is-ancestor v57.2 HEAD
test -f perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/index.ts
rg -n "com\.smartperfetto\.AIAssistant" perfetto/ui/src
git -C perfetto diff --check HEAD^1..HEAD
```

Expected: all commands exit zero and the plugin remains registered.

### Task 2: Align the Trace Processor Runtime Pin and Committed Prebuilts

**Files:**
- Modify: `scripts/trace-processor-pin.env`
- Modify: `start.sh`
- Regenerate: `backend/prebuilts/trace_processor/linux-x64/trace_processor_shell`
- Regenerate: `backend/prebuilts/trace_processor/darwin-arm64/trace_processor_shell`
- Regenerate: `backend/prebuilts/trace_processor/win32-x64/trace_processor_shell.exe`

**Interfaces:**
- Consumes: official LUCI artifacts under `perfetto-luci-artifacts/v57.2`.
- Produces: one version/SHA contract shared by local start, Docker, CLI, CI, and portable packaging.

- [ ] **Step 1: Update the v57.2 pin values**

Set `PERFETTO_VERSION=v57.2` and use these freshly downloaded SHA256 values:

```text
linux-amd64   55ba613fc6d4f71df81eee2dbfc293020063655c241b3e314bff75345b802684
linux-arm64   1dcc1d9aaff2eb92e8bc58f1957e4e445600294bd61dbc09345c1018c5ff0868
mac-amd64     c0f61397901da47cbe1bb9a0843624f7c2038ac92176ce15e3736ce9aa0afef0
mac-arm64     98a41b80e9f60da0373d64aff6455681f8c26b7c391ae5736324a5b11e3dacc2
windows-amd64 100334b6091596fbc97f872556849a5747bf47a7f7190c485ba8cea8d2409c7b
```

Update the defensive fallback values in `start.sh` to the same version and platform hashes so a source checkout cannot silently download v57.1 when the pin file is unavailable.

- [ ] **Step 2: Regenerate committed prebuilts with the repository script**

Run:

```bash
npm run trace-processor:sync-prebuilts
```

Expected: Linux x64, macOS arm64, and Windows x64 binaries are downloaded, SHA-verified, executable, and replaced.

- [ ] **Step 3: Verify pin and binary identity**

Run:

```bash
shasum -a 256 backend/prebuilts/trace_processor/linux-x64/trace_processor_shell
shasum -a 256 backend/prebuilts/trace_processor/darwin-arm64/trace_processor_shell
shasum -a 256 backend/prebuilts/trace_processor/win32-x64/trace_processor_shell.exe
backend/prebuilts/trace_processor/darwin-arm64/trace_processor_shell --version
```

Expected: hashes match the v57.2 pin and the native binary reports a v57.2 build.

### Task 3: Refresh the Committed Perfetto Frontend

**Files:**
- Regenerate: `frontend/index.html`
- Regenerate: `frontend/service_worker.js` when emitted differently
- Regenerate: `frontend/assets/**` when emitted differently
- Replace: `frontend/v57.1-1248e1f41/**` with the single generated `frontend/v57.2-<merge-sha>/**` directory
- Update gitlink: `perfetto`

**Interfaces:**
- Consumes: merged Perfetto fork source and existing SmartPerfetto static assistant assets.
- Produces: the committed frontend used by `./start.sh`, Docker, and portable packages.

- [ ] **Step 1: Confirm and stop stale UI build processes**

Inspect live processes and `perfetto/out/ui/watch.lock`. Stop only confirmed stale/live Perfetto UI watcher processes using the repository's `./scripts/stop-dev.sh`; never remove a held lock.

- [ ] **Step 2: Build native tests and both WebAssembly engines with Perfetto-supported tooling**

`v57.2` changes `descriptors.cc`, which is compiled into the native trace processor, classic wasm, and memory64 wasm. Build without `--no-wasm` so the new committed directory cannot silently retain v57.1 engines:

```bash
cd perfetto
./tools/node ui/build.mjs --no-depscheck
tools/ninja -C out/ui perfetto_unittests
out/ui/perfetto_unittests --gtest_brief=1 --gtest_filter='DescriptorsTest.*'
```

Expected: the full UI build emits classic and memory64 wasm and the descriptor compatibility unit tests pass.

- [ ] **Step 3: Start the built artifacts and verify the AI Assistant UI contract**

Run:

```bash
./scripts/start-dev.sh --quick
```

Open `http://localhost:10000`, load a trace, confirm the SmartPerfetto AI Assistant entry point appears, and verify Provider Manager still loads without changing provider selection semantics.

- [ ] **Step 4: Rebuild the complete dist after dev-server verification**

`start-dev.sh --quick` starts Perfetto's watch server, which recreates `out/ui/ui/dist` with a memory64-focused build. After stopping dev services, rerun the complete build so `frontend_bundle.js`, classic wasm, and memory64 wasm all come from v57.2:

```bash
cd perfetto
./tools/node ui/build.mjs --no-depscheck
```

- [ ] **Step 5: Refresh the committed prebuild**

Run:

```bash
./scripts/update-frontend.sh
npm run check:frontend-prebuild
shasum -a 256 frontend/v57.2-*/trace_processor.wasm frontend/v57.2-*/trace_processor_memory64.wasm
```

Expected: exactly one `frontend/v57.2-*` directory exists, `frontend/index.html` points to it, required wasm/JS/manifest/static assistant assets exist, and the prebuild checker exits zero. The classic wasm hash must differ from old v57.1 hash `2ad119d0b71ee17b01db76546b18da128204dd8c4c66d1a65f9066e447b2e884`; memory64 must differ from `65392050e18e25bce9c1f73fd14f41a1bc8c47657750c8400c21cab472bf73c9`.

- [ ] **Step 6: Keep unrelated generated knowledge unchanged**

Run:

```bash
git -C perfetto diff --quiet v57.1..v57.2 -- ui/src/trace_processor/perfetto_sql/stdlib
git -C perfetto diff --quiet v57.1..v57.2 -- src/trace_processor/perfetto_sql/stdlib
```

Expected: no stdlib changes. Do not rewrite `backend/data/perfettoSqlDocs.json`, SQL indexes, stdlib symbols, Skills, or Strategies when their source inputs did not change.

### Task 4: Verify, Review, Commit, and Push in Reachability-Safe Order

**Files:**
- Review all files changed by Tasks 1-3.
- Commit the root plan: `docs/superpowers/plans/2026-07-12-perfetto-v57-2-sync.md`.

**Interfaces:**
- Consumes: merged fork source and regenerated root artifacts.
- Produces: reachable fork commit followed by a root commit whose gitlink and artifacts are safe for users and CI.

- [ ] **Step 1: Run simplification review**

No code simplifier entry is configured by the repository for this generated/vendor-heavy sync. Perform a manual behavior-preserving simplification review of only `start.sh` and `scripts/trace-processor-pin.env`, then run:

```bash
git diff --check
git -C perfetto diff --check HEAD^1..HEAD
```

Expected: no whitespace errors and no unnecessary handwritten changes.

- [ ] **Step 2: Run the Perfetto sync verification tier**

Run from the repository root:

```bash
npm run check:frontend-prebuild
npm --prefix backend run cli:e2e
cd backend && npm run test:scene-trace-regression
```

Then run the repository's full pre-landing gate:

```bash
npm run verify:pr
```

Expected: the repository's required `verify:pr`, frontend prebuild check, and six-scene regression exit zero. The standalone `cli:e2e` currently has a pre-existing clean-checkout failure: `ProviderManager` writes its env-fallback diagnostic to JSON stdout. The identical failure was reproduced on the old `fb2c84db` / v57.1 baseline, so record it without expanding this Perfetto sync into an unrelated CLI logging fix. Skill/Strategy validation is covered by `verify:pr`; no Skill/Strategy files should change.

- [ ] **Step 3: Perform independent post-diff review**

Review release risk, generated assets, trace processor pins, submodule ancestry/reachability, AI Assistant registration, Provider Manager semantics, and staging scope. Revise any confirmed issue and rerun affected verification.

- [ ] **Step 4: Push the submodule commit first**

Run:

```bash
git -C perfetto push fork main
test "$(git -C perfetto rev-parse HEAD)" = "$(git -C perfetto ls-remote fork refs/heads/main | awk '{print $1}')"
git -C perfetto branch -r --contains HEAD
```

Expected: `fork/main` resolves to the local submodule HEAD and contains the merge commit.

- [ ] **Step 5: Commit and push the root repository**

Stage only the plan, `perfetto` gitlink, trace processor pin/fallback, regenerated prebuilts, and regenerated frontend. Inspect staged status and diff, then run:

```bash
git add docs/superpowers/plans/2026-07-12-perfetto-v57-2-sync.md \
  perfetto scripts/trace-processor-pin.env start.sh \
  backend/prebuilts/trace_processor
git add -A frontend
git status --short
git diff --cached --stat
git diff --cached --check
git commit -m "chore: sync Perfetto v57.2"
git push origin main
test "$(git rev-parse HEAD)" = "$(git ls-remote origin refs/heads/main | awk '{print $1}')"
```

Expected: root `origin/main` advances to the new commit only after the referenced submodule commit is reachable from `fork`.

- [ ] **Step 6: Verify final remote state**

Run:

```bash
git status --short --branch
git -C perfetto status --short --branch
git rev-parse HEAD
git ls-remote origin refs/heads/main
git -C perfetto rev-parse HEAD
git -C perfetto ls-remote fork refs/heads/main
```

Expected: both local branch heads match their pushed remote branch heads and the submodule worktree is clean. The root worktree may remain dirty only because the preserved concurrent `.gitignore`, `backend/skills/**`, `backend/src/services/skillEngine/**`, and `backend/skills/public-fixtures.yaml` changes are intentionally excluded from this commit.
