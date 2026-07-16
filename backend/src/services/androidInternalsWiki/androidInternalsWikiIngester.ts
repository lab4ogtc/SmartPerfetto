// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import type {
  ExternalKnowledgeIngestLeaseGuard,
  ExternalKnowledgeScope,
} from '../externalKnowledgeSourceRegistry';
import {ExternalKnowledgeSourceRegistry} from '../externalKnowledgeSourceRegistry';
import type {PathPreviewResult} from '../codebase/pathSecurityGate';
import {PathSecurityGate} from '../codebase/pathSecurityGate';
import type {RagChunk} from '../../types/sparkContracts';
import {RagStore} from '../ragStore';
import {
  inspectAndroidInternalsWikiIdentity,
  scanAndroidInternalsWiki,
  type AndroidInternalsWikiArticle,
} from './androidInternalsWikiCorpus';

const RETRIEVABLE_STATUSES = new Set(['finalized', 'verified']);
const LICENSE = 'CC-BY-NC-SA-4.0';
const ATTRIBUTION = 'Android Internals Wiki by Gracker (CC BY-NC-SA 4.0)';
const MAX_CHUNK_CHARACTERS = 1_800;

export interface AndroidInternalsWikiIngestResult {
  sourceId: string;
  generation: string;
  revision: string;
  contentFingerprint: string;
  dirtyAcceptedArticlePaths: string[];
  indexedArticleCount: number;
  indexedChunkCount: number;
  cleanup: {
    status: 'completed' | 'failed';
    removedChunkCount: number;
    error?: string;
  };
}

function retrievableArticles(articles: readonly AndroidInternalsWikiArticle[]): AndroidInternalsWikiArticle[] {
  const seenContent = new Set<string>();
  return articles.filter(article => {
    if (!article.metadataValid) return false;
    if (!RETRIEVABLE_STATUSES.has(article.status?.toLowerCase() ?? '')) return false;
    if (seenContent.has(article.contentHash)) return false;
    seenContent.add(article.contentHash);
    return true;
  });
}

function boundedParagraphs(body: string): string[] {
  const chunks: string[] = [];
  let current = '';
  const append = (paragraph: string): void => {
    if (paragraph.length > MAX_CHUNK_CHARACTERS) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARACTERS) {
        chunks.push(paragraph.slice(offset, offset + MAX_CHUNK_CHARACTERS));
      }
      return;
    }
    const combined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (combined.length > MAX_CHUNK_CHARACTERS) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = combined;
    }
  };
  for (const paragraph of body.split(/\r?\n\s*\r?\n/).map(value => value.trim()).filter(Boolean)) {
    append(paragraph);
  }
  if (current) chunks.push(current);
  return chunks;
}

function verifiedAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class AndroidInternalsWikiIngester {
  constructor(
    private readonly store: RagStore,
    private readonly registry: ExternalKnowledgeSourceRegistry,
    private readonly gate: PathSecurityGate,
  ) {}

  async preview(rootPath: string): Promise<PathPreviewResult> {
    return this.gate.preview(rootPath);
  }

  async ingest(
    sourceId: string,
    scope: ExternalKnowledgeScope,
  ): Promise<AndroidInternalsWikiIngestResult> {
    return this.registry.withIngestLease(sourceId, scope, lease =>
      this.ingestWithLease(sourceId, scope, lease));
  }

  private async ingestWithLease(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    lease: ExternalKnowledgeIngestLeaseGuard,
  ): Promise<AndroidInternalsWikiIngestResult> {
    const access = this.registry.evaluateAccess(sourceId, scope, [sourceId]);
    if (!access.allowed) throw new Error(access.reason);
    const preview = await this.gate.preview(access.source.rootRealpath);
    if (preview.blocked) throw new Error(preview.blockedReason ?? 'knowledge_root_blocked');
    const corpus = scanAndroidInternalsWiki(preview.rootRealpath);
    const acceptedPaths = new Set(preview.acceptedFiles.map(file => file.relativePath.split('\\').join('/')));
    const blockedArticles = corpus.articles.filter(article => !acceptedPaths.has(article.relativePath));
    if (blockedArticles.length > 0) {
      throw new Error(`knowledge_path_gate_excluded_${blockedArticles.length}_articles`);
    }
    const identity = inspectAndroidInternalsWikiIdentity(corpus);
    const generation = `wiki_${createHash('sha256')
      .update(`${sourceId}\0${identity.revision}\0${identity.contentFingerprint}\0${lease.operationId}`)
      .digest('hex')
      .slice(0, 24)}`;
    const articles = retrievableArticles(corpus.articles);
    const indexedAt = Date.now();
    const chunks: RagChunk[] = [];
    for (const article of articles) {
      const paragraphs = boundedParagraphs(article.body);
      const articleVerifiedAt = verifiedAt(article.lastVerified);
      paragraphs.forEach((snippet, index) => {
        const chunkId = `wiki_${createHash('sha256')
          .update(`${generation}\0${article.relativePath}\0${index}\0${snippet}`)
          .digest('hex')}`;
        chunks.push({
          chunkId,
          kind: 'android_internals_wiki',
          registryOrigin: 'external_knowledge_registry',
          knowledgeSourceId: sourceId,
          sourceGeneration: generation,
          uri: `android-internals-wiki://${sourceId}/${identity.revision}/${article.relativePath}#${index + 1}`,
          title: article.title,
          snippet,
          indexedAt,
          license: LICENSE,
          attribution: ATTRIBUTION,
          commitHash: identity.revision,
          contentFingerprint: identity.contentFingerprint,
          filePath: article.relativePath,
          sourceStatus: article.status,
          sourceConfidence: article.confidence,
          lastVerifiedAgainst: article.lastVerifiedAgainst,
          sourceTags: article.tags,
          ...(articleVerifiedAt !== undefined ? {verifiedAt: articleVerifiedAt} : {}),
        });
      });
    }
    for (const chunk of chunks) this.store.addChunk(chunk, scope);
    this.store.flush();
    const stagedCount = this.store.listChunks({
      kind: 'android_internals_wiki',
      registryOrigin: 'external_knowledge_registry',
      scope,
    }).filter(chunk =>
      chunk.knowledgeSourceId === sourceId && chunk.sourceGeneration === generation).length;
    if (stagedCount !== chunks.length) {
      throw new Error(`staged_chunk_count_mismatch:${stagedCount}:${chunks.length}`);
    }
    const cleanupChunkIds = this.store.listChunks({
      kind: 'android_internals_wiki',
      registryOrigin: 'external_knowledge_registry',
      scope,
    }).filter(chunk =>
      chunk.knowledgeSourceId === sourceId && chunk.sourceGeneration !== generation)
      .map(chunk => chunk.chunkId);
    lease.activateGeneration({
      generation,
      revision: identity.revision,
      contentFingerprint: identity.contentFingerprint,
      dirty: identity.dirty,
      indexedArticleCount: articles.length,
      indexedChunkCount: chunks.length,
    });
    let cleanup: AndroidInternalsWikiIngestResult['cleanup'];
    try {
      cleanup = {
        status: 'completed',
        removedChunkCount: this.store.removeKnowledgeSourceChunkIds(
          sourceId,
          cleanupChunkIds,
          scope,
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[AndroidInternalsWikiIngester] Inactive generation cleanup failed: ${message}`);
      cleanup = {status: 'failed', removedChunkCount: 0, error: message};
    }
    return {
      sourceId,
      generation,
      revision: identity.revision,
      contentFingerprint: identity.contentFingerprint,
      dirtyAcceptedArticlePaths: identity.dirtyAcceptedArticlePaths,
      indexedArticleCount: articles.length,
      indexedChunkCount: chunks.length,
      cleanup,
    };
  }
}
