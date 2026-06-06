// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { ProviderService } from '../providerService';
import { resolveProviderRuntimeSnapshot } from '../providerSnapshot';
import type { ProviderCreateInput } from '../types';

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `provider-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('provider runtime snapshot hash', () => {
  let dir: string;
  let svc: ProviderService;

  beforeEach(async () => {
    dir = makeTmpDir();
    await fsp.mkdir(dir, { recursive: true });
    svc = new ProviderService(path.join(dir, 'providers.json'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const openAIProvider: ProviderCreateInput = {
    name: 'OpenAI Provider',
    category: 'official',
    type: 'openai',
    models: { primary: 'gpt-5.2', light: 'gpt-5.2-mini' },
    connection: {
      agentRuntime: 'openai-agents-sdk',
      openaiBaseUrl: 'https://api.openai.example/v1',
      openaiApiKey: 'sk-openai-secret-value',
    },
    tuning: {
      fullPerTurnMs: 120000,
      quickPerTurnMs: 30000,
    },
  };

  it('is stable across activation-only metadata changes', () => {
    const provider = svc.create(openAIProvider);
    const before = resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash;

    svc.activate(provider.id);

    expect(resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash).toBe(before);
  });

  it('changes when resolved model or endpoint changes', () => {
    const provider = svc.create(openAIProvider);
    const before = resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash;

    svc.update(provider.id, {
      models: { primary: 'gpt-5.2-pro' },
      connection: { openaiBaseUrl: 'https://api.changed.example/v1' },
    });

    expect(resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash).not.toBe(before);
  });

  it('changes when secret material changes without storing plaintext secret', () => {
    const provider = svc.create(openAIProvider);
    const before = resolveProviderRuntimeSnapshot(svc, provider.id);

    svc.update(provider.id, {
      connection: { openaiApiKey: 'sk-openai-secret-value-v2' },
    });
    const after = resolveProviderRuntimeSnapshot(svc, provider.id);

    expect(after.snapshotHash).not.toBe(before.snapshotHash);
    expect(JSON.stringify(before.snapshot)).not.toContain('sk-openai-secret-value');
    expect(JSON.stringify(after.snapshot)).not.toContain('sk-openai-secret-value-v2');
    expect(after.snapshot.environment.OPENAI_API_KEY).toBeUndefined();
  });

  it('ignores ambient AWS env for non-Bedrock Claude providers', () => {
    const originalAwsProfile = process.env.AWS_PROFILE;
    const originalAwsRegion = process.env.AWS_REGION;
    const originalAwsSessionToken = process.env.AWS_SESSION_TOKEN;
    process.env.AWS_PROFILE = 'ambient-profile-before';
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_SESSION_TOKEN = 'ambient-session-token-before';
    try {
      const provider = svc.create({
        name: 'Anthropic Provider',
        category: 'official',
        type: 'anthropic',
        models: { primary: 'claude-test', light: 'claude-light' },
        connection: {
          agentRuntime: 'claude-agent-sdk',
          claudeApiKey: 'sk-ant-secret-value',
          claudeBaseUrl: 'https://api.anthropic.example',
        },
      });
      const before = resolveProviderRuntimeSnapshot(svc, provider.id);

      process.env.AWS_PROFILE = 'ambient-profile-after';
      process.env.AWS_REGION = 'eu-central-1';
      process.env.AWS_SESSION_TOKEN = 'ambient-session-token-after';
      const after = resolveProviderRuntimeSnapshot(svc, provider.id);

      expect(after.snapshotHash).toBe(before.snapshotHash);
      expect(after.snapshot.environment.AWS_PROFILE).toBeUndefined();
      expect(after.snapshot.environment.AWS_REGION).toBeUndefined();
      expect(JSON.stringify(after.snapshot)).not.toContain('ambient-session-token-after');
    } finally {
      if (originalAwsProfile === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = originalAwsProfile;
      if (originalAwsRegion === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = originalAwsRegion;
      if (originalAwsSessionToken === undefined) delete process.env.AWS_SESSION_TOKEN;
      else process.env.AWS_SESSION_TOKEN = originalAwsSessionToken;
    }
  });

  it('ignores OpenAI snapshot fields that the OpenAI runtime does not consume', () => {
    const provider = svc.create(openAIProvider);
    const before = resolveProviderRuntimeSnapshot(svc, provider.id);

    svc.update(provider.id, {
      models: { subAgent: 'ignored-openai-subagent-model' },
      tuning: {
        ...openAIProvider.tuning,
        maxBudgetUsd: 25,
        effort: 'max',
        verifierTimeoutMs: 70000,
        enableSubAgents: true,
        enableVerification: false,
      },
    });

    const after = resolveProviderRuntimeSnapshot(svc, provider.id);
    expect(after.snapshotHash).toBe(before.snapshotHash);
    expect(after.snapshot.resolvedModels.subAgent).toBeUndefined();
    expect(after.snapshot.resolvedTimeouts.verifierTimeoutMs).toBeUndefined();
    expect(after.snapshot.environment.OPENAI_SUB_AGENT_MODEL).toBeUndefined();
    expect(after.snapshot.environment.OPENAI_ENABLE_VERIFICATION).toBeUndefined();
  });

  it('ignores Pi and OpenCode overrides that the OpenAI runtime does not consume', () => {
    const provider = svc.create({
      name: 'Custom OpenAI Provider',
      category: 'custom',
      type: 'custom',
      models: { primary: 'gpt-5.2', light: 'gpt-5.2-mini' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://api.openai-compatible.example/v1',
        openaiApiKey: 'sk-openai-compatible-secret',
        openCodeModelJson: '{"modelID":"ignored-opencode"}',
        piAgentCoreModelJson: '{"id":"ignored-pi"}',
      },
      custom: {
        envOverrides: {
          SMARTPERFETTO_OPENCODE_PROJECT_DIR: '/tmp/opencode-before',
          SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON: '["node","ignored-before.js"]',
          SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH: '/tmp/pi-before.mjs',
          SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT: 'ignored pi prompt before',
        },
      },
    });
    const before = resolveProviderRuntimeSnapshot(svc, provider.id);

    svc.update(provider.id, {
      connection: {
        openCodeModelJson: '{"modelID":"ignored-opencode-v2"}',
        piAgentCoreModelJson: '{"id":"ignored-pi-v2"}',
      },
      custom: {
        envOverrides: {
          SMARTPERFETTO_OPENCODE_PROJECT_DIR: '/tmp/opencode-after',
          SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON: '["node","ignored-after.js"]',
          SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH: '/tmp/pi-after.mjs',
          SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT: 'ignored pi prompt after',
        },
      },
    });

    const after = resolveProviderRuntimeSnapshot(svc, provider.id);
    expect(after.snapshotHash).toBe(before.snapshotHash);
    expect(after.snapshot.environment.SMARTPERFETTO_OPENCODE_PROJECT_DIR).toBeUndefined();
    expect(after.snapshot.environment.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH).toBeUndefined();
  });

  it('captures OpenCode runtime snapshots without storing model JSON secrets', () => {
    const provider = svc.create({
      name: 'OpenCode Provider',
      category: 'custom',
      type: 'custom',
      models: { primary: 'opencode-primary', light: 'opencode-light' },
      connection: {
        agentRuntime: 'opencode',
        openaiBaseUrl: 'https://api.opencode.example/v1',
        openaiApiKey: 'sk-opencode-openai-secret',
        openCodeSdkModulePath: '/opt/smartperfetto/opencode-sdk.mjs',
        openCodeModelJson: '{"providerID":"smartperfetto","modelID":"opencode-test","apiKey":"sk-opencode-json-secret"}',
        openCodeSystemPrompt: 'secret opencode system prompt',
      },
      custom: {
        envOverrides: {
          SMARTPERFETTO_OPENCODE_PROJECT_DIR: '/work/opencode',
          SMARTPERFETTO_OPENCODE_SERVER_TIMEOUT_MS: '20000',
          SMARTPERFETTO_OPENCODE_PROMPT_TIMEOUT_MS: '30000',
          SMARTPERFETTO_OPENCODE_ENABLE_STANDALONE_MCP: '1',
          SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON: '["node","opencode-secret-mcp.js"]',
          SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS: '7000',
        },
      },
    });

    const before = resolveProviderRuntimeSnapshot(svc, provider.id);
    svc.update(provider.id, {
      connection: {
        openCodeModelJson: '{"providerID":"smartperfetto","modelID":"opencode-test","apiKey":"sk-opencode-json-secret-v2"}',
      },
    });
    const after = resolveProviderRuntimeSnapshot(svc, provider.id);

    expect(before.snapshot.runtimeKind).toBe('opencode');
    expect(before.snapshot.baseUrl).toBe('https://api.opencode.example/v1');
    expect(before.snapshot.resolvedModels).toMatchObject({
      primary: 'opencode-primary',
      light: 'opencode-light',
    });
    expect(before.snapshotHash).not.toBe(after.snapshotHash);
    expect(JSON.stringify(before.snapshot)).not.toContain('sk-opencode-openai-secret');
    expect(JSON.stringify(before.snapshot)).not.toContain('sk-opencode-json-secret');
    expect(JSON.stringify(before.snapshot)).not.toContain('secret opencode system prompt');
    expect(JSON.stringify(before.snapshot)).not.toContain('opencode-secret-mcp.js');
    expect(before.snapshot.environment.SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH)
      .toBe('/opt/smartperfetto/opencode-sdk.mjs');
    expect(before.snapshot.environment.SMARTPERFETTO_OPENCODE_PROJECT_DIR)
      .toBe('/work/opencode');
    expect(before.snapshot.environment.SMARTPERFETTO_OPENCODE_SERVER_TIMEOUT_MS)
      .toBe('20000');
    expect(before.snapshot.environment.SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS)
      .toBe('7000');
    expect(before.snapshot.environment.SMARTPERFETTO_OPENCODE_MODEL_JSON).toBeUndefined();
    expect(before.snapshot.environment.SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT).toBeUndefined();
    expect(before.snapshot.environment.SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON).toBeUndefined();
    expect(before.snapshot.environment.OPENAI_API_KEY).toBeUndefined();
  });

  it('changes when OpenCode module, system prompt, or MCP config changes', () => {
    const provider = svc.create({
      name: 'OpenCode Config Provider',
      category: 'custom',
      type: 'custom',
      models: { primary: 'opencode-primary', light: 'opencode-light' },
      connection: {
        agentRuntime: 'opencode',
        openaiBaseUrl: 'https://api.opencode.example/v1',
        openaiApiKey: 'sk-opencode-openai-secret',
        openCodeSdkModulePath: '/opt/opencode-sdk-v1.mjs',
        openCodeSystemPrompt: 'opencode system prompt v1',
      },
      custom: {
        envOverrides: {
          SMARTPERFETTO_OPENCODE_PROJECT_DIR: '/work/opencode-v1',
          SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON: '["node","mcp-v1.js"]',
        },
      },
    });

    const beforeModule = resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash;
    svc.update(provider.id, {
      connection: { openCodeSdkModulePath: '/opt/opencode-sdk-v2.mjs' },
    });
    expect(resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash).not.toBe(beforeModule);

    const beforeSystemPrompt = resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash;
    svc.update(provider.id, {
      connection: { openCodeSystemPrompt: 'opencode system prompt v2' },
    });
    expect(resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash).not.toBe(beforeSystemPrompt);

    const beforeMcpCommand = resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash;
    svc.update(provider.id, {
      custom: {
        envOverrides: {
          SMARTPERFETTO_OPENCODE_PROJECT_DIR: '/work/opencode-v1',
          SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON: '["node","mcp-v2.js"]',
        },
      },
    });
    expect(resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash).not.toBe(beforeMcpCommand);
  });

  it('captures Pi runtime snapshots without storing model JSON secrets', () => {
    const provider = svc.create({
      name: 'Pi Provider',
      category: 'custom',
      type: 'custom',
      models: { primary: 'pi-primary', light: 'pi-light' },
      connection: {
        agentRuntime: 'pi-agent-core',
        piAgentCoreModulePath: '/opt/smartperfetto/pi-agent-core.mjs',
        piAgentCoreModelJson: '{"id":"pi-test","provider":"test","apiKey":"sk-pi-json-secret"}',
        piAgentCoreSystemPrompt: 'secret pi system prompt',
      },
      custom: {
        envOverrides: {
          SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM: '1',
        },
      },
    });

    const before = resolveProviderRuntimeSnapshot(svc, provider.id);
    svc.update(provider.id, {
      connection: {
        piAgentCoreModelJson: '{"id":"pi-test","provider":"test","apiKey":"sk-pi-json-secret-v2"}',
      },
    });
    const after = resolveProviderRuntimeSnapshot(svc, provider.id);

    expect(before.snapshot.runtimeKind).toBe('pi-agent-core');
    expect(before.snapshot.resolvedModels).toMatchObject({
      primary: 'pi-primary',
      light: 'pi-light',
    });
    expect(before.snapshotHash).not.toBe(after.snapshotHash);
    expect(JSON.stringify(before.snapshot)).not.toContain('sk-pi-json-secret');
    expect(JSON.stringify(before.snapshot)).not.toContain('secret pi system prompt');
    expect(before.snapshot.environment.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH)
      .toBe('/opt/smartperfetto/pi-agent-core.mjs');
    expect(before.snapshot.environment.SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM).toBe('1');
    expect(before.snapshot.environment.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toBeUndefined();
    expect(before.snapshot.environment.SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT).toBeUndefined();
  });

  it('changes when Pi module path or system prompt changes', () => {
    const provider = svc.create({
      name: 'Pi Config Provider',
      category: 'custom',
      type: 'custom',
      models: { primary: 'pi-primary', light: 'pi-light' },
      connection: {
        agentRuntime: 'pi-agent-core',
        piAgentCoreModulePath: '/opt/pi-v1.mjs',
        piAgentCoreModelJson: '{"id":"pi-test","provider":"test"}',
        piAgentCoreSystemPrompt: 'pi system prompt v1',
      },
    });

    const beforeModule = resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash;
    svc.update(provider.id, {
      connection: { piAgentCoreModulePath: '/opt/pi-v2.mjs' },
    });
    expect(resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash).not.toBe(beforeModule);

    const beforeSystemPrompt = resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash;
    svc.update(provider.id, {
      connection: { piAgentCoreSystemPrompt: 'pi system prompt v2' },
    });
    expect(resolveProviderRuntimeSnapshot(svc, provider.id).snapshotHash).not.toBe(beforeSystemPrompt);
  });
});
