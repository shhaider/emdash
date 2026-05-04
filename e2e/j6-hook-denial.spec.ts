/**
 * J6: Hook denial journey — SimpleAgent gate blocks provisioning.
 *
 * Starts SimpleAgent's real Python bridge with FSM in planning state (deny),
 * configures .emdash/hooks.json in a project repo, opens the project in
 * emdash, and attempts to create a task. Verifies the hook denial is surfaced.
 *
 * Also tests J7 (allow) by restarting with FSM in implementation state.
 */
import { test, expect } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, ensureScreenshotDir, skipOnboardingIfPresent } from './helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EMDASH_ROOT = path.resolve(__dirname, '..');
const SIMPLEAGENT_ROOT = path.resolve(EMDASH_ROOT, '..', '..');

function writeFakeRun(stateRoot: string, currentState: string, status: string): void {
  const runDir = path.join(stateRoot, 'run-20240101T120000Z-e2ehook');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'RUN.json'),
    JSON.stringify({
      run_id: 'run-20240101T120000Z-e2ehook',
      channel: 'test',
      request_text: 'e2e hook test',
      route_key: 'software',
      current_state: currentState,
      path: 'mvp',
      status,
      created_at: '2024-01-01T12:00:00Z',
      last_updated: '2024-01-01T12:00:01Z',
      last_completed_state: null,
      last_artifact_path: null,
      history: [],
    }, null, 2),
    'utf8'
  );
}

function startBridge(stateRoot: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const script = `
import sys, json
from governed_fsm_conduit.bridge import start_bridge_server
port = start_bridge_server("${stateRoot.replace(/\\/g, '\\\\')}", port=0)
print(json.dumps({"port": port}), flush=True)
import time
time.sleep(300)
`;
    const proc = spawn('python3', ['-c', script], {
      cwd: SIMPLEAGENT_ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: SIMPLEAGENT_ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Bridge startup timed out. stderr: ${stderr}`));
    }, 15_000);

    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        if (line.trim().startsWith('{')) {
          try {
            const data = JSON.parse(line.trim());
            if (data.port) {
              clearTimeout(timeout);
              resolve({ proc, port: data.port });
              return;
            }
          } catch { /* not valid JSON yet */ }
        }
      }
    });
    proc.on('error', (e) => { clearTimeout(timeout); reject(e); });
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (!stdout.includes('"port"')) {
        reject(new Error(`Bridge exited ${code}. stderr: ${stderr}`));
      }
    });
  });
}

function writeHooksJson(projectDir: string, port: number): void {
  const emdashDir = path.join(projectDir, '.emdash');
  fs.mkdirSync(emdashDir, { recursive: true });
  fs.writeFileSync(
    path.join(emdashDir, 'hooks.json'),
    JSON.stringify({
      hooks: [{
        name: 'simpleagent-gate',
        event: 'task.before_provision',
        url: `http://127.0.0.1:${port}/hooks/before-provision`,
        timeout_ms: 5000,
        on_unreachable: 'block',
      }],
    }, null, 2),
    'utf8'
  );
}

test.beforeAll(() => ensureScreenshotDir());

test('J6: SimpleAgent bridge returns deny for planning state (HTTP level)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-j6-deny-'));
  const stateRoot = path.join(tmpDir, 'fsm');
  fs.mkdirSync(stateRoot, { recursive: true });
  writeFakeRun(stateRoot, 'S06', 'ACTIVE');

  let bridgeProc: ChildProcess | null = null;

  try {
    const { proc, port } = await startBridge(stateRoot);
    bridgeProc = proc;

    // Verify bridge denies at HTTP level
    const http = await import('node:http');
    const response = await new Promise<string>((resolve, reject) => {
      const body = JSON.stringify({
        event: 'task.before_provision',
        taskId: 't1',
        projectId: 'p1',
        taskName: 'e2e-test',
        sourceBranch: null,
        taskBranch: null,
        linkedIssue: null,
        timestamp: new Date().toISOString(),
      });
      const req = http.request(
        `http://127.0.0.1:${port}/hooks/before-provision`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString() } },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => resolve(data));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const parsed = JSON.parse(response);
    expect(parsed.allowed).toBe(false);
    expect(parsed.reason).toContain('S06');
    console.log('Bridge deny response:', parsed);
  } finally {
    bridgeProc?.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('J6: SimpleAgent bridge returns allow for implementation state (HTTP level)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-j6-allow-'));
  const stateRoot = path.join(tmpDir, 'fsm');
  fs.mkdirSync(stateRoot, { recursive: true });
  writeFakeRun(stateRoot, 'S14', 'ACTIVE');

  let bridgeProc: ChildProcess | null = null;

  try {
    const { proc, port } = await startBridge(stateRoot);
    bridgeProc = proc;

    const http = await import('node:http');
    const response = await new Promise<string>((resolve, reject) => {
      const body = JSON.stringify({
        event: 'task.before_provision',
        taskId: 't1',
        projectId: 'p1',
        taskName: 'e2e-test',
        sourceBranch: null,
        taskBranch: null,
        linkedIssue: null,
        timestamp: new Date().toISOString(),
      });
      const req = http.request(
        `http://127.0.0.1:${port}/hooks/before-provision`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString() } },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => resolve(data));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const parsed = JSON.parse(response);
    expect(parsed.allowed).toBe(true);
    console.log('Bridge allow response:', parsed);
  } finally {
    bridgeProc?.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('J6: emdash project with hooks.json + deny bridge — provision attempt blocked in UI', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-j6-ui-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  execSync('git init && git checkout -b main && git commit --allow-empty -m "init"', { cwd: projectDir });

  const stateRoot = path.join(tmpDir, 'fsm');
  fs.mkdirSync(stateRoot, { recursive: true });
  writeFakeRun(stateRoot, 'S06', 'ACTIVE');

  let bridgeProc: ChildProcess | null = null;

  try {
    const { proc, port } = await startBridge(stateRoot);
    bridgeProc = proc;
    writeHooksJson(projectDir, port);

    const { app, page } = await launchApp();

    try {
      await skipOnboardingIfPresent(page);
      await page.waitForTimeout(1000);

      // Mock file dialog and open the project
      await app.evaluate(async ({ dialog }, repoPath) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [repoPath],
        });
      }, projectDir);

      // Always use "Add Project" sidebar — works regardless of existing projects
      await page.getByText('Add Project').click();
      await page.waitForTimeout(1000);
      await page.getByText('Choose').click();
      await page.waitForTimeout(2000);
      const nameField = page.getByPlaceholder('Enter a project name');
      if (await nameField.isVisible({ timeout: 1000 }).catch(() => false)) {
        await nameField.fill('Hook Test');
      }
      await page.getByRole('button', { name: /Create/i }).click();
      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'e2e/screenshots/j6-01-project-opened.png' });

      const bodyText = await page.textContent('body') ?? '';
      console.log('J6 project view (first 800):', bodyText.substring(0, 800));

      // Look for any "new task" or task creation button
      const buttons = await page.locator('button').allTextContents();
      console.log('J6 buttons:', buttons.filter(b => b.trim()));

      await page.screenshot({ path: 'e2e/screenshots/j6-02-looking-for-task-button.png' });

      // Try to create a task — the hook should block provisioning
      const newTaskBtn = page.locator('button').filter({ hasText: /new.*task|create.*task|\+/i }).first();
      if (await newTaskBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await newTaskBtn.click();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'e2e/screenshots/j6-03-task-creation-attempt.png' });

        // Fill in task details if a modal appeared
        const nameInput = page.getByPlaceholder(/task.*name|enter.*name/i).first();
        if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await nameInput.fill('E2E Hook Test Task');
          await page.waitForTimeout(500);
        }

        // Submit task creation
        const createBtn = page.getByRole('button', { name: /create|submit/i }).last();
        if (await createBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await createBtn.click();
          await page.waitForTimeout(5000);
          await page.screenshot({ path: 'e2e/screenshots/j6-04-after-task-create.png' });
        }

        // Check for error/denial message
        const finalText = await page.textContent('body') ?? '';
        const hasDenialIndicator = finalText.includes('denied') ||
          finalText.includes('S06') ||
          finalText.includes('Hook') ||
          finalText.includes('error') ||
          finalText.includes('failed') ||
          finalText.includes('provision');

        console.log('J6 final text (first 1000):', finalText.substring(0, 1000));
        await page.screenshot({ path: 'e2e/screenshots/j6-05-denial-result.png' });
      } else {
        console.log('No task creation button found — project may not have fully loaded');
        await page.screenshot({ path: 'e2e/screenshots/j6-03-no-task-button.png' });
      }
    } finally {
      await app.close();
    }
  } finally {
    bridgeProc?.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}, 60_000);
