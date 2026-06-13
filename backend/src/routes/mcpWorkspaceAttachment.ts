// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

import type {CodebaseRegistry} from '../services/codebase/codebaseRegistry';
import type {AppSourceIngester, AppSourceIngestResult} from '../services/rag/appSourceIngester';

export interface McpWorkspaceRequestContext {
  tenantId: string;
  workspaceId: string;
  userId: string;
}

export interface ResolvedWorkspaceAttachmentPaths {
  workspaceRoot: string;
  workspaceRootRealpath: string;
  traceFilePath: string;
  traceFileRealpath: string;
}

export interface EnsureWorkspaceCodebaseInput {
  workspaceRoot: string;
  registry: CodebaseRegistry;
  ingester: AppSourceIngester;
  context: McpWorkspaceRequestContext;
}

export interface EnsureWorkspaceCodebaseResult {
  codebaseId: string;
  ingested: boolean;
  ingestResult?: AppSourceIngestResult;
}

function assertInsideRoot(rootRealpath: string, targetRealpath: string): void {
  const relative = path.relative(rootRealpath, targetRealpath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('filePath must point to a trace file inside workspaceId');
  }
}

async function realpathOrThrow(target: string, label: string): Promise<string> {
  try {
    return await fsPromises.realpath(target);
  } catch {
    throw new Error(`${label} not found: ${target}`);
  }
}

export async function resolveWorkspaceAttachmentPaths(input: {
  workspaceId: string;
  filePath: string;
}): Promise<ResolvedWorkspaceAttachmentPaths> {
  const workspaceRoot = path.resolve(input.workspaceId);
  const traceFilePath = path.isAbsolute(input.filePath)
    ? path.resolve(input.filePath)
    : path.resolve(workspaceRoot, input.filePath);

  const workspaceRootRealpath = await realpathOrThrow(workspaceRoot, 'workspaceId');
  const traceFileRealpath = await realpathOrThrow(traceFilePath, 'filePath');
  const workspaceStat = await fsPromises.stat(workspaceRootRealpath);
  if (!workspaceStat.isDirectory()) {
    throw new Error(`workspaceId must be a directory: ${input.workspaceId}`);
  }
  const traceStat = await fsPromises.stat(traceFileRealpath);
  if (!traceStat.isFile()) {
    throw new Error(`filePath must be a file: ${input.filePath}`);
  }
  assertInsideRoot(workspaceRootRealpath, traceFileRealpath);
  return {
    workspaceRoot,
    workspaceRootRealpath,
    traceFilePath,
    traceFileRealpath,
  };
}

export async function ensureWorkspaceCodebase(
  input: EnsureWorkspaceCodebaseInput,
): Promise<EnsureWorkspaceCodebaseResult> {
  const workspaceRootRealpath = fs.realpathSync(input.workspaceRoot);
  const existing = input.registry.findByRootRealpath(
    'app_source',
    workspaceRootRealpath,
    input.context,
  );
  if (existing) {
    if (existing.lastIngestStatus !== 'ok' || (existing.chunkCount ?? 0) <= 0) {
      const ingestResult = await input.ingester.ingest(existing.codebaseId);
      return {
        codebaseId: existing.codebaseId,
        ingested: true,
        ingestResult,
      };
    }
    return {
      codebaseId: existing.codebaseId,
      ingested: false,
    };
  }

  const ref = input.registry.register({
    kind: 'app_source',
    displayName: path.basename(workspaceRootRealpath) || workspaceRootRealpath,
    rootPath: input.workspaceRoot,
    rootRealpath: workspaceRootRealpath,
    sendToProvider: false,
    consentedBy: input.context.userId,
    tenantId: input.context.tenantId,
    workspaceId: input.context.workspaceId,
    userId: input.context.userId,
  });
  const ingestResult = await input.ingester.ingest(ref.codebaseId);
  return {
    codebaseId: ref.codebaseId,
    ingested: true,
    ingestResult,
  };
}
