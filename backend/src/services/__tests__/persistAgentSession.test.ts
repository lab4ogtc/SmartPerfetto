// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { EnhancedSessionContext, sessionContextManager } from '../../agent/context/enhancedSessionContext';
import { SessionPersistenceService } from '../sessionPersistenceService';
import { persistAgentTurn } from '../persistAgentSession';
import { createDataEnvelope } from '../../types/dataContract';

describe('persistAgentTurn', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    sessionContextManager.remove('session-partial-message');
    sessionContextManager.remove('session-sql-result-message');
    sessionContextManager.remove('session-sql-result-truncated');
    sessionContextManager.remove('session-continuity-breaks');
  });

  it('persists partial assistant messages with a visible integrity warning', () => {
    const appendMessages = jest.fn();
    jest.spyOn(SessionPersistenceService, 'getInstance').mockReturnValue({
      saveSessionStateSnapshot: jest.fn(() => true),
      appendMessages,
    } as any);

    const sessionId = 'session-partial-message';
    const traceId = 'trace-partial-message';
    sessionContextManager.set(sessionId, traceId, new EnhancedSessionContext(sessionId, traceId));

    persistAgentTurn({
      sessionId,
      traceId,
      query: '分析这个启动 trace',
      result: {
        conclusion: '综合结论：\n完成综合结论输出。',
        totalDurationMs: 123,
        partial: true,
        terminationMessage: '最终结果质量闸门发现 provider 没有产出可独立交付的完整结论。',
      },
      session: {
        createdAt: Date.now(),
        orchestrator: {
          takeSnapshot: jest.fn(() => ({
            conversationSteps: [],
            dataEnvelopes: [],
            analysisNotes: [],
          })),
        },
      } as any,
    });

    expect(appendMessages).toHaveBeenCalledTimes(1);
    const messages = appendMessages.mock.calls[0]?.[1] as Array<{ role: string; content: string }>;
    const assistantMessage = messages.find(message => message.role === 'assistant');
    expect(assistantMessage?.content).toContain('结果完整性提示');
    expect(assistantMessage?.content).toContain('最终结果质量闸门');
    expect(assistantMessage?.content).toContain('综合结论');
  });

  it('persists recent SQL result envelopes on the assistant message', () => {
    const appendMessages = jest.fn();
    jest.spyOn(SessionPersistenceService, 'getInstance').mockReturnValue({
      saveSessionStateSnapshot: jest.fn(() => true),
      appendMessages,
    } as any);

    const sessionId = 'session-sql-result-message';
    const traceId = 'trace-sql-result-message';
    sessionContextManager.set(sessionId, traceId, new EnhancedSessionContext(sessionId, traceId));

    const sqlEnvelope = {
      ...createDataEnvelope({
        columns: ['dur_ms'],
        rows: [[42]],
      }, {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'SQL Query (1 rows)',
        layer: 'list',
        format: 'table',
        evidenceRefId: 'data:sql:test',
        sourceToolCallId: 'execute_sql:1:params',
        queryHash: 'query-hash',
      }),
      sql: 'SELECT 42 AS dur_ms',
    };

    persistAgentTurn({
      sessionId,
      traceId,
      query: '查 SQL',
      result: {
        conclusion: '综合结论：SQL 已验证。',
        totalDurationMs: 123,
      },
      session: {
        createdAt: Date.now(),
        dataEnvelopes: [sqlEnvelope],
        orchestrator: {
          takeSnapshot: jest.fn(() => ({
            conversationSteps: [],
            dataEnvelopes: [sqlEnvelope],
            analysisNotes: [],
          })),
        },
      } as any,
    });

    const messages = appendMessages.mock.calls[0]?.[1] as Array<{ role: string; sqlResult?: any }>;
    const assistantMessage = messages.find(message => message.role === 'assistant');
    expect(assistantMessage?.sqlResult).toMatchObject({
      schemaVersion: 'sql_result_message_v1',
      resultCount: 1,
      results: [{
        title: 'SQL Query (1 rows)',
        evidenceRefId: 'data:sql:test',
        sourceToolCallId: 'execute_sql:1:params',
        queryHash: 'query-hash',
        sql: 'SELECT 42 AS dur_ms',
        data: {
          columns: ['dur_ms'],
          rows: [[42]],
        },
      }],
    });
  });

  it('truncates oversized SQL result payloads before persisting message sqlResult', () => {
    const appendMessages = jest.fn();
    jest.spyOn(SessionPersistenceService, 'getInstance').mockReturnValue({
      saveSessionStateSnapshot: jest.fn(() => true),
      appendMessages,
    } as any);

    const sessionId = 'session-sql-result-truncated';
    const traceId = 'trace-sql-result-truncated';
    sessionContextManager.set(sessionId, traceId, new EnhancedSessionContext(sessionId, traceId));
    const largeValue = 'x'.repeat(130 * 1024);
    const sqlEnvelope = createDataEnvelope({
      columns: ['payload'],
      rows: [[largeValue]],
    }, {
      type: 'sql_result',
      source: 'execute_sql',
      title: 'Huge SQL',
      layer: 'list',
      format: 'table',
      evidenceRefId: 'data:sql:huge',
    });

    persistAgentTurn({
      sessionId,
      traceId,
      query: '查大 SQL',
      result: {
        conclusion: '综合结论：SQL 已截断保存。',
        totalDurationMs: 123,
      },
      session: {
        createdAt: Date.now(),
        dataEnvelopes: [sqlEnvelope],
        orchestrator: {
          takeSnapshot: jest.fn(() => ({
            conversationSteps: [],
            dataEnvelopes: [sqlEnvelope],
            analysisNotes: [],
          })),
        },
      } as any,
    });

    const messages = appendMessages.mock.calls[0]?.[1] as Array<{ role: string; sqlResult?: any }>;
    const persisted = messages.find(message => message.role === 'assistant')?.sqlResult.results[0];
    expect(persisted.truncated).toBe(true);
    expect(persisted.originalBytes).toBeGreaterThan(100 * 1024);
    expect(JSON.stringify(persisted).length).toBeLessThan(105 * 1024);
    expect(JSON.stringify(persisted)).not.toContain(largeValue);
  });

  it('passes provider continuity breaks into the atomic session snapshot', () => {
    const appendMessages = jest.fn();
    const saveSessionStateSnapshot = jest.fn(() => true);
    jest.spyOn(SessionPersistenceService, 'getInstance').mockReturnValue({
      saveSessionStateSnapshot,
      appendMessages,
    } as any);

    const sessionId = 'session-continuity-breaks';
    const traceId = 'trace-continuity-breaks';
    const continuityBreaks = [{
      at: 1710000000000,
      previousProviderHash: 'hash-before-reset',
      reason: 'provider_snapshot_hash_mismatch' as const,
    }];
    sessionContextManager.set(sessionId, traceId, new EnhancedSessionContext(sessionId, traceId));
    const takeSnapshot = jest.fn((_sessionId: string, _traceId: string, fields: any) => ({
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId,
      traceId,
      ...fields,
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
    }));

    persistAgentTurn({
      sessionId,
      traceId,
      query: '继续分析',
      result: {
        conclusion: '综合结论：继续分析完成。',
        totalDurationMs: 123,
      },
      session: {
        createdAt: Date.now(),
        continuityBreaks,
        orchestrator: { takeSnapshot },
      } as any,
    });

    expect(takeSnapshot).toHaveBeenCalledWith(
      sessionId,
      traceId,
      expect.objectContaining({ continuityBreaks }),
    );
    const savedCall = saveSessionStateSnapshot.mock.calls[0] as unknown[];
    expect(savedCall[0]).toBe(sessionId);
    expect(savedCall[1]).toEqual(expect.objectContaining({ continuityBreaks }));
    expect(savedCall[2]).toEqual(expect.any(Object));
  });
});
