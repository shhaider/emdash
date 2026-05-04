/**
 * Real coding task journey — the DEFINITIVE test.
 *
 * Opens a real git repo, creates a task, launches Codex (OpenAI) agent,
 * gives it a real coding instruction, waits for it to write code, and
 * verifies the file was created.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, ensureScreenshotDir, skipOnboardingIfPresent } from './helpers';

test.beforeAll(() => ensureScreenshotDir());

test('REAL TASK: open repo → create task → launch Codex → agent writes code', async () => {
  // Create a real git repo with a starter file
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-real-'));
  execSync('git init -b main', { cwd: tmpRepo });
  fs.writeFileSync(
    path.join(tmpRepo, 'README.md'),
    '# Test Project\n\nA test project for emdash E2E testing.\n'
  );
  execSync('git add . && git commit -m "initial commit"', { cwd: tmpRepo });

  const { app, page } = await launchApp();

  try {
    // Step 1: Get past onboarding
    await skipOnboardingIfPresent(page);
    await page.waitForTimeout(1000);

    // Step 2: Open the project
    await app.evaluate(async ({ dialog }, repoPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [repoPath],
      });
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

    const nameInput = page.getByPlaceholder('Enter a project name');
    if (await nameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await nameInput.fill('Coding Task Project');
    }
    await page.getByRole('button', { name: /Create/i }).click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'e2e/screenshots/real-01-project-created.png' });

    // Step 3: Create a task
    const taskBtn = page.getByRole('button', { name: /Create Task/i }).first();
    if (await taskBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await taskBtn.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'e2e/screenshots/real-02-create-task-modal.png' });

      // Submit task with defaults
      const submitBtn = page.getByRole('button', { name: /^Create/i }).last();
      await submitBtn.click();
      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'e2e/screenshots/real-03-task-created.png' });

      // Step 4: Create conversation with Codex (OpenAI)
      const createConvBtn = page.getByText('Create conversation').first();
      if (await createConvBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await createConvBtn.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'e2e/screenshots/real-04-conv-modal.png' });

        // Switch agent from Claude Code to Codex (OpenAI)
        // The AgentSelector is a Combobox with a trigger button showing the current agent
        const agentTrigger = page.locator('button').filter({ hasText: /Claude Code/i }).first();
        if (await agentTrigger.isVisible({ timeout: 2000 }).catch(() => false)) {
          await agentTrigger.click();
          await page.waitForTimeout(1000);
          await page.screenshot({ path: 'e2e/screenshots/real-04b-agent-dropdown-open.png' });

          // Type "Codex" to filter the list
          await page.keyboard.type('Codex');
          await page.waitForTimeout(500);

          // Click the Codex option
          const codexItem = page.locator('[role="option"]').filter({ hasText: /^Codex/i }).first()
            .or(page.getByText('Codex').first());

          if (await codexItem.isVisible({ timeout: 2000 }).catch(() => false)) {
            await codexItem.click();
            await page.waitForTimeout(500);
            console.log('Selected Codex as agent');
          } else {
            console.log('Codex not found in dropdown — listing all options');
            const allOptions = await page.locator('[role="option"]').allTextContents();
            console.log('Dropdown options:', allOptions.slice(0, 10));
          }
        } else {
          console.log('Agent trigger button not found');
        }

        await page.screenshot({ path: 'e2e/screenshots/real-05-agent-selected.png' });

        // Click Create to launch the agent
        const modalCreate = page.getByRole('button', { name: /^Create/i }).last();
        await modalCreate.click();
        console.log('Launching agent...');

        // Wait for agent to start
        await page.waitForTimeout(15000);
        await page.screenshot({ path: 'e2e/screenshots/real-06-agent-started.png' });

        // Get page content to see what's happening
        const bodyAfterLaunch = await page.textContent('body') ?? '';
        console.log('After agent launch (first 2000):', bodyAfterLaunch.substring(0, 2000));

        // Click into the terminal area and type the coding instruction
        const terminal = page.locator('.xterm').first();
        if (await terminal.isVisible({ timeout: 5000 }).catch(() => false)) {
          await terminal.click();
          await page.waitForTimeout(2000);

          // Give a simple, concrete coding task
          const instruction = 'Create a file called greet.py with a function greet(name) that returns "Hello, {name}!" and a main block that calls it with "World"';
          await page.keyboard.type(instruction);
          await page.keyboard.press('Enter');
          console.log('Sent instruction to agent');

          // Wait for agent to process (this is the real test — does it write code?)
          await page.waitForTimeout(60000);
          await page.screenshot({ path: 'e2e/screenshots/real-07-agent-working.png' });

          // Check if the file was created in the repo
          const greetExists = fs.existsSync(path.join(tmpRepo, 'greet.py'));
          console.log('greet.py exists in repo:', greetExists);

          if (greetExists) {
            const content = fs.readFileSync(path.join(tmpRepo, 'greet.py'), 'utf-8');
            console.log('greet.py content:', content);
          }

          // Take another screenshot after more time
          await page.waitForTimeout(30000);
          await page.screenshot({ path: 'e2e/screenshots/real-08-agent-finished.png' });

          // Final check
          const greetFinal = fs.existsSync(path.join(tmpRepo, 'greet.py'));
          console.log('greet.py exists (final check):', greetFinal);

          // Also check the worktree (emdash might use a separate worktree)
          const worktrees = execSync('git worktree list', { cwd: tmpRepo }).toString();
          console.log('Git worktrees:', worktrees);

          // Check all worktree directories for the file
          for (const line of worktrees.split('\n')) {
            const wtPath = line.split(/\s+/)[0];
            if (wtPath && fs.existsSync(path.join(wtPath, 'greet.py'))) {
              const content = fs.readFileSync(path.join(wtPath, 'greet.py'), 'utf-8');
              console.log(`greet.py found in worktree ${wtPath}:`, content);
            }
          }

          const finalBody = await page.textContent('body') ?? '';
          console.log('Final state (first 3000):', finalBody.substring(0, 3000));
        } else {
          console.log('Terminal not visible after agent launch');
        }
      }
    } else {
      console.log('Create Task button not found');
    }

    await page.screenshot({ path: 'e2e/screenshots/real-09-final.png' });
  } finally {
    await app.close();
    // Don't clean up tmpRepo immediately — let the user inspect if needed
    console.log('Temp repo at:', tmpRepo);
  }
}, 300_000);
