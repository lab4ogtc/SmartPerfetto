// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { CodeAwareMode } from '../../services/codebase/codeAwareFeature';
import type {
  SelectionContext,
  TracePairContext,
  TracePairLayout,
  TracePaneSide,
  TraceSource,
} from '../../agentv3/types';
import type {
  SceneAnalysisSelection,
  SceneAnalysisSelectionScope,
} from '../../agent/scene/types';

export type AnalyzeEndpointKind = '/analyze' | '/sessions/:id/runs';
export type AnalyzePreset = 'smart';
export type AnalyzeMode = 'fast' | 'full' | 'auto';
export type SmartAnalyzeAction = 'preview' | 'analyze';

export interface NormalizedAnalyzeOptions {
  analysisMode: AnalyzeMode;
  preset?: AnalyzePreset;
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
  generateTracks?: boolean;
  forceRefresh?: boolean;
  selectionContext?: SelectionContext;
  tracePairContext?: TracePairContext;
  blockedStrategyIds?: string[];
  maxRounds?: number;
  confidenceThreshold?: number;
  maxNoProgressRounds?: number;
  maxFailureRounds?: number;
  maxConcurrentTasks?: number;
  taskTimeoutMs?: number;
  packageName?: string;
  timeRange?: unknown;
  adb?: unknown;
  estimatedSqlMs?: number;
  heavySkill?: boolean;
  longTask?: boolean;
  traceSizeBytes?: number;
  smartAction?: SmartAnalyzeAction;
  smartSelection?: SceneAnalysisSelection;
}

export class AnalyzeOptionsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'AnalyzeOptionsError';
  }
}

export interface NormalizeAnalyzeOptionsContext {
  readonly endpoint: AnalyzeEndpointKind;
  readonly hasReferenceTraceId: boolean;
  readonly traceId?: string;
  readonly referenceTraceId?: string;
}

export function normalizeAnalyzeOptions(
  rawOptions: unknown,
  ctx: NormalizeAnalyzeOptionsContext,
): NormalizedAnalyzeOptions {
  const raw = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
    ? rawOptions as Record<string, unknown>
    : {};

  const analysisMode = normalizeAnalysisMode(raw.analysisMode);
  const preset = normalizePreset(raw.preset);
  if (preset === 'smart' && ctx.hasReferenceTraceId) {
    throw new AnalyzeOptionsError(
      '智能分析暂不支持双 trace 对比',
      'SMART_COMPARISON_UNSUPPORTED',
    );
  }
  if (preset === 'smart' && ctx.endpoint === '/sessions/:id/runs') {
    throw new AnalyzeOptionsError(
      '智能分析仅支持新会话，不能作为已有会话的后续轮次运行',
      'SMART_CONTINUATION_UNSUPPORTED',
    );
  }

  const normalized: NormalizedAnalyzeOptions = { analysisMode };
  if (preset) normalized.preset = preset;
  const smartAction = normalizeSmartAction(raw.smartAction, preset);
  if (smartAction) {
    normalized.smartAction = smartAction;
    if (smartAction === 'analyze') {
      normalized.smartSelection = normalizeSmartSelection(raw.smartSelection);
    }
  } else if (raw.smartSelection !== undefined) {
    throw new AnalyzeOptionsError(
      'smartSelection requires preset=smart',
      'SMART_SELECTION_REQUIRES_SMART_PRESET',
    );
  }

  const codeAwareMode = normalizeCodeAwareMode(raw.codeAwareMode);
  if (codeAwareMode) normalized.codeAwareMode = codeAwareMode;

  const codebaseIds = normalizeStringArray(raw.codebaseIds);
  if (codebaseIds.length > 0) normalized.codebaseIds = codebaseIds;

  const knowledgeSourceIds = normalizeStringArray(raw.knowledgeSourceIds);
  if (knowledgeSourceIds.length > 0) normalized.knowledgeSourceIds = knowledgeSourceIds;

  const blockedStrategyIds = normalizeStringArray(raw.blockedStrategyIds);
  if (blockedStrategyIds.length > 0) normalized.blockedStrategyIds = blockedStrategyIds;

  copyBoolean(raw, normalized, 'generateTracks');
  copyBoolean(raw, normalized, 'forceRefresh');
  copyBoolean(raw, normalized, 'heavySkill');
  copyBoolean(raw, normalized, 'longTask');
  copyNumber(raw, normalized, 'maxRounds');
  copyNumber(raw, normalized, 'confidenceThreshold');
  copyNumber(raw, normalized, 'maxNoProgressRounds');
  copyNumber(raw, normalized, 'maxFailureRounds');
  copyNumber(raw, normalized, 'maxConcurrentTasks');
  copyNumber(raw, normalized, 'taskTimeoutMs');
  copyNumber(raw, normalized, 'estimatedSqlMs');
  copyNumber(raw, normalized, 'traceSizeBytes');
  copyString(raw, normalized, 'packageName');

  if (raw.selectionContext && typeof raw.selectionContext === 'object') {
    normalized.selectionContext = raw.selectionContext as SelectionContext;
  }
  if (ctx.hasReferenceTraceId) {
    const tracePairContext = normalizeTracePairContext(
      raw.tracePairContext,
      tracePairIdentityFromContext(ctx),
    );
    if (tracePairContext) normalized.tracePairContext = tracePairContext;
  }
  if (raw.timeRange && typeof raw.timeRange === 'object') {
    normalized.timeRange = raw.timeRange;
  }
  if (raw.adb && typeof raw.adb === 'object') {
    normalized.adb = raw.adb;
  }

  return normalized;
}

function normalizeAnalysisMode(value: unknown): AnalyzeMode {
  return value === 'fast' || value === 'full' || value === 'auto'
    ? value
    : 'auto';
}

function normalizePreset(value: unknown): AnalyzePreset | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'smart') return 'smart';
  throw new AnalyzeOptionsError(
    `Unsupported analyze preset: ${String(value)}`,
    'UNSUPPORTED_ANALYZE_PRESET',
  );
}

function normalizeSmartAction(
  value: unknown,
  preset: AnalyzePreset | undefined,
): SmartAnalyzeAction | undefined {
  if (!preset) {
    if (value === undefined || value === null || value === '') return undefined;
    throw new AnalyzeOptionsError(
      'smartAction requires preset=smart',
      'SMART_ACTION_REQUIRES_SMART_PRESET',
    );
  }

  if (value === undefined || value === null || value === '') return 'preview';
  if (value === 'preview' || value === 'analyze') return value;
  throw new AnalyzeOptionsError(
    `Unsupported smartAction: ${String(value)}`,
    'UNSUPPORTED_SMART_ACTION',
  );
}

function normalizeSmartSelection(value: unknown): SceneAnalysisSelection {
  if (value === undefined || value === null || value === '') {
    return { scope: 'all' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnalyzeOptionsError(
      'smartSelection must be an object',
      'INVALID_SMART_SELECTION',
    );
  }

  const raw = value as Record<string, unknown>;
  const scope = normalizeSmartSelectionScope(raw.scope);
  const label = normalizeOptionalString(raw.label, 80);
  const reportId = normalizeOptionalString(raw.reportId, 128);
  const sceneSnapshotId = normalizeOptionalString(raw.sceneSnapshotId, 128);
  const common = {
    ...(label ? { label } : {}),
    ...(reportId ? { reportId } : {}),
    ...(sceneSnapshotId ? { sceneSnapshotId } : {}),
  };
  if (scope === 'all') {
    return { scope, ...common };
  }

  if (scope === 'scene_types') {
    const sceneTypes = normalizeStringArray(raw.sceneTypes).slice(0, 64);
    if (sceneTypes.length === 0) {
      throw new AnalyzeOptionsError(
        'smartSelection.sceneTypes is required for scene_types scope',
        'INVALID_SMART_SELECTION',
      );
    }
    return { scope, sceneTypes, ...common };
  }

  const sceneIds = normalizeStringArray(raw.sceneIds).slice(0, 128);
  if (sceneIds.length === 0) {
    throw new AnalyzeOptionsError(
      'smartSelection.sceneIds is required for scene_ids scope',
      'INVALID_SMART_SELECTION',
    );
  }
  return { scope, sceneIds, ...common };
}

function normalizeSmartSelectionScope(value: unknown): SceneAnalysisSelectionScope {
  if (value === 'all' || value === 'scene_types' || value === 'scene_ids') {
    return value;
  }
  throw new AnalyzeOptionsError(
    `Unsupported smartSelection.scope: ${String(value)}`,
    'INVALID_SMART_SELECTION',
  );
}

function normalizeCodeAwareMode(value: unknown): CodeAwareMode | undefined {
  if (value === 'off' || value === 'metadata_only' || value === 'provider_send') {
    return value;
  }
  return undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

const TRACE_PANE_SIDES = new Set<TracePaneSide>(['left', 'right', 'top', 'bottom']);
const TRACE_PAIR_LAYOUTS = new Set<TracePairLayout>(['horizontal', 'vertical']);
const TRACE_SOURCES = new Set<TraceSource>(['current', 'reference']);
const HORIZONTAL_TRACE_PANE_SIDES = new Set<TracePaneSide>(['left', 'right']);
const VERTICAL_TRACE_PANE_SIDES = new Set<TracePaneSide>(['top', 'bottom']);

interface TracePairIdentity {
  readonly currentTraceId?: string;
  readonly referenceTraceId?: string;
}

function tracePairIdentityFromContext(ctx: NormalizeAnalyzeOptionsContext): TracePairIdentity {
  return {
    ...(ctx.traceId ? { currentTraceId: ctx.traceId } : {}),
    ...(ctx.referenceTraceId ? { referenceTraceId: ctx.referenceTraceId } : {}),
  };
}

function normalizeTracePairContext(
  value: unknown,
  identity: TracePairIdentity,
): TracePairContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return undefined;

  const layout = normalizeTracePairLayout(raw.layout);
  const primarySide = normalizeTracePaneSide(raw.primarySide);
  const referenceSide = normalizeTracePaneSide(raw.referenceSide);
  if (!layout || !primarySide || !referenceSide) return undefined;
  if (primarySide === referenceSide) return undefined;
  if (!tracePaneSideMatchesLayout(layout, primarySide)) return undefined;
  if (!tracePaneSideMatchesLayout(layout, referenceSide)) return undefined;

  const panes = Array.isArray(raw.panes)
    ? raw.panes
        .slice(0, 4)
        .map(normalizeTracePairPane)
        .filter((pane): pane is TracePairContext['panes'][number] => pane !== undefined)
    : [];
  const currentPane = panes.find(pane => pane.traceSide === 'current');
  const referencePane = panes.find(pane => pane.traceSide === 'reference');
  if (!currentPane || !referencePane) return undefined;
  if (currentPane.side !== primarySide || referencePane.side !== referenceSide) return undefined;
  if (!tracePairPaneMatchesIdentity(currentPane, identity.currentTraceId)) return undefined;
  if (!tracePairPaneMatchesIdentity(referencePane, identity.referenceTraceId)) return undefined;

  const activeSide = normalizeTracePaneSide(raw.activeSide);
  const layoutActiveSide = activeSide && tracePaneSideMatchesLayout(layout, activeSide)
    ? activeSide
    : undefined;
  const workspaceOpen = typeof raw.workspaceOpen === 'boolean'
    ? raw.workspaceOpen
    : undefined;
  const splitPercent = normalizeTracePairSplitPercent(raw.splitPercent);
  const maximizedTraceSide = normalizeTraceSource(raw.maximizedTraceSide);
  const minimizedTraceSides = normalizeTraceSources(raw.minimizedTraceSides);
  return {
    schemaVersion: 1,
    layout,
    primarySide,
    referenceSide,
    ...(layoutActiveSide ? { activeSide: layoutActiveSide } : {}),
    ...(workspaceOpen !== undefined ? { workspaceOpen } : {}),
    ...(splitPercent !== undefined ? { splitPercent } : {}),
    ...(maximizedTraceSide ? { maximizedTraceSide } : {}),
    ...(minimizedTraceSides.length > 0 ? { minimizedTraceSides } : {}),
    ...normalizeTracePairAliases(raw.aliases),
    panes,
  };
}

function tracePaneSideMatchesLayout(layout: TracePairLayout, side: TracePaneSide): boolean {
  return layout === 'horizontal'
    ? HORIZONTAL_TRACE_PANE_SIDES.has(side)
    : VERTICAL_TRACE_PANE_SIDES.has(side);
}

function tracePairPaneMatchesIdentity(
  pane: TracePairContext['panes'][number],
  expectedTraceId: string | undefined,
): boolean {
  return expectedTraceId === undefined || pane.traceId === expectedTraceId;
}

function normalizeTracePairPane(value: unknown): TracePairContext['panes'][number] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const side = normalizeTracePaneSide(raw.side);
  const traceSide = normalizeTraceSource(raw.traceSide);
  const traceId = normalizeOptionalString(raw.traceId, 256);
  if (!side || !traceSide || !traceId) return undefined;

  const traceName = normalizeOptionalString(raw.traceName, 256);
  const traceFingerprint = normalizeOptionalString(raw.traceFingerprint, 256);
  const active = typeof raw.active === 'boolean' ? raw.active : undefined;
  const visualState = raw.visualState === 'live' || raw.visualState === 'context_only'
    ? raw.visualState
    : undefined;

  return {
    side,
    traceSide,
    traceId,
    ...(traceName ? { traceName } : {}),
    ...(traceFingerprint ? { traceFingerprint } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(visualState ? { visualState } : {}),
  };
}

function normalizeTracePaneSide(value: unknown): TracePaneSide | undefined {
  return typeof value === 'string' && TRACE_PANE_SIDES.has(value as TracePaneSide)
    ? value as TracePaneSide
    : undefined;
}

function normalizeTracePairLayout(value: unknown): TracePairLayout | undefined {
  return typeof value === 'string' && TRACE_PAIR_LAYOUTS.has(value as TracePairLayout)
    ? value as TracePairLayout
    : undefined;
}

function normalizeTraceSource(value: unknown): TraceSource | undefined {
  return typeof value === 'string' && TRACE_SOURCES.has(value as TraceSource)
    ? value as TraceSource
    : undefined;
}

function normalizeTraceSources(value: unknown): TraceSource[] {
  if (!Array.isArray(value)) return [];
  const out: TraceSource[] = [];
  for (const item of value.slice(0, 2)) {
    const traceSource = normalizeTraceSource(item);
    if (traceSource && !out.includes(traceSource)) out.push(traceSource);
  }
  return out;
}

function normalizeTracePairSplitPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(82, Math.max(18, Math.round(value)));
}

function normalizeTracePairAliases(value: unknown): { aliases?: Record<string, TraceSource> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const aliases: Record<string, TraceSource> = {};
  for (const [key, rawTraceSide] of Object.entries(raw).slice(0, 24)) {
    const alias = normalizeOptionalString(key, 32);
    const traceSide = normalizeTraceSource(rawTraceSide);
    if (!alias || !traceSide) continue;
    aliases[alias] = traceSide;
  }
  return Object.keys(aliases).length > 0 ? { aliases } : {};
}

type BooleanAnalyzeOptionKey = 'generateTracks' | 'forceRefresh' | 'heavySkill' | 'longTask';
type NumberAnalyzeOptionKey =
  | 'maxRounds'
  | 'confidenceThreshold'
  | 'maxNoProgressRounds'
  | 'maxFailureRounds'
  | 'maxConcurrentTasks'
  | 'taskTimeoutMs'
  | 'estimatedSqlMs'
  | 'traceSizeBytes';
type StringAnalyzeOptionKey = 'packageName';

function copyBoolean(
  raw: Record<string, unknown>,
  out: NormalizedAnalyzeOptions,
  key: BooleanAnalyzeOptionKey,
): void {
  const value = raw[key];
  if (typeof value !== 'boolean') return;
  assignBooleanOption(out, key, value);
}

function copyNumber(
  raw: Record<string, unknown>,
  out: NormalizedAnalyzeOptions,
  key: NumberAnalyzeOptionKey,
): void {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  assignNumberOption(out, key, value);
}

function copyString(
  raw: Record<string, unknown>,
  out: NormalizedAnalyzeOptions,
  key: StringAnalyzeOptionKey,
): void {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim()) return;
  assignStringOption(out, key, value.trim());
}

function assignBooleanOption(
  out: NormalizedAnalyzeOptions,
  key: BooleanAnalyzeOptionKey,
  value: boolean,
): void {
  switch (key) {
    case 'generateTracks':
      out.generateTracks = value;
      return;
    case 'forceRefresh':
      out.forceRefresh = value;
      return;
    case 'heavySkill':
      out.heavySkill = value;
      return;
    case 'longTask':
      out.longTask = value;
      return;
  }
}

function assignNumberOption(
  out: NormalizedAnalyzeOptions,
  key: NumberAnalyzeOptionKey,
  value: number,
): void {
  switch (key) {
    case 'maxRounds':
      out.maxRounds = value;
      return;
    case 'confidenceThreshold':
      out.confidenceThreshold = value;
      return;
    case 'maxNoProgressRounds':
      out.maxNoProgressRounds = value;
      return;
    case 'maxFailureRounds':
      out.maxFailureRounds = value;
      return;
    case 'maxConcurrentTasks':
      out.maxConcurrentTasks = value;
      return;
    case 'taskTimeoutMs':
      out.taskTimeoutMs = value;
      return;
    case 'estimatedSqlMs':
      out.estimatedSqlMs = value;
      return;
    case 'traceSizeBytes':
      out.traceSizeBytes = value;
      return;
  }
}

function assignStringOption(
  out: NormalizedAnalyzeOptions,
  key: StringAnalyzeOptionKey,
  value: string,
): void {
  switch (key) {
    case 'packageName':
      out.packageName = value;
      return;
  }
}

function normalizeOptionalString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
