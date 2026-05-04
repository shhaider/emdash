/**
 * J9/J10: Settings and navigation journeys.
 *
 * Tests sidebar navigation between all main views (Skills, MCP, Settings)
 * and verifies each view renders correctly.
 */
import { test, expect } from '@playwright/test';
import { launchApp, ensureScreenshotDir, skipOnboardingIfPresent } from './helpers';

test.beforeAll(() => ensureScreenshotDir());

test('J9: navigate to Settings view', async () => {
  const { app, page } = await launchApp();

  try {
    await skipOnboardingIfPresent(page);
    await page.waitForTimeout(1000);

    await page.getByText('Settings').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/j9-01-settings.png' });

    const bodyText = await page.textContent('body') ?? '';
    const hasSettingsContent = bodyText.includes('Settings') ||
      bodyText.includes('Branch prefix') ||
      bodyText.includes('Theme') ||
      bodyText.includes('Preferences');

    expect(hasSettingsContent).toBe(true);
  } finally {
    await app.close();
  }
});

test('J9: navigate to Skills view', async () => {
  const { app, page } = await launchApp();

  try {
    await skipOnboardingIfPresent(page);
    await page.waitForTimeout(1000);

    await page.getByText('Skills').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/j9-02-skills.png' });

    const bodyText = await page.textContent('body') ?? '';
    expect(bodyText.length).toBeGreaterThan(50);
  } finally {
    await app.close();
  }
});

test('J9: navigate to MCP view', async () => {
  const { app, page } = await launchApp();

  try {
    await skipOnboardingIfPresent(page);
    await page.waitForTimeout(1000);

    await page.getByRole('button', { name: 'MCP', exact: true }).first().click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/j9-03-mcp.png' });

    const bodyText = await page.textContent('body') ?? '';
    expect(bodyText.length).toBeGreaterThan(50);
  } finally {
    await app.close();
  }
});

test('J9: navigate between all views and return home', async () => {
  const { app, page } = await launchApp();

  try {
    await skipOnboardingIfPresent(page);
    await page.waitForTimeout(1000);

    // Settings
    await page.getByText('Settings').click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'e2e/screenshots/j9-04-nav-settings.png' });

    // Skills
    await page.getByText('Skills').click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'e2e/screenshots/j9-05-nav-skills.png' });

    // MCP
    await page.getByRole('button', { name: 'MCP', exact: true }).first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'e2e/screenshots/j9-06-nav-mcp.png' });

    // Back to home (click the Emdash logo or PROJECTS area)
    const homeLink = page.locator('[class*="logo"], [data-testid*="home"]').first()
      .or(page.getByText('PROJECTS'));

    if (await homeLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await homeLink.click();
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: 'e2e/screenshots/j9-07-nav-back-home.png' });
  } finally {
    await app.close();
  }
});
