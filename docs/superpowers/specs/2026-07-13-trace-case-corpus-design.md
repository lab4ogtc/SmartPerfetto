# Trace Case Corpus Design

## Purpose

SmartPerfetto needs two source-controlled trace libraries under `Trace/`:

1. A real-case library that preserves a representative trace together with its
   analysis result, analysis logs, provenance, Android metadata, and a public
   index.
2. A constructed-case library that deterministically adds targeted Perfetto
   packets to a real base trace, producing repeatable regression fixtures for
   every runtime Skill and Strategy.

The corpus is a test and publication asset. It is deliberately separate from
`backend/knowledge/cases/`, whose Markdown files are recallable diagnostic
knowledge rather than binary trace fixtures.

## Considered Approaches

### Flat folders of trace files

This would be easy to start but would preserve the current hard-coded coupling
between six filenames and individual tests. It cannot prove coverage, capture
provenance, or keep README indexes correct as the corpus grows.

### Database or object-store catalog

This would scale to private enterprise data, but it would make GitHub review,
offline use, and deterministic releases harder. It is not the right primary
format for a public reference corpus.

### Selected: Git-native manifests plus reproducible overlays

Each case is a directory with a versioned `case.json`. Real cases contain the
captured trace and evidence files. Constructed cases contain a declarative
scenario and a small valid Perfetto overlay trace. The build tool concatenates
the base `Trace` protobuf and overlay `Trace` protobuf into a materialized trace;
protobuf repeated packet fields make the concatenation valid, while avoiding
dozens of copies of the same large base trace in Git.

Generated indexes and a coverage report are derived from manifests. No test or
documentation surface owns a second hard-coded case list.

## Repository Layout

```text
Trace/
  README.md                         generated public index and usage
  catalog.json                     generated machine-readable catalog
  coverage.json                    generated Skill/Strategy coverage report
  schema/
    case.schema.json
    scenario.schema.json
  real/
    README.md                       generated real-case index
    .private/                       ignored local staging for new imports
    <case-id>/
      case.json
      trace.pftrace
      analysis/
        result.*
        logs/*
  constructed/
    README.md                       generated constructed-case index
    <case-id>/
      case.json
      scenario.json
      trace.overlay.pftrace
      analysis/expected.json
  tools/
    trace-corpus.cjs
    lib/*.cjs
    __tests__/*.test.cjs
  .generated/                       ignored materialized combined traces/logs
```

`Trace/.generated/constructed/<case-id>/trace.pftrace` is the directly openable
base-plus-overlay output. Release automation may archive this directory, but it
is not committed.

## Case Contract

Every `case.json` has these stable sections:

- `schema_version`, `id`, `kind`, `title`, `description`, `scene`, and `tags`.
- `trace`: committed source filename, SHA-256, format, and materialization mode.
- `android`: release, API level, device/build metadata, and an optional tested
  compatibility range.
- `source`: origin, capture/import time, license, consent, sanitization review,
  and publication state.
- `analysis`: result files and log files that must exist.
- `coverage`: explicit Skill ids, Strategy ids, and executable expectations.
- `construction` for constructed cases: base case id, scenario filename,
  generator version, deterministic seed, and output path.

IDs are lowercase kebab-case and globally unique. Paths are relative, cannot
escape their case directory, and are checked for exact filename case.

## Real-Case Ingest Flow

`node Trace/tools/trace-corpus.cjs import-real ...` performs an atomic staged
import. It computes hashes, probes trace bounds and Android metadata with the
pinned `trace_processor_shell`, copies the trace/results/logs, writes the
manifest, validates the full catalog, and regenerates indexes.

Imports default to `private/draft` under ignored `Trace/real/.private/`; they do
not enter the tracked catalog or generated public index. A separate explicit
promotion command moves a case into the tracked library only when its manifest
has a redistributable license, source/consent record, completed privacy review,
and completed sanitization review. Validation rejects tracked private cases and
public cases without those fields. This prevents an accidental `git add` from
publishing app, device, path, account, or logcat data.

The six existing `test-traces/` fixtures are migrated with history-preserving
`git mv`. Their existing FPS reports become analysis results. Missing historical
analysis logs are represented as an empty list, not fabricated evidence. Since
the binaries already exist in Git history, their manifests record that legacy
publication fact while leaving unknown consent/license/privacy fields unknown;
the index must not misrepresent them as newly approved public examples.

## Constructed Trace Model

The generator loads Perfetto's checked-in `.proto` graph through the repository's
existing `protobufjs` dependency. It emits packets for the declared signal
families, including process/thread trees, atrace/TrackEvent slices, scheduler
switches and blocked reasons, Binder transactions, frame-timeline events,
counters, GPU work, memory pressure, power/thermal state, input, media/network,
and framework/pipeline tags.

Scenario timestamps are relative to a safe anchor inside the base trace. The
builder probes the base bounds, translates relative timestamps, writes a valid
overlay, concatenates it with the base, and then verifies the combined trace by
loading it with the pinned `trace_processor_shell`. Every build records base,
scenario, overlay, output, generator, and trace-processor hashes/versions.

All timestamps and protobuf `int64`/`uint64` values remain decimal strings or
`Long` values until encoding; JavaScript `number` is forbidden for nanosecond
timestamps. Before generation, the builder queries existing pids/tids, packet
sequence ids where observable, and track ids/UUIDs, then deterministically
allocates non-conflicting synthetic identities. Overlay packets clear
incremental state and use their own trusted sequence so they cannot inherit or
corrupt the base trace's interned data.

Constructed cases are grouped by one diagnostic behavior, not by implementation
file. A case may cover several Skills that consume the same evidence family,
but every Skill and Strategy id is listed explicitly. New source files are not
covered by a wildcard: adding one makes the coverage gate fail until a maintainer
assigns it to an executable case.

## Coverage Semantics

Coverage is computed from current repository truth:

- Runtime Skills are discovered from `backend/skills/**/*.skill.yaml`, excluding
  authoring templates and using the YAML `name` as the stable runtime id.
- Strategies are discovered from `backend/strategies/*.strategy.md` frontmatter.
- A target counts as covered only when exactly one or more case manifests list
  it and at least one executable expectation references it.
- Skill expectations execute the real Skill engine and assert success, required
  steps, row/value predicates, or an explicit graceful-empty contract.
- Strategy expectations assert deterministic routing inputs plus required
  trace evidence. Provider-backed end-to-end analysis is a separate optional
  release tier and cannot replace deterministic coverage.

`coverage.json` reports covered, duplicate, and missing targets. `validate`
fails on any missing target, stale target, missing expectation, hash drift,
schema error, stale generated index, or unparseable trace. This is the meaning
of 100% corpus coverage; it is not a raw line-coverage percentage.

## Regression and Release Flow

- `npm run trace:validate`: manifests, hashes, publication gates, indexes, and
  exact Skill/Strategy inventory coverage.
- `npm run trace:build`: regenerate every overlay and materialized trace, then
  verify parseability and provenance.
- `npm run trace:test`: execute deterministic case expectations and preserve
  per-case JSON results plus logs under `Trace/.generated/`.
- `npm run trace:regression`: validate, build, and test the complete corpus.

The backend PR gate runs `trace:validate` and the existing six-case scene
regression through the catalog resolver. Full corpus regression is suitable for
release and explicit corpus changes. CI path filters include `Trace/**`, the
corpus tools, Skills, and Strategies.

## Compatibility and Migration

Tests resolve fixtures by case id or legacy filename through one catalog helper.
There is no compatibility symlink because repository symlinks are unreliable on
Windows. Direct `test-traces/...` references are migrated to the helper or new
catalog path. A validation scan rejects new legacy references.

Android versions are data, not directory names. A case can declare an exact
capture API level and a tested min/max range. When behavior differs by Android
version, separate case ids share a scenario family and declare non-overlapping
version ranges; the index renders the matrix.

## Failure Handling

All write commands use a temporary staging directory and rename only after a
complete validation. Generated output is disposable. A failed probe, generator,
Skill, or expectation leaves source cases untouched and writes a diagnostic log
with command, exit code, and stderr. Hash or provenance mismatches are fatal.
Signals that cannot be expressed faithfully with the checked-in Perfetto schema
are rejected as unsupported generator capabilities; a tag-only substitute does
not count as semantic coverage for a Skill that queries another table.

## Non-Goals

- The first version does not upload artifacts to GitHub or publish a release.
- It does not turn private traces into public traces automatically.
- It does not merge binary fixtures into the AI knowledge-case store.
- It does not require every constructed case to commit a duplicated combined
  trace; reproducibility and release artifacts provide that deliverable.
