import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@main/lib/logger';
import { loadHookConfig } from './hook-config-loader';

async function makeTempDir(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeHooksFile(dir: string, contents: string): Promise<string> {
  const emdashDir = path.join(dir, '.emdash');
  await fsPromises.mkdir(emdashDir, { recursive: true });
  const filePath = path.join(emdashDir, 'hooks.json');
  await fsPromises.writeFile(filePath, contents, 'utf8');
  return filePath;
}

describe('loadHookConfig', () => {
  const cleanups: string[] = [];
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of cleanups.splice(0)) {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns empty hooks when no project or global config exists', async () => {
    const projectDir = await makeTempDir('emdash-hooks-noconfig-project-');
    const fakeHome = await makeTempDir('emdash-hooks-noconfig-home-');
    cleanups.push(projectDir, fakeHome);
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const config = await loadHookConfig(projectDir);
    expect(config).toEqual({ hooks: [] });
  });

  it('loads project file when it exists', async () => {
    const projectDir = await makeTempDir('emdash-hooks-project-');
    cleanups.push(projectDir);
    await writeHooksFile(
      projectDir,
      JSON.stringify({
        hooks: [
          {
            name: 'project-gate',
            event: 'task.before_provision',
            url: 'http://127.0.0.1:9000',
            timeout_ms: 1234,
            on_unreachable: 'block',
          },
        ],
      })
    );

    const config = await loadHookConfig(projectDir);
    expect(config.hooks).toHaveLength(1);
    expect(config.hooks[0]).toEqual({
      name: 'project-gate',
      event: 'task.before_provision',
      url: 'http://127.0.0.1:9000',
      timeout_ms: 1234,
      on_unreachable: 'block',
    });
  });

  it('falls back to global config when project file is absent', async () => {
    const projectDir = await makeTempDir('emdash-hooks-fallback-project-');
    const fakeHome = await makeTempDir('emdash-hooks-fallback-home-');
    cleanups.push(projectDir, fakeHome);
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    await writeHooksFile(
      fakeHome,
      JSON.stringify({
        hooks: [
          {
            name: 'global-gate',
            event: 'task.before_provision',
            url: 'http://127.0.0.1:9001',
            on_unreachable: 'allow',
          },
        ],
      })
    );

    const config = await loadHookConfig(projectDir);
    expect(config.hooks).toHaveLength(1);
    expect(config.hooks[0].name).toBe('global-gate');
    expect(config.hooks[0].timeout_ms).toBe(5000); // default applied
  });

  it('project file takes precedence when both exist', async () => {
    const projectDir = await makeTempDir('emdash-hooks-precedence-project-');
    const fakeHome = await makeTempDir('emdash-hooks-precedence-home-');
    cleanups.push(projectDir, fakeHome);
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    await writeHooksFile(
      projectDir,
      JSON.stringify({
        hooks: [
          {
            name: 'project-wins',
            event: 'task.before_provision',
            url: 'http://127.0.0.1:9002',
            on_unreachable: 'block',
          },
        ],
      })
    );
    await writeHooksFile(
      fakeHome,
      JSON.stringify({
        hooks: [
          {
            name: 'global-loses',
            event: 'task.before_provision',
            url: 'http://127.0.0.1:9003',
            on_unreachable: 'allow',
          },
        ],
      })
    );

    const config = await loadHookConfig(projectDir);
    expect(config.hooks).toHaveLength(1);
    expect(config.hooks[0].name).toBe('project-wins');
  });

  it('ignores hooks missing required fields and logs a warning', async () => {
    const projectDir = await makeTempDir('emdash-hooks-missing-fields-');
    cleanups.push(projectDir);
    await writeHooksFile(
      projectDir,
      JSON.stringify({
        hooks: [
          { event: 'task.before_provision', url: 'http://x', on_unreachable: 'block' }, // no name
          { name: 'no-url', event: 'task.before_provision', on_unreachable: 'block' }, // no url
          { name: 'no-event', url: 'http://x', on_unreachable: 'block' }, // no event
          {
            name: 'bad-on-unreachable',
            event: 'task.before_provision',
            url: 'http://x',
            on_unreachable: 'maybe',
          }, // bad on_unreachable
          {
            name: 'good',
            event: 'task.before_provision',
            url: 'http://127.0.0.1:9004',
            on_unreachable: 'allow',
          },
        ],
      })
    );

    const config = await loadHookConfig(projectDir);
    expect(config.hooks).toHaveLength(1);
    expect(config.hooks[0].name).toBe('good');
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('ignores hooks with unknown event values and logs a warning', async () => {
    const projectDir = await makeTempDir('emdash-hooks-unknown-event-');
    cleanups.push(projectDir);
    await writeHooksFile(
      projectDir,
      JSON.stringify({
        hooks: [
          {
            name: 'future',
            event: 'task.after_provision',
            url: 'http://x',
            on_unreachable: 'allow',
          },
        ],
      })
    );

    const config = await loadHookConfig(projectDir);
    expect(config.hooks).toHaveLength(0);
    const warnedAboutUnknown = warnSpy.mock.calls.some((args: unknown[]) =>
      String(args[0] ?? '').includes('Unknown hook event: task.after_provision')
    );
    expect(warnedAboutUnknown).toBe(true);
  });

  it('applies default timeout_ms=5000 when missing or invalid', async () => {
    const projectDir = await makeTempDir('emdash-hooks-default-timeout-');
    cleanups.push(projectDir);
    await writeHooksFile(
      projectDir,
      JSON.stringify({
        hooks: [
          {
            name: 'no-timeout',
            event: 'task.before_provision',
            url: 'http://127.0.0.1:9005',
            on_unreachable: 'block',
          },
          {
            name: 'bad-timeout',
            event: 'task.before_provision',
            url: 'http://127.0.0.1:9006',
            timeout_ms: -1,
            on_unreachable: 'block',
          },
          {
            name: 'string-timeout',
            event: 'task.before_provision',
            url: 'http://127.0.0.1:9007',
            timeout_ms: '500',
            on_unreachable: 'block',
          },
        ],
      })
    );

    const config = await loadHookConfig(projectDir);
    expect(config.hooks).toHaveLength(3);
    for (const hook of config.hooks) {
      expect(hook.timeout_ms).toBe(5000);
    }
  });

  it('handles malformed JSON gracefully', async () => {
    const projectDir = await makeTempDir('emdash-hooks-bad-json-');
    cleanups.push(projectDir);
    await writeHooksFile(projectDir, '{ not valid json');

    const config = await loadHookConfig(projectDir);
    expect(config).toEqual({ hooks: [] });
    expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('handles top-level shape errors gracefully', async () => {
    const projectDir = await makeTempDir('emdash-hooks-bad-shape-');
    cleanups.push(projectDir);
    await writeHooksFile(projectDir, JSON.stringify({ hooks: 'not-an-array' }));

    const config = await loadHookConfig(projectDir);
    expect(config).toEqual({ hooks: [] });
    expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
