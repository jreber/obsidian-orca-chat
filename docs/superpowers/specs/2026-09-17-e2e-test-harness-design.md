# Orca Chat Pane — E2E Test Harness Design

## Purpose

The chat pane (`src/chat-view.ts`) has grown past what the existing white-box
unit tests (`test/`, run via `node --test` against a jsdom fake) can catch:
rendering, layout, and real-DOM interaction bugs currently get discovered by
manual clicking in Obsidian and reported by hand. This spec adds a second
test tier — a Playwright suite that drives the *real* Obsidian app (it's an
Electron app) against a fake Orca backend, so rendering and interaction bugs
in the chat pane surface as failing tests instead of user reports.

## Prerequisite: delete the CLI-scrape terminal path

Before building the harness, remove the older of the chat pane's two session
sources. It predates the structured/RPC protocol work, was never satisfying,
and its removal shrinks what the harness needs to cover down to one path.

- Delete `src/orca-cli.ts` and `src/chat-scrape.ts` outright — both are only
  used by the terminal branch of `chat-view.ts`; nothing else imports them.
- In `chat-view.ts`: collapse `SessionEntry` to just the structured variant,
  delete the chat/raw mode toggle (raw mode only ever displayed terminal
  screen text — there is nothing left for it to show), delete
  `pollScreen`/`lastLines`/`hasWarnedThisPoll` and the 500ms poll interval,
  delete the terminal-scrape branch of `renderOutput`.
- `sendToSelected` drops its `entry.kind === "terminal"` branch — it always
  goes through `remoteClient.sendAgentSessionMessage`.
- Net result: one session source (structured/RPC), one rendering path, no
  polling loop (structured sessions already push updates via
  `subscribeAgentSessionHistory`).

## Non-goals

- Covering the CLI-scrape terminal path in tests — it no longer exists after
  the prerequisite cleanup above.
- Live-Orca E2E tests (real Orca app, real agent sessions). NOTES.md already
  documents a throwaway-script approach for that when needed; this harness
  is deliberately hermetic instead.
- Replacing the existing `test/` unit suite. The two tiers serve different
  purposes and keep separate npm scripts.
- Deciding the "embed Orca Mobile's UI instead" architecture question. This
  harness is built to validate whatever chat-rendering architecture exists
  today or comes next — it is not itself that decision.

## Components

### Fixture vault

- `test-e2e/fixture-vault/`: a minimal Obsidian vault checked into the repo
  — `.obsidian/community-plugins.json` enabling `orca-chat`, a couple of
  throwaway `.md` files so Obsidian has something open.
- A setup step (Playwright `globalSetup`) runs `npm run build`, then copies
  (not symlinks — this fixture is disposable) `main.js`, `manifest.json`,
  `styles.css` into
  `test-e2e/fixture-vault/.obsidian/plugins/orca-chat/`.
- The same setup step generates a fresh E2EE keypair per run (reusing
  `src/orca-remote/e2ee-crypto.ts`) and writes a paired-credential
  `data.json` into that plugin folder pointing at `127.0.0.1:<port>`, where
  `<port>` is wherever that test's fake server (below) is bound.
- Playwright launches the user's locally-installed Obsidian.app via
  `_electron.launch()`, pointed at the fixture vault path directly. No
  pinned/downloaded Obsidian version — whatever is installed locally is what
  gets tested against.

### Fake Orca server

- `test-e2e/fake-orca-server.ts`: a `ws`-based server implementing enough of
  the real wire protocol (`src/orca-remote/e2ee-crypto.ts`,
  `runtime-rpc-envelope.ts`, `remote-runtime-client-handshake.ts`, reused
  directly, not reimplemented) to satisfy `OrcaRemoteClient` — so the
  crypto/handshake/framing code is genuinely exercised by these tests, not
  bypassed.
- Scripting API tests use to drive scenarios and assert on outcomes:
  - `server.setSessionTabs([...])`
  - `server.setSessionHistory(sessionId, items)`
  - `server.pushHistoryEvent(sessionId, event)` — simulates a live push
    mid-test
  - `server.received(rpcName)` — asserts the client actually sent a given
    RPC (e.g. `sendAgentSessionMessage`, `respondToPrompt`) with the
    expected arguments
- One fresh server instance (fresh port, fresh keys, no shared state) per
  test, so tests can run in parallel and stay hermetic.

### Test suite

Lives under `test-e2e/`, using `@playwright/test` (new devDependency — its
built-in Electron support is exactly the tool for this, not something to
reimplement). Separate `npm run test:e2e` script; not part of `npm test`,
since it's slower and launches a real Electron app.

First-suite scenarios:

1. Open the pane → session picker shows tabs from `setSessionTabs` → select
   one → history renders as bubbles (text, tool-call summary + collapsible
   detail, diff, status).
2. Send a message → input clears → fake server receives
   `sendAgentSessionMessage` with the right session id and text.
3. Approval/question prompt renders as buttons → clicking one → server
   receives `respondToPrompt` → bubble shows the resolved state.
4. Live update: `server.pushHistoryEvent(...)` mid-test → new bubble appears
   without re-opening the pane, view auto-scrolls to the bottom.
5. Session disappears from tabs (server updates `setSessionTabs` to omit
   it) → picker shows the "previous session ended" `Notice`, pane doesn't
   crash.

## Testing

This spec's own subject *is* a test harness — "testing the tests" is just:
run `npm run test:e2e` locally, confirm all five scenarios pass against a
correct build, and confirm at least one deliberately-broken build (e.g.
comment out the auto-scroll call) makes the corresponding test fail. That
confirms the harness actually catches regressions rather than passing
vacuously.
