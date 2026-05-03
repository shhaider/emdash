import { promises as fsPromises } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@shared/tasks';
import type { HookConfigEntry } from '@main/core/hooks/types';
import type { ProjectProvider } from '@main/core/projects/project-provider';
import { log } from '@main/lib/logger';
import { applyBeforeProvisionGate } from './before-provision-gate';

interface ServerHandle {
  server: http.Server;
  port: number;
}

async function startServer(
  responder: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => responder(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('failed to bind');
  return { server, port: address.port };
}

async function stopServer(handle: ServerHandle | null): Promise<void> {
  if (!handle) return;
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
}

async function makeProjectDir(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeProjectHooks(
  projectDir: string,
  hooks: Array<Partial<HookConfigEntry> & Pick<HookConfigEntry, 'name' | 'event' | 'url'>>
): Promise<void> {
  const dir = path.join(projectDir, '.emdash');
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(
    path.join(dir, 'hooks.json'),
    JSON.stringify({ hooks }, null, 2),
    'utf8'
  );
}

function buildTask(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: 'task-1',
    projectId: 'proj-1',
    name: 'Sample task',
    status: 'todo',
    sourceBranch: { type: 'local', branch: 'main' },
    taskBranch: 'feature/x',
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:00:00.000Z',
    statusChangedAt: '2026-05-03T00:00:00.000Z',
    isPinned: false,
    prs: [],
    conversations: {},
  };
  return { ...base, ...overrides };
}

function buildProject(repoPath: string): ProjectProvider {
  // Test-only narrowing: applyBeforeProvisionGate only reads `.repoPath`.
  return { repoPath } as unknown as ProjectProvider;
}

describe('applyBeforeProvisionGate', () => {
  const cleanups: string[] = [];
  const servers: ServerHandle[] = [];

  beforeEach(() => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const handle of servers.splice(0)) {
      await stopServer(handle);
    }
    for (const dir of cleanups.splice(0)) {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves without throwing when the hook approves', async () => {
    const projectDir = await makeProjectDir('emdash-gate-allow-');
    cleanups.push(projectDir);
    const handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: true }));
    });
    servers.push(handle);
    await writeProjectHooks(projectDir, [
      {
        name: 'gate-allow',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${handle.port}`,
        timeout_ms: 1000,
        on_unreachable: 'block',
      },
    ]);

    await expect(
      applyBeforeProvisionGate(buildTask(), buildProject(projectDir))
    ).resolves.toBeUndefined();
  });

  it('throws a formatted error when the hook denies with reason and details', async () => {
    const projectDir = await makeProjectDir('emdash-gate-deny-');
    cleanups.push(projectDir);
    const handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, reason: 'X', details: 'Y' }));
    });
    servers.push(handle);
    await writeProjectHooks(projectDir, [
      {
        name: 'gate-deny',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${handle.port}`,
        timeout_ms: 1000,
        on_unreachable: 'block',
      },
    ]);

    await expect(applyBeforeProvisionGate(buildTask(), buildProject(projectDir))).rejects.toThrow(
      'Hook "gate-deny" denied: X (Y)'
    );
  });

  it('throws when the hook is unreachable and on_unreachable=block', async () => {
    const projectDir = await makeProjectDir('emdash-gate-unreach-block-');
    cleanups.push(projectDir);
    await writeProjectHooks(projectDir, [
      {
        name: 'gate-block',
        event: 'task.before_provision',
        url: 'http://127.0.0.1:1',
        timeout_ms: 200,
        on_unreachable: 'block',
      },
    ]);

    await expect(applyBeforeProvisionGate(buildTask(), buildProject(projectDir))).rejects.toThrow(
      /denied/
    );
  });

  it('resolves when the hook is unreachable and on_unreachable=allow', async () => {
    const projectDir = await makeProjectDir('emdash-gate-unreach-allow-');
    cleanups.push(projectDir);
    await writeProjectHooks(projectDir, [
      {
        name: 'gate-allow-unreach',
        event: 'task.before_provision',
        url: 'http://127.0.0.1:1',
        timeout_ms: 200,
        on_unreachable: 'allow',
      },
    ]);

    await expect(
      applyBeforeProvisionGate(buildTask(), buildProject(projectDir))
    ).resolves.toBeUndefined();
  });
});
