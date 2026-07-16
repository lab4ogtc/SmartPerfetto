// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import { bootstrap } from '../bootstrap';
import type { OutputFormat } from '../repl/renderer';
import { CliAnalyzeService } from '../services/cliAnalyzeService';
import { withConsoleLogToStderr } from '../io/stdio';
import { ensureSkillRegistryInitialized, skillRegistry } from '../../services/skillEngine/skillLoader';
import { runBatchSkill } from '../../services/batchTrace/batchTraceRunner';
import { writeBatchTraceArtifacts } from '../../services/batchTrace/batchTraceReportService';
import type { BatchTraceInputV1, BatchTraceResultV1, BatchTraceRunV1 } from '../../services/batchTrace/batchTraceTypes';

export interface BatchSkillCommandArgs {
  skillId: string;
  traces: string[];
  traceList?: string;
  params?: string;
  concurrency?: string;
  format?: OutputFormat;
  out?: string;
  jsonOut?: string;
  envFile?: string;
  sessionDir?: string;
}

function parseParams(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--params must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function parseConcurrency(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  return parsed;
}

function traceListPaths(traceList: string | undefined): string[] {
  if (!traceList?.trim()) return [];
  const filePath = path.resolve(traceList);
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function resolveTraceInputs(traces: string[], traceList: string | undefined): BatchTraceInputV1[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const trace of [...traces, ...traceListPaths(traceList)]) {
    const resolved = path.resolve(trace);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    paths.push(resolved);
  }
  return paths.map((tracePath, ordinal) => ({
    ordinal,
    source: 'local_path',
    tracePath,
    label: path.basename(tracePath),
    sizeBytes: fs.existsSync(tracePath) ? fs.statSync(tracePath).size : undefined,
  }));
}

function defaultBatchDirectory(home: string, runId: string): string {
  return path.join(home, 'batch-runs', runId);
}

function emitProgress(format: OutputFormat, result: BatchTraceResultV1): void {
  const payload = {
    type: 'trace_result',
    ordinal: result.ordinal,
    trace: result.input.label ?? result.input.tracePath ?? result.input.traceId,
    status: result.status,
    metricCount: result.metrics.length,
    error: result.error,
  };
  if (format === 'ndjson') {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (format === 'text') {
    const suffix = result.error ? ` (${result.error})` : '';
    process.stderr.write(`[${result.ordinal}] ${payload.trace}: ${result.status}, metrics=${result.metrics.length}${suffix}\n`);
  }
}

function writeRunOutput(format: OutputFormat, run: BatchTraceRunV1): void {
  if (format === 'json') {
    console.log(JSON.stringify({ success: run.status === 'completed', run }, null, 2));
    return;
  }
  if (format === 'ndjson') {
    console.log(JSON.stringify({ type: 'complete', success: run.status === 'completed', run }));
    return;
  }
  console.log(`Batch run ${run.id}: ${run.status}`);
  console.log(`Skill: ${run.input.skillId}`);
  console.log(`Traces: ${run.perTrace.length}`);
  if (run.report?.jsonPath) console.log(`JSON: ${run.report.jsonPath}`);
  if (run.report?.htmlPath) console.log(`HTML: ${run.report.htmlPath}`);
}

function writeCommandError(format: OutputFormat, message: string): void {
  if (format === 'json' || format === 'ndjson') {
    console.error(JSON.stringify({ success: false, type: 'error', error: message }));
    return;
  }
  console.error(`Error: ${message}`);
}

export async function runBatchSkillCommand(args: BatchSkillCommandArgs): Promise<number> {
  const format = args.format ?? 'text';
  let cliService: CliAnalyzeService | null = null;
  try {
    const bootstrapResult = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
    const traceInputs = resolveTraceInputs(args.traces, args.traceList);
    if (traceInputs.length === 0) {
      writeCommandError(format, 'batch skill requires at least one trace');
      return 2;
    }
    const params = parseParams(args.params);
    const maxConcurrency = parseConcurrency(args.concurrency);
    cliService = new CliAnalyzeService();
    await cliService.prepareTraceProcessor();
    await ensureSkillRegistryInitialized();
    const run = await withConsoleLogToStderr(format !== 'text', () => runBatchSkill({
      surface: 'cli',
      skillId: args.skillId,
      params,
      traceInputs,
      maxConcurrency,
      onTraceResult: result => emitProgress(format, result),
    }, { registry: skillRegistry }));
    const runWithArtifacts = writeBatchTraceArtifacts({
      run,
      directory: defaultBatchDirectory(bootstrapResult.paths.home, run.id),
      ...(args.out ? { htmlPath: path.resolve(args.out) } : {}),
      ...(args.jsonOut ? { jsonPath: path.resolve(args.jsonOut) } : {}),
    });
    writeRunOutput(format, runWithArtifacts);
    return run.status === 'completed' ? 0 : 1;
  } catch (error) {
    writeCommandError(format, error instanceof Error ? error.message : String(error));
    return error instanceof SyntaxError ? 2 : 1;
  } finally {
    await cliService?.shutdown();
  }
}
