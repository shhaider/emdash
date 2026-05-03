import type { Task } from '@shared/tasks';
import { runHooks } from '@main/core/hooks/hook-runner';
import type { BeforeProvisionContext } from '@main/core/hooks/types';
import type { ProjectProvider } from '@main/core/projects/project-provider';

/**
 * Runs the `task.before_provision` hook chain for the given task/project pair.
 *
 * Resolves with `void` if all hooks allow (or none are configured). On denial,
 * throws a plain `Error` whose message matches the existing
 * `Failed to provision task: ...` shape produced by `provisionTask.ts`, so the
 * pre-existing renderer error pipe surfaces the hook reason without changes.
 *
 * Note: the message format here is kept in sync with `formatProvisionTaskError`'s
 * `'hook-denied'` branch in `provision-task-error.ts`. We inline it rather than
 * importing the formatter to avoid pulling the heavy `db/client` import chain
 * into the gate's transitive dependencies (and into its tests).
 */
export async function applyBeforeProvisionGate(
  task: Task,
  project: ProjectProvider
): Promise<void> {
  const context: BeforeProvisionContext = {
    taskId: task.id,
    projectId: task.projectId,
    taskName: task.name,
    sourceBranch: task.sourceBranch?.branch ?? null,
    taskBranch: task.taskBranch ?? null,
    linkedIssue: task.linkedIssue?.identifier ?? null,
    timestamp: new Date().toISOString(),
  };

  const result = await runHooks('task.before_provision', context, {
    projectRepoPath: project.repoPath,
  });

  if (result.allowed) return;

  const formatted = result.details
    ? `Hook "${result.hookName}" denied: ${result.reason} (${result.details})`
    : `Hook "${result.hookName}" denied: ${result.reason}`;
  throw new Error(`Failed to provision task: ${formatted}`);
}
