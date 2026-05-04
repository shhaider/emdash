import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EMDASH_ROOT = path.resolve(__dirname, '..');

let _e2eUserDataDir: string | null = null;

function getE2EUserDataDir(): string {
  if (!_e2eUserDataDir) {
    _e2eUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-e2e-userdata-'));
  }
  return _e2eUserDataDir;
}

export async function launchApp(options?: {
  env?: Record<string, string>;
}): Promise<{ app: ElectronApplication; page: Page }> {
  const mainEntry = path.resolve(EMDASH_ROOT, 'out', 'main', 'index.js');

  if (!fs.existsSync(mainEntry)) {
    throw new Error(
      `Built main entry not found at ${mainEntry}. Run "pnpm run build" first.`
    );
  }

  const userDataDir = getE2EUserDataDir();

  const app = await electron.launch({
    args: ['--user-data-dir=' + userDataDir, '--force-device-scale-factor=1', EMDASH_ROOT],
    cwd: EMDASH_ROOT,
    colorScheme: 'light',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TELEMETRY_ENABLED: 'false',
      EMDASH_DB_FILE: path.join(userDataDir, 'emdash-e2e.db'),
      ...options?.env,
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  return { app, page };
}

export async function screenshotAndClose(
  app: ElectronApplication,
  page: Page,
  name: string
): Promise<void> {
  await page.screenshot({ path: path.join(__dirname, 'screenshots', `${name}.png`) });
  await app.close();
}

export function ensureScreenshotDir(): void {
  const dir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function skipOnboardingIfPresent(page: Page): Promise<void> {
  await page.waitForTimeout(5000);
  const skipBtn = page.getByText('Skip');
  if (await skipBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await skipBtn.click();
    await page.waitForTimeout(2000);
  }
  const startBtn = page.getByText('Start shipping');
  if (await startBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await startBtn.click();
    await page.waitForTimeout(2000);
  }
}
