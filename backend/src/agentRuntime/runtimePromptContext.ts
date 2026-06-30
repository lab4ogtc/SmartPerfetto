// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceDataset } from '../agent/core/orchestratorTypes';
import type { QuickRunContextInjectedCounts } from '../agent/core/orchestratorTypes';
import type { Finding, ConversationTurn } from '../agent/types';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';

export function formatTraceContext(
  datasets: TraceDataset[] | undefined,
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): string {
  if (!datasets || datasets.length === 0) return '';
  const parts = datasets.map((d) => {
    const sourceLines = [
      d.evidenceRefId ? `- evidence_ref_id: \`${d.evidenceRefId}\`` : undefined,
      d.sourceToolCallId ? `- source_tool_call_id: \`${d.sourceToolCallId}\`` : undefined,
      d.queryHash ? `- query_hash: \`${d.queryHash}\`` : undefined,
      d.traceSide ? `- trace_side: \`${d.traceSide}\`` : undefined,
    ].filter(Boolean).join('\n');
    const header = `| ${d.columns.join(' | ')} |`;
    const sep = `| ${d.columns.map(() => '---').join(' | ')} |`;
    const rows = d.rows.slice(0, 100).map(
      (r) => `| ${r.map((v) => String(v ?? '-')).join(' | ')} |`,
    );
    const truncNote = d.rows.length > 100
      ? localize(outputLanguage, `\n*(前 100 行，共 ${d.rows.length} 行)*`, `\n*(first 100 rows out of ${d.rows.length})*`)
      : '';
    return `### ${d.label}\n${sourceLines ? `${sourceLines}\n\n` : ''}${header}\n${sep}\n${rows.join('\n')}${truncNote}`;
  });
  return localize(
    outputLanguage,
    `## 前端预查询 Trace 数据\n\n以下数据已由前端查询完毕，直接使用，无需重复 SQL 查询。回答中引用这些数据时使用对应的 evidence_ref_id（例如 data:frontend_prequery:*）：\n\n${parts.join('\n\n')}`,
    `## Frontend Pre-queried Trace Data\n\nThe frontend has already queried the following data. Use it directly; do not repeat the same SQL query. When citing these data, use the corresponding evidence_ref_id (for example data:frontend_prequery:*).\n\n${parts.join('\n\n')}`,
  );
}

function compactForPrompt(value: unknown, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}...`;
}

export function buildQuickConversationContext(
  previousTurns: ConversationTurn[],
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): string | undefined {
  const turns = previousTurns.filter(turn => turn.completed).slice(-3);
  if (turns.length === 0) return undefined;

  const lines = [
    localize(
      outputLanguage,
      '## 最近对话上下文\n\n以下是 SmartPerfetto 本地保存的最近问答，用于理解“继续/刚才/这个”等指代；不要把它当作当前问题的新证据。',
      '## Recent Conversation Context\n\nThe following recent SmartPerfetto turns are local context for references like "continue", "earlier", or "this"; do not treat them as new evidence for the current question.',
    ),
  ];

  for (const turn of turns) {
    const query = compactForPrompt(turn.query, 220);
    const answer = compactForPrompt(turn.result?.message || '', 700);
    const findings = turn.findings
      .slice(0, 3)
      .map(f => `[${f.severity}] ${compactForPrompt(f.title, 160)}`)
      .filter(Boolean);

    lines.push(`### Turn ${turn.turnIndex + 1}`);
    lines.push(`- ${localize(outputLanguage, '用户', 'User')}: ${query}`);
    if (answer) {
      lines.push(`- ${localize(outputLanguage, '上轮回答', 'Previous answer')}: ${answer}`);
    }
    if (findings.length > 0) {
      lines.push(`- ${localize(outputLanguage, '上轮发现', 'Previous findings')}: ${findings.join('; ')}`);
    }
  }

  return lines.join('\n');
}

export interface QuickMemoryContextInput {
  patternContext?: string;
  negativePatternContext?: string;
  caseBackgroundContext?: string;
  sqlErrorFixPairs?: Array<{
    errorSql?: string;
    errorMessage?: string;
    fixedSql?: string;
  }>;
  recentSqlResultsContext?: string;
  recentSqlResultsCount?: number;
  outputLanguage?: OutputLanguage;
}

export interface QuickMemoryContextPayload {
  text?: string;
  counts: Omit<QuickRunContextInjectedCounts, 'conversationTurns'>;
  tokenEstimate: number;
  dropped: string[];
}

function estimatePromptTokens(text: string | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function countRecentSqlResultSections(text: string | undefined): number {
  if (!text?.trim()) return 0;
  const matches = text.match(/SQL Result\s+\d+/gi);
  if (matches && matches.length > 0) return matches.length;
  return 1;
}

export function buildQuickMemoryContextPayload(input: QuickMemoryContextInput): QuickMemoryContextPayload {
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const parts: string[] = [];
  const dropped: string[] = [];
  const counts: QuickMemoryContextPayload['counts'] = {
    recentSqlResults: 0,
    sqlPitfallPairs: 0,
    patternHints: 0,
    negativePatternHints: 0,
    caseBackgroundCases: 0,
  };

  if (input.recentSqlResultsContext?.trim()) {
    parts.push(input.recentSqlResultsContext.trim());
    counts.recentSqlResults = input.recentSqlResultsCount ?? countRecentSqlResultSections(input.recentSqlResultsContext);
  }

  const sqlPairs = (input.sqlErrorFixPairs ?? [])
    .filter(pair => pair.errorMessage && pair.fixedSql)
    .slice(-3);
  if (sqlPairs.length > 0) {
    const pairLines = sqlPairs.map((pair, index) => [
      `${index + 1}. ERROR: \`${compactForPrompt(pair.errorMessage, 100)}\``,
      `   BAD: \`${compactForPrompt(pair.errorSql, 150)}\``,
      `   FIX: \`${compactForPrompt(pair.fixedSql, 150)}\``,
    ].join('\n'));
    parts.push(localize(
      outputLanguage,
      `## SQL 踩坑提示（快速模式）\n\n以下是历史 SQL 错误/修正对，只用于避坑和加速，不是当前 trace 证据：\n\n${pairLines.join('\n')}`,
      `## SQL Pitfall Hints (Fast Mode)\n\nThe following historical SQL error/fix pairs are hints for avoiding repeated mistakes and are not current-trace evidence:\n\n${pairLines.join('\n')}`,
    ));
    counts.sqlPitfallPairs = sqlPairs.length;
  }
  const droppedSqlPairs = (input.sqlErrorFixPairs ?? []).filter(pair => pair.errorMessage && !pair.fixedSql).length;
  if (droppedSqlPairs > 0) dropped.push(`sqlPitfallPairs:${droppedSqlPairs}`);

  if (input.patternContext?.trim()) {
    parts.push(input.patternContext.trim());
    counts.patternHints = 1;
  }
  if (input.negativePatternContext?.trim()) {
    parts.push(input.negativePatternContext.trim());
    counts.negativePatternHints = 1;
  }
  if (input.caseBackgroundContext?.trim()) {
    parts.push(input.caseBackgroundContext.trim());
    counts.caseBackgroundCases = 1;
  }

  if (parts.length === 0) {
    return { counts, tokenEstimate: 0, dropped };
  }
  const text = localize(
    outputLanguage,
    `## 快速模式可复用上下文\n\n以下内容来自 SmartPerfetto 已保存的上下文或跨会话记忆；只能用于理解上下文、避坑和减少重复查询，不能作为当前问题的证据。若与当前 trace 数据冲突，以本轮新查询或前端预查询 evidence_ref_id 为准。\n\n${parts.join('\n\n')}`,
    `## Fast Mode Reusable Context\n\nThe following context comes from saved SmartPerfetto session state or cross-session memory. It may only help interpret context, avoid pitfalls, and reduce repeated queries; it is not evidence for the current question. If it conflicts with current trace data, trust new evidence from this turn or frontend pre-query evidence_ref_id values.\n\n${parts.join('\n\n')}`,
  );
  return {
    text,
    counts,
    tokenEstimate: estimatePromptTokens(text),
    dropped,
  };
}

export function buildQuickMemoryContext(input: QuickMemoryContextInput): string | undefined {
  return buildQuickMemoryContextPayload(input).text;
}

export function collectRecentFindings(
  sessionContext: any,
  options: { maxTurns?: number; maxFindings?: number } = {},
): Finding[] {
  try {
    let turns = sessionContext.getAllTurns?.() || [];
    if (options.maxTurns && options.maxTurns > 0) {
      turns = turns.slice(-options.maxTurns);
    }
    return turns.flatMap((turn: any) => turn.findings || []).slice(-(options.maxFindings ?? 5));
  } catch {
    return [];
  }
}
