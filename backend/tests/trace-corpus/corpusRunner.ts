// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'fs';
import path from 'path';

import {classifyScene} from '../../src/agentv3/sceneClassifier';
import {loadStrategies} from '../../src/agentv3/strategyLoader';
import {createSkillEvaluator, type SkillEvaluator} from '../skill-eval/runner';

type TokenContext = {
  trace_start: string;
  trace_end: string;
  fixture_upid: number;
  fixture_utid: number;
};

type CorpusExpectation = {
  id: string;
  type: 'skill' | 'strategy';
  target: string;
  mode?: 'semantic' | 'graceful_empty' | 'unavailable' | 'definition';
  source_file?: string;
  parameters?: Record<string, unknown>;
  required_steps?: string[];
  semantic_step?: string;
  limitation_reason?: string;
  expected_error?: string;
  required_marker?: string;
  query?: string;
  expected_strategy?: string;
};

type CorpusCase = {
  id: string;
  kind: 'real' | 'constructed';
  case_dir: string;
  manifest_path: string;
  construction?: {output: string};
  coverage: {expectations: CorpusExpectation[]};
};

export type CorpusRunResult = {
  executed: string[];
  failures: Array<{case_id: string; target: string; reason: string}>;
};

export function loadCorpus(repoRoot: string): {
  cases: CorpusCase[];
  coverage: any;
} {
  return {
    cases: JSON.parse(fs.readFileSync(path.join(repoRoot, 'Trace/catalog.json'), 'utf8')).cases,
    coverage: JSON.parse(fs.readFileSync(path.join(repoRoot, 'Trace/coverage.json'), 'utf8')),
  };
}

export function resolveParameterTokens(
  parameters: Record<string, unknown>,
  context: TokenContext,
): Record<string, unknown> {
  const tokenValues = new Map<string, unknown>([
    ['${trace_start}', context.trace_start],
    ['${trace_end}', context.trace_end],
    ['${fixture_upid}', context.fixture_upid],
    ['${fixture_utid}', context.fixture_utid],
  ]);
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [
      key,
      typeof value === 'string' && tokenValues.has(value) ? tokenValues.get(value) : value,
    ]),
  );
}

async function loadTokenContext(evaluator: SkillEvaluator): Promise<TokenContext> {
  const result = await evaluator.executeSQL(`
    SELECT
      printf('%d', trace_start()) AS trace_start,
      printf('%d', trace_end()) AS trace_end,
      COALESCE((SELECT upid FROM process WHERE name = 'com.smartperfetto.fixture' ORDER BY upid DESC LIMIT 1), 0) AS fixture_upid,
      COALESCE((
        SELECT t.utid FROM thread t
        JOIN process p USING (upid)
        WHERE p.name = 'com.smartperfetto.fixture' AND t.name = 'main'
        ORDER BY t.utid DESC LIMIT 1
      ), 0) AS fixture_utid
  `);
  if (result.error || result.rows.length !== 1) {
    throw new Error(`cannot resolve trace tokens: ${result.error ?? 'no row'}`);
  }
  const row = result.rows[0];
  return {
    trace_start: String(row[0]),
    trace_end: String(row[1]),
    fixture_upid: Number(row[2]),
    fixture_utid: Number(row[3]),
  };
}

async function assertMarker(evaluator: SkillEvaluator, marker: string | undefined): Promise<void> {
  if (!marker) return;
  const escaped = marker.replace(/'/g, "''");
  const result = await evaluator.executeSQL(`SELECT COUNT(*) AS count FROM slice WHERE name = '${escaped}'`);
  if (result.error || Number(result.rows[0]?.[0] ?? 0) < 1) {
    throw new Error(`required marker is absent: ${marker}`);
  }
}

function validateDefinition(repoRoot: string, expectation: CorpusExpectation): void {
  if (!expectation.source_file) throw new Error('definition expectation has no source_file');
  const sourcePath = path.resolve(repoRoot, expectation.source_file);
  if (!fs.existsSync(sourcePath)) throw new Error(`definition source is missing: ${expectation.source_file}`);
  const source = fs.readFileSync(sourcePath, 'utf8');
  if (!new RegExp(`^name:\\s*["']?${expectation.target}["']?\\s*$`, 'm').test(source)) {
    throw new Error(`definition source does not declare ${expectation.target}`);
  }
}

async function runSkillExpectation(
  evaluator: SkillEvaluator,
  expectation: CorpusExpectation,
  tokenContext: TokenContext,
): Promise<void> {
  await assertMarker(evaluator, expectation.required_marker);
  if (expectation.mode === 'definition') return;
  await evaluator.selectSkill(expectation.target);
  const requiredSteps = expectation.required_steps ?? [];
  if (requiredSteps.length === 0) throw new Error('execute expectation has no required_steps');
  const params = resolveParameterTokens(expectation.parameters ?? {}, tokenContext);
  const semanticStep = expectation.semantic_step ?? requiredSteps[requiredSteps.length - 1];
  let results;
  try {
    results = await evaluator.executeStepSequence(requiredSteps, params);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    if (expectation.mode === 'unavailable' && expectation.expected_error && message.includes(expectation.expected_error)) {
      return;
    }
    throw error;
  }
  const failed = results.find((result) =>
    !result.success &&
    !(result.stepId !== semanticStep && result.error === 'Condition not met'),
  );
  if (failed) {
    const message = `${failed.stepId} failed: ${failed.error ?? 'unknown error'}`;
    if (expectation.mode === 'unavailable' && expectation.expected_error && message.includes(expectation.expected_error)) {
      return;
    }
    throw new Error(message);
  }
  const semanticResult = results.find((result) => result.stepId === semanticStep);
  if (!semanticResult) throw new Error(`semantic step was not executed: ${semanticStep}`);
  if (expectation.mode === 'graceful_empty') {
    if (semanticResult.data.length !== 0) {
      throw new Error(`graceful-empty expectation unexpectedly returned ${semanticResult.data.length} row(s): ${semanticStep}`);
    }
    return;
  }
  if (expectation.mode === 'unavailable') {
    throw new Error(`unavailable expectation unexpectedly executed successfully: ${semanticStep}`);
  }
  if (semanticResult.data.length === 0) {
    throw new Error(`semantic step returned no rows: ${semanticStep ?? requiredSteps.join(', ')}`);
  }
}

async function runStrategyExpectation(
  evaluator: SkillEvaluator,
  expectation: CorpusExpectation,
): Promise<void> {
  await assertMarker(evaluator, expectation.required_marker);
  const strategy = loadStrategies().get(expectation.target);
  if (!strategy) throw new Error(`Strategy loader cannot resolve ${expectation.target}`);
  if (strategy.strategyKind !== 'contract_only') {
    const actual = classifyScene(expectation.query ?? '');
    if (actual !== (expectation.expected_strategy ?? expectation.target)) {
      throw new Error(`classifier returned ${actual} for query ${JSON.stringify(expectation.query)}`);
    }
  }
}

export async function runCorpusRegression(
  repoRoot: string,
  options: {
    caseIds?: string[];
    targetIds?: string[];
    writeEvidence?: boolean;
  } = {},
): Promise<CorpusRunResult> {
  const corpus = loadCorpus(repoRoot);
  const selectedCases = corpus.cases.filter((entry) =>
    entry.kind === 'constructed' && (!options.caseIds || options.caseIds.includes(entry.id)),
  );
  const targetFilter = options.targetIds ? new Set(options.targetIds) : null;
  const result: CorpusRunResult = {executed: [], failures: []};

  for (const entry of selectedCases) {
    const expectations = entry.coverage.expectations.filter((expectation) =>
      !targetFilter || targetFilter.has(expectation.target),
    );
    if (expectations.length === 0) continue;
    const tracePath = path.resolve(repoRoot, entry.construction!.output);
    if (!fs.existsSync(tracePath)) {
      for (const expectation of expectations) {
        result.failures.push({case_id: entry.id, target: expectation.target, reason: `materialized trace missing: ${tracePath}`});
      }
      continue;
    }
    const executable = expectations.find((expectation) => expectation.type === 'skill' && expectation.mode !== 'definition');
    const evaluator = createSkillEvaluator(executable?.target ?? 'global_trace_sanity_check');
    try {
      await evaluator.loadTrace(tracePath);
      const tokenContext = await loadTokenContext(evaluator);
      for (const expectation of expectations) {
        const executionKey = `${entry.id}:${expectation.type}:${expectation.target}`;
        try {
          if (expectation.type === 'skill') {
            if (expectation.mode === 'definition') validateDefinition(repoRoot, expectation);
            await runSkillExpectation(evaluator, expectation, tokenContext);
          } else {
            await runStrategyExpectation(evaluator, expectation);
          }
          result.executed.push(executionKey);
        } catch (error: any) {
          result.failures.push({case_id: entry.id, target: expectation.target, reason: error?.message ?? String(error)});
        }
      }
    } catch (error: any) {
      for (const expectation of expectations) {
        result.failures.push({case_id: entry.id, target: expectation.target, reason: error?.message ?? String(error)});
      }
    } finally {
      await evaluator.cleanup();
    }

    if (options.writeEvidence !== false) {
      const evidencePath = path.join(repoRoot, 'Trace/.generated/constructed', entry.id, 'regression-result.json');
      const caseEvidence = {
        schema_version: 1,
        case_id: entry.id,
        executed: result.executed.filter((key) => key.startsWith(`${entry.id}:`)),
        failures: result.failures.filter((failure) => failure.case_id === entry.id),
      };
      fs.writeFileSync(evidencePath, `${JSON.stringify(caseEvidence, null, 2)}\n`);
    }
  }
  return result;
}
