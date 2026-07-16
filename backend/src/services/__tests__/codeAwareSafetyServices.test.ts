// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {makeSparkProvenance, type RagChunk, type RagRetrievalResult} from '../../types/sparkContracts';
import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {CodeLookupLedger} from '../codebase/codeLookupLedger';
import {filterRagLookup} from '../rag/lookupResponseFilter';
import {SessionToolResultRegistry, projectedSidecarMissing} from '../rag/sessionToolResultRegistry';
import {projectRagResultForSseAndLog} from '../rag/toolResultProjectionFilter';
import * as toolResultProjection from '../rag/toolResultProjectionFilter';
import {clearCodeAwareOutputGuards, sanitizeCodeAwareText} from '../security/codeAwareOutputRegistry';
import {LLMEchoOutputStream, type CodeRef} from '../security/llmEchoOutputFilter';
import {ExternalKnowledgeSourceRegistry} from '../externalKnowledgeSourceRegistry';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-aware-safety-test-'));
});

afterEach(() => {
  clearCodeAwareOutputGuards('session-echo');
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function makeChunk(overrides: Partial<RagChunk> = {}): RagChunk {
  return {
    chunkId: 'chunk-app-1',
    kind: 'app_source',
    uri: 'src/MainActivity.kt',
    snippet: 'class MainActivity { val api_key = "1234567890" }',
    tokenCount: 12,
    indexedAt: 1714600000000,
    filePath: 'src/MainActivity.kt',
    lineRange: {start: 1, end: 2},
    symbol: 'MainActivity',
    language: 'kotlin',
    registryOrigin: 'codebase_registry',
    ...overrides,
  };
}

function makeRawResult(chunk: RagChunk, overrides: Partial<RagRetrievalResult> = {}): RagRetrievalResult {
  return {
    ...makeSparkProvenance({source: 'code-aware-safety-test'}),
    query: 'MainActivity launch',
    results: [{chunkId: chunk.chunkId, score: 0.91, chunk}],
    probed: [chunk.kind],
    retrievedAt: 1714600001000,
    ...overrides,
  };
}

function makeRegistry(sendToProvider: boolean): {registry: CodebaseRegistry; codebaseId: string} {
  const registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
  const root = path.join(tmpDir, 'app');
  fs.mkdirSync(root, {recursive: true});
  const ref = registry.register({
    kind: 'app_source',
    displayName: 'App',
    rootPath: root,
    sendToProvider,
    userId: 'tester',
  });
  return {registry, codebaseId: ref.codebaseId};
}

describe('CodeLookupLedger', () => {
  it('persists append-only lookup entries and restores caps', async () => {
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    const ledger = new CodeLookupLedger('session-a', 100, 1, ledgerPath);

    ledger.record({
      turn: 1,
      ts: 1714600000000,
      toolName: 'lookup_app_source',
      codebaseId: 'cb_1',
      chunkIds: ['chunk-a'],
      consentApplied: true,
      tokensSpent: 12,
      outcome: 'success',
      legacyPath: false,
    });
    ledger.record({
      turn: 2,
      ts: 1714600001000,
      toolName: 'propose_patch',
      codebaseId: 'cb_1',
      chunkIds: ['chunk-a'],
      consentApplied: true,
      tokensSpent: 0,
      outcome: 'patch_sketch',
      legacyPath: false,
    });
    await ledger.flush();

    const restored = CodeLookupLedger.restore('session-a', 100, 1, ledgerPath);
    expect(restored.hasPriorLookupOf('chunk-a')).toBe(true);
    expect(restored.hasSuccessfulCodeLookup()).toBe(true);
    expect(restored.remainingTokens()).toBe(88);
    expect(restored.remainingPatches()).toBe(0);
    expect(restored.toSnapshotSummary()).toEqual({
      lookupCount: 1,
      patchCount: 1,
      referencedCodebaseIds: ['cb_1'],
    });
    expect(fs.readFileSync(ledgerPath, 'utf-8').trim().split('\n')).toHaveLength(2);
  });
});

describe('filterRagLookup', () => {
  it('redacts secrets and records successful user codebase lookups when consent allows provider send', async () => {
    const {registry, codebaseId} = makeRegistry(true);
    const ledger = new CodeLookupLedger('session-b', 1000, 1, path.join(tmpDir, 'ledger-b.jsonl'));
    const result = await filterRagLookup(
      makeRawResult(makeChunk({codebaseId})),
      {toolName: 'lookup_app_source', turn: 1, codebaseRegistry: registry, ledger},
    );
    await ledger.flush();

    expect(result.legacyPath).toBe(false);
    expect(result.hits[0]?.snippet).toContain('[REDACTED_SECRET]');
    expect(result.hits[0]?.snippet).not.toContain('1234567890');
    expect(result.hits[0]?.redactedCount).toBe(1);
    expect(ledger.hasSuccessfulCodeLookup()).toBe(true);
  });

  it('registers returned snippets with the output echo guard', async () => {
    const {registry, codebaseId} = makeRegistry(true);
    const ledger = new CodeLookupLedger('session-echo', 1000, 1, path.join(tmpDir, 'ledger-echo.jsonl'));
    await filterRagLookup(
      makeRawResult(makeChunk({
        codebaseId,
        snippet: 'fun guardedLaunchPath() = Unit',
        symbol: 'guardedLaunchPath',
      })),
      {
        toolName: 'lookup_app_source',
        turn: 1,
        codebaseRegistry: registry,
        ledger,
        sessionId: 'session-echo',
      },
    );
    await ledger.flush();

    const sanitized = sanitizeCodeAwareText('session-echo', 'Model echoed: fun guardedLaunchPath() = Unit');
    expect(sanitized).not.toContain('fun guardedLaunchPath()');
    expect(sanitized).toContain('Code: guardedLaunchPath');
  });

  it('returns metadata-only hits when provider-send consent is absent', async () => {
    const {registry, codebaseId} = makeRegistry(false);
    const ledger = new CodeLookupLedger('session-c', 1000, 1, path.join(tmpDir, 'ledger-c.jsonl'));
    const result = await filterRagLookup(
      makeRawResult(makeChunk({codebaseId})),
      {toolName: 'lookup_app_source', turn: 1, codebaseRegistry: registry, ledger},
    );
    await ledger.flush();

    expect(result.hits[0]?.snippet).toBeUndefined();
    expect(result.hits[0]?.unsupportedReason).toBe('no_send_to_provider_consent');
    expect(ledger.getEntries()[0]?.outcome).toBe('consent_blocked');
  });

  it('keeps legacy knowledge snippets on the legacy path', async () => {
    const ledger = new CodeLookupLedger('session-d', 1000, 1, path.join(tmpDir, 'ledger-d.jsonl'));
    const legacyChunk = makeChunk({
      chunkId: 'legacy-blog',
      kind: 'androidperformance.com',
      uri: 'https://androidperformance.com/article',
      snippet: 'legacy article text with api_key = "1234567890"',
      registryOrigin: 'legacy_plan55',
      codebaseId: undefined,
    });
    const result = await filterRagLookup(
      makeRawResult(legacyChunk),
      {toolName: 'lookup_blog_knowledge', turn: 1, ledger},
    );
    await ledger.flush();

    expect(result.legacyPath).toBe(true);
    expect(result.hits[0]?.snippet).toBe('legacy article text with api_key = "1234567890"');
    expect(ledger.getEntries()[0]).toEqual(expect.objectContaining({
      outcome: 'success',
      legacyPath: true,
      consentApplied: false,
    }));
  });

  it('rechecks private knowledge consent and returns attributed redacted snippets', async () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'external-sources.json'));
    const root = path.join(tmpDir, 'wiki');
    fs.mkdirSync(root);
    const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
    const source = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: root,
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-a',
      scope,
    });
    await registry.withIngestLease(source.sourceId, scope, lease =>
      lease.activateGeneration({
        generation: 'generation-a',
        revision: source.revision,
        contentFingerprint: source.contentFingerprint,
        dirty: false,
        indexedArticleCount: 1,
        indexedChunkCount: 1,
      }));
    const chunk = makeChunk({
      chunkId: 'wiki-1',
      kind: 'android_internals_wiki',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: source.sourceId,
      sourceGeneration: 'generation-a',
      uri: `android-internals-wiki://${source.sourceId}/article`,
      title: 'Handler internals',
      snippet: 'Handler callback with api_key = "1234567890"',
      filePath: 'src/handler.md',
      license: 'CC-BY-NC-SA-4.0',
      attribution: 'Android Internals Wiki by Gracker (CC BY-NC-SA 4.0)',
      sourceStatus: 'finalized',
      sourceConfidence: 'high',
      commitHash: source.revision,
      contentFingerprint: source.contentFingerprint,
      codebaseId: undefined,
    });

    const result = await filterRagLookup(makeRawResult(chunk), {
      toolName: 'lookup_blog_knowledge',
      turn: 1,
      externalKnowledgeRegistry: registry,
      knowledgeSourceIds: [source.sourceId],
      knowledgeScope: scope,
    } as any);

    expect(result.legacyPath).toBe(false);
    expect(result.hits[0]?.snippet).toContain('[REDACTED_SECRET]');
    expect(result.hits[0]?.metadata).toEqual(expect.objectContaining({
      kind: 'android_internals_wiki',
      title: 'Handler internals',
      license: 'CC-BY-NC-SA-4.0',
      attribution: 'Android Internals Wiki by Gracker (CC BY-NC-SA 4.0)',
      sourceStatus: 'finalized',
      sourceConfidence: 'high',
    }));
  });
});

describe('tool result projection and session registry', () => {
  it('projects sanitized RAG snippets to hashes for SSE/log payloads', () => {
    const projected = projectRagResultForSseAndLog('lookup_app_source', {
      query: 'MainActivity',
      probed: ['app_source'],
      retrievedAt: 1714600000000,
      legacyPath: false,
      hits: [{
        chunkId: 'chunk-app-1',
        score: 0.9,
        metadata: {kind: 'app_source', codebaseId: 'cb_1'},
        snippet: 'secret source line',
        redactedCount: 0,
      }],
    });

    expect(projected.chunkRefs[0]).toEqual(expect.objectContaining({
      chunkId: 'chunk-app-1',
      codebaseId: 'cb_1',
      kind: 'app_source',
      snippetHash: expect.any(String),
      snippetLength: 18,
    }));
    expect(JSON.stringify(projected)).not.toContain('secret source line');
  });

  it('extracts a private wiki MCP result into a snippet-free shared sidecar', () => {
    const project = (toolResultProjection as any).projectPrivateKnowledgeToolResult;
    const raw = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          result: {
            query: 'Handler',
            probed: ['android_internals_wiki'],
            retrievedAt: 1714600000000,
            legacyPath: false,
            hits: [{
              chunkId: 'wiki-1',
              score: 0.9,
              metadata: {
                kind: 'android_internals_wiki',
                knowledgeSourceId: 'source-a',
                title: 'PRIVATE_WIKI_TITLE_CANARY',
                uri: 'android-internals-wiki://source-a/PRIVATE_WIKI_PATH_CANARY',
                attribution: 'Android Internals Wiki (CC BY-NC-SA 4.0)',
              },
              snippet: 'PRIVATE_WIKI_TOOL_RESULT',
            }],
          },
        }),
      }],
    };

    const sidecar = project('lookup_blog_knowledge', raw);

    expect(sidecar).toEqual(expect.objectContaining({
      toolName: 'lookup_blog_knowledge',
      chunkRefs: [expect.objectContaining({
        chunkId: 'wiki-1',
        kind: 'android_internals_wiki',
        snippetHash: expect.any(String),
        snippetLength: 24,
      })],
    }));
    expect(JSON.stringify(sidecar)).not.toContain('PRIVATE_WIKI_TOOL_RESULT');
    expect(JSON.stringify(sidecar)).not.toContain('PRIVATE_WIKI_TITLE_CANARY');
    expect(JSON.stringify(sidecar)).not.toContain('PRIVATE_WIKI_PATH_CANARY');
    expect(sidecar.chunkRefs[0].attribution).toContain('CC BY-NC-SA');
  });

  it('keeps runtime tool results namespaced by session/run/runtime/invocation', () => {
    const registry = new SessionToolResultRegistry();
    const target = {sessionId: 's1', runId: 'r1', runtime: 'openai' as const, invocationId: 'tool-1'};
    const alias = {sessionId: 's1', runId: 'r1', runtime: 'claude' as const, invocationId: 'tool-1'};
    const sidecar = projectedSidecarMissing('lookup_app_source');
    registry.put(target, {llmPayload: {content: 'provider payload'}, sidecar});
    registry.alias(alias, target);

    expect(registry.getSidecar(alias)).toEqual(sidecar);
    expect(registry.getLlmPayload(target)).toEqual({content: 'provider payload'});

    registry.clearRun('s1', 'r1');
    expect(registry.getSidecar(target)).toBeUndefined();
    expect(registry.getSidecar(alias)).toBeUndefined();
  });
});

describe('LLMEchoOutputStream', () => {
  it('replaces exact code echoes with source references and never stores raw snippets in stats', () => {
    const stream = new LLMEchoOutputStream();
    const ref: CodeRef = {
      chunkId: 'chunk-app-1',
      codebaseId: 'cb_1',
      filePath: 'src/MainActivity.kt',
      lineRange: {start: 10, end: 12},
      symbol: 'MainActivity.onCreate',
    };
    stream.registerSnippet('val launchPath = computeLaunchPath()', ref);

    const output = stream.write('The answer is val launchPath = computeLaunchPath()') + stream.flush();
    expect(output).not.toContain('computeLaunchPath()');
    expect(output).toContain('[Code: MainActivity.onCreate @ src/MainActivity.kt:10-12]');
    expect(JSON.stringify(stream.stats())).not.toContain('computeLaunchPath()');
    expect(stream.stats().hits[0]).toEqual(expect.objectContaining({
      patternKind: 'exact',
      codeRef: ref,
    }));
  });

  it('redacts canary echoes across streamed chunks', () => {
    const stream = new LLMEchoOutputStream(16);
    stream.registerCanary('CANARY-DO-NOT-EMIT');

    const output =
      stream.write('prefix CANARY-') +
      stream.write('DO-NOT-EMIT suffix') +
      stream.flush();
    expect(output).not.toContain('CANARY-DO-NOT-EMIT');
    expect(output).toContain('[REDACTED_CODE_ECHO]');
  });
});
