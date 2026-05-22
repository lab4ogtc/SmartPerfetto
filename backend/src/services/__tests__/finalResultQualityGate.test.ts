// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import {
  applyFinalResultQualityGate,
  assessFinalResultQuality,
  hasDeliverableFinalReportHeading,
  looksLikePhaseSummaryFallback,
} from '../finalResultQualityGate';

function result(overrides: Partial<AnalysisResult>): AnalysisResult {
  return {
    sessionId: 'session-final-quality',
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: '# 启动性能分析报告\n\n## 综合结论\n\n启动耗时正常。\n\n## 关键证据链\n\n- startup_detail 已验证。\n\n## 优化建议\n\n无需处理。',
    confidence: 0.8,
    rounds: 1,
    totalDurationMs: 1000,
    ...overrides,
  };
}

describe('final result quality gate', () => {
  it('recognizes deliverable report headings without Chinese word-boundary false negatives', () => {
    expect(hasDeliverableFinalReportHeading('# 启动性能分析报告\n\n## 综合结论')).toBe(true);
    expect(hasDeliverableFinalReportHeading('## 综合结论\n\n冷启动 TTID=1912ms。')).toBe(true);
    expect(hasDeliverableFinalReportHeading('### Phase 1 关键发现记录\n\nTTID=1912ms。')).toBe(false);
  });

  it('detects phase-summary fallback text as non-final output', () => {
    const fallback = [
      '## 综合结论',
      '',
      '完成综合结论输出。冷启动TTID=1912ms，主因是主线程模拟负载过重。',
      '',
      '## 分阶段证据摘要',
      '',
      '- 启动概览采集: 获取启动概览：冷启动dur=1338ms，TTID=1912ms。',
      '- 启动详情分析: 四象限：Q1=62.8%, Q4b=35.1%。',
      '- 综合结论: 完成综合结论输出。',
    ].join('\n');

    expect(looksLikePhaseSummaryFallback(fallback)).toBe(true);
    expect(assessFinalResultQuality({
      result: result({ conclusion: fallback }),
      query: '分析这个启动 trace',
    })?.code).toBe('plan_summary_fallback');

    expect(looksLikePhaseSummaryFallback([
      '## 综合结论',
      '',
      '主要瓶颈来自 ChaosTask，证据 art-30。',
      '',
      '## 分阶段证据摘要',
      '',
      '- p1: 获取启动概览，证据 art-2。',
      '- p2: 输出结论，证据 data:sql_table:current:abc。',
    ].join('\n'))).toBe(true);

    expect(looksLikePhaseSummaryFallback([
      '综合结论',
      '',
      '完成综合结论输出。',
      '',
      '分阶段证据摘要',
      '',
      '- 启动概览采集: 获取启动概览。',
      '- 综合结论: 完成综合结论输出。',
    ].join('\n'))).toBe(true);

    expect(looksLikePhaseSummaryFallback([
      '综合结论：',
      '完成综合结论输出。冷启动TTID=1912ms，主因是主线程模拟负载过重(A16)。',
      '',
      '分阶段证据摘要：',
      '启动概览采集: 获取启动概览：冷启动dur=1338ms，TTID=1912ms。',
      '启动类型验证: 确认为冷启动。',
      '启动详情分析: 四象限：Q1=62.8%,Q4b=35.1%。',
      '综合结论: 完成综合结论输出。',
    ].join('\n'))).toBe(true);

    expect(looksLikePhaseSummaryFallback([
      '## Final Conclusion',
      '',
      'Completed final conclusion output.',
      '',
      '## Evidence Summary By Phase',
      '',
      '- Overview collection: TTID=1912ms.',
    ].join('\n'))).toBe(true);

    expect(looksLikePhaseSummaryFallback([
      '## 综合结论',
      '',
      '完成综合结论输出。',
      '',
      '## 分阶段证据摘要',
      '',
      '- 启动概览采集: 获取启动概览。',
      '',
      '## 根因拆解',
      '',
      '主要来自启动阶段。',
      '',
      '## 优化建议',
      '',
      '建议优化启动任务。',
    ].join('\n'))).toBe(true);

    expect(looksLikePhaseSummaryFallback([
      '综合结论：完成综合结论输出。冷启动TTID=1912ms。',
      '分阶段证据摘要：启动概览采集: 获取启动概览：冷启动dur=1338ms。',
      '1. 启动详情分析: 四象限 Q1=62.8%。',
    ].join('\n'))).toBe(true);
  });

  it('does not flag a rich report that contains independent evidence sections', () => {
    const report = [
      '# 启动性能分析报告',
      '',
      '## 综合结论',
      '',
      '冷启动 TTID=1912ms，主因是主线程模拟负载。ChaosTask self=456ms，LoadSimulator_ActivityInit self=249.8ms。',
      '',
      '## 分阶段证据摘要',
      '',
      '- 启动概览采集: 获取启动概览，TTID=1912ms。',
      '- 启动详情分析: 四象限 Q1=62.8%、Q4b=35.1%。',
      '',
      '## 关键证据链',
      '',
      '- startup_detail 对应证据 ID art-10。',
      '- hot_slice_states 对应 data:sql_table:current:abc。',
      '',
      '## 优化建议',
      '',
      '降低启动期主线程模拟负载。',
    ].join('\n');

    expect(looksLikePhaseSummaryFallback(report)).toBe(false);
    expect(assessFinalResultQuality({
      result: result({ conclusion: report }),
      query: '分析这个启动 trace',
    })).toBeUndefined();

    const plainReport = [
      '综合结论：',
      '冷启动 TTID=1912ms，主因是主线程模拟负载。',
      '',
      '分阶段证据摘要：',
      '启动概览采集: 获取启动概览，TTID=1912ms。',
      '',
      '关键证据链：',
      'startup_detail 对应证据 ID art-10。',
      'hot_slice_states 对应 data:sql_table:current:abc。',
      '',
      '优化建议：',
      '降低启动期主线程模拟负载。',
    ].join('\n');

    expect(looksLikePhaseSummaryFallback(plainReport)).toBe(false);
    expect(assessFinalResultQuality({
      result: result({ conclusion: plainReport }),
      query: '分析这个启动 trace',
    })).toBeUndefined();
  });

  it('marks empty successful results as partial instead of normal completion', () => {
    const target = result({
      conclusion: '   ',
      confidence: 0.91,
    });

    const issue = applyFinalResultQualityGate({
      result: target,
      query: '分析这个 trace',
    });

    expect(issue?.code).toBe('empty_conclusion');
    expect(target.partial).toBe(true);
    expect(target.confidence).toBe(0.55);
    expect(target.terminationMessage).toContain('最终结果质量闸门');
  });

  it('flags process narration that leaked into the final conclusion', () => {
    const leaked = [
      '1. **冷启动**，dur=1338.65ms，原分类warm已被重分类为cold（R009）',
      '2. **TTID=1912.20ms > dur=1338.65ms**，差距573.55ms（R008触发）',
      '',
      '现在完成Phase 1，进入Phase 1.5验证启动类型，然后进入Phase 2深钻。',
      'Phase 2 已获取关键概要数据。现在进入 Phase 2.5。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: leaked }),
      query: '分析启动性能',
    })?.code).toBe('process_narration_conclusion');
  });

  it('flags structured interim markdown that has no deliverable final-report heading', () => {
    const interim = [
      '### Phase 1 关键发现记录',
      '',
      '- 冷启动 dur=1338ms，TTID=1912ms。',
      '- 主线程 Running=63%。',
      '',
      '### Phase 2 待验证项',
      '',
      '- 继续检查内存压力、Binder 和 CPU 频率。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: interim }),
      query: '分析启动性能',
    })?.code).toBe('missing_final_report_heading');
  });

  it('flags sparse unverified analysis conclusions but leaves concise verified answers alone', () => {
    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'failed',
          policy: 'block',
          passed: false,
          checkedClaimCount: 1,
          unsupportedClaimCount: 1,
          claimResults: [{ claimId: 'claim-ttid', status: 'unsupported' }],
          issues: [{
            claimId: 'claim-ttid',
            severity: 'error',
            code: 'unsupported_claim',
            message: 'No evidence matched this claim',
          }],
        },
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: '应用包名是 com.example.demo。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '这个 trace 的应用包名是什么？',
    })).toBeUndefined();

    expect(assessFinalResultQuality({
      result: result({
        conclusion: '最慢函数是 ChaosTask，self_ms=456ms。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '哪个函数最慢？',
    })).toBeUndefined();

    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [],
          clusters: [],
          evidenceChain: [{
            conclusionId: 'c1',
            text: 'startup_detail 显示 TTID=1912ms',
          }],
          claims: [{
            id: 'claim-ttid',
            text: 'TTID=1912ms',
            references: [{
              evidenceRefId: 'art-10',
              column: 'ttid_ms',
              value: 1912,
            }],
          }],
          uncertainties: [],
          nextSteps: [],
        },
      }),
      query: '分析这个启动 trace',
    })).toBeUndefined();

    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [],
          clusters: [],
          evidenceChain: [],
          claims: [{
            id: 'claim-empty',
            text: 'TTID=1912ms',
            references: [],
          }],
          uncertainties: [],
          nextSteps: [],
        },
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');
  });

  it('does not override runtime results that are already marked partial', () => {
    expect(assessFinalResultQuality({
      result: result({
        conclusion: '   ',
        partial: true,
        terminationMessage: 'runtime already degraded this result',
      }),
      query: '分析这个 trace',
    })).toBeUndefined();
  });
});
