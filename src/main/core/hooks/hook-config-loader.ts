import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '@main/lib/logger';
import type { HookConfig, HookConfigEntry, HookEvent } from './types';

const KNOWN_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(['task.before_provision']);
const DEFAULT_TIMEOUT_MS = 5000;

interface ReadFileResult {
  source: string;
  raw: string;
}

async function tryRead(filePath: string): Promise<ReadFileResult | null> {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return { source: filePath, raw };
  } catch (error) {
    const errnoError = error as NodeJS.ErrnoException;
    if (errnoError && errnoError.code === 'ENOENT') {
      return null;
    }
    log.warn(`hook-config-loader: failed to read ${filePath}`, {
      error: String(errnoError?.message ?? error),
    });
    return null;
  }
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validateEntry(rawEntry: unknown, indexLabel: string): HookConfigEntry | null {
  if (!rawEntry || typeof rawEntry !== 'object') {
    log.warn(`hook-config-loader: hook ${indexLabel} skipped — entry is not an object`);
    return null;
  }
  const entry = rawEntry as Record<string, unknown>;

  const nameValue = entry.name;
  const eventValue = entry.event;
  const urlValue = entry.url;
  const onUnreachableValue = entry.on_unreachable;
  const timeoutValue = entry.timeout_ms;

  const nameLabel = typeof nameValue === 'string' && nameValue.length > 0 ? nameValue : indexLabel;

  if (typeof nameValue !== 'string' || nameValue.length === 0) {
    log.warn(`hook-config-loader: hook ${indexLabel} skipped — missing or invalid 'name' field`);
    return null;
  }
  if (typeof eventValue !== 'string' || eventValue.length === 0) {
    log.warn(`hook-config-loader: hook ${nameLabel} skipped — missing or invalid 'event' field`);
    return null;
  }
  if (typeof urlValue !== 'string' || urlValue.length === 0) {
    log.warn(`hook-config-loader: hook ${nameLabel} skipped — missing or invalid 'url' field`);
    return null;
  }
  if (onUnreachableValue !== 'allow' && onUnreachableValue !== 'block') {
    log.warn(
      `hook-config-loader: hook ${nameLabel} skipped — 'on_unreachable' must be 'allow' or 'block'`
    );
    return null;
  }

  if (!KNOWN_EVENTS.has(eventValue as HookEvent)) {
    log.warn(`hook-config-loader: Unknown hook event: ${eventValue}`);
    return null;
  }

  const timeoutMs = isPositiveNumber(timeoutValue) ? timeoutValue : DEFAULT_TIMEOUT_MS;

  return {
    name: nameValue,
    event: eventValue as HookEvent,
    url: urlValue,
    timeout_ms: timeoutMs,
    on_unreachable: onUnreachableValue,
  };
}

function parseConfig(raw: string, source: string): HookConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.error(`hook-config-loader: invalid JSON in ${source}`, {
      error: String((error as Error)?.message ?? error),
    });
    return { hooks: [] };
  }

  if (!parsed || typeof parsed !== 'object') {
    log.error(`hook-config-loader: ${source} top-level value must be an object with 'hooks' array`);
    return { hooks: [] };
  }

  const hooksField = (parsed as Record<string, unknown>).hooks;
  if (!Array.isArray(hooksField)) {
    log.error(`hook-config-loader: ${source} missing or invalid 'hooks' array`);
    return { hooks: [] };
  }

  const validated: HookConfigEntry[] = [];
  hooksField.forEach((rawEntry, index) => {
    const entry = validateEntry(rawEntry, `at index ${index}`);
    if (entry) validated.push(entry);
  });

  return { hooks: validated };
}

export async function loadHookConfig(projectRepoPath: string): Promise<HookConfig> {
  const projectFile = path.join(projectRepoPath, '.emdash', 'hooks.json');
  const projectResult = await tryRead(projectFile);
  if (projectResult) {
    return parseConfig(projectResult.raw, projectResult.source);
  }

  const globalFile = path.join(os.homedir(), '.emdash', 'hooks.json');
  const globalResult = await tryRead(globalFile);
  if (globalResult) {
    return parseConfig(globalResult.raw, globalResult.source);
  }

  return { hooks: [] };
}
