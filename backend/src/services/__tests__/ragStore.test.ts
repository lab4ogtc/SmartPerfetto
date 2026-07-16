// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';

import {RagStore, getDefaultRagStore, ragStoreRequiresLicense} from '../ragStore';
import type {RagChunk} from '../../types/sparkContracts';

let tmpDir: string;
let storagePath: string;
const PRIVATE_SCOPE = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-store-test-'));
  storagePath = path.join(tmpDir, 'store.json');
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

function makeChunk(overrides: Partial<RagChunk> = {}): RagChunk {
  return {
    chunkId: 'sha256:test001',
    kind: 'androidperformance.com',
    uri: 'https://androidperformance.com/binder',
    snippet: 'binder transactions reveal cross-process latency',
    indexedAt: 1714600000000,
    ...overrides,
  };
}

describe('RagStore — basic CRUD', () => {
  it('shares one default store between admin ingestion and runtime lookup', () => {
    expect(getDefaultRagStore()).toBe(getDefaultRagStore());
  });

  it('adds and reads back a chunk', () => {
    const store = new RagStore(storagePath);
    const chunk = makeChunk({chunkId: 'a'});
    store.addChunk(chunk);
    expect(store.getChunk('a')).toEqual({
      ...chunk,
      registryOrigin: 'legacy_plan55',
    });
  });

  it('returns undefined for an unknown chunkId', () => {
    const store = new RagStore(storagePath);
    expect(store.getChunk('nope')).toBeUndefined();
  });

  it('removeChunk returns true when present, false otherwise', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({chunkId: 'a'}));
    expect(store.removeChunk('a')).toBe(true);
    expect(store.removeChunk('a')).toBe(false);
  });

  it('replaces a chunk on re-add with the same chunkId', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({chunkId: 'a', snippet: 'old'}));
    store.addChunk(makeChunk({chunkId: 'a', snippet: 'new'}));
    expect(store.getChunk('a')?.snippet).toBe('new');
  });
});

describe('RagStore — license gate', () => {
  it('rejects aosp chunks without a license', () => {
    const store = new RagStore(storagePath);
    expect(() =>
      store.addChunk(makeChunk({chunkId: 'a', kind: 'aosp'})),
    ).toThrow(/license/i);
  });

  it('rejects oem_sdk chunks without a license', () => {
    const store = new RagStore(storagePath);
    expect(() =>
      store.addChunk(makeChunk({chunkId: 'a', kind: 'oem_sdk'})),
    ).toThrow(/license/i);
  });

  it('rejects Android Internals Wiki chunks without a license', () => {
    const store = new RagStore(storagePath);
    expect(() =>
      store.addChunk(makeChunk({
        chunkId: 'wiki-a',
        kind: 'android_internals_wiki' as RagChunk['kind'],
      })),
    ).toThrow(/license/i);
  });

  it('accepts aosp chunks with Apache-2.0 license', () => {
    const store = new RagStore(storagePath);
    expect(() =>
      store.addChunk(
        makeChunk({chunkId: 'a', kind: 'aosp', license: 'Apache-2.0'}),
      ),
    ).not.toThrow();
  });

  it('blog chunks are not gated by license', () => {
    const store = new RagStore(storagePath);
    expect(() => store.addChunk(makeChunk())).not.toThrow();
  });

  it('ragStoreRequiresLicense reports the right kinds', () => {
    expect(ragStoreRequiresLicense('aosp')).toBe(true);
    expect(ragStoreRequiresLicense('oem_sdk')).toBe(true);
    expect(ragStoreRequiresLicense('kernel_source')).toBe(true);
    expect(ragStoreRequiresLicense('androidperformance.com')).toBe(false);
    expect(ragStoreRequiresLicense('project_memory')).toBe(false);
    expect(ragStoreRequiresLicense('world_memory')).toBe(false);
    expect(ragStoreRequiresLicense('case_library')).toBe(false);
    expect(ragStoreRequiresLicense('app_source')).toBe(false);
  });
});

describe('RagStore — persistence', () => {
  it('persists across instances at the same path', () => {
    const store1 = new RagStore(storagePath);
    store1.addChunk(makeChunk({chunkId: 'a', snippet: 'persisted'}));
    store1.flush();

    const store2 = new RagStore(storagePath);
    expect(store2.getChunk('a')?.snippet).toBe('persisted');
  });

  it('merges interleaved writers instead of overwriting a stale in-memory snapshot', () => {
    const first = new RagStore(storagePath);
    const second = new RagStore(storagePath);
    first.addChunk(makeChunk({chunkId: 'first', snippet: 'first writer'}));
    second.addChunk(makeChunk({chunkId: 'second', snippet: 'second writer'}));

    first.flush();
    second.flush();

    expect(new RagStore(storagePath).listChunks().map(chunk => chunk.chunkId).sort())
      .toEqual(['first', 'second']);
  });

  it('persisted file is valid JSON with schemaVersion 2', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({chunkId: 'a'}));
    store.flush();
    const raw = fs.readFileSync(storagePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.chunks).toHaveLength(1);
  });

  it('does not crash on a missing storage file', () => {
    const store = new RagStore(path.join(tmpDir, 'absent.json'));
    expect(store.getChunk('a')).toBeUndefined();
  });

  it('survives a corrupted on-disk JSON without losing the file', () => {
    fs.writeFileSync(storagePath, 'not-json{', 'utf-8');
    const store = new RagStore(storagePath);
    expect(store.getChunk('a')).toBeUndefined();
    // Corrupted file is preserved for operator inspection.
    expect(fs.existsSync(storagePath)).toBe(true);
    // After recovery the store still accepts new writes.
    store.addChunk(makeChunk({chunkId: 'a'}));
    expect(store.getChunk('a')).toBeDefined();
  });

  it('atomic write does not leave the temp file around on success', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({chunkId: 'a'}));
    expect(fs.existsSync(`${storagePath}.tmp`)).toBe(false);
  });

  it('backfills schemaVersion 1 legacy chunks with registryOrigin', () => {
    fs.writeFileSync(storagePath, JSON.stringify({
      schemaVersion: 1,
      chunks: [
        makeChunk({chunkId: 'blog-v1'}),
        makeChunk({chunkId: 'case-v1', kind: 'case_library'}),
      ],
    }), 'utf-8');
    const store = new RagStore(storagePath);
    expect(store.getChunk('blog-v1')?.registryOrigin).toBe('legacy_plan55');
    expect(store.getChunk('case-v1')?.registryOrigin).toBe('plan54_cases');
  });

  it('rejects code-aware chunks without codebase metadata', () => {
    const store = new RagStore(storagePath);
    expect(() => store.addChunk(makeChunk({
      chunkId: 'bad-app',
      kind: 'app_source',
      uri: 'src/MainActivity.kt',
      snippet: 'class MainActivity',
    }))).toThrow(/codebaseId/i);
  });
});

describe('RagStore — search', () => {
  function seed(store: RagStore): void {
    store.addChunk(
      makeChunk({
        chunkId: 'b1',
        kind: 'androidperformance.com',
        title: 'Binder transactions',
        snippet: 'binder transactions reveal cross-process latency',
      }),
    );
    store.addChunk(
      makeChunk({
        chunkId: 'b2',
        kind: 'androidperformance.com',
        title: 'Frame timeline',
        snippet: 'frame timeline tells the truth about jank',
      }),
    );
    store.addChunk(
      makeChunk({
        chunkId: 'a1',
        kind: 'aosp',
        license: 'Apache-2.0',
        title: 'HwcLayer',
        snippet: 'composition fallback path lives in HwcLayer',
      }),
    );
  }

  it('returns ranked hits matching the query tokens', () => {
    const store = new RagStore(storagePath);
    seed(store);
    const result = store.search('binder transactions');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].chunkId).toBe('b1');
  });

  it('matches Chinese knowledge with Unicode-aware tokens', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({
      chunkId: 'zh-handler',
      title: 'Looper 与消息队列',
      snippet: '主线程消息队列阻塞会推迟 Handler 分发',
    }));

    const result = store.search('消息队列阻塞');

    expect(result.results[0]?.chunkId).toBe('zh-handler');
  });

  it('splits adjacent Latin and Han runs for mixed Android queries', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({
      chunkId: 'mixed-handler',
      title: 'Android消息队列',
      snippet: 'Looper分发callback',
    }));

    expect(store.search('消息队列').results[0]?.chunkId).toBe('mixed-handler');
    expect(store.search('Android').results[0]?.chunkId).toBe('mixed-handler');
  });

  it('respects topK', () => {
    const store = new RagStore(storagePath);
    seed(store);
    const result = store.search(
      'binder transaction frame timeline composition',
      {topK: 1},
    );
    expect(result.results).toHaveLength(1);
  });

  it('respects the kind filter', () => {
    const store = new RagStore(storagePath);
    seed(store);
    const result = store.search('composition', {kinds: ['aosp']});
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every(r => r.chunk?.kind === 'aosp')).toBe(true);
  });

  it('searches only the request-scoped active private knowledge generation', () => {
    const store = new RagStore(storagePath);
    const wiki = (overrides: Record<string, unknown>) => makeChunk({
      kind: 'android_internals_wiki' as RagChunk['kind'],
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry' as RagChunk['registryOrigin'],
      snippet: '消息队列 Handler callback',
      ...(overrides as Partial<RagChunk>),
    });
    store.addChunk(
      wiki({chunkId: 'old', knowledgeSourceId: 'source-a', sourceGeneration: 'gen-1'}),
      PRIVATE_SCOPE,
    );
    store.addChunk(
      wiki({chunkId: 'new', knowledgeSourceId: 'source-a', sourceGeneration: 'gen-2'}),
      PRIVATE_SCOPE,
    );
    store.addChunk(
      wiki({chunkId: 'other', knowledgeSourceId: 'source-b', sourceGeneration: 'gen-2'}),
      PRIVATE_SCOPE,
    );

    const result = store.search('Handler', {
      kinds: ['android_internals_wiki' as RagChunk['kind']],
      knowledgeSourceIds: ['source-a'],
      activeSourceGenerations: {'source-a': 'gen-2'},
      scope: PRIVATE_SCOPE,
    });

    expect(result.results.map(hit => hit.chunkId)).toEqual(['new']);
  });

  it('removes every generation for one private knowledge source in one operation', () => {
    const store = new RagStore(storagePath);
    const wiki = (chunkId: string, sourceId: string, generation: string) => makeChunk({
      chunkId,
      kind: 'android_internals_wiki',
      uri: `android-internals-wiki://${sourceId}/${chunkId}`,
      snippet: 'Handler callback',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: sourceId,
      sourceGeneration: generation,
    });
    store.addChunk(wiki('old', 'source-a', 'gen-1'), PRIVATE_SCOPE);
    store.addChunk(wiki('new', 'source-a', 'gen-2'), PRIVATE_SCOPE);
    store.addChunk(wiki('other', 'source-b', 'gen-1'), PRIVATE_SCOPE);
    store.flush();

    expect(store.removeKnowledgeSourceChunks('source-a', PRIVATE_SCOPE)).toBe(2);
    expect(store.listChunks({scope: PRIVATE_SCOPE}).map(chunk => chunk.chunkId)).toEqual(['other']);
  });

  it('removes only inactive generations for one private knowledge source', () => {
    const store = new RagStore(storagePath);
    const wiki = (chunkId: string, sourceId: string, generation: string) => makeChunk({
      chunkId,
      kind: 'android_internals_wiki',
      uri: `android-internals-wiki://${sourceId}/${chunkId}`,
      snippet: 'Handler callback',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: sourceId,
      sourceGeneration: generation,
    });
    store.addChunk(wiki('old', 'source-a', 'gen-1'), PRIVATE_SCOPE);
    store.addChunk(wiki('active', 'source-a', 'gen-2'), PRIVATE_SCOPE);
    store.addChunk(wiki('other', 'source-b', 'gen-1'), PRIVATE_SCOPE);
    store.flush();

    expect(store.removeInactiveKnowledgeSourceChunks('source-a', 'gen-2', PRIVATE_SCOPE)).toBe(1);
    expect(store.listChunks({scope: PRIVATE_SCOPE}).map(chunk => chunk.chunkId)).toEqual([
      'active',
      'other',
    ]);
  });

  it('removes only an exact private-chunk snapshot during fenced cleanup', () => {
    const store = new RagStore(storagePath);
    const wiki = (chunkId: string, sourceId: string, generation: string) => makeChunk({
      chunkId,
      kind: 'android_internals_wiki',
      uri: `android-internals-wiki://${sourceId}/${chunkId}`,
      snippet: 'Handler callback',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: sourceId,
      sourceGeneration: generation,
    });
    store.addChunk(wiki('snapshot-old', 'source-a', 'gen-1'), PRIVATE_SCOPE);
    store.addChunk(wiki('later-active', 'source-a', 'gen-2'), PRIVATE_SCOPE);
    store.addChunk(wiki('same-id-other-source', 'source-b', 'gen-1'), PRIVATE_SCOPE);
    store.flush();

    expect(store.removeKnowledgeSourceChunkIds(
      'source-a',
      ['snapshot-old', 'same-id-other-source'],
      PRIVATE_SCOPE,
    )).toBe(1);
    expect(store.listChunks({scope: PRIVATE_SCOPE}).map(chunk => chunk.chunkId)).toEqual([
      'later-active',
      'same-id-other-source',
    ]);
  });

  it('fails closed across tenant, workspace, and user scope in the legacy store', () => {
    const store = new RagStore(storagePath);
    const chunk = makeChunk({
      chunkId: 'private-a',
      kind: 'android_internals_wiki',
      uri: 'android-internals-wiki://source-a/private-a',
      snippet: 'PRIVATE_SCOPE_CANARY Handler callback',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: 'source-a',
      sourceGeneration: 'gen-1',
    });
    store.addChunk(chunk, PRIVATE_SCOPE);

    const otherUser = {...PRIVATE_SCOPE, userId: 'user-b'};
    expect(store.getChunk('private-a', PRIVATE_SCOPE)?.snippet).toContain('PRIVATE_SCOPE_CANARY');
    expect(store.getChunk('private-a', otherUser)).toBeUndefined();
    expect(store.getChunk('private-a')).toBeUndefined();
    expect(store.listChunks({scope: otherUser})).toEqual([]);
    expect(store.getStats(otherUser).android_internals_wiki.chunkCount).toBe(0);
    expect(store.search('Handler', {
      kinds: ['android_internals_wiki'],
      knowledgeSourceIds: ['source-a'],
      activeSourceGenerations: {'source-a': 'gen-1'},
      scope: otherUser,
    }).results).toEqual([]);
  });

  it('supports codebase metadata filters and rank tiers', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({
      chunkId: 'app-main',
      kind: 'app_source',
      uri: 'launch-aosp/src/main/java/com/example/launch/aosp/MainActivity.kt',
      snippet: 'simulate async network load during startup',
      codebaseId: 'codebase-1',
      registryOrigin: 'codebase_registry',
      filePath: 'launch-aosp/src/main/java/com/example/launch/aosp/MainActivity.kt',
      lineRange: {start: 22, end: 140},
      symbol: 'MainActivity',
      language: 'kotlin',
    }));
    store.addChunk(makeChunk({
      chunkId: 'app-load',
      kind: 'app_source',
      uri: 'launch-common/src/main/java/com/example/launch/common/LoadSimulator.kt',
      snippet: 'Application init blocking load simulator',
      codebaseId: 'codebase-1',
      registryOrigin: 'codebase_registry',
      filePath: 'launch-common/src/main/java/com/example/launch/common/LoadSimulator.kt',
      lineRange: {start: 1, end: 80},
      symbol: 'LoadSimulator',
      language: 'kotlin',
    }));

    const result = store.search('startup load', {
      kinds: ['app_source'],
      codebaseIds: ['codebase-1'],
      symbolExact: 'MainActivity',
      languages: ['kotlin'],
    });

    expect(result.results[0].chunkId).toBe('app-main');
    expect(result.results.every(hit => hit.chunk?.codebaseId === 'codebase-1')).toBe(true);
  });

  it('skips chunks with unsupportedReason', () => {
    const store = new RagStore(storagePath);
    store.addChunk(
      makeChunk({
        chunkId: 'blocked',
        snippet: 'binder transactions',
        unsupportedReason: 'license expired',
      }),
    );
    store.addChunk(
      makeChunk({chunkId: 'visible', snippet: 'binder transactions'}),
    );
    const result = store.search('binder transactions');
    expect(result.results.find(r => r.chunkId === 'blocked')).toBeUndefined();
    expect(result.results.find(r => r.chunkId === 'visible')).toBeDefined();
  });

  it('reports retrieval-level unsupportedReason for an empty index', () => {
    const store = new RagStore(storagePath);
    const result = store.search('anything');
    expect(result.unsupportedReason).toBe('index empty');
    expect(result.results).toHaveLength(0);
  });

  it('reports retrieval-level unsupportedReason when every chunk is blocked', () => {
    const store = new RagStore(storagePath);
    store.addChunk(
      makeChunk({
        chunkId: 'blocked-1',
        snippet: 'binder transactions',
        unsupportedReason: 'license expired',
      }),
    );
    const result = store.search('binder');
    expect(result.unsupportedReason).toBe(
      'all chunks blocked by unsupportedReason',
    );
    expect(result.results).toHaveLength(0);
  });

  it('zero-match legitimate query has no unsupportedReason', () => {
    const store = new RagStore(storagePath);
    seed(store);
    const result = store.search('completely unrelated zzzqxzqq');
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.results).toHaveLength(0);
  });

  it('search result carries spark provenance and the query string', () => {
    const store = new RagStore(storagePath);
    seed(store);
    const result = store.search('binder');
    expect(result.schemaVersion).toBe(1);
    expect(result.source).toBe('ragStore.search');
    expect(result.createdAt).toBeGreaterThan(0);
    expect(result.retrievedAt).toBeGreaterThan(0);
    expect(result.query).toBe('binder');
  });
});

describe('RagStore — stats', () => {
  it('tracks per-kind chunk counts and lastIndexedAt', () => {
    const store = new RagStore(storagePath);
    store.addChunk(
      makeChunk({chunkId: 'b1', kind: 'androidperformance.com', indexedAt: 100}),
    );
    store.addChunk(
      makeChunk({chunkId: 'b2', kind: 'androidperformance.com', indexedAt: 200}),
    );
    store.addChunk(
      makeChunk({
        chunkId: 'a1',
        kind: 'aosp',
        license: 'Apache-2.0',
        indexedAt: 300,
      }),
    );
    const stats = store.getStats();
    expect(stats['androidperformance.com'].chunkCount).toBe(2);
    expect(stats['androidperformance.com'].lastIndexedAt).toBe(200);
    expect(stats.aosp.chunkCount).toBe(1);
    expect(stats.aosp.lastIndexedAt).toBe(300);
    expect(stats.oem_sdk.chunkCount).toBe(0);
    expect(stats.app_source.chunkCount).toBe(0);
    expect(stats.kernel_source.chunkCount).toBe(0);
  });
});
