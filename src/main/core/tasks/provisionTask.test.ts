import { promises as fsPromises } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookConfigEntry } from '@main/core/hooks/types';
import { log } from '@main/lib/logger';
// Import provisionTask AFTER all mocks are registered.
import { provisionTask } from './provisionTask';

// --- Mocks (must be hoisted before importing provisionTask) ---

const hoisted = vi.hoisted(() => {
  const taskRow = {
    id: 'task-1',
    projectId: 'proj-1',
    name: 'Sample task',
    status: 'todo',
    sourceBranch: null,
    taskBranch: null,
    linkedIssue: null,
    archivedAt: null,
    lastInteractedAt: null,
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:00:00.000Z',
    statusChangedAt: '2026-05-03T00:00:00.000Z',
    isPinned: 0,
    workspaceProvider: null,
    workspaceId: null,
    workspaceProviderData: null,
  };
  const state = { projectRepoPath: '', selectCall: 0 };
  const taskManagerProvision = vi.fn(async () => ({
    success: true as const,
    data: {
      persistData: {
        workspaceId: 'ws-1',
        workspaceProviderData: undefined,
        sshConnectionId: undefined,
      },
    },
  }));
  return { taskRow, state, taskManagerProvision };
});

vi.mock('@main/db/client', () => {
  // First .select().from(tasks).where(...) per test returns the task row.
  // Subsequent calls (parallel terminals/conversations reads) return [].
  // The counter lives in `hoisted.state.selectCall` so it can be reset between tests.
  const select = vi.fn(() => {
    hoisted.state.selectCall += 1;
    if (hoisted.state.selectCall === 1) {
      return {
        from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([hoisted.taskRow])) })),
      };
    }
    return { from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) };
  });
  const updateWhere = vi.fn(() => Promise.resolve());
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    db: {
      select,
      update,
    },
  };
});

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: {
    getProject: vi.fn(() => ({
      get repoPath() {
        return hoisted.state.projectRepoPath;
      },
    })),
  },
}));

vi.mock('@main/core/tasks/task-manager', () => ({
  taskManager: {
    getTask: vi.fn(() => undefined),
    getWorkspaceId: vi.fn(() => undefined),
    provisionTask: hoisted.taskManagerProvision,
  },
}));

vi.mock('@main/core/workspaces/workspace-registry', () => ({
  workspaceRegistry: {
    get: vi.fn(() => ({ path: '/tmp/ws-1' })),
  },
}));

vi.mock('@main/lib/telemetry', () => ({
  capture: vi.fn(),
}));

vi.mock('@main/core/conversations/utils', () => ({
  mapConversationRowToConversation: vi.fn(),
}));

vi.mock('@main/core/terminals/core', () => ({
  mapTerminalRowToTerminal: vi.fn(),
}));

vi.mock('./utils/utils', () => ({
  mapTaskRowToTask: vi.fn((row: typeof hoisted.taskRow) => ({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    status: row.status,
    sourceBranch: undefined,
    taskBranch: undefined,
    linkedIssue: undefined,
    isPinned: false,
    prs: [],
    conversations: {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    statusChangedAt: row.statusChangedAt,
  })),
}));

// --- Real local HTTP server helpers (NOT mocked) ---

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

describe('provisionTask hook wiring', () => {
  const cleanups: string[] = [];
  const servers: ServerHandle[] = [];
  let fakeHome: string;

  beforeEach(async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    hoisted.taskManagerProvision.mockClear();
    hoisted.state.selectCall = 0;
    fakeHome = await makeProjectDir('emdash-prov-home-');
    cleanups.push(fakeHome);
    // Avoid picking up a developer's real ~/.emdash/hooks.json during tests.
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const handle of servers.splice(0)) {
      await stopServer(handle);
    }
    for (const dir of cleanups.splice(0)) {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
    hoisted.state.projectRepoPath = '';
  });

  it('throws when the configured hook denies, and does not call taskManager.provisionTask', async () => {
    const projectDir = await makeProjectDir('emdash-prov-deny-');
    cleanups.push(projectDir);
    hoisted.state.projectRepoPath = projectDir;

    const handle = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, reason: 'TEST' }));
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

    await expect(provisionTask('task-1')).rejects.toThrow(/TEST/);
    expect(hoisted.taskManagerProvision).not.toHaveBeenCalled();
  });

  it('proceeds to taskManager.provisionTask when no hook is configured', async () => {
    const projectDir = await makeProjectDir('emdash-prov-no-hook-');
    cleanups.push(projectDir);
    hoisted.state.projectRepoPath = projectDir;

    const result = await provisionTask('task-1');
    expect(hoisted.taskManagerProvision).toHaveBeenCalledTimes(1);
    expect(result.workspaceId).toBe('ws-1');
  });
});
