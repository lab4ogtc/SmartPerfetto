# Perfetto AI RFC 0025 SmartPerfetto Implementation Plans

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement an approved plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide eight independently reviewable implementation plans for
SmartPerfetto improvements inspired by Google Perfetto RFC-0025.

**Architecture:** Each plan starts from current SmartPerfetto contracts:
runtime selection, MCP registry, YAML Skills, Markdown strategies,
DataEnvelope evidence, reports, CLI artifacts, analysis-result snapshots, and
the forked Perfetto UI plugin. The plans are intentionally separate so a
reviewer can approve, reject, or reorder them without forcing a mega-project.

**Tech Stack:** Node.js 24 LTS, TypeScript strict mode, Express,
Perfetto UI plugin, SmartPerfetto MCP registry, YAML Skills, Markdown
strategies, SQLite-backed services, Jest, existing repository validation
commands.

## Global Constraints

- Preserve existing evidence contracts: trace-backed facts, model hypotheses,
  memory hints, reports, snapshots, and chat projection must remain separate.
- Do not hardcode durable prompt content in TypeScript; use
  `backend/strategies/` and template assets.
- Do not hardcode MCP tool counts, Skill counts, scene lists, or AI output
  sections; use registries, frontmatter, and file-tree discovery.
- Do not make LLM output an unreviewable execution authority. Proposal and
  confirmation boundaries must be explicit.
- Keep Web UI, CLI, API/SSE, reports, Docker, portable packages, and runtime
  provider/session pinning in scope for any future implementation.
- Use current-project verification only. Docs-only changes use
  `git diff --check`; code changes must follow `.claude/rules/testing.md`.

---

## Source Context

Primary external source:

- GitHub discussion: https://github.com/google/perfetto/discussions/5763
- RFC document: https://github.com/google/perfetto/blob/rfcs/0025-ai-in-perfetto.md

Current SmartPerfetto anchor docs:

- `AGENTS.md`
- `.claude/rules/product-surface.md`
- `.claude/rules/backend.md`
- `.claude/rules/frontend.md`
- `.claude/rules/prompts.md`
- `.claude/rules/skills.md`
- `.claude/rules/testing.md`
- `docs/architecture/overview.md`
- `docs/architecture/agent-runtime.md`
- `docs/reference/mcp-tools.md`
- `docs/reference/skill-system.md`
- `docs/reference/cli.md`
- `docs/reference/api.md`

At planning time, this checkout had existing unrelated local changes in
provider/runtime docs and source files, generated frontend bundle files, and
the `perfetto` submodule. These plans do not depend on or modify that work.

## Review Order

The first four are short-term candidates that should not sacrifice current
quality if implemented carefully. The last four are larger or more strategic
and should receive stricter architecture review before implementation.

| Plan | File | Suggested horizon | Main value | Main risk |
| --- | --- | --- | --- | --- |
| 1 | `01-analysis-receipt-and-evidence-audit.md` | Short term | More trustworthy analysis audit trail | Chat/report noise if surfaced poorly |
| 2 | `02-trace-config-proposal.md` | Short term | Better data collection before analysis | Unsafe capture defaults if confirmation is weak |
| 3 | `03-ui-action-proposal-protocol.md` | Short term | Brings AI results back into Perfetto UI context | UI control overreach |
| 4 | `04-snapshot-case-similarity-mvp.md` | Short term / experimental | Lightweight Trace-Shazam using existing data | Treating similarity as proof |
| 5 | `05-query-ir-review-layer.md` | Medium term | Reviewable query plan between prompt and SQL | Scope creep into new query language |
| 6 | `06-external-skill-pack-extension-server.md` | Medium term | Team/OEM skill extensibility | Security, versioning, and trust boundaries |
| 7 | `07-batch-trace-lifecycle.md` | Medium term | Local N-trace lifecycle before Bigtrace | Resource isolation and UX complexity |
| 8 | `08-ai-disable-and-capability-disclosure.md` | Short / medium term | Clear AI off switch and runtime disclosure | Fragmented partial-disable behavior |

## Execution Tracker

This tracker records current implementation-readiness work. Do not mark a plan
as implementation-ready until it has been re-grounded against current code and
the reviewer questions in that plan have a concrete answer.

Current cross-plan implementation and verification status is recorded in
`09-final-implementation-and-verification.md`.

Surface projection across the frontend AI panel, HTML Report, and CLI is
audited in `10-surface-projection-audit.md`.

| Plan | Code-grounded revision | Implementation status | Verification status |
| --- | --- | --- | --- |
| 1. Analysis receipt and evidence audit | Updated and implemented 2026-07-06 against current completion, quality-artifact, quick-run, SSE replay, report, snapshot, CLI, runtime/provider, and frontend projection boundaries | Implemented | Focused Jest, route SSE replay test, typecheck, build, Perfetto UI build/SSE test, frontend prebuild check/update, scene trace regression, Claude quick e2e, Deepseek OpenAI-compatible startup e2e, and report artifact inspection passed |
| 2. Trace config proposal | Updated and implemented 2026-07-06 against current trace config generator, shared capture renderer, CLI/API command split, capture safety boundaries, AI Assistant preview entry, and reviewer decisions | Implemented | Focused Jest, typecheck, build, CLI smoke, frontend helper tests, browser preview smoke, Perfetto UI build, frontend prebuild update, Claude quick e2e, and Deepseek OpenAI-compatible e2e passed |
| 3. UI action proposal protocol | Updated and implemented 2026-07-06 against current DataEnvelope click metadata, SQL table navigation, command bus limits, track overlay registry, SSE handlers, frontend type generation boundaries, strategy-template guidance, and reviewer decisions | Implemented | Focused Jest, frontend proposal/SSE tests, strategy validation, typecheck, build, Perfetto UI build, frontend prebuild check/update, quick dev-mode health check, Claude quick e2e, Deepseek OpenAI-compatible startup e2e, and report artifact inspection passed |
| 4. Snapshot and case similarity MVP | Updated and implemented 2026-07-06 against current analysis-result snapshots, scoped repository access, comparison routes, case recommendation retriever, MCP case-recall boundaries, result-picker UI summary, and reviewer decisions | Implemented | Focused service/route/MCP Jest, backend typecheck, Perfetto UI typecheck/build, browser similarity-summary smoke, frontend prebuild update, HTTP API smoke, Deepseek-backed OpenAI e2e, and root `npm run verify:pr` passed; Claude e2e is blocked by local Claude Code auth |
| 5. Query IR review layer | Updated and implemented 2026-07-06 against current SQL/Skill MCP execution, plan gate, DataEnvelope provenance, ArtifactStore, SQL guardrails, schema lookup, evidence-contract boundaries, report rendering, AI Assistant table projection, and reviewer decisions | Implemented | Focused Jest, report/evidence tests, frontend type generation, SSE plugin tests, browser disclosure smoke, typecheck, Perfetto UI build, frontend prebuild update, and `git diff --check` passed |
| 6. External Skill pack and extension server | Updated and implemented 2026-07-06 against current SkillRegistry root loading, custom skill admin writes, workspace route patterns, enterprise `skill_registry_entries`, RBAC, adapter cache, fragment/Skill collision boundaries, and MCP runtime registry binding | Local directory Skill Pack preview/install API and workspace-scoped `list_skills` / `invoke_skill` runtime integration implemented; archive unpacking, remote extension server discovery, auto-sync/signatures, and CLI workspace-pack execution deferred | Focused manifest/preview/install/provider/MCP/route Jest, request-context coverage, typecheck, build, skill validation, scene trace regression, and `git diff --check` passed |
| 7. Batch trace lifecycle | Updated and implemented 2026-07-06 against current CLI skill/query/compare commands, TraceProcessorService lease APIs, SkillExecutor outputs, standard comparison metrics, snapshot/comparison stores, workspace route patterns, and real CLI artifact behavior | Deterministic Skill batch runner, CLI command, workspace API, enterprise store, HTML/JSON reports, explicit snapshot promotion, and comparison bridge implemented; raw batch SQL, remote workers, browser UI, and automatic promotion deferred | Focused Jest 9 suites / 33 tests, typecheck, skill validation, CLI pack check/build, scene trace regression, real CLI smoke, artifact inspection, and `git diff --check` passed |
| 8. AI disable and capability disclosure | Updated and implemented 2026-07-06 against current runtime selection, health payload, agent analyze/resume/scene routes, Provider Manager test routes, CLI runtime/provider guards, SkillExecutor AI steps, AI Assistant/provider panel status surfaces, and reviewer decisions | Implemented | Focused Jest 9 suites / 212 tests, typecheck, disabled/enabled CLI smoke, scene trace regression, dev-mode browser smoke, Perfetto UI production build, frontend prebuild update, `git diff --check`, and root `npm run verify:pr` passed |

## Cross-Plan Dependencies

- Plan 1 should precede or accompany Plans 3, 4, 5, and 7 because they all add
  new evidence/proposal surfaces.
- Plan 2 can proceed independently because `traceConfigGenerator.ts` and
  capture CLI already exist.
- Plan 3 can start with frontend-only proposal rendering before adding new MCP
  or runtime tools.
- Plan 4 should start with scoped analysis-result snapshot similarity, reuse
  `CaseLibrary` and `caseRecommendationRetriever` only as an optional
  evidence-gated case adapter, and keep `recall_similar_case` as MCP case
  recall rather than the product API.
- Plan 5 should not block short-term receipt or UI action work; its first
  milestone should attach observed-execution `queryReview` sidecars to current
  SQL/Skill evidence rather than introducing a new query compiler.
- Plan 6 should start as a local managed Skill Pack import path, not as a
  generic package manager or remote extension-server marketplace. Workspace
  scope, registry cache invalidation, and Skill/fragment collision rejection are
  part of the first implementation boundary.
- Plan 7 should start as bounded CLI/API batch execution over current Skills,
  not as a distributed execution system. Snapshot promotion should be explicit
  and should feed existing analysis-result comparison rather than creating a
  private batch-only comparison format.
- Plan 8 is a product safety layer and should start with an env-level backend
  and CLI kill switch, health/doctor disclosure, provider-test blocking, and
  then UI disclosure. Workspace-scoped policy should wait for a real workspace
  settings contract.

## Third-Party Review Checklist

For each plan, review these points before implementation:

- Does the plan preserve trace-backed evidence as the final authority?
- Are model-generated suggestions clearly separated from executable actions?
- Does the file list match current SmartPerfetto ownership boundaries?
- Are Web UI, CLI, API, reports, snapshots, Docker, portable packages, and
  provider/session pinning considered?
- Are tests mapped to current repository scripts rather than imported from
  another project?
- Is there a smaller first milestone that produces independently useful,
  testable behavior?
- Are privacy, RBAC, and code/source leakage boundaries explicit?
