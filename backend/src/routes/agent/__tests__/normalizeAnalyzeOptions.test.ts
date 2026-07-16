// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  AnalyzeOptionsError,
  normalizeAnalyzeOptions,
} from '../normalizeAnalyzeOptions';

describe('normalizeAnalyzeOptions', () => {
  it('defaults unsupported analysisMode to auto and strips unknown options', () => {
    const normalized = normalizeAnalyzeOptions(
      {
        analysisMode: 'turbo',
        maxRounds: 3,
        confidenceThreshold: 0.5,
        unknown: 'ignored',
      },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    );

    expect(normalized).toEqual({
      analysisMode: 'auto',
      maxRounds: 3,
      confidenceThreshold: 0.5,
    });
  });

  it('accepts smart preset on new analyze requests without comparison', () => {
    expect(normalizeAnalyzeOptions(
      { analysisMode: 'full', preset: 'smart' },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toEqual({
      analysisMode: 'full',
      preset: 'smart',
      smartAction: 'preview',
    });
  });

  it('accepts smart analyze selection scopes', () => {
    expect(normalizeAnalyzeOptions(
      {
        preset: 'smart',
        smartAction: 'analyze',
        smartSelection: {
          scope: 'scene_types',
          sceneTypes: ['scroll', 'scroll', 'inertial_scroll'],
          label: '滑动',
          reportId: 'report-123',
          sceneSnapshotId: 'legacy-snapshot-123',
        },
      },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toEqual({
      analysisMode: 'auto',
      preset: 'smart',
      smartAction: 'analyze',
      smartSelection: {
        scope: 'scene_types',
        sceneTypes: ['scroll', 'inertial_scroll'],
        label: '滑动',
        reportId: 'report-123',
        sceneSnapshotId: 'legacy-snapshot-123',
      },
    });
  });

  it('preserves authorized knowledge sources for smart deep-dive requests', () => {
    expect(normalizeAnalyzeOptions(
      {
        preset: 'smart',
        smartAction: 'analyze',
        knowledgeSourceIds: ['wiki-a', 'wiki-a', 'wiki-b'],
      },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toEqual({
      analysisMode: 'auto',
      preset: 'smart',
      smartAction: 'analyze',
      smartSelection: { scope: 'all' },
      knowledgeSourceIds: ['wiki-a', 'wiki-b'],
    });
  });

  it('defaults smart analyze selection to all scenes', () => {
    expect(normalizeAnalyzeOptions(
      { preset: 'smart', smartAction: 'analyze' },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toEqual({
      analysisMode: 'auto',
      preset: 'smart',
      smartAction: 'analyze',
      smartSelection: { scope: 'all' },
    });
  });

  it('rejects smart preset with referenceTraceId', () => {
    expect(() => normalizeAnalyzeOptions(
      { preset: 'smart' },
      { endpoint: '/analyze', hasReferenceTraceId: true },
    )).toThrow(AnalyzeOptionsError);

    try {
      normalizeAnalyzeOptions(
        { preset: 'smart' },
        { endpoint: '/analyze', hasReferenceTraceId: true },
      );
    } catch (error: any) {
      expect(error.code).toBe('SMART_COMPARISON_UNSUPPORTED');
      expect(error.httpStatus).toBe(400);
    }
  });

  it('rejects smart preset on continuation run endpoint', () => {
    expect(() => normalizeAnalyzeOptions(
      { preset: 'smart' },
      { endpoint: '/sessions/:id/runs', hasReferenceTraceId: false },
    )).toThrow(/仅支持新会话/);
  });

  it('accepts normal continuation runs and comparison options', () => {
    expect(normalizeAnalyzeOptions(
      {
        analysisMode: 'fast',
        codeAwareMode: 'metadata_only',
        codebaseIds: ['a', 'a', 'b'],
        knowledgeSourceIds: ['wiki-a', 'wiki-a', 'wiki-b'],
      },
      { endpoint: '/sessions/:id/runs', hasReferenceTraceId: true },
    )).toEqual({
      analysisMode: 'fast',
      codeAwareMode: 'metadata_only',
      codebaseIds: ['a', 'b'],
      knowledgeSourceIds: ['wiki-a', 'wiki-b'],
    });
  });

  it('normalizes trace pair context only for comparison requests', () => {
    const tracePairContext = {
      schemaVersion: 1,
      layout: 'horizontal',
      primarySide: 'left',
      referenceSide: 'right',
      activeSide: 'left',
      workspaceOpen: true,
      splitPercent: 67.8,
      maximizedTraceSide: 'other',
      minimizedTraceSides: ['reference', 'other', 'reference'],
      aliases: {
        '左侧': 'current',
        '右侧': 'reference',
        invalid: 'other',
      },
      panes: [
        {
          side: 'left',
          traceSide: 'current',
          traceId: 'trace-current',
          traceName: 'Current Trace',
          traceFingerprint: 'fingerprint-current',
          active: true,
          visualState: 'live',
          ignored: 'field',
        },
        {
          side: 'right',
          traceSide: 'reference',
          traceId: 'trace-reference',
          traceName: 'Reference Trace',
          visualState: 'context_only',
        },
      ],
    };

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    ).tracePairContext).toBeUndefined();

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      { endpoint: '/analyze', hasReferenceTraceId: true },
    ).tracePairContext).toEqual({
      schemaVersion: 1,
      layout: 'horizontal',
      primarySide: 'left',
      referenceSide: 'right',
      activeSide: 'left',
      workspaceOpen: true,
      splitPercent: 68,
      minimizedTraceSides: ['reference'],
      aliases: {
        '左侧': 'current',
        '右侧': 'reference',
      },
      panes: [
        {
          side: 'left',
          traceSide: 'current',
          traceId: 'trace-current',
          traceName: 'Current Trace',
          traceFingerprint: 'fingerprint-current',
          active: true,
          visualState: 'live',
        },
        {
          side: 'right',
          traceSide: 'reference',
          traceId: 'trace-reference',
          traceName: 'Reference Trace',
          visualState: 'context_only',
        },
      ],
    });
  });

  it('preserves same-page vertical dual-trace workspace state for comparison requests', () => {
    const tracePairContext = {
      schemaVersion: 1,
      layout: 'vertical',
      primarySide: 'top',
      referenceSide: 'bottom',
      activeSide: 'bottom',
      workspaceOpen: true,
      splitPercent: 65.5,
      maximizedTraceSide: 'reference',
      minimizedTraceSides: ['current'],
      aliases: {
        top: 'current',
        bottom: 'reference',
        '上方': 'current',
        '下方': 'reference',
      },
      panes: [
        {
          side: 'top',
          traceSide: 'current',
          traceId: 'trace-current',
          traceName: 'current.trace',
          active: false,
          visualState: 'context_only',
        },
        {
          side: 'bottom',
          traceSide: 'reference',
          traceId: 'trace-reference',
          traceName: 'reference.trace',
          active: true,
          visualState: 'live',
        },
      ],
    };

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      {
        endpoint: '/analyze',
        hasReferenceTraceId: true,
        traceId: 'trace-current',
        referenceTraceId: 'trace-reference',
      },
    ).tracePairContext).toEqual({
      schemaVersion: 1,
      layout: 'vertical',
      primarySide: 'top',
      referenceSide: 'bottom',
      activeSide: 'bottom',
      workspaceOpen: true,
      splitPercent: 66,
      maximizedTraceSide: 'reference',
      minimizedTraceSides: ['current'],
      aliases: {
        top: 'current',
        bottom: 'reference',
        '上方': 'current',
        '下方': 'reference',
      },
      panes: [
        {
          side: 'top',
          traceSide: 'current',
          traceId: 'trace-current',
          traceName: 'current.trace',
          active: false,
          visualState: 'context_only',
        },
        {
          side: 'bottom',
          traceSide: 'reference',
          traceId: 'trace-reference',
          traceName: 'reference.trace',
          active: true,
          visualState: 'live',
        },
      ],
    });
  });

  it('drops trace pair context when pane identity does not match the requested traces', () => {
    const tracePairContext = {
      schemaVersion: 1,
      layout: 'horizontal',
      primarySide: 'left',
      referenceSide: 'right',
      panes: [
        {
          side: 'left',
          traceSide: 'current',
          traceId: 'trace-current',
        },
        {
          side: 'right',
          traceSide: 'reference',
          traceId: 'trace-reference',
        },
      ],
    };

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      {
        endpoint: '/analyze',
        hasReferenceTraceId: true,
        traceId: 'trace-current',
        referenceTraceId: 'trace-reference',
      },
    ).tracePairContext).toBeDefined();

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      {
        endpoint: '/analyze',
        hasReferenceTraceId: true,
        traceId: 'stale-current',
        referenceTraceId: 'trace-reference',
      },
    ).tracePairContext).toBeUndefined();

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      {
        endpoint: '/analyze',
        hasReferenceTraceId: true,
        traceId: 'trace-current',
        referenceTraceId: 'stale-reference',
      },
    ).tracePairContext).toBeUndefined();
  });

  it('drops trace pair context when pane sides do not match the declared layout', () => {
    expect(normalizeAnalyzeOptions(
      {
        tracePairContext: {
          schemaVersion: 1,
          layout: 'horizontal',
          primarySide: 'top',
          referenceSide: 'bottom',
          activeSide: 'top',
          panes: [
            {
              side: 'top',
              traceSide: 'current',
              traceId: 'trace-current',
            },
            {
              side: 'bottom',
              traceSide: 'reference',
              traceId: 'trace-reference',
            },
          ],
        },
      },
      {
        endpoint: '/analyze',
        hasReferenceTraceId: true,
        traceId: 'trace-current',
        referenceTraceId: 'trace-reference',
      },
    ).tracePairContext).toBeUndefined();
  });

  it('rejects unknown presets instead of passing them through', () => {
    expect(() => normalizeAnalyzeOptions(
      { preset: 'other' },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toThrow(/Unsupported analyze preset/);
  });

  it('rejects invalid smart action and selection payloads', () => {
    expect(() => normalizeAnalyzeOptions(
      { smartAction: 'preview' },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toThrow(/requires preset=smart/);

    expect(() => normalizeAnalyzeOptions(
      { preset: 'smart', smartAction: 'deep' },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toThrow(/Unsupported smartAction/);

    expect(() => normalizeAnalyzeOptions(
      { preset: 'smart', smartAction: 'analyze', smartSelection: { scope: 'scene_types' } },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toThrow(/sceneTypes is required/);
  });
});
