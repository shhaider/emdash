import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, ensureScreenshotDir, skipOnboardingIfPresent } from './helpers';

test.beforeAll(() => ensureScreenshotDir());

test('J2: home view shows project actions and sidebar', async () => {
  const { app, page } = await launchApp();

  try {
    await skipOnboardingIfPresent(page);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/j2-home.png' });

    await expect(page.getByText('PROJECTS')).toBeVisible();
    await expect(page.getByText('Add Project')).toBeVisible();
    await expect(page.getByText('Skills')).toBeVisible();
    await expect(page.getByText('MCP')).toBeVisible();
    await expect(page.getByText('Settings')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('J2: clicking Open project triggers file selection', async () => {
  const { app, page } = await launchApp();

  try {
    await skipOnboardingIfPresent(page);

    await page.getByText('Open project').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/j2-open-project.png' });
  } finally {
    await app.close();
  }
});

test('J2: clicking Create New Project opens project creation', async () => {
  const { app, page } = await launchApp();

  try {
    await skipOnboardingIfPresent(page);

    await page.getByText('Create New Project').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/j2-create-project.png' });
  } finally {
    await app.close();
  }
});

test('J2: sidebar Add Project button opens modal', async () => {
  const { app, page } = await launchApp();

  try {
    await skipOnboardingIfPresent(page);

    await page.getByText('Add Project').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/j2-add-project-modal.png' });
  } finally {
    await app.close();
  }
});
