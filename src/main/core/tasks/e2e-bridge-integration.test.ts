/**
 * End-to-end integration test: emdash hook runner → SimpleAgent bridge.
 *
 * Starts SimpleAgent's real Python bridge server as a subprocess, then
 * runs emdash's `applyBeforeProvisionGate` against it. Proves the full
 * chain that was flagged as INFRASTRUCTURE_READY_NOT_WIRED in Sprint 3.
 *
 * Requires: Python 3 with governed_fsm_conduit importable (i.e., the
 * SimpleAgent repo at ../../ relative to emdash root).
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@shared/tasks';
import type { ProjectProvider } from '@main/core/projects/project-provider';
import { log } from '@main/lib/logger';
import { applyBeforeProvisionGate } from './before-provision-gate';

const EMDASH_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SIMPLEAGENT_ROOT = path.resolve(EMDASH_ROOT, '..', '..');

function buildTask(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: 'task-e2e-1',
    projectId: 'proj-e2e-1',
    name: 'E2E integration test task',
    status: 'todo',
    sourceBranch: { type: 'local', branch: 'main' },
    taskBranch: 'feature/e2e-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    statusChangedAt: new Date().toISOString(),
    isPinned: false,
    prs: [],
    conversations: {},
  };
  return { ...base, ...overrides };
}

function buildProject(repoPath: string): ProjectProvider {
  return { repoPath } as unknown as ProjectProvider;
}

async function writeProjectHooks(
  projectDir: string,
  port: number
): Promise<void> {
  const dir = path.join(projectDir, '.emdash');
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(
    path.join(dir, 'hooks.json'),
    JSON.stringify(
      {
        hooks: [
          {
            name: 'simpleagent-gate',
            event: 'task.before_provision',
            url: `http://127.0.0.1:${port}/hooks/before-provision`,
            timeout_ms: 5000,
            on_unreachable: 'block',
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );
}

function writeFakeRun(stateRoot: string, currentState: string, status: string): void {
  const runDir = path.join(stateRoot, 'run-20240101T120000Z-e2etest');
  execSync(`mkdir -p "${runDir}"`);
  const run = {
    run_id: 'run-20240101T120000Z-e2etest',
    channel: 'test',
    request_text: 'e2e test',
    route_key: 'software',
    current_state: currentState,
    path: 'mvp',
    status,
    created_at: '2024-01-01T12:00:00Z',
    last_updated: '2024-01-01T12:00:01Z',
    last_completed_state: null,
    last_artifact_path: null,
    history: [],
  };
  const fs = require('node:fs');
  fs.writeFileSync(path.join(runDir, 'RUN.json'), JSON.stringify(run, null, 2), 'utf8');
}

function startBridge(stateRoot: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const script = `
import sys, json
from governed_fsm_conduit.bridge import start_bridge_server
port = start_bridge_server("${stateRoot}", port=0)
print(json.dumps({"port": port}), flush=True)
import time
time.sleep(120)
`;
    const proc = spawn('python3', ['-c', script], {
      cwd: SIMPLEAGENT_ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: SIMPLEAGENT_ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Bridge startup timed out. stderr: ${stderr}`));
    }, 10_000);

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          try {
            const data = JSON.parse(line.trim());
            if (data.port) {
              clearTimeout(timeout);
              resolve({ proc, port: data.port });
              return;
            }
          } catch {
            // not valid JSON yet
          }
        }
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (!stdout.includes('"port"')) {
        reject(new Error(`Bridge exited with code ${code} before printing port. stderr: ${stderr}`));
      }
    });
  });
}

describe('E2E: emdash → SimpleAgent bridge', () => {
  const cleanups: string[] = [];
  let bridgeProc: ChildProcess | null = null;

  beforeEach(() => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    vi.spyOn(os, 'homedir').mockReturnValue('/tmp/emdash-e2e-no-global-hooks');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (bridgeProc) {
      bridgeProc.kill();
      bridgeProc = null;
    }
    for (const dir of cleanups.splice(0)) {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it('denies provisioning when SimpleAgent FSM is in planning state (S06)', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'e2e-deny-'));
    cleanups.push(tmpDir);

    const stateRoot = path.join(tmpDir, 'fsm-state');
    await fsPromises.mkdir(stateRoot, { recursive: true });
    writeFakeRun(stateRoot, 'S06', 'ACTIVE');

    const { proc, port } = await startBridge(stateRoot);
    bridgeProc = proc;

    const projectDir = path.join(tmpDir, 'project');
    await fsPromises.mkdir(projectDir, { recursive: true });
    await writeProjectHooks(projectDir, port);

    await expect(
      applyBeforeProvisionGate(buildTask(), buildProject(projectDir))
    ).rejects.toThrow(/S06/);
  }, 15_000);

  it('allows provisioning when SimpleAgent FSM is in implementation state (S14)', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'e2e-allow-'));
    cleanups.push(tmpDir);

    const stateRoot = path.join(tmpDir, 'fsm-state');
    await fsPromises.mkdir(stateRoot, { recursive: true });
    writeFakeRun(stateRoot, 'S14', 'ACTIVE');

    const { proc, port } = await startBridge(stateRoot);
    bridgeProc = proc;

    const projectDir = path.join(tmpDir, 'project');
    await fsPromises.mkdir(projectDir, { recursive: true });
    await writeProjectHooks(projectDir, port);

    await expect(
      applyBeforeProvisionGate(buildTask(), buildProject(projectDir))
    ).resolves.toBeUndefined();
  }, 15_000);

  it('allows provisioning when no FSM run exists (no governance active)', async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'e2e-no-run-'));
    cleanups.push(tmpDir);

    const stateRoot = path.join(tmpDir, 'fsm-state-empty');

    const { proc, port } = await startBridge(stateRoot);
    bridgeProc = proc;

    const projectDir = path.join(tmpDir, 'project');
    await fsPromises.mkdir(projectDir, { recursive: true });
    await writeProjectHooks(projectDir, port);

    await expect(
      applyBeforeProvisionGate(buildTask(), buildProject(projectDir))
    ).resolves.toBeUndefined();
  }, 15_000);
});
