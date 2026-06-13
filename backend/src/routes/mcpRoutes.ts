// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'node:crypto';
import express from 'express';
import {z} from 'zod';
import * as fsPromises from 'fs/promises';

import {ArtifactStore} from '../agentv3/artifactStore';
import {createClaudeMcpServer, getRagStore} from '../agentv3/claudeMcpServer';
import {
  McpToolRegistry,
  filterByExposure,
} from '../agentv3/mcpToolRegistry';
import {dispatch} from '../agentv3/standaloneMcpServer';
import type {SharedToolSpec} from '../agentRuntime/runtimeToolSpec';
import {StreamProjector} from '../assistant/stream/streamProjector';
import {authenticate, requireRequestContext} from '../middleware/auth';
import {getDefaultCodebaseRegistry} from '../services/codebase/defaultCodebaseServices';
import {PathSecurityGate} from '../services/codebase/pathSecurityGate';
import {createSkillExecutor} from '../services/skillEngine/skillExecutor';
import {AppSourceIngester} from '../services/rag/appSourceIngester';
import {traceService} from '../controllers/traceProcessorController';
import type {McpToolExposure} from '../types/sparkContracts';
import {
  ensureWorkspaceCodebase,
  resolveWorkspaceAttachmentPaths,
} from './mcpWorkspaceAttachment';

const EXTERNAL_ATTACHED_EXPOSURES: readonly McpToolExposure[] = [
  'public',
  'public-readonly',
  'requires_codebase_permission',
];

const router = express.Router();
const streamProjector = new StreamProjector();

interface McpSession {
  sessionId: string;
  registry: McpToolRegistry;
  res?: express.Response;
  allowedExposures: readonly McpToolExposure[];
  workspaceRoot?: string;
  traceId?: string;
  codebaseId?: string;
  artifactStore: ArtifactStore;
}

const activeMcpSessions = new Map<string, McpSession>();

function sendSseEventSafe(session: McpSession, eventType: string, payload: unknown): void {
  if (!session.res) return;
  if (session.res.destroyed || session.res.writableEnded) return;
  try {
    streamProjector.sendEvent(session.res, eventType, payload);
  } catch (error) {
    console.warn(`[MCP-SSE] Failed to write event to session ${session.sessionId}:`, error);
  }
}

function visibleToolCount(session: McpSession): number {
  return filterByExposure(session.registry.list(), session.allowedExposures).length;
}

function registerAttachTool(session: McpSession): void {
  session.registry.registerShared({
    name: 'attach_session',
    description: 'Attach this MCP session to a local workspace and trace file. '
      + 'workspaceId is treated as the local codebase root; filePath must point to a trace file inside it.',
    exposure: 'public',
    inputSchema: {
      workspaceId: z.string().describe('Local workspace root path, usually the agent current working directory'),
      filePath: z.string().optional().describe('Trace file path inside workspaceId, absolute or workspace-relative'),
      traceId: z.string().optional().describe('Existing SmartPerfetto trace ID, alternative to filePath'),
    },
    handler: async (args) => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            message: 'attach_session must be called through the HTTP MCP route dispatcher',
          }),
        }],
        isError: true,
      };
    },
  } satisfies SharedToolSpec);
}

function createMcpSession(res?: express.Response): McpSession {
  const session: McpSession = {
    sessionId: crypto.randomUUID(),
    registry: new McpToolRegistry(),
    allowedExposures: ['public'],
    artifactStore: new ArtifactStore(),
    ...(res ? {res} : {}),
  };
  registerAttachTool(session);
  activeMcpSessions.set(session.sessionId, session);
  return session;
}

async function resolveTraceId(workspaceId: string, filePath?: string, traceId?: string): Promise<{
  traceId: string;
  workspaceRoot: string;
  workspaceRootRealpath: string;
}> {
  if (filePath) {
    const resolved = await resolveWorkspaceAttachmentPaths({workspaceId, filePath});
    const loadedTraceId = await traceService.loadTraceFromFilePath(resolved.traceFileRealpath);
    return {
      traceId: loadedTraceId,
      workspaceRoot: resolved.workspaceRoot,
      workspaceRootRealpath: resolved.workspaceRootRealpath,
    };
  }

  const resolved = await resolveWorkspaceAttachmentPaths({
    workspaceId,
    filePath: '.',
  }).catch(async () => {
    const rootOnly = await fsPromises.realpath(workspaceId);
    return {
      workspaceRoot: workspaceId,
      workspaceRootRealpath: rootOnly,
      traceFilePath: '',
      traceFileRealpath: '',
    };
  });

  const loaded = traceService.getTrace(traceId!) ?? await traceService.loadTraceFromDisk(traceId!);
  if (!loaded || loaded.status !== 'ready') {
    throw new Error(`Trace ${traceId} is not available`);
  }
  return {
    traceId: traceId!,
    workspaceRoot: resolved.workspaceRoot,
    workspaceRootRealpath: resolved.workspaceRootRealpath,
  };
}

async function attachWithRequestContext(
  req: express.Request,
  session: McpSession,
  workspaceId: string,
  traceRef: {filePath?: string; traceId?: string},
) {
  try {
    const {traceId, workspaceRoot, workspaceRootRealpath} = await resolveTraceId(
      workspaceId,
      traceRef.filePath,
      traceRef.traceId,
    );
    const requestContext = requireRequestContext(req);
    const registry = getDefaultCodebaseRegistry();
    const ingester = new AppSourceIngester(
      getRagStore(),
      registry,
      new PathSecurityGate({allowlistRoots: [workspaceRootRealpath]}),
    );
    const codebase = await ensureWorkspaceCodebase({
      workspaceRoot: workspaceRootRealpath,
      registry,
      ingester,
      context: {
        tenantId: requestContext.tenantId,
        workspaceId: requestContext.workspaceId,
        userId: requestContext.userId,
      },
    });

    const skillExecutor = createSkillExecutor(traceService);
    const {registry: analysisRegistry} = createClaudeMcpServer({
      traceId,
      traceProcessorService: traceService,
      skillExecutor,
      artifactStore: session.artifactStore,
      sessionId: session.sessionId,
      codeAwareMode: 'metadata_only',
      codebaseIds: [codebase.codebaseId],
      codebaseRegistry: registry,
      emitUpdate: (update) => {
        sendSseEventSafe(session, 'message', {
          jsonrpc: '2.0',
          method: 'smartperfetto/stream_update',
          params: update,
        });
      },
    });

    const nextRegistry = new McpToolRegistry();
    session.registry = nextRegistry;
    registerAttachTool(session);
    for (const def of analysisRegistry.list()) {
      session.registry.register({
        name: def.name,
        exposure: def.exposure,
        tool: def.tool,
        shared: def.shared,
        summary: def.summary,
        requires: def.requires,
      });
    }
    session.allowedExposures = EXTERNAL_ATTACHED_EXPOSURES;
    session.workspaceRoot = workspaceRoot;
    session.traceId = traceId;
    session.codebaseId = codebase.codebaseId;

    sendSseEventSafe(session, 'message', {
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });

    return {
      success: true,
      traceId,
      codebaseId: codebase.codebaseId,
      codebaseIngested: codebase.ingested,
      tools: visibleToolCount(session),
      message: `Attached trace ${traceId}; workspace codebase ${codebase.codebaseId} is available.`,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

router.get('/', authenticate, (req, res) => {
  streamProjector.setSseHeaders(res);
  const session = createMcpSession(res);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.write(`event: endpoint\ndata: ${baseUrl}/api/mcp?sessionId=${session.sessionId}\n\n`);
  streamProjector.bindKeepAlive(req, res);
  req.on('close', () => {
    setTimeout(() => {
      activeMcpSessions.delete(session.sessionId);
    }, 10_000);
  });
});

function jsonRpcId(req: express.Request): string | number | null {
  return (req.body as {id?: string | number | null})?.id ?? null;
}

function jsonRpcToolCall(req: express.Request): {
  method?: string;
  params?: {name?: string; arguments?: Record<string, unknown>};
} {
  return req.body as {
    method?: string;
    params?: {name?: string; arguments?: Record<string, unknown>};
  };
}

async function handleAttachToolCall(req: express.Request, session: McpSession) {
  const body = jsonRpcToolCall(req);
  const args = body.params?.arguments ?? {};
  const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId : '';
  const filePath = typeof args.filePath === 'string' ? args.filePath : undefined;
  const traceId = typeof args.traceId === 'string' ? args.traceId : undefined;
  const result = await attachWithRequestContext(req, session, workspaceId, {filePath, traceId});
  return {
    jsonrpc: '2.0',
    id: jsonRpcId(req),
    result: {
      content: [{type: 'text', text: JSON.stringify(result)}],
      ...(result.success ? {} : {isError: true}),
    },
  };
}

async function handleStreamableHttpPost(req: express.Request, res: express.Response): Promise<void> {
  let sessionId = req.get('mcp-session-id') ?? '';
  let session = sessionId ? activeMcpSessions.get(sessionId) : undefined;
  const body = jsonRpcToolCall(req);

  if (!session && body?.method === 'initialize') {
    session = createMcpSession();
    sessionId = session.sessionId;
  }
  if (!session) {
    res.status(404).json({
      jsonrpc: '2.0',
      id: jsonRpcId(req),
      error: {code: -32001, message: 'MCP session not found; call initialize first'},
    });
    return;
  }

  res.setHeader('Mcp-Session-Id', session.sessionId);
  if (body?.method === 'tools/call' && body.params?.name === 'attach_session') {
    res.json(await handleAttachToolCall(req, session));
    return;
  }

  const rpcResponse = await dispatch(session.registry, req.body, {
    allowedExposures: session.allowedExposures,
    listChanged: true,
  });
  if (!rpcResponse) {
    res.status(202).send('');
    return;
  }
  res.json(rpcResponse);
}

router.post('/', authenticate, async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  if (!sessionId) {
    await handleStreamableHttpPost(req, res);
    return;
  }
  const session = activeMcpSessions.get(sessionId);
  if (!session) {
    res.status(404).json({error: 'Session not found or expired'});
    return;
  }

  const body = jsonRpcToolCall(req);
  if (body?.method === 'tools/call' && body.params?.name === 'attach_session') {
    sendSseEventSafe(session, 'message', await handleAttachToolCall(req, session));
    res.sendStatus(202);
    return;
  }

  res.sendStatus(202);
  try {
    const rpcResponse = await dispatch(session.registry, req.body, {
      allowedExposures: session.allowedExposures,
      listChanged: true,
    });
    if (rpcResponse) sendSseEventSafe(session, 'message', rpcResponse);
  } catch (error) {
    sendSseEventSafe(session, 'message', {
      jsonrpc: '2.0',
      id: jsonRpcId(req),
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

export default router;
