export type HookEvent = 'task.before_provision';

export interface HookConfigEntry {
  name: string;
  event: HookEvent;
  url: string;
  timeout_ms: number; // default 5000 applied by loader
  on_unreachable: 'allow' | 'block';
}

export interface HookConfig {
  hooks: HookConfigEntry[];
}

export interface BeforeProvisionContext {
  taskId: string;
  projectId: string;
  taskName: string;
  sourceBranch: string | null;
  taskBranch: string | null;
  linkedIssue: string | null;
  timestamp: string; // ISO 8601 UTC
}

export type HookRunResult =
  | { allowed: true }
  | { allowed: false; hookName: string; reason: string; details?: string };
