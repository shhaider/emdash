# Emdash User Journeys

## J1 — First Launch (Onboarding)

**Precondition:** Fresh install, no projects configured.

1. Launch Emdash
2. Home view loads with empty project list
3. User sees "Add Project" button/prompt
4. **Verification:** Home view rendered, no crash, app title visible

## J2 — Add Local Project

**Precondition:** App is running, home view visible.

1. Click "Add Project" (opens `addProjectModal`)
2. Select local project option
3. Enter/browse to a git repository path
4. Path status check returns valid (`getLocalProjectPathStatus`)
5. Enter project name
6. Click create
7. Project appears in sidebar
8. Project state transitions: creating → bootstrapping → ready
9. **Verification:** Project visible in sidebar, project view loads, git info displayed

## J3 — Create Task from Branch

**Precondition:** Project is mounted and in "ready" state.

1. Open project view
2. Click "Create Task" (opens `taskModal`)
3. Select "New Branch" strategy
4. Enter task name (or auto-generate via `generateTaskName`)
5. Select source branch
6. Click create
7. Task appears in task list
8. Task state: creating → provisioning → ready
9. **Verification:** Task visible, workspace provisioned, terminal/conversation ready

## J4 — Create Task from Issue

**Precondition:** Project mounted, issue tracker integration configured (GitHub/Linear/Jira).

1. Open project view
2. Click "Create Task"
3. Select "From Issue" strategy
4. Search/select issue from tracker
5. Task name auto-populated from issue title
6. Click create
7. Task linked to issue, branch created
8. **Verification:** Task shows linked issue badge, issue ID in task details

## J5 — Create Task from Pull Request

**Precondition:** Project mounted, GitHub connected.

1. Open project view
2. Click "Create Task"
3. Select "From Pull Request" strategy
4. Select PR from list
5. Task created with PR branch as source
6. **Verification:** Task shows PR link, correct branch checked out

## J6 — Hook Denial (SimpleAgent Gate)

**Precondition:** Project mounted, `.emdash/hooks.json` configured pointing at SimpleAgent bridge, SimpleAgent FSM in planning state (deny).

1. Open project view
2. Click "Create Task" or provision existing task
3. emdash calls `POST /hooks/before-provision` to SimpleAgent bridge
4. Bridge returns `{allowed: false, reason: "State S06 requires approval..."}`
5. Task creation/provisioning fails
6. Error message displayed with hook denial reason
7. **Verification:** Error message contains SimpleAgent's reason string, task NOT provisioned, no workspace created

## J7 — Hook Allow (SimpleAgent Gate)

**Precondition:** Same as J6 but SimpleAgent FSM in implementation state (S14).

1. Open project view
2. Create/provision task
3. Bridge returns `{allowed: true}`
4. Task provisions normally
5. **Verification:** Task provisioned, workspace created, no error

## J8 — Task Workspace Interaction

**Precondition:** Task provisioned and in "ready" state.

1. Open task view
2. Terminal panel visible with PTY session
3. Conversation panel visible
4. User can type in terminal
5. User can start a conversation with an agent
6. **Verification:** Terminal responds to input, conversation UI functional

## J9 — Task Lifecycle Management

**Precondition:** Task exists in various states.

1. Rename task (opens `renameTaskModal`)
2. Archive task (`archiveTask`)
3. Restore archived task (`restoreTask`)
4. Pin task (`setTaskPinned`)
5. Delete task (`deleteTask`)
6. **Verification:** Each operation updates UI immediately, state persists across reload

## J10 — Settings Configuration

**Precondition:** App running.

1. Navigate to Settings view
2. Configure branch prefix
3. Configure agent auto-approve defaults
4. Configure provider settings
5. **Verification:** Settings saved, reflected in subsequent task creation

## J11 — MCP Server Management

**Precondition:** App running.

1. Navigate to MCP view
2. Add MCP server (opens `mcpServerModal`)
3. Configure server details
4. **Verification:** MCP server listed, connection status shown

## J12 — Error Recovery

**Precondition:** Various error states.

1. Project path not found → shows path_not_found state with recovery option
2. SSH disconnected → shows ssh_disconnected state with reconnect option
3. Provision error → shows provision-error state with retry option
4. **Verification:** Error states display correctly, recovery actions work

---

## Priority for Playwright Implementation

| Priority | Journey | Complexity | Value |
|----------|---------|------------|-------|
| P0 | J1 First Launch | Low | Smoke test — proves app starts |
| P0 | J2 Add Local Project | Medium | Core flow — most common first action |
| P0 | J3 Create Task from Branch | Medium | Core flow — the main user action |
| P1 | J6 Hook Denial | Medium | Proves SimpleAgent integration works end-to-end |
| P1 | J7 Hook Allow | Low | Counterpart to J6 |
| P1 | J9 Task Lifecycle | Medium | Proves CRUD operations work |
| P2 | J8 Workspace Interaction | High | Terminal/PTY testing is complex |
| P2 | J10 Settings | Low | Simple form testing |
| P2 | J4/J5 Issue/PR | High | Requires external service mocks |
| P3 | J11 MCP | Medium | Niche feature |
| P3 | J12 Error Recovery | High | Requires deliberate failure injection |
