// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import path from 'path';

import {runCorpusRegression} from './corpusRunner';

function optionValues(name: string): string[] | undefined {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values.length > 0 ? values : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes('--quiet')) {
    const writeSummary = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      if (String(args[0] ?? '').startsWith('Trace corpus regression')) writeSummary(...args);
    };
  }
  const repoRoot = path.resolve(__dirname, '../../..');
  const result = await runCorpusRegression(repoRoot, {
    caseIds: optionValues('--case'),
    targetIds: optionValues('--target'),
    writeEvidence: true,
  });
  for (const failure of result.failures) {
    console.error(`[FAIL] ${failure.case_id}:${failure.target} - ${failure.reason}`);
  }
  if (result.failures.length > 0) {
    throw new Error(
      `Trace corpus regression failed: ${result.executed.length} passed, ${result.failures.length} failed`,
    );
  }
  console.log(`Trace corpus regression passed: ${result.executed.length} expectation(s)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
