# Obsidian ↔ Orca Chat Plugin — Design

## Purpose

Let the user run a chat session inside Obsidian against a local coding-agent
harness (Claude Code, OpenCode, or GitHub Copilot), and let them highlight
text in a note, attach a question, and send that pair straight into an agent
session without leaving Obsidian.

## Why Orca

Orca (an already-installed local app, `~/repos/orca`) already orchestrates
Claude Code, OpenCode, and Copilot sessions, each running as a managed
terminal. Its CLI (`orca`) exposes a stable, scriptable surface for exactly
what this plugin needs:

- `orca terminal list --json` — enumerate live agent sessions (handle, title,
  agent identity, worktree path).
- `orca terminal send --terminal <handle> --text <text> --enter` — inject
  text into a live session.
- `orca terminal read --terminal <handle> --screen --json` — read the
  terminal's current rendered screen as plain text lines (`result.terminal.tail`).
  Escape sequences are already resolved/stripped in this mode — no ANSI or
  color data is present.

This means the plugin does no harness process management and no protocol
reverse-engineering. It is a thin client that shells out to `orca` via
`child_process.execFile`. No public HTTP/WebSocket API exists for Orca (the
mobile companion uses a private, versioned wire protocol not intended for
third parties) — the CLI is the supported integration surface.

## Non-goals

- Embedding Orca's actual rendered UI (no embed API exists for this).
- Managing or spawning agent CLI processes directly — Orca already owns this.
- A persistent chat-bubble history / conversation log. See "Rendering model" below.
- Writing anything back into the note on annotate.
- Multiple simultaneous chat panes.

## Components

- `main.ts` — plugin entry. Registers `ChatView`, the "Open Orca chat"
  command, and the "Annotate selection" command/hotkey.
- `orca-cli.ts` — wraps `child_process.execFile('orca', [...])` for
  `terminal list`, `terminal send`, `terminal read --screen`. Parses JSON
  output (`--json` flag on every call).
- `chat-view.ts` — an Obsidian `ItemView`. Contains:
  - a session-picker dropdown, populated from `terminal list`, refreshed
    each time the view opens or the dropdown is focused
  - a monospace `<pre>` output panel
  - an input box + send button
  - a poll loop (`setInterval`, ~500ms) calling `terminal read --screen`
    against the selected session's handle, replacing the `<pre>` contents
    with the joined `tail` lines each tick
  - the poll loop runs only while the view is visible (paused on
    `onunload`/tab hidden) to avoid spawning `orca` processes for a pane
    that isn't on screen
- `annotate-modal.ts` — a small Obsidian `Modal` with one text input for the
  question. Reads the active editor's selection via `Editor.getSelection()`.
  On submit, sends `${selection}\n\n${question}` via `orca-cli.ts` to the
  chat pane's currently targeted session. If no chat pane is open yet, opens
  one and prompts the session picker first.

## Rendering model

`--screen` reads return already-resolved plain text (no ANSI/color codes),
so there is nothing for a terminal emulator library (e.g. xterm.js) to
interpret — it would add a dependency for no benefit. The plugin renders the
polled `tail` lines directly into a styled monospace `<pre>` block, replacing
its contents on each poll tick. This gives a live-looking mirror of the
terminal's current screen (streaming text, spinners, prompts) without
chat-bubble reconstruction. Trade-off, accepted: this is a viewport into one
live terminal, not a scrollable multi-turn history — scrollback matches
whatever the terminal itself retains, the same as switching to the Orca
window directly.

## Session targeting

- The chat pane has one active target at a time, chosen from its picker
  dropdown (built from `orca terminal list --json`).
- Annotate always sends to whatever session the chat pane currently targets.
  It never shows its own picker. If the pane isn't open, annotate opens it
  and surfaces the picker first, then proceeds once a session is chosen.
- No pinned/default session in settings — the user may have several
  concurrent agent conversations running in Orca, so the picker is
  per-open-of-the-pane, not persisted as a vault-wide default.

## Error handling

Kept to the failure modes that actually occur for a thin CLI-wrapping client:

- `orca` unreachable (not on PATH, or the Orca app isn't running) —
  `terminal list` / `terminal send` / `terminal read` fail. Show a single
  Obsidian `Notice` ("Orca not reachable — is it running?"). No retry loop.
- Annotate triggered with no editor selection — `Notice` ("Select text
  first"), no-op.
- `terminal send` fails (e.g. the target session's terminal was closed) —
  `Notice` with the CLI's reported error text. The typed message is left in
  the input box so nothing the user typed is lost.

## Testing

No unit-test framework — the plugin is almost entirely I/O glue
(`child_process` + Obsidian UI calls), which doesn't benefit from mocking.
Manual smoke test covers the whole surface:

1. Open the chat pane, pick a live Orca session from the dropdown.
2. Send a message, confirm the mirrored screen updates.
3. Select text in a note, trigger Annotate, enter a question, confirm the
   selection+question lands in the targeted session.
4. Quit Orca (or point at a bad binary name) and confirm the plugin shows
   the "not reachable" `Notice` instead of hanging or throwing.

## Packaging

Standard Obsidian community-plugin scaffold: `manifest.json`, `esbuild`
build to `main.js`, TypeScript source under `src/`. Not published to the
community plugin directory — installed locally by symlinking (or copying)
the built output into the vault's `.obsidian/plugins/` folder.
