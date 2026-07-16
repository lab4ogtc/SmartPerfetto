// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import type {RagSourceKind} from '../../types/sparkContracts';
import type {CodeLookupOutcome} from '../codebase/codeLookupLedger';
import type {SanitizedRagResult} from './lookupResponseFilter';

export interface ProjectedPayload {
  toolName: string;
  chunkRefs: Array<{
    chunkId: string;
    codebaseId?: string;
    knowledgeSourceId?: string;
    kind: RagSourceKind;
    title?: string;
    uri?: string;
    license?: string;
    attribution?: string;
    sourceStatus?: string;
    sourceConfidence?: string;
    lastVerifiedAgainst?: string;
    commitHash?: string;
    snippetHash?: string;
    snippetLength?: number;
    redactedCount?: number;
  }>;
  outcome: CodeLookupOutcome;
  legacyPath: boolean;
}

function hashSnippet(snippet: string): string {
  return createHash('sha256').update(snippet).digest('hex').slice(0, 12);
}

export function projectRagResultForSseAndLog(toolName: string, result: SanitizedRagResult): ProjectedPayload {
  let outcome: CodeLookupOutcome = 'success';
  const chunkRefs = result.hits.map(hit => {
    if (hit.unsupportedReason) outcome = hit.unsupportedReason === 'budget_exceeded'
      ? 'budget_exceeded'
      : 'rejected';
    const privateWiki = hit.metadata?.kind === 'android_internals_wiki';
    return {
      chunkId: hit.chunkId,
      ...(hit.metadata?.codebaseId ? {codebaseId: hit.metadata.codebaseId} : {}),
      ...(hit.metadata?.knowledgeSourceId
        ? {knowledgeSourceId: hit.metadata.knowledgeSourceId}
        : {}),
      kind: hit.metadata?.kind ?? 'androidperformance.com',
      ...(!privateWiki && hit.metadata?.title ? {title: hit.metadata.title} : {}),
      ...(!privateWiki && hit.metadata?.uri ? {uri: hit.metadata.uri} : {}),
      ...(hit.metadata?.license ? {license: hit.metadata.license} : {}),
      ...(hit.metadata?.attribution ? {attribution: hit.metadata.attribution} : {}),
      ...(hit.metadata?.sourceStatus ? {sourceStatus: hit.metadata.sourceStatus} : {}),
      ...(hit.metadata?.sourceConfidence
        ? {sourceConfidence: hit.metadata.sourceConfidence}
        : {}),
      ...(hit.metadata?.lastVerifiedAgainst
        ? {lastVerifiedAgainst: hit.metadata.lastVerifiedAgainst}
        : {}),
      ...(hit.metadata?.commitHash ? {commitHash: hit.metadata.commitHash} : {}),
      ...(hit.snippet ? {snippetHash: hashSnippet(hit.snippet), snippetLength: hit.snippet.length} : {}),
      ...(hit.redactedCount !== undefined ? {redactedCount: hit.redactedCount} : {}),
    };
  });
  return {
    toolName,
    chunkRefs,
    outcome,
    legacyPath: result.legacyPath,
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function unwrapMcpPayload(raw: unknown): unknown {
  const direct = parseJson(raw);
  if (!direct || typeof direct !== 'object') return direct;
  const content = (direct as {content?: unknown}).content;
  if (Array.isArray(content)) {
    const text = content.find(block =>
      block && typeof block === 'object' && (block as {type?: unknown}).type === 'text') as
      {text?: unknown} | undefined;
    if (text) return parseJson(text.text);
  }
  return direct;
}

/**
 * Extract a sanitized private-knowledge result from provider-specific tool
 * output envelopes. Returns undefined for public/non-RAG results so runtimes
 * preserve their existing summaries byte-for-byte.
 */
export function projectPrivateKnowledgeToolResult(
  toolName: string,
  raw: unknown,
): ProjectedPayload | undefined {
  const payload = unwrapMcpPayload(raw);
  if (!payload || typeof payload !== 'object') return undefined;
  const candidate = (payload as {result?: unknown}).result ?? payload;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const result = candidate as SanitizedRagResult;
  if (!Array.isArray(result.hits)) return undefined;
  if (!result.hits.some(hit => hit.metadata?.kind === 'android_internals_wiki')) {
    return undefined;
  }
  return projectRagResultForSseAndLog(toolName, result);
}
