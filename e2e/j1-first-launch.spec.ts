import { test, expect } from '@playwright/test';
import { launchApp, ensureScreenshotDir, skipOnboardingIfPresent } from './helpers';

test.beforeAll(() => ensureScreenshotDir());

test('J1: app launches successfully with visible window', async () => {
  const { app, page } = await launchApp();

  try {
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'e2e/screenshots/j1-launch.png' });

    const windowState = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return null;
      return {
        width: win.getBounds().width,
        height: win.getBounds().height,
        visible: win.isVisible(),
        title: win.getTitle(),
      };
    });

    expect(windowState).not.toBeNull();
    expect(windowState!.width).toBeGreaterThanOrEqual(700);
    expect(windowState!.height).toBeGreaterThanOrEqual(500);
    expect(windowState!.title).toContain('Emdash');

    const html = await page.content();
    expect(html.length).toBeGreaterThan(500);
  } finally {
    await app.close();
  }
});

test('J1: app reaches home view (past onboarding)', async () => {
  const { app, page } = await launchApp();

  try {
    await skipOnboardingIfPresent(page);
    await page.screenshot({ path: 'e2e/screenshots/j1-home.png' });

    await expect(page.getByText('PROJECTS')).toBeVisible();
    await expect(page.getByText('Settings')).toBeVisible();
  } finally {
    await app.close();
  }
});
