# Upstream Skill Gap Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Perfetto-Skills from marking official upstream files covered by path-prefix policy and synchronize completed SmartPerfetto evidence Skills with immutable paired provenance.

**Architecture:** Every official file is classified only by an exact `(path, sha256)` reviewed decision. Decisions carry reason, local path, test id, and reviewed source commit where applicable. After SmartPerfetto implementation is committed, the public projection is regenerated and both repositories run independent gates.

**Tech Stack:** Python 3.12, unittest, JSON locks/reports, `uv`, Perfetto-Skills exporter/compiler, SmartPerfetto cross-repository impact gates.

## Global Constraints

- Work on the existing `../Perfetto-Skills` feature branch without resetting it.
- No directory-prefix outcome inference.
- `already_covered` and `adopted` require local path, test id, and exact source commit.
- `not_applicable` requires a concrete reason, not a fabricated implementation.
- Do not update the SmartPerfetto lock until SmartPerfetto HEAD is committed.

---

### Task 1: Exact-hash decision model

**Files:**
- Modify: `../Perfetto-Skills/tools/sync_official_skill.py`
- Modify: `../Perfetto-Skills/tests/unit/test_official_skill_sync.py`
- Modify: `../Perfetto-Skills/upstreams/official-skill-decisions.json`
- Modify: `../Perfetto-Skills/docs/maintenance/upstream-sync.md`

**Interfaces:**
- Consumes: exact path/SHA decision entries.
- Produces: structured `ReviewedDecision` values and file-by-file classifications.

- [ ] **Step 1: Write failing false-positive tests**

```py
def test_unchanged_file_without_exact_decision_stays_pending(self):
    path = "ai/skills/perfetto/workflows/android_memory/new.md"
    snapshot = {"files": [{"path": path, "sha256": "a" * 64}]}
    report = build_gap_report(snapshot, snapshot, {})
    self.assertEqual(report["classifications"], [
        {"path": path, "outcome": "pending_review"}
    ])

def test_exact_hash_decision_applies_with_evidence(self):
    decision = {
        "outcome": "already_covered",
        "reason": "Implemented as deterministic SmartPerfetto evidence",
        "local_path": "backend/skills/composite/example.skill.yaml",
        "test_id": "execute-example",
        "reviewed_source_commit": "b" * 40,
    }
    report = build_gap_report(snapshot, snapshot, {(path, "a" * 64): decision})
    self.assertEqual(report["classifications"][0]["outcome"], "already_covered")
```

- [ ] **Step 2: Run RED**

Run: `cd ../Perfetto-Skills && uv run python -m unittest tests.unit.test_official_skill_sync -v`

Expected: FAIL because unchanged files inherit path-prefix outcomes and decisions return strings.

- [ ] **Step 3: Replace prefix policy with structured exact decisions**

```py
class ReviewedDecision(TypedDict):
    outcome: str
    reason: str
    local_path: NotRequired[str]
    test_id: NotRequired[str]
    reviewed_source_commit: NotRequired[str]
```

`build_gap_report(previous, current, reviewed_decisions)` defaults every current
or removed file to `pending_review`, then applies only the exact path/hash
decision. Copy evidence fields into the report. Delete `local_contract` and its
prefix loop.

- [ ] **Step 4: Strengthen decision validation**

Require `local_path`, `test_id`, and 40-character lowercase hex source commit
for `adopted`/`already_covered`. Require a non-empty reason for every outcome.
Reject unknown keys, duplicate pairs, pending outcomes, and malformed hashes.

- [ ] **Step 5: Run GREEN**

Run: `cd ../Perfetto-Skills && uv run python -m unittest tests.unit.test_official_skill_sync -v`

Expected: PASS, including unchanged-file regression.

- [ ] **Step 6: Populate exact decisions for the pinned snapshot**

Heap clustering references the committed SmartPerfetto extraction/batch paths
and memory semantic fixture. Generic GPU compute references its Skill and GPU
fixture. NVIDIA counter files remain `not_applicable` with a precise fixture/
schema reason. Bootstrap docs need concrete local runtime paths and test ids.

- [ ] **Step 7: Document and commit**

```bash
git -C ../Perfetto-Skills add tools/sync_official_skill.py tests/unit/test_official_skill_sync.py upstreams/official-skill-decisions.json docs/maintenance/upstream-sync.md
git -C ../Perfetto-Skills commit -m "fix: require evidence for official Skill coverage"
```

### Task 2: Regenerate paired projection and prove both repositories

**Files:**
- Modify: `../Perfetto-Skills/upstreams/smartperfetto.lock.json`
- Regenerate: `../Perfetto-Skills/upstreams/reports/official-skill-gap.json`
- Regenerate: public references/catalogs selected by the exporter/compiler

**Interfaces:**
- Consumes: exact committed SmartPerfetto HEAD.
- Produces: immutable public projection and zero-unresolved official report.

- [ ] **Step 1: Verify committed paired source**

Run:

```bash
smart_ref="$(git rev-parse HEAD)"
test "${#smart_ref}" -eq 40
git diff --check
```

Expected: exact commit exists; every unrelated worktree change remains
unstaged.

- [ ] **Step 2: Dry-run and apply SmartPerfetto import**

Run:

Create a temporary detached worktree from the committed SmartPerfetto ref so
the importer receives the exact clean source even when the primary worktree
contains unrelated user changes:

```bash
smart_repo="$(git rev-parse --show-toplevel)"
smart_ref="$(git rev-parse HEAD)"
smart_source="$(mktemp -d)/SmartPerfetto"
git worktree add --detach "$smart_source" "$smart_ref"
cd ../Perfetto-Skills
uv run python tools/sync_smartperfetto.py --source "$smart_source" --commit "$smart_ref" --report-dir test-output/sync
uv run python tools/sync_smartperfetto.py --source "$smart_source" --commit "$smart_ref" --report-dir test-output/sync --apply
uv run python tools/compile_skill.py --apply
```

Expected: only reviewed deltas and a lock equal to exact SmartPerfetto HEAD.
Remove the detached worktree after all paired gates complete with
`git -C "$smart_repo" worktree remove "$smart_source"`.

- [ ] **Step 3: Apply official gap report**

Run:

```bash
uv run python tools/sync_official_skill.py --perfetto ../SmartPerfetto/perfetto --report-dir test-output/sync --apply
```

Expected: exit 0; heap clustering and generic GPU compute have structured evidence; NVIDIA stays explicitly not applicable.

- [ ] **Step 4: Run public focused and complete gates**

Run:

```bash
uv run python -m unittest tests.unit.test_official_skill_sync tests.unit.test_smartperfetto_sync tests.unit.test_generated_references -v
uv run python tools/compile_skill.py --check
uv run python tools/validate_all_queries.py
uv run python tools/verify.py
```

Expected: all commands exit 0 with locked processor and owned fixtures.

- [ ] **Step 5: Record public paired impact**

```bash
uv run python tools/check_cross_repo_impact.py --repository perfetto-skills --base "$(git merge-base HEAD origin/main)" --decision required --reason "Official Skill coverage and portable SmartPerfetto evidence changed" --paired-path ../SmartPerfetto --paired-ref "$(git -C ../SmartPerfetto rev-parse HEAD)"
```

- [ ] **Step 6: Commit public regeneration**

Review `test-output/sync` and `git diff --name-status`, write the exact approved
generated file paths to a NUL-delimited staging list, and stage only that list;
do not stage a directory prefix:

```bash
xargs -0 git -C ../Perfetto-Skills add -- < test-output/sync/approved-generated-paths.zlist
git -C ../Perfetto-Skills diff --cached --check
git -C ../Perfetto-Skills commit -m "chore: sync SmartPerfetto AI evidence skills"
```

- [ ] **Step 7: Verify the paired projection from SmartPerfetto**

Run:

```bash
cd ../SmartPerfetto
npm run check:perfetto-skills-impact -- --base "$(git merge-base HEAD origin/main)" --decision required --reason "Portable extraction and GPU compute evidence were regenerated" --paired-path ../Perfetto-Skills --paired-ref "$(git -C ../Perfetto-Skills rev-parse HEAD)"
npm run verify:public-skills
npm run verify:pr
```

Expected: both paired checks and SmartPerfetto PR gate pass.
