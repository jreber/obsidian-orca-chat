# Obsidian plugin: embed Orca's native chat UI via `<webview>` — Design

## Purpose

Replace `chat-view.ts`'s hand-built chat renderer (custom journal-item
rendering, approval/question prompt buttons, merge-by-revision logic) with
Orca's own chat UI, embedded live via Electron's `<webview>` tag. Orca now
ships a chrome-free single-session web entry point
(`single-session-index.html`, see `~/repos/orca/docs/reference/single-session-web-embed-mode.md`)
built exactly for this: it mounts one `NativeChatStructuredSession` against a
paired remote environment, with no app shell.

## Why

The plugin's hand-rolled renderer duplicates Orca's real UI (message
formatting, tool-call rendering, diffs, approval/question cards) and will
permanently lag behind it. Orca already exposes the real component through a
paired RPC connection; the only missing piece was a URL-addressable,
shell-free entry point to load it from — which now exists.

## Prerequisite (Orca-side)

`~/repos/orca/src/main/runtime/rpc/static-web-client-handler.ts` currently
serves only `/web-index.html` (`STATIC_WEB_ALLOWED_PATHS`). Add
`/single-session-index.html` to that allowlist. Small, separate change,
made directly (not through this plan) since it's a one-line addition to an
existing Set literal with an existing test file to extend.

## Components

- **`chat-view.ts`** — kept as the `ItemView` host, but shrinks: retains the
  session-picker dropdown (`populateSessions()`, unchanged — still polls
  `listAllAgentSessionTabs` every 3s) and `getSelectedHandle()`/
  `focusPicker()` (used unchanged by `main.ts`'s annotate flow). Removes
  everything downstream of session selection: `renderOutput`,
  `renderAgentJournalItem`, `renderPromptItem`, `mergeJournalItems`,
  `ensureStructuredSession`/`trySetupStructuredSession`/
  `teardownStructuredSession`, the `subscribeAgentSessionHistory` call, and
  `sendToSelected`/`handleSend` (input box + send button — the embedded UI
  has its own composer).
- **New: `embed-url.ts`** — pure function
  `buildSingleSessionEmbedUrl(pairing: PairedCredential, sessionId: string, agent: string): string`.
  Derives the HTTP(S) origin from `pairing.endpoint` (swap `ws:`→`http:`,
  `wss:`→`https:`), builds
  `<origin>/single-session-index.html?pairing=<encoded offer>&sessionId=<id>&agent=<agent>`,
  reusing `encodePairingOffer` from `orca-remote/pairing.ts` for the
  `pairing` param so its JSON shape matches what Orca's
  `parseSingleSessionLocation` decodes.
- **`chat-view.ts` webview lifecycle:**
  - On session select (dropdown change): remove any existing `<webview>`
    child, create a new one with `src` set to the built embed URL and a
    fresh, non-persistent `partition` attribute (`orca-embed-<sessionId>-<random>`,
    no `persist:` prefix) so Electron never writes the pairing token to
    disk, append it to the view's content container.
  - On session change or pane close (`onClose`): remove the current
    `<webview>` from the DOM (no reuse/postMessage — recreating is simpler
    and matches the "one active target" model already in place for the old
    renderer).
  - No polling, no subscription, no journal state in the plugin anymore for
    the embedded pane — Orca's own UI owns rendering entirely once the
    webview is live.

## Data flow

1. User picks a session in the dropdown (existing `populateSessions()`
   flow, unchanged).
2. `chat-view.ts` calls `buildSingleSessionEmbedUrl(pairedCredential, sessionId, agent)`.
3. `chat-view.ts` swaps in a new `<webview src="...">`.
4. The webview loads Orca's `single-session-index.html`, which parses the
   URL, connects its own `WebRuntimeClient` over the paired endpoint, and
   renders the live session — entirely inside Orca's code, no further
   plugin involvement.

## Non-goals

- No changes to `orca-remote-client.ts`'s RPC methods — the embedded page
  makes its own connection; the plugin's existing E2EE client is only used
  for session listing (`listAllAgentSessionTabs`) to populate the dropdown.
- No two-way messaging between the plugin and the embedded page (no
  `postMessage`, no `webview` IPC) — out of scope until a concrete need
  arises.
- No change to the annotate flow beyond keeping `getSelectedHandle()`
  working.

## Testing

- Unit test `embed-url.ts`: origin derivation for `ws:`/`wss:` endpoints,
  correct query param encoding, round-trips through
  `decodePairingOffer(decodeURIComponent(...))`.
- Existing e2e harness (Playwright) gets one new scenario: opening a chat
  pane with a paired credential renders a `<webview>` element with a `src`
  matching the expected pattern (the harness cannot easily assert on Orca's
  internal rendering without a real Orca instance — that's Orca's own test
  surface).
