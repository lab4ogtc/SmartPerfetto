import {afterEach, describe, expect, it} from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {CodebaseRegistry} from '../../services/codebase/codebaseRegistry';
import {PathSecurityGate} from '../../services/codebase/pathSecurityGate';
import {AppSourceIngester} from '../../services/rag/appSourceIngester';
import {RagStore} from '../../services/ragStore';
import {
  ensureWorkspaceCodebase,
  resolveWorkspaceAttachmentPaths,
} from '../mcpWorkspaceAttachment';

let tmpDir = '';

function makeProject(): {projectRoot: string; tracePath: string; registry: CodebaseRegistry; store: RagStore} {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-mcp-workspace-'));
  const projectRoot = path.join(tmpDir, 'my-project');
  fs.mkdirSync(path.join(projectRoot, 'src'), {recursive: true});
  fs.mkdirSync(path.join(projectRoot, 'traces'), {recursive: true});
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'MainActivity.kt'),
    'class MainActivity { fun onCreate() = Unit }\n',
    'utf-8',
  );
  const tracePath = path.join(projectRoot, 'traces', 'boot.pftrace');
  fs.writeFileSync(tracePath, 'trace-bytes', 'utf-8');

  return {
    projectRoot,
    tracePath,
    registry: new CodebaseRegistry(path.join(tmpDir, 'codebases.json')),
    store: new RagStore(path.join(tmpDir, 'rag.json')),
  };
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, {recursive: true, force: true});
  tmpDir = '';
});

describe('resolveWorkspaceAttachmentPaths', () => {
  it('accepts trace files inside the workspace root', async () => {
    const {projectRoot, tracePath} = makeProject();

    const resolved = await resolveWorkspaceAttachmentPaths({
      workspaceId: projectRoot,
      filePath: tracePath,
    });

    expect(resolved.workspaceRootRealpath).toBe(fs.realpathSync(projectRoot));
    expect(resolved.traceFileRealpath).toBe(fs.realpathSync(tracePath));
  });

  it('rejects trace files outside the workspace root', async () => {
    const {projectRoot} = makeProject();
    const outsideTrace = path.join(tmpDir, 'boot.pftrace');
    fs.writeFileSync(outsideTrace, 'trace-bytes', 'utf-8');

    await expect(resolveWorkspaceAttachmentPaths({
      workspaceId: projectRoot,
      filePath: outsideTrace,
    })).rejects.toThrow(/inside workspace/);
  });
});

describe('ensureWorkspaceCodebase', () => {
  it('registers, ingests, and reuses the workspace as an app source codebase', async () => {
    const {projectRoot, registry, store} = makeProject();
    const gate = new PathSecurityGate({allowlistRoots: [projectRoot]});
    const ingester = new AppSourceIngester(store, registry, gate);
    const context = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};

    const first = await ensureWorkspaceCodebase({
      workspaceRoot: projectRoot,
      registry,
      ingester,
      context,
    });
    const second = await ensureWorkspaceCodebase({
      workspaceRoot: projectRoot,
      registry,
      ingester,
      context,
    });

    expect(second.codebaseId).toBe(first.codebaseId);
    expect(first.ingested).toBe(true);
    expect(second.ingested).toBe(false);
    expect(registry.list()).toHaveLength(1);
    expect(store.search('MainActivity', {
      kinds: ['app_source'],
      codebaseIds: [first.codebaseId],
    }).results).toHaveLength(1);
  });
});
