# External Hooks

## Summary

emdash supports external HTTP hooks that can gate task provisioning. Configure a project-local
`.emdash/hooks.json` (preferred) or a global `~/.emdash/hooks.json` (fallback) to register hook
endpoints. When the configured event fires, emdash POSTs a JSON payload to each matching
endpoint and uses the response to allow or deny the operation. Currently only the
`task.before_provision` event is supported.

## Main Files

- `src/main/core/hooks/hook-config-loader.ts`
- `src/main/core/hooks/external-hook-client.ts`
- `src/main/core/hooks/hook-runner.ts`
- `src/main/core/tasks/before-provision-gate.ts`
- `src/main/core/tasks/provisionTask.ts` (call site)

## Config Schema

```json
{
  "hooks": [
    {
      "name": "simpleagent-gate",
      "event": "task.before_provision",
      "url": "http://127.0.0.1:8765/hooks/before-provision",
      "timeout_ms": 30000,
      "on_unreachable": "block"
    }
  ]
}
```

- `name` — human-readable identifier surfaced in error messages
- `event` — only `task.before_provision` is supported in v1
- `url` — `http://` or `https://` endpoint that accepts POST + JSON
- `timeout_ms` — per-hook timeout, defaults to `5000` when omitted
- `on_unreachable` — `"block"` denies provisioning when the endpoint cannot be reached;
  `"allow"` lets provisioning proceed

## Request Body

emdash POSTs the following JSON for `task.before_provision`:

```json
{
  "event": "task.before_provision",
  "taskId": "...",
  "projectId": "...",
  "taskName": "...",
  "sourceBranch": "main" | null,
  "taskBranch": "feature/x" | null,
  "linkedIssue": "ISSUE-123" | null,
  "timestamp": "2026-05-03T00:00:00.000Z"
}
```

## Response Shape

```json
{ "allowed": true }
```

```json
{ "allowed": false, "reason": "Awaiting proof at S11", "details": "optional context" }
```

- `allowed` is required
- `reason` is required when `allowed: false`; surfaced verbatim in the UI error
- `details` is optional; appears in parentheses after the reason when present
- Non-2xx responses, malformed JSON, or schema-fail bodies are treated as unreachable
  and fall back to the hook's `on_unreachable` semantics

## Failure Semantics

When a hook is unreachable (network error, timeout, non-2xx, malformed body):

- `on_unreachable: "block"` → the runner returns a denial, and `provisionTask` throws
  `Error("Failed to provision task: Hook \"<name>\" denied: Hook <name> unreachable: ...")`
- `on_unreachable: "allow"` → the runner logs a warning and treats the hook as allow

When multiple hooks are configured for the same event, they all run in parallel; results are
evaluated in config-array order, and the first denial wins.

## Per-Hook Timeout

Each hook has an independent `timeout_ms` budget. When the budget elapses, the request is
aborted and treated as unreachable.

## Worked Example

A 2-second curl-able test endpoint that always denies, demonstrating the UI message:

```bash
# In one terminal:
node -e '
  const http = require("http");
  http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ allowed: false, reason: "Test deny", details: "from worked example" }));
    });
  }).listen(8765, () => console.log("listening on 8765"));
'

# Project-local hooks config:
cat > .emdash/hooks.json <<'JSON'
{
  "hooks": [
    {
      "name": "test-gate",
      "event": "task.before_provision",
      "url": "http://127.0.0.1:8765",
      "timeout_ms": 2000,
      "on_unreachable": "block"
    }
  ]
}
JSON
```

Provisioning any task will now fail with:

```
Failed to provision task: Hook "test-gate" denied: Test deny (from worked example)
```

## Rules

- do not add other hook events without first updating the `HookEvent` union and the runner
- do not invoke hooks from any new call site without routing through `runHooks(...)` so the
  config loader, timeout, and `on_unreachable` semantics stay consistent
- the request body shape is part of the public hook contract — additive changes only
