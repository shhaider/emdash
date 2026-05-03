import { promises as fsPromises } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@main/lib/logger';
import { runHooks } from './hook-runner';
import type { BeforeProvisionContext, HookConfigEntry } from './types';

interface ResponderFn {
  (req: http.IncomingMessage, res: http.ServerResponse, body: string): void;
}

interface ServerHandle {
  server: http.Server;
  port: number;
  setResponder: (fn: ResponderFn) => void;
}

async function startServer(initial: ResponderFn): Promise<ServerHandle> {
  let responder = initial;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      responder(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('failed to bind');
  return {
    server,
    port: address.port,
    setResponder: (fn) => {
      responder = fn;
    },
  };
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

const sampleContext: BeforeProvisionContext = {
  taskId: 't-1',
  projectId: 'p-1',
  taskName: 'Try it',
  sourceBranch: 'main',
  taskBranch: 'feature/try',
  linkedIssue: null,
  timestamp: '2026-05-03T00:00:00.000Z',
};

describe('runHooks', () => {
  const cleanups: string[] = [];
  const servers: ServerHandle[] = [];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
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

  it('returns allowed:true when no hooks are configured', async () => {
    const projectDir = await makeProjectDir('emdash-runner-no-hooks-');
    cleanups.push(projectDir);
    // Also point homedir at empty temp dir so the global fallback finds nothing.
    const fakeHome = await makeProjectDir('emdash-runner-empty-home-');
    cleanups.push(fakeHome);
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const result = await runHooks('task.before_provision', sampleContext, {
      projectRepoPath: projectDir,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('returns allowed:true when single hook approves', async () => {
    const projectDir = await makeProjectDir('emdash-runner-approve-');
    cleanups.push(projectDir);
    const handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: true }));
    });
    servers.push(handle);
    await writeProjectHooks(projectDir, [
      {
        name: 'gate-a',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${handle.port}`,
        timeout_ms: 1000,
        on_unreachable: 'block',
      },
    ]);

    const result = await runHooks('task.before_provision', sampleContext, {
      projectRepoPath: projectDir,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('returns deny with hookName and reason when single hook denies', async () => {
    const projectDir = await makeProjectDir('emdash-runner-deny-');
    cleanups.push(projectDir);
    const handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, reason: 'nope' }));
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

    const result = await runHooks('task.before_provision', sampleContext, {
      projectRepoPath: projectDir,
    });
    expect(result).toEqual({ allowed: false, hookName: 'gate-deny', reason: 'nope' });
  });

  it('returns allowed:true when two hooks both approve', async () => {
    const projectDir = await makeProjectDir('emdash-runner-two-approve-');
    cleanups.push(projectDir);
    const okResponder: ResponderFn = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: true }));
    };
    const a = await startServer(okResponder);
    const b = await startServer(okResponder);
    servers.push(a, b);
    await writeProjectHooks(projectDir, [
      {
        name: 'a',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${a.port}`,
        timeout_ms: 1000,
        on_unreachable: 'block',
      },
      {
        name: 'b',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${b.port}`,
        timeout_ms: 1000,
        on_unreachable: 'block',
      },
    ]);

    const result = await runHooks('task.before_provision', sampleContext, {
      projectRepoPath: projectDir,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('returns deny from second hook when only second denies', async () => {
    const projectDir = await makeProjectDir('emdash-runner-second-denies-');
    cleanups.push(projectDir);
    const a = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: true }));
    });
    const b = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, reason: 'b-reason' }));
    });
    servers.push(a, b);
    await writeProjectHooks(projectDir, [
      {
        name: 'a',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${a.port}`,
        timeout_ms: 1000,
        on_unreachable: 'block',
      },
      {
        name: 'b',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${b.port}`,
        timeout_ms: 1000,
        on_unreachable: 'block',
      },
    ]);

    const result = await runHooks('task.before_provision', sampleContext, {
      projectRepoPath: projectDir,
    });
    expect(result).toEqual({ allowed: false, hookName: 'b', reason: 'b-reason' });
  });

  it('returns first denial in config-array order when two hooks both deny', async () => {
    const projectDir = await makeProjectDir('emdash-runner-both-deny-');
    cleanups.push(projectDir);
    const a = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, reason: 'a-reason' }));
    });
    const b = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, reason: 'b-reason' }));
    });
    servers.push(a, b);
    await writeProjectHooks(projectDir, [
      {
        name: 'a',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${a.port}`,
        timeout_ms: 1000,
        on_unreachable: 'block',
      },
      {
        name: 'b',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${b.port}`,
        timeout_ms: 1000,
        on_unreachable: 'block',
      },
    ]);

    const result = await runHooks('task.before_provision', sampleContext, {
      projectRepoPath: projectDir,
    });
    expect(result).toEqual({ allowed: false, hookName: 'a', reason: 'a-reason' });
  });

  it('blocks when single hook is unreachable and on_unreachable=block', async () => {
    const projectDir = await makeProjectDir('emdash-runner-unreachable-block-');
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

    const result = await runHooks('task.before_provision', sampleContext, {
      projectRepoPath: projectDir,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.hookName).toBe('gate-block');
      expect(result.reason).toContain('Hook gate-block unreachable');
    }
    const warnedAboutUnreachable = warnSpy.mock.calls.some((args: unknown[]) =>
      String(args[0] ?? '').includes('hook gate-block unreachable')
    );
    expect(warnedAboutUnreachable).toBe(true);
  });

  it('allows when single hook is unreachable and on_unreachable=allow', async () => {
    const projectDir = await makeProjectDir('emdash-runner-unreachable-allow-');
    cleanups.push(projectDir);
    await writeProjectHooks(projectDir, [
      {
        name: 'gate-allow',
        event: 'task.before_provision',
        url: 'http://127.0.0.1:1',
        timeout_ms: 200,
        on_unreachable: 'allow',
      },
    ]);

    const result = await runHooks('task.before_provision', sampleContext, {
      projectRepoPath: projectDir,
    });
    expect(result).toEqual({ allowed: true });
    const warnedAboutUnreachable = warnSpy.mock.calls.some((args: unknown[]) =>
      String(args[0] ?? '').includes('hook gate-allow unreachable')
    );
    expect(warnedAboutUnreachable).toBe(true);
  });

  it('mixed: A approves, B unreachable+block → blocks with B', async () => {
    const projectDir = await makeProjectDir('emdash-runner-mixed-');
    cleanups.push(projectDir);
    const a = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: true }));
    });
    servers.push(a);
    await writeProjectHooks(projectDir, [
      {
        name: 'a',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${a.port}`,
        timeout_ms: 1000,
        on_unreachable: 'block',
      },
      {
        name: 'b',
        event: 'task.before_provision',
        url: 'http://127.0.0.1:1',
        timeout_ms: 200,
        on_unreachable: 'block',
      },
    ]);

    const result = await runHooks('task.before_provision', sampleContext, {
      projectRepoPath: projectDir,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.hookName).toBe('b');
      expect(result.reason).toContain('Hook b unreachable');
    }
  });
});
