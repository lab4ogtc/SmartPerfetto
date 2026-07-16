# External Skill Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace admin install reviewed SmartPerfetto Skill packs
without editing the core repository or exposing untrusted remote content to the
agent runtime.

**Architecture:** The first release is a local managed import path, not a
remote extension-server marketplace. A pack is previewed from a local directory,
validated in an isolated Skill registry, copied under
`backendDataPath('skill-packs', ...)`, recorded in the existing
`skill_registry_entries` workspace table, and loaded only for the matching
workspace request context. Built-in Skills remain the default global registry;
external packs are merged through a request-scoped registry provider with
explicit origin metadata and collision checks.

**Tech Stack:** Node.js 24 LTS, TypeScript strict mode, Express workspace
routes, YAML Skill validation, `SkillRegistry`, `EnterpriseWorkspaceRepository`,
RBAC, `backendDataPath`, Jest.

## Implementation Update 2026-07-06

Implemented the short-term local-directory import path:

- Manifest parser and fail-closed asset validation for
  `smartperfetto-skill-pack.json`.
- Strict local directory preview with manifest hash, content hash, asset hash
  checks, undeclared/missing file detection, symlink rejection, duplicate Skill
  detection, built-in Skill collision rejection, and fragment collision
  rejection.
- `SkillRegistry.loadSkillRoots()` with external-pack origin metadata and
  external root collision policy while preserving the built-in singleton path.
- `skill_registry_entries.metadata_json` migration plus a typed repository and
  managed install service using `backendDataPath('skill-packs', ...)`.
- Workspace API at `/api/workspaces/:workspaceId/skill-packs` for list,
  preview, install, enable/disable, and remove, guarded by `runtime:manage`.
- Request-scoped runtime integration for workspace agent sessions: `list_skills`
  and `invoke_skill` bind to a registry built from built-ins plus enabled pack
  roots, refresh the Skill executor and SQL fragment registry on fingerprint
  changes, and expose external-pack origin metadata in Skill listings.

Deferred from this short-term implementation:

- Archive unpacking, because the current dependency set has no dedicated
  zip/tar extraction library and the first release should not shell out.
- Remote extension-server discovery, `.well-known` metadata, auto-sync, and
  signatures.
- CLI execution of workspace packs, because `smp skill` does not yet carry an
  explicit tenant/workspace context. It remains built-in-only.

## Global Constraints

- External packs must contain data files only: Skill YAML, SQL fragments, and
  documentation assets.
- First release must not load external strategies, TypeScript, JavaScript,
  shell scripts, dynamic imports, or executable hooks.
- First release must not fetch remote pack content or auto-sync installed packs.
- External Skills must pass the same condition, fragment, and display-contract
  checks as built-in Skills.
- Workspace-scoped packs must not be loaded into the process-global built-in
  `skillRegistry`.
- Prompt and playbook prose must stay in Markdown/YAML assets, not TypeScript.
- Pack counts, Skill counts, and MCP tool exposure must be discovered from
  registries and file trees.

---

## Code-Grounded Current State

Relevant current files and contracts:

- `backend/src/services/skillEngine/skillLoader.ts`
  - `SkillRegistry.loadSkills(skillsDir)` loads one root shaped like
    `backend/skills/`, then sets an `initialized` guard.
  - `ensureSkillRegistryInitialized()` loads only `getSkillsDir()` and then
    upserts the generated rendering-pipeline detection Skill.
  - `reload()` clears the singleton registry and reloads only the built-in
    `backend/skills` root.
  - `loadSingleSkill(skillsDir, relativeSkillPath)` is useful for isolated
    validation but does not initialize the full registry.
  - SQL fragments are stored by global keys such as `fragments/common.sql`.
    Loading another root can silently overwrite a fragment key today.
  - Skill IDs are stored in `Map<string, SkillDefinition>` and a later load can
    silently replace an earlier Skill with the same `name`.
- `backend/src/services/skillEngine/__tests__/customSkillLoader.test.ts`
  - Confirms temp-root loading, `custom/`, `comparison/`, vendor override
    display validation, and programmatic upsert validation.
- `backend/src/services/skillEngine/skillAnalysisAdapter.ts`
  - Caches registered Skills inside an adapter after `ensureInitialized()`.
    Runtime pack enable/disable therefore needs adapter invalidation or a
    registry fingerprint.
- `backend/src/controllers/skillAdminController.ts`
  - Legacy admin CRUD writes directly into `backend/skills/custom` and calls
    `skillRegistry.reload()`.
  - Enterprise mode disables custom write routes, but list/detail/reload routes
    still operate on the global built-in registry.
- `backend/src/routes/skillAdminRoutes.ts`
  - Global `/api/admin/skills` is authenticated but is not workspace-scoped and
    is the wrong surface for approved external packs.
- `backend/src/index.ts`
  - Workspace product APIs are mounted under `/api/workspaces/:workspaceId/...`
    with `workspaceRouteContextMiddleware`.
- `backend/src/services/enterpriseSchema.ts`
  - `skill_registry_entries` already exists with `id`, `tenant_id`,
    `workspace_id`, `scope`, `version`, `enabled`, `source_path`,
    `created_at`, and `updated_at`.
  - The table lacks manifest hash, content hash, approval actor, trust state,
    and structured metadata columns.
- `backend/src/services/enterpriseRepository.ts`
  - `skill_registry_entries` is already listed as an
    `EnterpriseWorkspaceScopedTable`.
- `backend/src/services/rbac.ts`
  - There is no `skill_pack:manage` permission. `workspace_admin` and
    `org_admin` already have `runtime:manage`.
- `backend/src/agentv3/claudeMcpServer.ts`
  - `list_skills` and `invoke_skill` discover Skills from the Skill registry
    and must not be backed by hardcoded lists.
- `backend/src/cli-user/commands/skill.ts`
  - CLI Skill execution uses the global built-in `skillRegistry`; workspace
    pack execution needs an explicit workspace-aware path before CLI support is
    enabled.
- `backend/src/runtimePaths.ts`
  - `backendDataPath(...segments)` is the correct managed storage root for pack
    copies.

## First Milestone Decisions

- Supported source: local directory selected by an admin.
- Unsupported source: remote HTTPS URL, `.well-known` discovery, and automatic
  update checks.
- Supported pack content: `atomic/`, `composite/`, `deep/`, `system/`,
  `comparison/`, `modules/`, `pipelines/`, `fragments/`, and `docs/`.
- Unsupported pack content: `strategies/`, `vendors/`, `custom/`, executable
  files, hidden files, symlinks that escape the pack root, and generated
  frontend assets.
- Storage: copy approved content to
  `backendDataPath('skill-packs', tenantId, workspaceId, packId, version)`.
- Persistence: reuse `skill_registry_entries`, but add a structured
  `metadata_json` column before storing approval and trust metadata.
- Permission: use `runtime:manage` for preview, install, disable, and remove in
  the first release. A narrower `skill_pack:manage` permission can be added
  only when another admin feature needs that separation.
- Runtime scope: built-in-only singleton registry remains available for legacy
  and unauthenticated routes. Workspace agent and authenticated Skill routes use
  a registry created from built-ins plus enabled pack roots for the request
  workspace.
- Collision policy: reject external Skill IDs that collide with built-in Skills
  or installed packs. Reject SQL fragment key collisions unless the bytes are
  identical and the manifest declares the fragment as shared.
- Origin policy: do not mutate Skill YAML. Maintain an origin sidecar keyed by
  Skill ID and expose it in list/detail surfaces.

## Proposed Contracts

Create `backend/src/services/skillPacks/skillPackManifest.ts`:

```ts
export const SKILL_PACK_MANIFEST_SCHEMA_VERSION = 1 as const;

export type SkillPackAssetKind = 'skill' | 'fragment' | 'doc';

export interface SkillPackManifestAssetV1 {
  kind: SkillPackAssetKind;
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface SkillPackManifestV1 {
  schemaVersion: 1;
  packId: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  license: string;
  assets: SkillPackManifestAssetV1[];
  compatibility: {
    smartPerfettoMinVersion: string;
  };
  trust?: {
    signature?: string;
    publicKeyId?: string;
  };
}

export interface ParsedSkillPackManifest {
  manifest: SkillPackManifestV1;
  manifestHash: string;
}

export function parseSkillPackManifest(value: unknown): ParsedSkillPackManifest;
```

Create `backend/src/services/skillPacks/skillPackTypes.ts`:

```ts
export type SkillPackTrustState = 'local_unverified' | 'approved';
export type SkillPackInstallState = 'enabled' | 'disabled';
export type SkillOriginKind = 'built_in' | 'external_pack';

export interface SkillPackRecordMetadata {
  schemaVersion: 1;
  packId: string;
  name: string;
  publisher: string;
  manifestHash: string;
  contentHash: string;
  trustState: SkillPackTrustState;
  approvedBy: string;
  approvedAt: number;
  disabledAt?: number;
  skillIds: string[];
  fragmentKeys: string[];
  docPaths: string[];
}

export interface SkillOriginMetadata {
  origin: SkillOriginKind;
  packId?: string;
  packVersion?: string;
  trustState?: SkillPackTrustState;
  sourcePath?: string;
}
```

Create workspace routes under:

```text
GET    /api/workspaces/:workspaceId/skill-packs
POST   /api/workspaces/:workspaceId/skill-packs/preview
POST   /api/workspaces/:workspaceId/skill-packs/install
PATCH  /api/workspaces/:workspaceId/skill-packs/:packId
DELETE /api/workspaces/:workspaceId/skill-packs/:packId
```

The routes require `runtime:manage` and must use
`workspaceRouteContextMiddleware`.

## Files and Responsibilities

- Create: `backend/src/services/skillPacks/skillPackTypes.ts`
  - Shared manifest, record, preview, install, and origin types.
- Create: `backend/src/services/skillPacks/skillPackManifest.ts`
  - Manifest parsing, path checks, asset allowlist checks, hash validation
    helpers, and size limits.
- Create: `backend/src/services/skillPacks/skillPackPreviewService.ts`
  - Local directory preview, manifest verification, isolated Skill validation,
    collision detection, and preview result output. Archive unpacking is
    intentionally deferred.
- Create: `backend/src/services/skillPacks/skillPackRepository.ts`
  - Thin typed wrapper around `EnterpriseWorkspaceRepository` for
    `skill_registry_entries`.
- Create: `backend/src/services/skillPacks/skillPackInstallService.ts`
  - Managed copy, metadata persistence, enable/disable/remove operations, and
    registry cache invalidation.
- Create: `backend/src/services/skillPacks/workspaceSkillRegistryProvider.ts`
  - Builds and caches per-workspace registries from built-ins plus enabled pack
    roots. Exposes origin metadata and a fingerprint for adapter invalidation.
- Modify: `backend/src/services/enterpriseSchema.ts`
  - Add a migration that appends `metadata_json TEXT` to
    `skill_registry_entries`.
- Modify: `backend/src/services/rbac.ts`
  - Keep `runtime:manage` as the first-release permission check helper for
    skill-pack routes.
- Modify: `backend/src/services/skillEngine/skillLoader.ts`
  - Add multi-root loading with duplicate Skill and fragment collision policies.
  - Preserve `ensureSkillRegistryInitialized()` as the built-in default path.
  - Add origin sidecar registration without changing Skill YAML definitions.
- Modify: `backend/src/services/skillEngine/skillAnalysisAdapter.ts`
  - Accept an injected registry plus registry fingerprint, or expose a reset
    path when the workspace registry changes.
- Modify: `backend/src/controllers/skillController.ts`
  - Use the workspace registry provider for authenticated workspace Skill
    surfaces. Keep legacy `/api/skills` built-in-only behavior.
- Create: `backend/src/controllers/skillPackController.ts`
  - Route handler layer for preview/install/list/disable/remove.
- Create: `backend/src/routes/skillPackRoutes.ts`
  - Workspace-scoped route definitions and RBAC checks.
- Modify: `backend/src/index.ts`
  - Mount `skillPackRoutes` at `/api/workspaces/:workspaceId/skill-packs`.
- Modify: `backend/src/agentv3/claudeMcpServer.ts`
  - Include origin metadata in `list_skills` and ensure `invoke_skill` uses the
    request workspace registry when a workspace context exists.
- Modify: `backend/src/cli-user/commands/skill.ts`
  - Keep existing built-in execution as the default; add workspace-pack CLI
    support only after the command can supply tenant/workspace context.
- Modify: `docs/reference/skill-system.md`
  - Document local Skill Pack authoring, manifest fields, validation, install,
    disable, and collision rules.
- Modify: `docs/reference/skill-system.en.md`
  - Mirror the English reference if that file exists in the checkout at
    implementation time.
- Test: `backend/src/services/skillPacks/__tests__/skillPackManifest.test.ts`
- Test: `backend/src/services/skillPacks/__tests__/skillPackPreviewService.test.ts`
- Test: `backend/src/services/skillPacks/__tests__/skillPackInstallService.test.ts`
- Test: `backend/src/services/skillPacks/__tests__/workspaceSkillRegistryProvider.test.ts`
- Test: `backend/src/routes/__tests__/skillPackRoutes.test.ts`
- Test: extend `backend/src/services/skillEngine/__tests__/customSkillLoader.test.ts`

## Implementation Tasks

### Task 1: Manifest Schema and Closed Validation

**Files:**

- Create: `backend/src/services/skillPacks/skillPackTypes.ts`
- Create: `backend/src/services/skillPacks/skillPackManifest.ts`
- Test: `backend/src/services/skillPacks/__tests__/skillPackManifest.test.ts`

**Interfaces:**

- Consumes: raw JSON parsed from `smartperfetto-skill-pack.json`.
- Produces:
  - `parseSkillPackManifest(value: unknown): ParsedSkillPackManifest`
  - `assertSafePackAssetPath(path: string): void`
  - `isAllowedPackAssetKind(kind: string): kind is SkillPackAssetKind`

- [x] Create failing tests for valid manifest parsing, parent traversal
  rejection, absolute path rejection, unsupported asset kind rejection, missing
  hash rejection, and executable extension rejection.
- [x] Implement `SkillPackManifestV1` and parser with exact error messages:
  `invalid_schema_version`, `invalid_pack_id`, `invalid_asset_path`,
  `unsupported_asset_kind`, `invalid_sha256`, `asset_too_large`.
- [x] Enforce path roots:
  `atomic/`, `composite/`, `deep/`, `system/`, `comparison/`, `modules/`,
  `pipelines/`, `fragments/`, and `docs/`.
- [x] Reject `strategies/`, `vendors/`, `custom/`, `.`, `..`, hidden path
  segments, absolute paths, and files ending in `.js`, `.ts`, `.mjs`, `.cjs`,
  `.sh`, `.bash`, `.zsh`, `.py`, `.rb`, `.go`, `.rs`, `.dylib`, `.so`, `.dll`,
  or `.exe`.
- [x] Compute `manifestHash` from the canonical JSON string used by the parser.

Validation:

```bash
cd backend
npx jest src/services/skillPacks/__tests__/skillPackManifest.test.ts --runInBand
```

Expected result: valid local manifests parse, unsafe manifests fail closed, and
no remote URL behavior exists in this task.

### Task 2: Strict Preview and Collision Detection

**Files:**

- Create: `backend/src/services/skillPacks/skillPackPreviewService.ts`
- Modify: `backend/src/services/skillEngine/skillLoader.ts`
- Test: `backend/src/services/skillPacks/__tests__/skillPackPreviewService.test.ts`
- Test: extend `backend/src/services/skillEngine/__tests__/customSkillLoader.test.ts`

**Interfaces:**

- Consumes:
  - `previewSkillPack(input: { sourcePath: string; builtInSkillsDir?: string }): Promise<SkillPackPreviewResult>`
  - `parseSkillPackManifest(value: unknown): ParsedSkillPackManifest`
- Produces:
  - `SkillPackPreviewResult` with `manifest`, `manifestHash`, `contentHash`,
    `skillIds`, `fragmentKeys`, `docPaths`, `errors`, and `warnings`.
  - `SkillRegistry.loadSkillRoots(roots: SkillRootDescriptor[]): Promise<void>`
    for isolated validation and future runtime loading.

- [x] Create failing tests for a preview that validates a local directory and
  returns extracted Skill IDs without installing files.
- [x] Create failing tests for SHA mismatch, undeclared file, missing declared
  file, symlink escape, duplicate Skill ID, built-in Skill ID collision, and
  fragment key collision.
- [x] Add `SkillRootDescriptor` with fields `rootPath`, `origin`, `packId`,
  `packVersion`, and `trustState`.
- [x] Refactor `SkillRegistry.loadSkills(skillsDir)` to call
  `loadSkillRoots([{ rootPath: skillsDir, origin: 'built_in' }])` so existing
  callers keep working.
- [x] Add duplicate Skill detection before `this.skills.set(...)` replaces an
  existing entry. Built-in duplicate behavior must stay unchanged for existing
  built-in roots; external roots must reject collisions.
- [x] Add fragment collision detection before `fragmentCache.set(...)`.
  External fragment collisions fail unless the bytes match and the manifest
  asset declares the same `sha256`.
- [x] Run the existing condition, fragment, and display-contract validators in
  strict mode for external packs. Any validation issue returns a preview error
  and prevents install.
- [x] Keep preview read-only for local directory sources. Archive unpacking is
  intentionally unsupported in the first release, so no temp extraction path is
  executed.

Validation:

```bash
cd backend
npx jest src/services/skillPacks/__tests__/skillPackPreviewService.test.ts --runInBand
npx jest src/services/skillEngine/__tests__/customSkillLoader.test.ts --runInBand
```

Expected result: preview never changes `backend/skills`, never changes
`backendDataPath`, and refuses content that would change built-in Skill or
fragment semantics.

### Task 3: Repository, Schema, and Managed Install

**Files:**

- Modify: `backend/src/services/enterpriseSchema.ts`
- Create: `backend/src/services/skillPacks/skillPackRepository.ts`
- Create: `backend/src/services/skillPacks/skillPackInstallService.ts`
- Test: `backend/src/services/skillPacks/__tests__/skillPackInstallService.test.ts`

**Interfaces:**

- Consumes:
  - `SkillPackPreviewResult`
  - `EnterpriseRepositoryScope`
  - admin actor user ID from `RequestContext`
- Produces:
  - `installSkillPack(scope, actor, preview): Promise<InstalledSkillPackRecord>`
  - `setSkillPackEnabled(scope, packId, enabled): Promise<InstalledSkillPackRecord>`
  - `removeSkillPack(scope, packId): Promise<void>`

- [x] Add an enterprise schema migration using `addColumnIfMissing` for
  `skill_registry_entries.metadata_json TEXT`.
- [x] Implement `SkillPackRepository` around
  `EnterpriseWorkspaceRepository<SkillRegistryEntryRow>`.
- [x] Store one row per installed pack with:
  - `id = packId`
  - `scope = 'workspace'`
  - `version = manifest.version`
  - `enabled = 1`
  - `source_path = managed pack root`
  - `metadata_json = SkillPackRecordMetadata`
- [x] Copy approved assets to
  `backendDataPath('skill-packs', tenantId, workspaceId, packId, version)`.
- [x] Preserve immutable installed content by rejecting install when the same
  `packId` and `version` already exist with a different `contentHash`.
- [x] Disable by setting `enabled = 0` and writing `disabledAt` into
  `metadata_json`; do not delete managed files during disable.
- [x] Remove by disabling the row first, deleting only the managed pack
  directory, and leaving built-in Skills untouched.
- [x] Emit registry invalidation for the affected `tenantId/workspaceId` after
  install, disable, or remove.

Validation:

```bash
cd backend
npx jest src/services/skillPacks/__tests__/skillPackInstallService.test.ts --runInBand
```

Expected result: approved packs are copied to managed storage, persisted in the
workspace-scoped table, and can be disabled without affecting built-ins.

### Task 4: Workspace Registry Provider and Runtime Origin

**Files:**

- Create: `backend/src/services/skillPacks/workspaceSkillRegistryProvider.ts`
- Modify: `backend/src/services/skillEngine/skillLoader.ts`
- Modify: `backend/src/services/skillEngine/skillAnalysisAdapter.ts`
- Modify: `backend/src/agentv3/claudeMcpServer.ts`
- Test: `backend/src/services/skillPacks/__tests__/workspaceSkillRegistryProvider.test.ts`

**Interfaces:**

- Consumes:
  - request `EnterpriseRepositoryScope`
  - enabled pack records from `SkillPackRepository`
  - built-in root from `getSkillsDir()`
- Produces:
  - `getWorkspaceSkillRegistry(scope): Promise<WorkspaceSkillRegistryHandle>`
  - `invalidateWorkspaceSkillRegistry(scope): void`
  - `getSkillOrigin(skillId): SkillOriginMetadata | undefined`
  - `registryFingerprint: string`

- [x] Build a workspace registry from built-ins plus enabled pack roots in this
  order: built-in root first, enabled packs sorted by `packId` and `version`.
- [x] Keep a built-in-only global registry for legacy routes and local CLI.
- [x] Add `SkillOriginMetadata` sidecar registration during root loading.
  Built-in Skills report `{ origin: 'built_in' }`; external Skills report pack
  ID, pack version, trust state, and managed source path.
- [x] Refuse to construct a workspace registry if two enabled packs expose the
  same Skill ID or fragment key.
- [x] Add a fingerprint derived from built-in root mtime summary plus enabled
  pack IDs, versions, and content hashes.
- [x] Modify `SkillAnalysisAdapter` so a changed fingerprint causes the
  executor to re-register Skills and fragment cache.
- [x] Modify `list_skills` output to include origin metadata while preserving
  existing fields and tool visibility behavior.
- [x] Modify `invoke_skill` to resolve Skills from the workspace registry when
  the request has a workspace context. If no context exists, use built-ins only.

Validation:

```bash
cd backend
npx jest src/services/skillPacks/__tests__/workspaceSkillRegistryProvider.test.ts --runInBand
npx jest src/agentv3/__tests__/claudeMcpServer.test.ts --runInBand
```

Expected result: an approved external Skill appears in `list_skills` only for
the approving workspace and `invoke_skill` cannot execute it from another
workspace.

### Task 5: Workspace API Surface

**Files:**

- Create: `backend/src/controllers/skillPackController.ts`
- Create: `backend/src/routes/skillPackRoutes.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/routes/__tests__/skillPackRoutes.test.ts`
- Test: extend `backend/src/routes/__tests__/requestContextRouteCoverage.test.ts`

**Interfaces:**

- Consumes:
  - `RequestContext` from `workspaceRouteContextMiddleware`
  - `runtime:manage` via `hasRbacPermission`
  - services from Tasks 2 and 3
- Produces workspace endpoints:
  - `GET /api/workspaces/:workspaceId/skill-packs`
  - `POST /api/workspaces/:workspaceId/skill-packs/preview`
  - `POST /api/workspaces/:workspaceId/skill-packs/install`
  - `PATCH /api/workspaces/:workspaceId/skill-packs/:packId`
  - `DELETE /api/workspaces/:workspaceId/skill-packs/:packId`

- [x] Route preview requires JSON `{ "sourcePath": "/absolute/local/path" }`
  and returns a preview result without writing managed storage.
- [x] Route install requires JSON `{ "sourcePath": "/absolute/local/path" }`,
  reruns preview, installs the exact validated content, and returns the
  installed record.
- [x] Route patch accepts `{ "enabled": true }` or `{ "enabled": false }`.
- [x] Route delete disables and removes the managed copy.
- [x] Every mutating route rejects users without `runtime:manage` with HTTP
  `403`.
- [x] Every route is tenant/workspace scoped; a workspace cannot list or modify
  another workspace's packs.
- [x] Mount the route before legacy global routes and include it in request
  context route coverage.

Validation:

```bash
cd backend
npx jest src/routes/__tests__/skillPackRoutes.test.ts --runInBand
npx jest src/routes/__tests__/requestContextRouteCoverage.test.ts --runInBand
```

Expected result: pack management behaves like other workspace resources and is
not exposed through the legacy global admin/custom skill write path.

### Task 6: Docs, CLI Boundary, and Full Verification

**Files:**

- Modify: `backend/src/cli-user/commands/skill.ts`
- Modify: `docs/reference/skill-system.md`
- Modify: `docs/reference/skill-system.en.md` when present
- Modify: `docs/reference/api.md`

**Interfaces:**

- Consumes: implemented route and service contracts from Tasks 1 through 5.
- Produces: user-facing docs and a documented CLI boundary.

- [x] Document local pack manifest format, allowed roots, hash rules,
  workspace approval flow, disable/remove behavior, and collision policy.
- [x] Document that remote extension-server discovery is outside the first
  release and that installed packs never auto-sync.
- [x] Keep `smp skill` built-in-only unless the command can supply an explicit
  tenant/workspace context. Document this boundary in CLI help/reference.
- [x] Add API reference entries for the five workspace skill-pack routes.
- [x] Run focused service and route tests.
- [x] Run `cd backend && npm run typecheck`.
- [x] Run `cd backend && npm run validate:skills`.
- [x] Run `cd backend && npm run test:scene-trace-regression` because runtime
  Skill discovery changes.
- [x] Run `git diff --check`.

Expected result: source, Web/API behavior, CLI boundary, docs, and runtime
Skill discovery are consistent.

## Security and Quality Review Points

- Remote content is intentionally absent from the first release. A future
  `.well-known/smartperfetto-skill-pack.json` protocol must reuse the same
  manifest parser, hash verifier, preview service, approval flow, and managed
  copy semantics before it is exposed.
- External strategies are intentionally absent from the first release because
  they affect durable prompt behavior. A future strategy-pack feature needs a
  separate prompt/security review and strategy validation gate.
- Workspace scope is mandatory because the process-global `skillRegistry` cannot
  safely represent per-workspace approved content.
- Legacy `/api/admin/skills` custom writes remain a compatibility surface. The
  pack feature must not expand that path or write into `backend/skills/custom`.
- Pack disable and remove must invalidate adapter caches; otherwise an executor
  that already registered the external Skill could keep running stale content.
- Similarity, reports, snapshots, and final claims must treat external pack
  results as trace-backed evidence only when the Skill produced DataEnvelope or
  artifact provenance through existing evidence contracts.

## Reviewer Questions Answered

- Should the first milestone support remote HTTPS URLs?
  - No. First milestone accepts local directory input only.
- Should external strategies be allowed in the first release?
  - No. First milestone allows Skill YAML, SQL fragments, and docs only.
- What permission should manage packs?
  - Use existing `runtime:manage` until there is a product need for a narrower
    `skill_pack:manage` permission.
- Should installation be workspace-scoped from day one?
  - Yes. The existing `skill_registry_entries` table is workspace-scoped, and a
    global registry would leak external Skills across workspaces.
- Can external packs override built-in Skills?
  - No. First release rejects Skill ID collisions and fragment collisions.
- Is the extension server part of this implementation?
  - No. The file name keeps the RFC lineage, but this implementation plan
    deliberately ships the local managed Skill Pack path first.
