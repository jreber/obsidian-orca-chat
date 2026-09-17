# Working notes for this plugin

Lessons learned the hard way, kept here so the next round of work doesn't re-pay for them.
Written for whoever (human or agent) touches this repo next — including future me.

## Open complaint / future-direction idea (2026-09-17, not started)

Even after the styling pass (bubbles, collapsible tool-call detail, auto-scroll, clickable
permission-prompt buttons), the hand-built chat renderer in `chat-view.ts` still isn't a
satisfying chat UI. James is considering a different architecture: embed/tie into Orca Mobile's
own UI directly instead of continuing to reimplement chat rendering (message bubbles, tool-call
summaries, approval prompts, ...) from the raw `agentSession.*` journal here. Orca Mobile has
presumably already solved this same rendering problem properly. Worth a real spike before sinking
more time into polishing this plugin's own renderer further: what would it take to host or embed
Orca Mobile's actual UI inside an Obsidian pane (e.g. a webview pointed at Orca's mobile web
client, if one exists) rather than hand-rolling a second one here.

## Before claiming something works

**Run `npm test` and `npm run build` before saying a fix is done.** `npm test` runs a real,
hermetic regression suite (see below) — use it instead of asking the user to click through
Obsidian to confirm basic logic. Reserve "please try it in Obsidian" for things the test harness
genuinely can't cover: live network/pairing state, actual rendering/CSS, real Orca session data.

Concretely, before this session added `npm test`, verifying "does the input clear on send" meant:
guess at the cause, ship a patch, ask the user to test it live, get evidence it was still wrong,
guess again. Each round cost a full user round-trip. The `handleSend` bug in
`test/chat-view.send-clears-input.test.ts` should have existed *before* the first fix attempt —
write the test for the exact contract being asked for, watch it fail against the old code, then
fix it.

## Testing this plugin without Obsidian

`npm test` bundles `test/**/*.test.ts` with esbuild and runs the result with Node's built-in test
runner (`node --test`) — no test framework dependency. This works because:

- The real `obsidian` npm package is **types only** (`main: ""` in its package.json — nothing to
  import at runtime). `test/fakes/obsidian.ts` is a minimal runtime stand-in (DOM-extension
  methods like `createDiv`/`createEl`/`empty`, plus `ItemView`/`Plugin`/`DropdownComponent`/
  `Notice`/`Modal`). Extend it as tests need more surface — don't front-load the rest of the API.
- `test/run.mjs` aliases the bare `"obsidian"` import to that fake file and bundles everything
  else that's local (`src/**`, `test/**`) while leaving real node_modules packages
  (`ws`, `tweetnacl`, `jsdom`, `zod`) as genuine runtime imports (`packages: "external"`). Several
  of those packages do dynamic `require()`s of Node built-ins that esbuild cannot safely inline
  into an ESM bundle — bundling them produces a "Dynamic require of X is not supported" crash at
  test-run time, not a build-time error, so it's easy to chase one at a time and not realize the
  real fix is "don't bundle node_modules at all." `packages: "external"` at the top mangles
  `"node:test"`/`"node:assert"` into the wrong bare specifiers (`"test"`/`"assert"`) — they're
  listed in `external` explicitly afterward to keep the `node:` prefix intact.
- jsdom provides `document`/`HTMLElement`/etc. Tests assign these to `globalThis` **before**
  importing anything from `src/` — none of this plugin's modules touch `document` at import time
  (only inside methods), so plain static imports at the top of a test file are fine as long as the
  jsdom setup lines physically come first in that file.

**Current tests are white-box** (`test/chat-view.send-clears-input.test.ts` reaches
`view["input"]`/`view["handleSend"]`/`view["sendToSelected"]` via bracket access, since
`OrcaChatView` has no constructor seam for injecting a fake CLI/RPC client). That's a deliberate
shortcut for a single-view plugin with one non-trivial send path, not a pattern to scale
indefinitely — if tests keep needing to reach further into private state, that's the signal to add
real seams (e.g. accept an injected `OrcaRemoteClient`-shaped interface, or split `handleSend`'s
send-and-clear logic into a small pure function) rather than adding more bracket-access tests.

**What the test harness deliberately does NOT cover**: don't call the real `onOpen()` in a test —
it shells out to the real `orca` CLI (`listTerminals()`) and opens a real E2EE network connection.
That's exactly the kind of environment-dependent, slow, non-hermetic call this harness exists to
avoid. Build fixtures that only construct the DOM pieces a given code path actually touches.

## Live-testing against a real Orca instance (when the test harness isn't enough)

Sometimes there's no substitute for calling the real protocol — e.g. to find the exact shape of
a wire response, or confirm a capability string, or check whether an RPC call itself is the thing
hanging. Bundle a throwaway script directly against `src/orca-remote-client.ts` rather than
guessing at wire shapes from reading Orca's source alone:

```bash
npx esbuild --bundle --platform=node --external:obsidian scratch.ts --outfile=scratch.js
node scratch.js
```

Read the paired credential straight out of the vault's plugin `data.json` (bypasses needing
Obsidian's `Plugin.loadData()` at all):

```
~/path/to/YourVault/.obsidian/plugins/orca-chat/data.json
```

This has caught real bugs no amount of source-reading did: the `clientOperationId` format
(`/^(\d{13})-[0-9a-f]{32}$/`, not a plain UUID), and confirming a "still timing out" report was a
genuinely dead network path (`nc -z <host> <port>`), not a code bug at all.

## Deployment gotchas specific to this setup

- **`main.js` is symlinked**, not copied, into the vault plugin folder
  (`.obsidian/plugins/orca-chat/main.js -> ~/repos/obsidian-orca-chat/main.js`), so a fresh
  `npm run build` is live immediately — no reinstall step. `manifest.json` and `styles.css` are
  symlinked the same way. If a live symptom looks like the code "isn't taking effect," check these
  are actually symlinks (`ls -la` on the plugin folder) before suspecting anything else — Obsidian
  does NOT hot-reload `main.js` on save, though: a code change still needs a full Obsidian restart
  (or the plugin re-enabled) to take effect, `styles.css` included.
- **The vault's plugin folder is named `orca-chat`**, not `obsidian-orca-chat` (matches
  `manifest.json`'s `id`, not the repo directory name) — don't go looking for a folder matching
  the repo name.
- **Mobile-scope pairing bakes in a LAN IP by default**, which breaks the instant the pairing
  machine changes networks (Wi-Fi ↔ hotspot ↔ VPN) since Obsidian and Orca run on the *same*
  machine here. When re-pairing, use Orca's "This computer only" address option (encodes
  `127.0.0.1`) instead of a LAN interface — immune to network changes, and there is no reason to
  ever prefer a LAN address for a same-machine setup.
- **No persistent connection** to Orca at all: every single RPC call in
  `src/orca-remote/remote-runtime-request-socket.ts` opens a fresh WebSocket, does a full E2EE
  handshake, and closes when done. This means (a) call frequency matters — don't poll structured
  session data on a short interval, only refetch on real triggers (dropdown focus, explicit
  actions); and (b) a client-visible error from one of these calls does **not** reliably mean the
  server-side mutation never happened — the ack can be lost after the mutation already applied.
  Don't build UI logic (e.g. "restore the typed message on a reported send failure") that assumes
  otherwise; see `handleSend`'s comment in `chat-view.ts`.
