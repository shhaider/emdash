/**
 * Real coding task — agent writes code through emdash.
 *
 * Flow: open repo → create task → agent launches → dismiss warnings →
 * switch to Opus model → type coding instruction → verify file created.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, ensureScreenshotDir, skipOnboardingIfPresent } from './helpers';

test.beforeAll(() => ensureScreenshotDir());

test('REAL TASK: agent writes greet.py through emdash', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-real-'));
  execSync('git init -b main', { cwd: tmpRepo });
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Test Project\n');
  execSync('git add . && git commit -m "initial commit"', { cwd: tmpRepo });

  const { app, page } = await launchApp();

  try {
    // 1. Skip onboarding
    await skipOnboardingIfPresent(page);
    await page.waitForTimeout(1000);

    // 2. Open project
    await app.evaluate(async ({ dialog }, repoPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repoPath] });
    }, tmpRepo);

    const openBtn = page.getByText('Open project');
    if (await openBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await openBtn.click();
    } else {
      await page.getByText('Add Project').click();
    }
    await page.waitForTimeout(1000);
    await page.getByText('Choose').click();
    await page.waitForTimeout(2000);
    const nameField = page.getByPlaceholder('Enter a project name');
    if (await nameField.isVisible({ timeout: 1000 }).catch(() => false)) {
      await nameField.fill('Greet Task');
    }
    await page.getByRole('button', { name: /Create/i }).click();
    await page.waitForTimeout(5000);

    // 3. Create task (no initial prompt — we'll type directly after model switch)
    const taskBtn = page.getByRole('button', { name: /Create Task/i }).first();
    expect(await taskBtn.isVisible({ timeout: 5000 })).toBe(true);
    await taskBtn.click();
    await page.waitForTimeout(2000);
    // Just submit with defaults
    await page.getByRole('button', { name: /^Create/i }).last().click();
    await page.waitForTimeout(5000);

    // 4. Create conversation with Claude Code
    const createConvBtn = page.getByText('Create conversation').first();
    if (await createConvBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await createConvBtn.click();
      await page.waitForTimeout(1000);

      // Enable skip permissions
      const skipToggle = page.locator('button[role="switch"]').first();
      if (await skipToggle.isVisible({ timeout: 1000 }).catch(() => false)) {
        const checked = await skipToggle.getAttribute('aria-checked');
        if (checked !== 'true') {
          await skipToggle.click();
          console.log('Enabled skip permissions');
        }
      }

      await page.getByRole('button', { name: /^Create/i }).last().click();
      console.log('Conversation created — agent launching...');

      // 5. Wait for agent to start
      await page.waitForTimeout(15000);
      await page.screenshot({ path: 'e2e/screenshots/real-01-agent-starting.png' });

      // 6. Click terminal and dismiss any warnings with Enter
      const terminal = page.locator('.xterm').first();
      if (await terminal.isVisible({ timeout: 5000 }).catch(() => false)) {
        await terminal.click();
        await page.waitForTimeout(1000);
        // Press Enter several times to dismiss settings warnings
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'e2e/screenshots/real-02-warnings-dismissed.png' });

        // 7. Switch to Opus model (not rate-limited)
        await page.keyboard.type('/model opus');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'e2e/screenshots/real-03-model-switched.png' });

        // 8. Type the coding instruction
        await page.keyboard.type('Create a file called greet.py with a function greet(name) that returns f"Hello, {name}!" and a main block that prints greet("World")');
        await page.keyboard.press('Enter');
        console.log('Instruction sent to agent');

        // 9. Poll for file creation
        let greetFound = false;
        let greetContent = '';
        let greetPath = '';

        for (let i = 0; i < 24; i++) {
          await page.waitForTimeout(10000);

          // Check original repo and all worktrees
          try {
            const worktrees = execSync('git worktree list', { cwd: tmpRepo }).toString();
            for (const line of worktrees.split('\n')) {
              const wtPath = line.split(/\s+/)[0];
              if (wtPath) {
                if (fs.existsSync(path.join(wtPath, 'greet.py'))) {
                  greetFound = true;
                  greetPath = path.join(wtPath, 'greet.py');
                  greetContent = fs.readFileSync(greetPath, 'utf-8');
                  break;
                }
              }
            }
          } catch { /* ignore */ }

          if (greetFound) break;

          if (i % 4 === 3) {
            await page.screenshot({ path: `e2e/screenshots/real-04-poll-${i}.png` });
            console.log(`Poll ${i + 1}/24: waiting...`);
          }
        }

        await page.screenshot({ path: 'e2e/screenshots/real-05-result.png' });

        if (greetFound) {
          console.log('SUCCESS: greet.py at', greetPath);
          console.log('Content:\n' + greetContent);
          expect(greetContent).toContain('greet');
        } else {
          const body = await page.textContent('body') ?? '';
          console.log('File not created. Terminal:\n' + body.substring(0, 3000));
          await page.screenshot({ path: 'e2e/screenshots/real-05-failed.png' });
        }
      }
    }
  } finally {
    await app.close();
    console.log('Repo:', tmpRepo);
  }
}, 600_000);
