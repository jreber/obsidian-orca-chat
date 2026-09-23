# New-session button: vault-rooted Orca chat — design

Date: 2026-09-23. Status: implemented and verified on Linux (unit tests, fake-server Playwright, and a real
Obsidian paired to a real Orca). Not yet exercised on macOS or Windows.

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
   exactly as Orca's own `normalizeRuntimePathForComparison` does. Unicode NFC everywhere. A Windows
   drive or UNC path (`C:\…`, `\\server\…`) compares case-insensitively, with backslashes folded
   to `/`, repeated separators collapsed and the trailing separator trimmed (a `C:/` root is kept). A
   POSIX path compares in exact case, with repeated `/` collapsed and a trailing `/` trimmed (the `/`
   root is kept). Symlinks are not resolved. The comparison key is never sent: `repo.add` gets the
   raw vault path.
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

Not paired; Orca unreachable at open (its own Notice, stored session id kept); connection not permitted to
call `repo.add`/`worktree.list`; create refused (message from the refusal); not desktop Obsidian. The user
declining the add-project prompt is not an error: nothing is created and no Notice is shown.

## Testing (required)

- **Unit (plugin):** path matching (NFC, separators and trailing slash, Windows drive/UNC case folding, POSIX exact
  case); create envelope and fingerprint
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
  `~/bin/local-claude`, and case-only path differences on macOS's case-insensitive filesystem
  (`/Users/x/Vault` vs `/users/x/vault` would register twice, because POSIX paths compare in exact
  case; a documented limitation, same as Orca). Windows paths fold case, so they don't have it.

## Out of scope

Codex or other agents in the pane; SSH/WSL hosts; multi-session lists; terminal embedding for
Copilot/OpenCode (a separate project).

## Findings from the real Obsidian ↔ real Orca run

- The plugin must advertise `agent-session.structured.claude.v1`. Without it Orca's `session.tabs.listAll`
  hides Claude chat tabs from a paired client, so the pane's liveness check tore the live chat down ~15 s
  after New session. Fixed; pinned by unit tests, a capability-faithful fake server, and the real-Orca spec.
- Pair with Orca's **"This computer only"** link (runtime scope). A mobile-scope pairing is refused
  `repo.add` / `worktree.list` ("not available to mobile clients"); the pairing dialog and the error Notice
  say so.
- Orca accepts a plain `crypto.randomUUID()` as the create session id; the plugin's create fingerprint
  matches Orca's recomputation.
- No startup transient: after an Orca restart the first `listAll` answer already lists the restored
  sessions, and the pane keeps its session.
- Creating a chat works with no `claude` on PATH when `agentCmdOverrides.claude` (absolute or `~/…`) is set.
  Orca uses only the override's first word (arguments are ignored for chat sessions).

## Known limitations and follow-ups

- macOS's case-insensitive filesystem: a vault opened under a differently-cased path registers as a second
  project (same as Orca's own comparison).
- Orca seeds every `agentSession.create` with a short first turn so the chat appears on the Agent
  Dashboard immediately. That applies to all clients of the create RPC (Orca's own new-chat flows and
  mobile as well as this plugin), and a prompt sent with the chat waits behind the seed turn. If that is
  unwanted, make the seed opt-in through an optional create field only the plugin sends.
- If the Claude binary is missing, Orca reports "claude stream-json exited" rather than saying it was not
  found.
- The Windows override case and the `.cmd` wrapper are untested.
- Rare races left as documented: re-pairing during a create can leave the pane on the previous session
  until reopened; a hung `saveData` can hold the New session button disabled.

## How to try it on macOS

1. In Orca: check out `agent-dashboard-webview-fixes` (remote `personal`), install, run. In Settings set the
   Claude command override to `~/bin/local-claude` (only the executable is used).
2. In the plugin: check out `webview-didfail-status`, `npm install && npm run build`, copy `main.js`,
   `manifest.json` and `styles.css` into the vault's `.obsidian/plugins/orca-chat/`, reload the plugin.
   Commit or `git stash -u` any local edits first (a stray edit to `orca-remote-client.ts` breaks the build).
3. In Orca use the "This computer only" pairing link; in Obsidian run **Pair with Orca** and paste it.
4. Open the Orca Chat pane and click **New session**. Approve "Add this vault to Orca?" once.
5. Expect: "Connecting…" then "● Live chat"; the chat visible in the pane; the vault as a project and a
   "Claude Chat" card on Orca's Agent Dashboard. Reopening the pane reattaches to the same chat.
