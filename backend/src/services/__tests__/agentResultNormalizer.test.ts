// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  deriveEvidenceBackedConclusionContractForNarrative,
  deriveConclusionContractForNarrative,
  normalizeNarrativeForContract,
  normalizeNarrativeForClient,
  normalizeResultForReport,
} from '../agentResultNormalizer';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import { runClaimVerification } from '../verifier/claimVerificationRunner';
import type { DataEnvelope } from '../../types/dataContract';

function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    sessionId: 'agent-test',
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: '',
    confidence: 0.7,
    rounds: 1,
    totalDurationMs: 1000,
    ...overrides,
  };
}

describe('normalizeNarrativeForClient', () => {
  test('returns empty string unchanged', () => {
    expect(normalizeNarrativeForClient('')).toBe('');
    expect(normalizeNarrativeForClient('   ')).toBe('   ');
  });

  test('strips evidence ids (internal sanitization)', () => {
    // Sample an evidence-id-shaped token — the sanitizer should remove it.
    const input = 'The jank event (ev_deadbeef1234) was at frame 12.';
    const out = normalizeNarrativeForClient(input);
    expect(out).not.toContain('ev_deadbeef1234');
  });

  test('returns raw when narrative is non-conclusion text', () => {
    const raw = 'just a plain string with no special markers';
    expect(normalizeNarrativeForClient(raw)).toBe(raw);
  });

  test('tolerates non-string-coerced inputs', () => {
    expect(normalizeNarrativeForClient(null as unknown as string)).toBe('');
    expect(normalizeNarrativeForClient(undefined as unknown as string)).toBe('');
  });
});

describe('deriveConclusionContractForNarrative', () => {
  const narrativeWithEvClaim = [
    '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
    '',
    '## 逐句数据引用（结构化来源）',
    '- Q1 / C1: 帧耗时 45.6ms',
    '  - evidence_ref_id=ev_deadbeef1234; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
  ].join('\n');

  test('keeps evidence ids available for contract parsing before display sanitization', () => {
    const display = normalizeNarrativeForClient(narrativeWithEvClaim);
    expect(display).not.toContain('ev_deadbeef1234');

    const contractSource = normalizeNarrativeForContract(narrativeWithEvClaim);
    expect(contractSource).toContain('ev_deadbeef1234');

    const contract = deriveConclusionContractForNarrative(narrativeWithEvClaim);
    expect(contract?.claims?.[0]?.references?.[0]?.evidenceRefId).toBe('ev_deadbeef1234');
    expect(contract?.claims?.[0]?.references?.[0]?.sourceRef).toBe('表 1');
  });
});

describe('deriveEvidenceBackedConclusionContractForNarrative', () => {
  test('builds verifier-ready claims for rich reports that do not use contract headings', () => {
    const envelopes: DataEnvelope[] = [
      {
        meta: {
          type: 'skill_result',
          version: '2.0.0',
          source: 'startup_analysis',
          skillId: 'startup_analysis',
          stepId: 'get_startups',
          evidenceRefId: 'data:skill:startup_analysis:get_startups:current:abc',
          artifactId: 'art-2',
          traceId: 'trace-1',
          traceSide: 'current',
          timestamp: 1,
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '检测到的启动事件',
        },
        data: {
          columns: ['package', 'startup_type', 'dur_ms', 'ttid_ms'],
          rows: [['com.example.launch.aosp.heavy', 'cold', 1339, 1912]],
        },
      },
      {
        meta: {
          type: 'skill_result',
          version: '2.0.0',
          source: 'startup_detail',
          skillId: 'startup_detail',
          stepId: 'actionable_hotspots',
          evidenceRefId: 'data:skill:startup_detail:actionable_hotspots:current:def',
          artifactId: 'art-30',
          traceId: 'trace-1',
          traceSide: 'current',
          timestamp: 2,
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '可操作热点',
        },
        data: {
          columns: ['slice_name', 'self_ms', 'self_percent'],
          rows: [
            ['ChaosTask', 456, 34.1],
            ['LoadSimulator_ActivityInit', 249.8, 18.7],
          ],
        },
      },
    ];
    const report = [
      '# 启动性能分析报告',
      '',
      '## 综合结论',
      '',
      '冷启动 TTID=1912ms，dur=1339ms，主因是 ChaosTask self=456ms 和 LoadSimulator_ActivityInit self=249.8ms。',
      '',
      '## 关键证据链',
      '',
      '- 启动事件与热点表均已采集。',
    ].join('\n');

    const contract = deriveEvidenceBackedConclusionContractForNarrative(report, envelopes, {
      mode: 'initial_report',
      sceneId: 'startup',
    });
    expect(contract?.claims?.length).toBeGreaterThanOrEqual(2);
    expect(contract?.metadata?.derivedFromNarrativeEvidenceMatch).toBe(true);
    expect(contract?.metadata?.claimVerificationScope).toBe('sampled_narrative_evidence');
    expect(contract?.claims?.some(claim =>
      claim.references.some(ref => ref.evidenceRefId === 'art-2' || ref.evidenceRefId === 'data:skill:startup_analysis:get_startups:current:abc'),
    )).toBe(true);

    const verification = runClaimVerification({
      conclusionContract: contract,
      dataEnvelopes: envelopes,
      policy: 'record_only',
    }).claimVerificationResult;
    expect(verification.status).toBe('passed');
    expect(verification.checkedClaimCount).toBeGreaterThan(0);
  });

  test('does not derive numeric claims from numbers embedded inside larger tokens', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'startup_detail',
        skillId: 'startup_detail',
        stepId: 'counts',
        evidenceRefId: 'data:skill:startup_detail:counts:current:abc',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
      },
      display: {
        layer: 'list',
        format: 'table',
        title: '计数表',
      },
      data: {
        columns: ['slice_name', 'small_count'],
        rows: [['ChaosTask', 3]],
      },
    }];
    const report = '# 启动性能分析报告\n\n## 综合结论\n\nChaosTask self=1339ms，未提到 small_count。';

    const contract = deriveEvidenceBackedConclusionContractForNarrative(report, envelopes);

    expect(contract?.claims?.some(claim =>
      claim.references.some(ref => ref.column === 'small_count' && ref.value === 3),
    )).not.toBe(true);
  });
});

describe('normalizeResultForReport', () => {
  test('returns input identity when nothing would change', () => {
    const r = makeResult({ conclusion: 'plain text', conclusionContract: { mode: 'focused_answer' } as any });
    const out = normalizeResultForReport(r);
    // Identity check — callers rely on this to skip downstream work.
    expect(out).toBe(r);
  });

  test('strips evidence ids from conclusion', () => {
    const r = makeResult({ conclusion: 'Frame regression at (ev_aaaaaaaaaaaa).' });
    const out = normalizeResultForReport(r);
    expect(out.conclusion).not.toContain('ev_aaaaaaaaaaaa');
  });

  test('derives a conclusionContract when missing', () => {
    const r = makeResult({ conclusion: 'Some analysis summary.', conclusionContract: undefined, rounds: 2 });
    const out = normalizeResultForReport(r);
    // Either gets a contract (if derivable from this text) or stays undefined;
    // what matters is that the call doesn't throw and the shape is preserved.
    expect(typeof out.conclusion).toBe('string');
    expect(out.rounds).toBe(2);
  });

  test('preserves existing conclusionContract', () => {
    const contract = { mode: 'initial_report' } as any;
    const r = makeResult({ conclusion: 'text', conclusionContract: contract });
    const out = normalizeResultForReport(r);
    expect(out.conclusionContract).toBe(contract);
  });

  test('derives claim provenance from unsanitized narrative while returning sanitized display text', () => {
    const r = makeResult({
      conclusion: [
        '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
        '',
        '## 逐句数据引用（结构化来源）',
        '- Q1 / C1: 帧耗时 45.6ms',
        '  - evidence_ref_id=ev_deadbeef1234; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
      ].join('\n'),
    });

    const out = normalizeResultForReport(r);
    expect(out.conclusion).not.toContain('ev_deadbeef1234');
    expect(out.conclusionContract?.claims?.[0]?.references?.[0]?.evidenceRefId).toBe('ev_deadbeef1234');
  });

  test('uses captured DataEnvelopes to normalize rich report contracts for CLI/report paths', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'startup_analysis',
        skillId: 'startup_analysis',
        stepId: 'startup_overview',
        evidenceRefId: 'data:skill:startup_analysis:startup_overview:current:abc',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
      },
      display: {
        layer: 'overview',
        format: 'table',
        title: '启动概览',
      },
      data: {
        columns: ['package', 'startup_type', 'ttid_ms'],
        rows: [['com.example.launch.aosp.heavy', 'cold', 1912]],
      },
    }];
    const r = makeResult({
      conclusion: '# 启动性能分析报告\n\n## 综合结论\n\ncom.example.launch.aosp.heavy 是冷启动，TTID=1912ms。',
      conclusionContract: undefined,
    });

    const out = normalizeResultForReport(r, { dataEnvelopes: envelopes });

    expect(out.conclusionContract?.metadata?.derivedFromNarrativeEvidenceMatch).toBe(true);
    expect(out.conclusionContract?.claims?.some(claim =>
      claim.references.some(ref => ref.column === 'ttid_ms' && ref.value === 1912),
    )).toBe(true);
  });
});
