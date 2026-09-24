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
4. `worktree.list` for that project gives the folder workspace id: the workspace whose path is the
   vault root, or else the project's only workspace when it sits at the project's own path. The chat
   never runs outside the vault: with no such workspace (say, a git project whose other checkouts
   don't match), New session refuses with a Notice naming the vault path and "⚠ Session not
   created".
5. `agentSession.create` with `worktree: 'id:<workspaceId>'`, `agent: 'claude'`, a fresh session id, and
   an envelope with `expectedRuntimeFence: null` and the create fingerprint
   (`{method:'agentSession.create', sessionId, fields:{worktree, agent, resumeFrom}}`), mirroring
   Orca's `structured-agent-session.ts`. The existing `buildMutationEnvelope` reads a fence from
   history and cannot be reused for create. Create has a 30 s timeout (reads keep 10 s): a cold first
   create installs and starts Orca's session host. If the outcome is lost (a timeout, a dropped
   connection, or Orca's `agent_session_operation_unknown` refusal), the plugin sends the same
   envelope again, which Orca's operation ledger answers as a replay, and failing that looks the
   session id up in `session.tabs.listAll`. A session found either way is attached as a normal
   success, so a slow create never leaves an orphaned chat in Orca; only if neither finds it does the
   pane show "⚠ Session not created".
6. Persist the session id as this device's last session (see Storage). Mount the embed.
   The plugin sends no message on the user's behalf: a just-created chat has no turns. Orca lists
   it at once as a ready row (status null on the wire; an Idle "Claude Chat" card on the Agent
   Dashboard), so `session.tabs.listAll`, reattach and the 15 s liveness check see it; the user's
   first message is the chat's first turn.

## Pane behavior

- The session dropdown and its 3 s polling are removed. The pane shows the New session button and the
  existing status label.
- On open: read `lastSessionId`, confirm it exists via `session.tabs.listAll`; if so mount it, else show
  the button (with "previous session ended" if one was stored).
- Embed load status (Connecting… / Live chat / failed) is unchanged.
- `sendToSelected` (annotate and flashcard flows) targets the current session; with none, it says to
  create one first.
- A 15 s existence check for the current session only (not the old list refresh) detects a session closed in Orca.

## Storage: per device, never in the synced data.json

A vault may be synced between computers (iCloud, Obsidian Sync, git), and each computer pairs with
its own Orca. So the pairing credential and the last session id are per device: they live in
Obsidian's per-device, per-vault local storage (`App#saveLocalStorage` / `App#loadLocalStorage`,
keys `orca-chat:paired-credential` and `orca-chat:last-session-id`), which is not synced. The
plugin's `data.json` keeps any other settings. These APIs are public since Obsidian 1.8.7, so
`minAppVersion` is 1.8.7.

- Reads and writes of both values go through one per-plugin queue, so the stored-id
  compare-and-set (a late create after the pane closed, a restore's clear) keeps its guarantees.
- **One-time migration.** Earlier versions kept both in `data.json`. On load (and before any other
  pairing or session read or write), the plugin moves them into local storage and removes them from
  `data.json`, keeping other settings. A value the device already has (only possible after an
  interrupted first run) is never overwritten. The device is then
  marked migrated (`orca-chat:device-storage-migrated`): later copies in `data.json` (say, synced
  from a machine still on an older version) are only removed, never imported, so another machine's
  writes never change this device's pairing or session. If `data.json` can't be read before the
  first migration, the operation fails and the migration is retried; a failed cleanup is logged
  without the data and retried on the next load. The credential is never logged.
- **Pairings are no longer synced: pair each computer once after updating.** The synced `data.json`
  held the pairing of whichever computer paired last, so the migration can hand a computer another
  computer's pairing (and that computer then loses its own, once the cleaned `data.json` syncs back).
  When Orca rejects the pairing (an unknown device token, or a close with 4001 because the auth frame
  was sealed for another Orca's key; `isPairingRejected`), the pane says so instead of showing a
  transport error: the Notice "Orca didn't accept this computer's pairing… Run Pair with Orca on this
  computer, using a "This computer only" link…" and the status "⚠ Re-pair this computer". The
  Notice is shown when the pane opens (or re-reads the pairing) and on each New session click; the
  liveness tick's quiet retries only keep the status. Orca being down or unreachable is reported as
  before ("Can't reach Orca").

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
  and on Orca's dashboard, with no user turn in it; the pane stays live past a 15 s liveness tick
  with no turn; then a message typed into the embed is the chat's first turn. This also settles live
  that the plugin's client may call `repo.add`/`worktree.list`. The plugin only ever sends `id:`
  selectors.
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

## Wikilinks in chat

**Finding (verified against the real Orca build):** Orca's chat markdown renderer drops link schemes
it doesn't know (react-markdown's `defaultUrlTransform`), so an `obsidian://…` link in the agent's
output renders with an empty href and the pane's obsidian:// click interception never fires for it.
It also doesn't parse `[[wikilinks]]`: they render as literal text `[[Note]]`.

**Design (Option A):** the agent writes ordinary wikilinks; the pane makes them work.

- On `dom-ready` the pane injects a second script into the guest (`src/wikilinks.ts`, beside the
  obsidian:// interceptor, same `executeJavaScript` in / `console-message` out channel, guarded by a
  window flag). It links `[[target]]`, `[[target#heading]]`, `[[target|alias]]` and
  `[[target#heading|alias]]` found in text nodes, on load and via a MutationObserver as messages
  stream in. It skips `pre`, `code`, existing links, `script`/`style`, form fields and editable
  areas (the composer). Anchors are built with DOM APIs, never `innerHTML`. A text node the page
  re-renders or removes takes the anchors made from it along, so React stays in charge of its nodes,
  and an unclosed `[[Note` isn't linked until `]]` arrives.
- The guest reports each distinct target once (`orca-chat:wikilink-check:`, at most 200 per
  message). The host resolves them with `metadataCache.getFirstLinkpathDest` and has the guest mark
  the missing ones (faded, dotted underline, "Note not found in this vault"). When the vault changes
  (a note created, deleted or renamed; `metadataCache` "resolved"), the host re-checks the targets
  the page reported, debounced, and sends only the changes, so a note the agent creates later loses
  its dead mark and a deleted one gains it.
- A click reports `orca-chat:wikilink-open:{"link":…}`. The page is agent-influenced, so the host
  validates it strictly (JSON, a string of at most 512 characters, no control characters). It then
  opens the note only if it exists in the vault, in the most recent main-area leaf, or a new tab when
  that leaf is the chat. It never opens a note in the chat's own leaf (a click in the webview makes
  that leaf active) and never creates a note. A missing note gets a Notice
  (`no note named "…" in this vault`).
- Tests: jsdom unit tests of the guest script and the host core; a fake-server Playwright spec; and
  the real-Orca spec, where the stub Claude answers with `See [[Welcome]] and [[Missing note]].`
  (Orca's `CLAUDE_STUB_REPLY`, added for this). The test types a first message into the embed's
  composer, and both links are checked in the real reply.

## Advice for the agent: AGENTS.md in the vault

The chat session's working folder is the vault root, so standing guidance for the agent belongs in the
vault's own `AGENTS.md`; files in the Orca or plugin repos are never read by it. Claude Code decides
whether it reads that file: current Claude Code reads `AGENTS.md` only when the project has no
`CLAUDE.md` of its own (its `instructionFiles` default), and older versions may not read `AGENTS.md`
at all. The pane's header has an **Append AGENTS.md advice** button beside New session. It is a plain,
secondary button (New session is the pane's one call to action) with a tooltip saying what it does;
the header wraps in a narrow pane. It writes a block between `<!-- orca-chat:advice:start -->` and
`<!-- orca-chat:advice:end -->`: be brief and conversational, and use inline `[[wikilinks]]` to
existing notes where appropriate. It creates the file if it is missing (`Vault#create`), appends the
block at the end after a blank line, or replaces an existing block in place (never a second copy); an
existing file is changed through `Vault#process`, so an open editor's pending save isn't lost. It
never changes text outside the markers and keeps the file's line endings. A start marker without an
end marker is refused. The button is disabled while it writes. Notices: "Added Orca Chat advice to
AGENTS.md" or "Updated Orca Chat advice in AGENTS.md"; when the vault root has a `CLAUDE.md` (or
`.claude/CLAUDE.md`), the Notice adds "This vault has a CLAUDE.md, and current Claude Code may read
that instead of AGENTS.md." See [docs/vault-agents-advice.md](../../vault-agents-advice.md). There is
no command-palette entry.

## Versioning

Obsidian requires a plain `x.y.z` in `manifest.json`, so a git hash can't be the version. The plugin is
0.2.0 (`manifest.json`, `package.json`, `package-lock.json`); `versions.json` maps each version to its
`minAppVersion`. The build defines `__ORCA_CHAT_BUILD__` as the short git hash (`-dirty` when tracked
files have uncommitted changes, `unknown` without git), and `versionLabel()`
(`Orca Chat v0.2.0 (abc1234)`) is logged on load and shown under the Pair button in Pair with Orca.

## Known limitations and follow-ups

- A chat created by New session appears in Orca's sidebar at once. On the Agent Dashboard it is an
  Idle card, which shows only when the dashboard's **Show idle agents** setting (in its Board
  settings menu) is on; it is off by default.
- macOS's case-insensitive filesystem: a vault opened under a differently-cased path registers as a second
  project (same as Orca's own comparison).
- If the Claude binary is missing, Orca reports "claude stream-json exited" rather than saying it was not
  found.
- The Windows override case and the `.cmd` wrapper are untested.
- `obsidian://` links in chat output are not clickable (Orca strips the href); agents should use
  wikilinks. A wikilink split across several text nodes by the renderer would not be linked (not seen
  with Orca's current renderer).
- Rare races left as documented: re-pairing during a create can leave the pane on the previous session
  until reopened.

## How to try it on macOS

1. In Orca: check out `agent-dashboard-webview-fixes` (remote `personal`), install, run. In Settings set the
   Claude command override to `~/bin/local-claude` (only the executable is used).
2. In the plugin: check out `webview-didfail-status`, `npm install && npm run build`, copy `main.js`,
   `manifest.json` and `styles.css` into the vault's `.obsidian/plugins/orca-chat/`, reload the plugin.
   Commit or `git stash -u` any local edits first (a stray edit to `orca-remote-client.ts` breaks the build).
3. In Orca use the "This computer only" pairing link; in Obsidian run **Pair with Orca** and paste it.
   The pairing is stored on this Mac only (Obsidian's local storage, not the synced `data.json`), so
   pair each computer with its own Orca. **If you use this vault on more than one computer, run Pair
   with Orca on each of them after updating, each with its own Orca's "This computer only" link.**
   Pairings are no longer synced: an existing pairing from an earlier build is moved out of
   `data.json` on first load, but it belonged to whichever computer paired last, so it may be the
   other computer's (the pane then says "⚠ Re-pair this computer"), and the other computer finds
   itself unpaired once the cleaned `data.json` syncs. Needs Obsidian 1.8.7 or later.
4. Open the Orca Chat pane and click **New session**. Approve "Add this vault to Orca?" once.
5. Expect: "Connecting…" then "● Live chat"; the chat visible in the pane, empty until you write the
   first message; the vault as a project and the chat in Orca's sidebar. Reopening the pane
   reattaches to the same chat. On the Agent Dashboard the new chat is an Idle "Claude Chat" card,
   shown only when the dashboard's **Show idle agents** setting (Board settings) is on; it is off by
   default.
6. Optional: click **Append AGENTS.md advice** in the pane so new chats link notes as clickable
   `[[wikilinks]]` (see [docs/vault-agents-advice.md](../../vault-agents-advice.md)). The Pair with
   Orca dialog's footer shows the installed version and build (`Orca Chat v0.2.0 (<hash>)`).
