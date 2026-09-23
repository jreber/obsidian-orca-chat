# New-session button: vault-rooted Orca chat — design

Date: 2026-09-23. Status: approved in conversation, pending written-spec review.

## Goal

Replace "pick an existing Orca chat" in the Orca Chat pane with a **New session** button. Clicking it
creates a Claude chat rooted at the vault's root folder. The session is a normal Orca session in every
respect (tab in Orca, Agent Dashboard card, history), and the pane embeds it exactly as it does today.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Vault not yet an Orca project | Ask once ("Add this vault to Orca as a project?"), then `repo.add`. After that it is registered, so no further prompts. |
| Pane on reopen/restart | Reattach to the last session this vault created. A new session only on button click. No session list. |
| Agent | Claude only. Codex is not offered. Copilot and OpenCode are not chat-session agents in Orca (terminal-only), so they are out of scope. |
| Mac launcher `~/bin/local-claude` | Orca change: structured Claude sessions honor `agentCmdOverrides.claude` (with `~` expansion). Set once in Orca settings. |
| Branches | Plugin work on `webview-didfail-status`; Orca change on `agent-dashboard-webview-fixes`. |

## Flow

1. Resolve the vault root (`FileSystemAdapter.getBasePath()`). Desktop only; on mobile the button shows
   "Orca Chat needs desktop Obsidian".
2. `repo.list`; find a project whose `path` equals the vault root. The plugin compares paths itself:
   Unicode NFC, trailing slash trimmed, exact case. It does not lowercase or resolve symlinks (Orca's
   own comparison does neither).
3. No match: show the confirmation modal. Confirm calls `repo.add {path, kind: 'folder', displayName:
   <vault name>}` (`kind` must be explicit; Orca defaults to `git`). Decline aborts with nothing created.
   `repo.add` is idempotent for an already-registered path.
4. `worktree.list` for that project gives the folder workspace id.
5. `agentSession.create` with `worktree: 'id:<workspaceId>'`, `agent: 'claude'`, a fresh session id, and
   an envelope with `expectedRuntimeFence: null` and the create fingerprint
   (`{method:'agentSession.create', sessionId, fields:{worktree, agent, resumeFrom}}`), mirroring
   Orca's `structured-agent-session.ts`. The existing `buildMutationEnvelope` reads a fence from
   history and cannot be reused for create.
6. Persist `lastSessionId` in the vault's `data.json` (beside `pairedCredential`). Mount the embed.
   Orca's seed-turn fix means the session appears on the Agent Dashboard immediately.

## Pane behavior

- The session dropdown and its 3 s polling are removed. The pane shows the New session button and the
  existing status label.
- On open: read `lastSessionId`, confirm it exists via `session.tabs.listAll`; if so mount it, else show
  the button (with "previous session ended" if one was stored).
- Embed load status (Connecting… / Live chat / failed) is unchanged.
- `sendToSelected` (annotate and flashcard flows) targets the current session; with none, it says to
  create one first.
- A 15 s existence check for the current session only (not the old list refresh) detects a session closed in Orca.

## Orca change

Structured Claude resolves its binary through `resolveClaudeCommand()` (a PATH lookup) and never
reads `agentCmdOverrides`. Wire the settings override into that resolution: use
`agentCmdOverrides.claude` when set (trimmed, `~` expanded, path built with `path`/`os.homedir()`),
else the current lookup. Local host only (structured Claude is already local-only).

## Errors (each a Notice; nothing half-created)

Not paired or Orca unreachable; connection not permitted to call `repo.add`/`worktree.list`; user
declines the add-project prompt; create refused (message from the refusal); not desktop Obsidian.

## Testing (required)

- **Unit (plugin):** path matching (NFC, trailing slash, exact case); create envelope and fingerprint
  equal Orca's computation; the call sequence with each step failing; reattach with a live, missing,
  and never-stored session.
- **Unit (Orca):** override resolution: unset, absolute path, `~/…`, whitespace, non-existent.
- **Orca Playwright:** real `agentSession.create` on a non-git folder project: tab, dashboard card, and
  the override honored (stub Claude that records which binary ran).
- **Obsidian Playwright (fake server extended for `repo.list`/`repo.add`/`worktree.list`/
  `agentSession.create`):** registered vault; unregistered vault with confirm; with decline; reattach
  after reload; session vanished; not paired.
- **Combined end to end:** real Obsidian with the plugin paired to a real Orca (worktree build,
  isolated data folder, stub Claude). Click New session; the same session appears in the Obsidian pane
  and on Orca's dashboard. This also settles two open questions live: that the plugin's client may
  call `repo.add`/`worktree.list`, and that `path:<vault>` (fallback selector) works.
- **Cannot be tested on the Linux dev machine (verify on the Mac):** macOS default paths, the real
  `~/bin/local-claude`, and case-insensitive path collisions (`/Users/x/Vault` vs `/users/x/vault` would
  register twice; documented limitation, same as Orca).

## Out of scope

Codex or other agents in the pane; SSH/WSL hosts; multi-session lists; terminal embedding for
Copilot/OpenCode (a separate project).
