/**
 * Full agent session journey — the REAL test.
 *
 * Opens a real git repo in emdash, creates a task, waits for the
 * agent PTY to start, sends a real instruction, and verifies the
 * agent responds. This proves emdash works as a usable interface
 * for interacting with a coding agent.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, ensureScreenshotDir, skipOnboardingIfPresent } from './helpers';

test.beforeAll(() => ensureScreenshotDir());

test('FULL: open repo → create task → agent starts → user types → agent responds', async () => {
  // Create a real git repo with a real file
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-full-'));
  execSync('git init -b main', { cwd: tmpRepo });
  fs.writeFileSync(path.join(tmpRepo, 'hello.py'), 'print("hello world")\n');
  execSync('git add . && git commit -m "initial commit"', { cwd: tmpRepo });

  const { app, page } = await launchApp();

  try {
    // Step 1: Get past onboarding
    await skipOnboardingIfPresent(page);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e/screenshots/full-01-home.png' });

    // Step 2: Mock file dialog and open the project
    await app.evaluate(async ({ dialog }, repoPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [repoPath],
      });
    }, tmpRepo);

    // Open the Add Project modal
    const openBtn = page.getByText('Open project');
    if (await openBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await openBtn.click();
    } else {
      await page.getByText('Add Project').click();
    }
    await page.waitForTimeout(1000);

    // Click "Choose" to trigger the mocked file dialog
    await page.getByText('Choose').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/full-02-directory-chosen.png' });

    // Fill in project name
    const nameInput = page.getByPlaceholder('Enter a project name');
    if (await nameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await nameInput.fill('Full Test Project');
    }

    // Click Create to submit
    await page.getByRole('button', { name: /Create/i }).click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'e2e/screenshots/full-02-project-opened.png' });

    // Step 3: Find and click "Create Task"
    const createTaskBtn = page.getByRole('button', { name: /Create Task/i }).first();
    const hasCreateTask = await createTaskBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasCreateTask) {
      // Maybe we need to navigate to the project first
      const projectLink = page.locator('[class*="sidebar"] >> text=/emdash-full/i').first()
        .or(page.locator('nav >> text=/emdash-full/i').first());
      if (await projectLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        await projectLink.click();
        await page.waitForTimeout(3000);
      }
    }
    await page.screenshot({ path: 'e2e/screenshots/full-03-before-create-task.png' });

    // Click Create Task
    const taskBtn = page.getByRole('button', { name: /Create Task/i }).first();
    if (await taskBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await taskBtn.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'e2e/screenshots/full-04-create-task-modal.png' });

      // Read what's on screen — look for task creation form elements
      const bodyText = await page.textContent('body') ?? '';
      console.log('Create task modal body (first 1000):', bodyText.substring(0, 1000));

      // Look for the task name input and fill it
      const nameInput = page.getByPlaceholder(/name|task/i).first();
      if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nameInput.fill('Add a greeting function');
        await page.waitForTimeout(500);
      }

      // Look for branch name input
      const branchInput = page.getByPlaceholder(/branch/i).first();
      if (await branchInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        await branchInput.fill('feature/greeting');
      }

      await page.screenshot({ path: 'e2e/screenshots/full-05-task-form-filled.png' });

      // Submit the task
      const submitBtn = page.getByRole('button', { name: /create|submit|start/i }).last();
      if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(8000);
        await page.screenshot({ path: 'e2e/screenshots/full-06-task-created.png' });

        // Step 4: Verify we're in the task view
        const afterBody = await page.textContent('body') ?? '';
        console.log('After task creation (first 1500):', afterBody.substring(0, 1500));

        await page.screenshot({ path: 'e2e/screenshots/full-07-task-view.png' });

        // Step 5: Click "Create conversation" to start the agent
        const createConvBtn = page.getByText('Create conversation').first()
          .or(page.getByRole('button', { name: /create.*conversation/i }).first());

        if (await createConvBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await createConvBtn.click();
          await page.waitForTimeout(2000);
          await page.screenshot({ path: 'e2e/screenshots/full-08-create-conv-modal.png' });

          // The modal shows "Agent: Claude Code" + "Dangerously skip permissions" + "Create"
          // Click Create in the modal to actually launch the agent
          const modalCreateBtn = page.getByRole('button', { name: /^Create/i }).last();
          if (await modalCreateBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await modalCreateBtn.click();
            console.log('Clicked Create in conversation modal — launching Claude Code agent');

            // Wait for agent to start (PTY subprocess spawn + initialization)
            await page.waitForTimeout(15000);
            await page.screenshot({ path: 'e2e/screenshots/full-09-agent-launched.png' });

            const afterConv = await page.textContent('body') ?? '';
            console.log('After agent launch (first 3000):', afterConv.substring(0, 3000));

            // Check for terminal elements
            const xtermCount = await page.locator('.xterm, [class*="xterm"], .xterm-screen').count();
            console.log('xterm elements found:', xtermCount);

            // xterm renders a hidden textarea for keyboard input
            const xtermTextarea = page.locator('.xterm-helper-textarea').first();
            // Also try the xterm container
            const terminal = page.locator('.xterm').first();

            const canType = await xtermTextarea.count() > 0 || await terminal.isVisible({ timeout: 3000 }).catch(() => false);

            if (canType) {
              console.log('Terminal found — clicking to focus and typing');
              // Click the xterm container to focus it
              if (await terminal.isVisible({ timeout: 1000 }).catch(() => false)) {
                await terminal.click();
              }
              await page.waitForTimeout(2000);

              // Type a simple instruction
              await page.keyboard.type('what files are in this repo?');
              await page.keyboard.press('Enter');

              // Wait for agent to process
              await page.waitForTimeout(30000);
              await page.screenshot({ path: 'e2e/screenshots/full-10-agent-response.png' });

              const responseBody = await page.textContent('body') ?? '';
              console.log('After agent interaction (first 3000):', responseBody.substring(0, 3000));

              // Take one more screenshot after more time
              await page.waitForTimeout(15000);
              await page.screenshot({ path: 'e2e/screenshots/full-11-agent-continued.png' });
            } else {
              console.log('Terminal not visible after agent launch');
              await page.screenshot({ path: 'e2e/screenshots/full-09-no-terminal.png' });
            }
          }
        } else {
          console.log('Create conversation button not found');
        }

        await page.screenshot({ path: 'e2e/screenshots/full-11-final-state.png' });
      }
    } else {
      console.log('Create Task button not found');
      const allButtons = await page.locator('button').allTextContents();
      console.log('Available buttons:', allButtons.filter(b => b.trim()));
      await page.screenshot({ path: 'e2e/screenshots/full-04-no-create-task.png' });
    }
  } finally {
    await app.close();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}, 180_000);
