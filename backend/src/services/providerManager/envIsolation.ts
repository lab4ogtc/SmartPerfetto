// backend/src/services/providerManager/envIsolation.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

const PROVIDER_ENV_PREFIXES = [
  'ANTHROPIC_',
  'AWS_',
  'CLAUDE_',
  'OPENAI_',
  'SMARTPERFETTO_PI_AGENT_CORE_',
  'SMARTPERFETTO_OPENCODE_',
];

const PROVIDER_ENV_KEYS = new Set([
  'SMARTPERFETTO_AGENT_RUNTIME',
  'CLOUD_ML_REGION',
]);

export function clearProviderRuntimeEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (PROVIDER_ENV_KEYS.has(key) || PROVIDER_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      delete env[key];
    }
  }
}

export function mergeIsolatedProviderEnv(
  baseEnv: Record<string, string | undefined>,
  providerEnv: Record<string, string> | null | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  if (providerEnv) {
    clearProviderRuntimeEnv(env);
    Object.assign(env, providerEnv);
  }
  return env;
}
