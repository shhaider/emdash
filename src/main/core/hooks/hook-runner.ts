import { log } from '@main/lib/logger';
import { callExternalHook, type HookCallOutcome } from './external-hook-client';
import { loadHookConfig } from './hook-config-loader';
import type { BeforeProvisionContext, HookConfigEntry, HookEvent, HookRunResult } from './types';

export async function runHooks(
  event: HookEvent,
  context: BeforeProvisionContext,
  options: { projectRepoPath: string }
): Promise<HookRunResult> {
  const config = await loadHookConfig(options.projectRepoPath);
  const matching: HookConfigEntry[] = config.hooks.filter((hook) => hook.event === event);
  if (matching.length === 0) {
    return { allowed: true };
  }

  const body = { event, ...context };
  const outcomes: HookCallOutcome[] = await Promise.all(
    matching.map((hook) => callExternalHook(hook, body))
  );

  for (let i = 0; i < matching.length; i += 1) {
    const hook = matching[i];
    const outcome = outcomes[i];

    if (outcome.kind === 'decision') {
      if (outcome.allowed) continue;
      const denied: HookRunResult = {
        allowed: false,
        hookName: hook.name,
        reason: outcome.reason,
      };
      if (outcome.details !== undefined) denied.details = outcome.details;
      return denied;
    }

    log.warn(
      `hook ${hook.name} unreachable: ${outcome.reason}, applying on_unreachable=${hook.on_unreachable}`
    );
    if (hook.on_unreachable === 'allow') {
      continue;
    }
    return {
      allowed: false,
      hookName: hook.name,
      reason: `Hook ${hook.name} unreachable: ${outcome.reason}`,
    };
  }

  return { allowed: true };
}
