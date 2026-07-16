// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * RAG admin routes — operator-side surface for the Plan 55 RAG
 * store. Lets a curator inspect index population per source kind,
 * delete blocked / stale chunks, and search the index directly
 * (without going through the agent).
 *
 * Endpoints (all under `/api/rag`):
 *   GET    /stats              per-kind chunk counts + last indexed
 *   GET    /chunks/:chunkId    fetch one chunk
 *   DELETE /chunks/:chunkId    remove a chunk (license-blocked
 *                              entries can be evicted permanently
 *                              once the curator decides to)
 *   POST   /search             body `{query, kinds?, topK?}` —
 *                              run a search like the agent would
 *
 * The Android Internals endpoints only register and index an operator-
 * allowlisted local checkout. Remote blog, AOSP, and OEM fetchers remain
 * operator-script-only because their authenticated source credentials do
 * not belong in the HTTP surface.
 *
 * @module ragAdminRoutes
 */

import {createHash} from 'crypto';
import * as path from 'path';

import {Router, type Router as ExpressRouter} from 'express';

import {authenticate, requireRequestContext} from '../middleware/auth';
import {RagStore, getDefaultRagStore, type RagStoreSearchOptions} from '../services/ragStore';
import {knowledgeScopeFromRequestContext} from '../services/scopedKnowledgeStore';
import type {RagChunk, RagRetrievalResult, RagSourceKind} from '../types/sparkContracts';
import {requireCodebaseScope} from '../services/auth/codebaseScopes';
import {CodebaseRegistry, type CodebaseRef} from '../services/codebase/codebaseRegistry';
import {getDefaultCodebaseRegistry} from '../services/codebase/defaultCodebaseServices';
import {PathSecurityGate, type PathPreviewResult} from '../services/codebase/pathSecurityGate';
import {AppSourceIngester} from '../services/rag/appSourceIngester';
import {AospSourceIngester} from '../services/rag/aospSourceIngester';
import {KernelSourceIngester} from '../services/rag/kernelSourceIngester';
import {SymbolResolver} from '../services/symbol/symbolResolver';
import {codeAwareFeatureEnabled} from '../services/codebase/codeAwareFeature';
import {
  ExternalKnowledgeSourceRegistry,
  getDefaultExternalKnowledgeSourceRegistry,
  type ExternalKnowledgeSource,
} from '../services/externalKnowledgeSourceRegistry';
import {AndroidInternalsWikiIngester} from '../services/androidInternalsWiki/androidInternalsWikiIngester';
import {
  inspectAndroidInternalsWikiIdentity,
  scanAndroidInternalsWiki,
} from '../services/androidInternalsWiki/androidInternalsWikiCorpus';
import {
  auditAndroidInternalsWiki,
  loadAuditableSkills,
  loadValidatedAssertionRefs,
  loadWikiCapabilityMap,
} from '../services/androidInternalsWiki/androidInternalsWikiAudit';

export interface RagAdminRouteServices {
  registry?: CodebaseRegistry;
  gate?: PathSecurityGate;
  appSourceIngester?: AppSourceIngester;
  aospSourceIngester?: AospSourceIngester;
  kernelSourceIngester?: KernelSourceIngester;
  externalKnowledgeRegistry?: ExternalKnowledgeSourceRegistry;
  androidInternalsWikiIngester?: AndroidInternalsWikiIngester;
  androidInternalsWikiAuditPaths?: {
    capabilityMapPath: string;
    skillsPath: string;
    fixtureManifestPath: string;
  };
}

function snippetHash(snippet: string): string {
  return createHash('sha256').update(snippet).digest('hex').slice(0, 12);
}

function isCodeAwareChunk(chunk: RagChunk): boolean {
  return chunk.kind === 'app_source' ||
    chunk.kind === 'kernel_source' ||
    chunk.registryOrigin === 'codebase_registry';
}

function isSensitiveKnowledgeChunk(chunk: RagChunk): boolean {
  return isCodeAwareChunk(chunk) || chunk.kind === 'android_internals_wiki';
}

function sanitizeChunk(chunk: RagChunk): RagChunk & {snippetHash?: string; snippetLength?: number} {
  if (!isSensitiveKnowledgeChunk(chunk)) return chunk;
  const {snippet, knowledgeScopeFingerprint: _knowledgeScopeFingerprint, ...rest} = chunk;
  return {
    ...rest,
    snippet: undefined as any,
    ...(chunk.kind === 'android_internals_wiki'
      ? {
          title: undefined,
          uri: undefined as any,
          filePath: undefined,
          sourceTags: undefined,
        }
      : {}),
    snippetHash: snippetHash(snippet),
    snippetLength: snippet.length,
  };
}

function sanitizeRetrieval(result: RagRetrievalResult): RagRetrievalResult {
  return {
    ...result,
    results: result.results.map(hit => ({
      ...hit,
      ...(hit.chunk ? {chunk: sanitizeChunk(hit.chunk)} : {}),
    })),
  };
}

function sanitizeCodebase(ref: CodebaseRef) {
  const {rootPath: _rootPath, rootRealpath: _rootRealpath, consent, ...rest} = ref;
  return {
    ...rest,
    eligibleForSendToProvider: consent.sendToProvider,
    consent: {
      sendToProvider: consent.sendToProvider,
      consentedAt: consent.consentedAt,
      consentedBy: consent.consentedBy,
      consentHash: consent.consentHash,
    },
  };
}

function sanitizePreview(preview: PathPreviewResult) {
  return {
    blocked: preview.blocked,
    ...(preview.blockedReason ? {blockedReason: preview.blockedReason} : {}),
    acceptedFileCount: preview.acceptedFiles.length,
    skippedFileCount: preview.skippedFiles.length,
    acceptedFiles: preview.acceptedFiles.slice(0, 200),
    skippedFiles: preview.skippedFiles.slice(0, 200),
  };
}

function sanitizeExternalKnowledgeSource(source: ExternalKnowledgeSource) {
  const {rootRealpath: _rootRealpath, scope: _scope, ...safeSource} = source;
  return safeSource;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/** Test/factory hook. */
export function createRagAdminRoutes(store?: RagStore, services: RagAdminRouteServices = {}): ExpressRouter {
  const s = store ?? getDefaultRagStore();
  const registry = services.registry ?? getDefaultCodebaseRegistry();
  const gate = services.gate ?? new PathSecurityGate();
  const appSourceIngester = services.appSourceIngester ?? new AppSourceIngester(s, registry, gate);
  const aospSourceIngester = services.aospSourceIngester ?? new AospSourceIngester(s, registry, gate);
  const kernelSourceIngester = services.kernelSourceIngester ?? new KernelSourceIngester(s, registry, gate);
  const externalKnowledgeRegistry = services.externalKnowledgeRegistry ??
    getDefaultExternalKnowledgeSourceRegistry();
  const androidInternalsWikiIngester = services.androidInternalsWikiIngester ??
    new AndroidInternalsWikiIngester(
      s,
      externalKnowledgeRegistry,
      new PathSecurityGate({
        allowlistEnvironmentVariable: 'SMARTPERFETTO_KNOWLEDGE_ROOTS',
        allowedExtensions: ['.md'],
      }),
    );
  const backendRoot = path.resolve(__dirname, '../..');
  const androidInternalsWikiAuditPaths = services.androidInternalsWikiAuditPaths ?? {
    capabilityMapPath: path.join(backendRoot, 'knowledge/android-internals-capability-map.yaml'),
    skillsPath: path.join(backendRoot, 'skills'),
    fixtureManifestPath: path.join(backendRoot, 'skills/public-fixtures.yaml'),
  };
  const symbolResolver = new SymbolResolver(s);
  const router = Router();
  router.use(authenticate);

  router.get('/stats', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    res.json({success: true, stats: s.getStats(scope)});
  });

  router.get('/chunks/:chunkId', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const chunkId = routeParam(req.params.chunkId);
    const chunk = s.getChunk(chunkId, scope);
    if (!chunk || chunk.kind === 'android_internals_wiki') {
      return res.status(404).json({
        success: false,
        error: `Chunk '${chunkId}' not found`,
      });
    }
    res.json({success: true, chunk: sanitizeChunk(chunk)});
  });

  router.delete('/chunks/:chunkId', requireCodebaseScope('codebase:admin'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const chunkId = routeParam(req.params.chunkId);
    const chunk = s.getChunk(chunkId, scope);
    if (!chunk || chunk.kind === 'android_internals_wiki') {
      return res.status(404).json({
        success: false,
        error: `Chunk '${chunkId}' not found`,
      });
    }
    const removed = s.removeChunk(chunkId, scope);
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: `Chunk '${chunkId}' not found`,
      });
    }
    res.json({success: true});
  });

  router.post('/search', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const {query, kinds, topK, codebaseIds, vendor, buildId, pathPrefix, symbolExact, filePathExact, languages} = (req.body ?? {}) as {
      query?: string;
      kinds?: RagSourceKind[];
      topK?: number;
    } & RagStoreSearchOptions;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        success: false,
        error: '`query` (string) is required',
      });
    }
    const result = s.search(query, {
      ...(kinds ? {kinds} : {}),
      ...(topK ? {topK} : {}),
      ...(codebaseIds ? {codebaseIds} : {}),
      ...(vendor ? {vendor} : {}),
      ...(buildId ? {buildId} : {}),
      ...(pathPrefix ? {pathPrefix} : {}),
      ...(symbolExact ? {symbolExact} : {}),
      ...(filePathExact ? {filePathExact} : {}),
      ...(languages ? {languages} : {}),
      scope,
    });
    res.json({success: true, result: sanitizeRetrieval(result)});
  });

  router.post('/android-internals/preview', requireCodebaseScope('codebase:read'), async (req, res) => {
    const rootPath = typeof req.body?.rootPath === 'string' ? req.body.rootPath : '';
    if (!rootPath) {
      return res.status(400).json({success: false, error: '`rootPath` is required'});
    }
    const preview = await androidInternalsWikiIngester.preview(rootPath);
    if (preview.blocked) {
      return res.status(400).json({
        success: false,
        error: preview.blockedReason ?? 'knowledge root blocked',
        preview: {
          blocked: true,
          blockedReason: preview.blockedReason,
          acceptedFileCount: preview.acceptedFiles.length,
          skippedFileCount: preview.skippedFiles.length,
        },
      });
    }
    try {
      const corpus = scanAndroidInternalsWiki(preview.rootRealpath);
      const identity = inspectAndroidInternalsWikiIdentity(corpus);
      const statusCounts: Record<string, number> = {};
      for (const article of corpus.articles) {
        const status = article.status ?? 'unknown';
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      }
      return res.json({
        success: true,
        preview: {
          blocked: false,
          acceptedFileCount: preview.acceptedFiles.length,
          skippedFileCount: preview.skippedFiles.length,
          totalArticles: corpus.totalArticles,
          metadataErrorCount: corpus.articles.filter(article => !article.metadataValid).length,
          statusCounts,
          revision: identity.revision,
          contentFingerprint: identity.contentFingerprint,
          dirtyAcceptedArticleCount: identity.dirtyAcceptedArticlePaths.length,
        },
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post('/android-internals/sources', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const rootPath = typeof req.body?.rootPath === 'string' ? req.body.rootPath : '';
    const displayName = typeof req.body?.displayName === 'string'
      ? req.body.displayName.trim()
      : 'Android Internals Wiki';
    if (!rootPath) return res.status(400).json({success: false, error: '`rootPath` is required'});
    if (req.body?.rightsAcknowledged !== true) {
      return res.status(400).json({
        success: false,
        error: '`rightsAcknowledged: true` is required for CC BY-NC-SA use',
      });
    }
    if (typeof req.body?.sendToProvider !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: '`sendToProvider` must be an explicit boolean',
      });
    }
    const preview = await androidInternalsWikiIngester.preview(rootPath);
    if (preview.blocked) {
      return res.status(400).json({
        success: false,
        error: preview.blockedReason ?? 'knowledge root blocked',
      });
    }
    try {
      const corpus = scanAndroidInternalsWiki(preview.rootRealpath);
      const identity = inspectAndroidInternalsWikiIdentity(corpus);
      const context = requireRequestContext(req);
      const scope = knowledgeScopeFromRequestContext(context);
      const source = externalKnowledgeRegistry.register({
        kind: 'android_internals_wiki',
        displayName,
        rootRealpath: preview.rootRealpath,
        revision: identity.revision,
        contentFingerprint: identity.contentFingerprint,
        dirty: identity.dirty,
        license: 'CC-BY-NC-SA-4.0',
        rightsAcknowledged: true,
        sendToProvider: req.body.sendToProvider,
        consentedBy: context.userId,
        scope,
      });
      return res.json({success: true, source: sanitizeExternalKnowledgeSource(source)});
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/android-internals/sources', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const sources = externalKnowledgeRegistry.list(scope).map(sanitizeExternalKnowledgeSource);
    return res.json({success: true, sources});
  });

  router.post(
    '/android-internals/sources/:id/reindex',
    requireCodebaseScope('codebase:manage'),
    async (req, res) => {
      const sourceId = routeParam(req.params.id);
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      if (!externalKnowledgeRegistry.get(sourceId, scope)) {
        return res.status(404).json({
          success: false,
          error: `External knowledge source '${sourceId}' not found`,
        });
      }
      try {
        const result = await androidInternalsWikiIngester.ingest(sourceId, scope);
        return res.json({success: true, result});
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  router.patch(
    '/android-internals/sources/:id/consent',
    requireCodebaseScope('codebase:manage'),
    (req, res) => {
      if (typeof req.body?.sendToProvider !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: '`sendToProvider` must be an explicit boolean',
        });
      }
      const context = requireRequestContext(req);
      const scope = knowledgeScopeFromRequestContext(context);
      try {
        const source = externalKnowledgeRegistry.setProviderConsent(
          routeParam(req.params.id),
          scope,
          req.body.sendToProvider,
          context.userId,
        );
        return res.json({success: true, source: sanitizeExternalKnowledgeSource(source)});
      } catch (error) {
        return res.status(404).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  router.delete(
    '/android-internals/sources/:id/index',
    requireCodebaseScope('codebase:manage'),
    async (req, res) => {
      const sourceId = routeParam(req.params.id);
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      if (!externalKnowledgeRegistry.get(sourceId, scope)) {
        return res.status(404).json({
          success: false,
          error: `External knowledge source '${sourceId}' not found`,
        });
      }
      try {
        return await externalKnowledgeRegistry.withIngestLease(sourceId, scope, lease => {
          const chunkIds = s.listChunks({
            kind: 'android_internals_wiki',
            registryOrigin: 'external_knowledge_registry',
            scope,
          }).filter(chunk => chunk.knowledgeSourceId === sourceId)
            .map(chunk => chunk.chunkId);
          const source = lease.clearActiveGeneration();
          const removedChunkCount = s.removeKnowledgeSourceChunkIds(sourceId, chunkIds, scope);
          return res.json({
            success: true,
            removedChunkCount,
            source: sanitizeExternalKnowledgeSource(source),
          });
        });
      } catch (error) {
        return res.status(409).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  router.get(
    '/android-internals/sources/:id/audit',
    requireCodebaseScope('codebase:read'),
    async (req, res) => {
      const sourceId = routeParam(req.params.id);
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      const source = externalKnowledgeRegistry.get(sourceId, scope);
      if (!source) {
        return res.status(404).json({
          success: false,
          error: `External knowledge source '${sourceId}' not found`,
        });
      }
      try {
        const preview = await androidInternalsWikiIngester.preview(source.rootRealpath);
        if (preview.blocked) {
          throw new Error(preview.blockedReason ?? 'knowledge_root_blocked');
        }
        if (preview.rootRealpath !== source.rootRealpath) {
          throw new Error('knowledge_root_realpath_drift');
        }
        const corpus = scanAndroidInternalsWiki(preview.rootRealpath);
        const acceptedPaths = new Set(
          preview.acceptedFiles.map(file => file.relativePath.split('\\').join('/')),
        );
        const excludedArticleCount = corpus.articles.filter(
          article => !acceptedPaths.has(article.relativePath),
        ).length;
        if (excludedArticleCount > 0) {
          throw new Error(`knowledge_path_gate_excluded_${excludedArticleCount}_articles`);
        }
        const identity = inspectAndroidInternalsWikiIdentity(corpus);
        const report = auditAndroidInternalsWiki(
          corpus,
          loadWikiCapabilityMap(androidInternalsWikiAuditPaths.capabilityMapPath),
          loadAuditableSkills(androidInternalsWikiAuditPaths.skillsPath),
          loadValidatedAssertionRefs(androidInternalsWikiAuditPaths.fixtureManifestPath),
        );
        return res.json({
          success: true,
          audit: {
            repository: {
              revision: identity.revision,
              contentFingerprint: identity.contentFingerprint,
              dirtyAcceptedArticlePaths: identity.dirtyAcceptedArticlePaths,
            },
            report,
          },
        });
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  router.get('/codebases', requireCodebaseScope('codebase:read'), (_req, res) => {
    res.json({
      success: true,
      featureEnabled: codeAwareFeatureEnabled(),
      codebases: registry.list(),
    });
  });

  router.post('/codebases/preview', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const {rootPath} = (req.body ?? {}) as {rootPath?: string};
    if (!rootPath || typeof rootPath !== 'string') {
      return res.status(400).json({success: false, error: '`rootPath` is required'});
    }
    res.json({success: true, preview: sanitizePreview(await gate.preview(rootPath))});
  });

  router.post('/codebases/register', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const {
      kind = 'app_source',
      displayName,
      rootPath,
      commitHash,
      vendor,
      buildId,
      pathFilters,
      excludeGlobs,
      symbolMapPaths,
      licenseTag,
      sendToProvider,
    } = (req.body ?? {}) as Record<string, any>;
    if (!displayName || typeof displayName !== 'string') {
      return res.status(400).json({success: false, error: '`displayName` is required'});
    }
    if (!rootPath || typeof rootPath !== 'string') {
      return res.status(400).json({success: false, error: '`rootPath` is required'});
    }
    const preview = await gate.preview(rootPath);
    if (preview.blocked) {
      return res.status(400).json({
        success: false,
        error: preview.blockedReason ?? 'root blocked by path security gate',
        preview: sanitizePreview(preview),
      });
    }
    const context = requireRequestContext(req);
    try {
      const ref = registry.register({
        kind,
        displayName,
        rootPath,
        rootRealpath: preview.rootRealpath,
        ...(commitHash ? {commitHash} : {}),
        ...(vendor ? {vendor} : {}),
        ...(buildId ? {buildId} : {}),
        ...(Array.isArray(pathFilters) ? {pathFilters} : {}),
        ...(Array.isArray(excludeGlobs) ? {excludeGlobs} : {}),
        ...(Array.isArray(symbolMapPaths) ? {symbolMapPaths} : {}),
        ...(licenseTag ? {licenseTag} : {}),
        sendToProvider: Boolean(sendToProvider),
        consentedBy: context.userId,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        userId: context.userId,
      });
      res.json({success: true, codebase: sanitizeCodebase(ref), preview: sanitizePreview(preview)});
    } catch (error) {
      res.status(400).json({success: false, error: error instanceof Error ? error.message : String(error)});
    }
  });

  router.get('/codebases/:id', requireCodebaseScope('codebase:read'), (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const ref = registry.get(codebaseId);
    if (!ref) {
      return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
    }
    res.json({success: true, codebase: sanitizeCodebase(ref)});
  });

  router.get('/codebases/:id/symbols', requireCodebaseScope('codebase:read'), (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const ref = registry.get(codebaseId);
    if (!ref) {
      return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
    }
    const symbol = typeof req.query.symbol === 'string'
      ? req.query.symbol
      : typeof req.query.query === 'string'
        ? req.query.query
        : '';
    if (!symbol) {
      return res.status(400).json({success: false, error: '`symbol` or `query` is required'});
    }
    const common = {
      codebaseId,
      buildId: typeof req.query.buildId === 'string' ? req.query.buildId : undefined,
      topK: typeof req.query.topK === 'string' ? Number(req.query.topK) : undefined,
    };
    const result = ref.kind === 'kernel_source'
      ? symbolResolver.resolveKernel({
          symbol,
          vendor: ref.vendor,
          ...common,
        })
      : ref.kind === 'aosp'
        ? symbolResolver.resolveNative({
            symbol,
            ...common,
          })
        : symbolResolver.resolveApp({
            symbol,
            codebaseId,
            buildId: common.buildId,
            filePath: typeof req.query.filePath === 'string' ? req.query.filePath : undefined,
          });
    res.json({success: true, result});
  });

  router.get('/codebases/:id/excerpt', requireCodebaseScope('codebase:read'), (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const ref = registry.get(codebaseId);
    if (!ref) {
      return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
    }
    const chunkId = typeof req.query.chunkId === 'string' ? req.query.chunkId : '';
    if (!chunkId) {
      return res.status(400).json({success: false, error: '`chunkId` is required'});
    }
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const chunk = s.getChunk(chunkId, scope);
    if (!chunk || chunk.codebaseId !== codebaseId || !isCodeAwareChunk(chunk)) {
      return res.status(404).json({success: false, error: `Code excerpt '${chunkId}' not found`});
    }
    const maxLines = typeof req.query.maxLines === 'string'
      ? Math.max(1, Math.min(80, Number(req.query.maxLines) || 20))
      : 20;
    const lines = chunk.snippet.split(/\r?\n/).slice(0, maxLines);
    res.json({
      success: true,
      excerpt: {
        chunkId,
        codebaseId,
        filePath: chunk.filePath,
        lineRange: chunk.lineRange,
        symbol: chunk.symbol,
        language: chunk.language,
        text: lines.join('\n'),
        truncated: lines.length < chunk.snippet.split(/\r?\n/).length,
      },
    });
  });

  router.post('/codebases/:id/reindex', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const ref = registry.get(codebaseId);
    if (!ref) {
      return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
    }
    try {
      const result = await (ref.kind === 'kernel_source'
        ? kernelSourceIngester.ingest(codebaseId, req.body ?? {})
        : ref.kind === 'aosp'
          ? aospSourceIngester.ingest(codebaseId, req.body ?? {})
          : appSourceIngester.ingest(codebaseId, req.body ?? {}));
      res.json({success: true, result});
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/codebases/:id/audit', requireCodebaseScope('codebase:read'), (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const ref = registry.get(codebaseId);
    if (!ref) {
      return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
    }
    res.json({
      success: true,
      audit: {
        codebaseId: ref.codebaseId,
        kind: ref.kind,
        indexGeneration: ref.indexGeneration,
        lastIngestAt: ref.lastIngestAt,
        lastIngestStatus: ref.lastIngestStatus,
        lastIngestError: ref.lastIngestError,
        chunkCount: ref.chunkCount ?? 0,
        blockedFileCount: ref.blockedFileCount ?? 0,
        redactionHitCount: ref.redactionHitCount ?? 0,
      },
    });
  });

  return router;
}

const ragAdminRoutes = createRagAdminRoutes();
export default ragAdminRoutes;
