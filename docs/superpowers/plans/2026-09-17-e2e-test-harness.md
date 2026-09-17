# Chat Pane E2E Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Playwright suite that drives the real Obsidian desktop app (with this plugin installed) against a fake Orca host, so chat-pane rendering/interaction bugs surface as failing tests instead of manual bug reports.

**Architecture:** A fake WebSocket server (`test-e2e/protocol/`) plays the *host* side of Orca's private E2EE remote-runtime protocol, reusing the plugin's own crypto/envelope code — not reimplementing it — so `OrcaRemoteClient` connects to it exactly as it would to real Orca. A Playwright fixture (`test-e2e/helpers/obsidian-fixture.ts`) launches the real, locally-installed Obsidian.app via `_electron.launch()` against a fresh temp copy of a checked-in fixture vault, with the plugin's `data.json` pointed at that test's fake server. Five scenario tests drive the pane's real DOM.

**Tech Stack:** `@playwright/test` (new devDependency) for Electron automation; `ws` + `tweetnacl` (already dependencies) for the fake server; Node's built-in `node:test` for the lower-level protocol tests (no Electron needed there).

**Spec:** `docs/superpowers/specs/2026-09-17-e2e-test-harness-design.md`

## Global Constraints

- The only new dependency this plan adds is `@playwright/test` (devDependency). Everything else (fake server, fixture vault, helpers) is plugin/Node code.
- The fake server MUST import crypto/protocol primitives directly from `src/orca-remote/e2ee-crypto.ts` — never reimplement NaCl box crypto.
- Every test gets its own: fake `FakeOrcaServer` instance (fresh port + fresh keypair), fresh temp copy of the fixture vault, and fresh Electron `--user-data-dir`. No shared state between tests, so they can run in parallel.
- `npm test` (existing `node:test` suite under `test/`) and `npm run test:e2e` (new Playwright suite under `test-e2e/`) stay separate scripts — different runners, different speed/hermeticity trade-offs.
- Obsidian's executable path is hardcoded for macOS (`/Applications/Obsidian.app/Contents/MacOS/Obsidian`), matching the approved design decision to test against the locally-installed app on this machine. Not cross-platform by design.
- This machine's Obsidian has its CLI companion (`obsidian-cli`) disabled ("Command line interface is not enabled... Settings > General > Advanced") — do not depend on it. Vault opening goes through a plain positional launch argument instead (verified empirically as part of Task 2).

---

## Task 1: Fake Orca protocol server

**Files:**
- Create: `test-e2e/protocol/e2ee-server-connection.ts`
- Create: `test-e2e/protocol/fake-orca-server.ts`
- Test: `test/fake-orca-server.protocol.test.ts` (goes in the *existing* `node:test` suite — no Electron needed to verify wire-protocol correctness, only the real client-side transport code driven directly against a real `ws` socket)

**Interfaces:**
- Produces (consumed by every later task):
  - `FakeOrcaServer.start(): Promise<FakeOrcaServer>`
  - `server.port: number`, `server.credential: PairingOffer`
  - `server.setSessionTabs(tabs: AgentSessionTab[]): void`
  - `server.setSessionHistory(sessionId: string, page: AgentSessionHistoryPage): void`
  - `server.pushHistoryEvent(sessionId: string, event: AgentSessionSubscribeEvent): void`
  - `server.received(method: string): unknown[]`
  - `server.stop(): Promise<void>`
  - Builder helpers: `historyPage(sessionId, items, fence?)`, `textMessageItem(itemId, sequence, role, text)`, `approvalItem(itemId, sequence, title, options)`, `agentSessionTab(sessionId, title, agent?)`

### Step 1: Write the failing test for `session.tabs.listAll`

Create `test/fake-orca-server.protocol.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { sendRemoteRuntimeRequest } from "../src/orca-remote/remote-runtime-client.ts";
import { FakeOrcaServer, agentSessionTab, historyPage, textMessageItem } from "../test-e2e/protocol/fake-orca-server.ts";
import { OrcaRemoteClient } from "../src/orca-remote-client.ts";

test("session.tabs.listAll returns the tabs configured on the fake server", async () => {
	const server = await FakeOrcaServer.start();
	try {
		const tab = agentSessionTab("sess-1", "My chat");
		server.setSessionTabs([tab]);
		const response = await sendRemoteRuntimeRequest<{ snapshots: { worktree: string; tabs: unknown[] }[] }>(
			server.credential,
			"session.tabs.listAll",
			null,
			5000,
		);
		if (!response.ok) throw new Error(response.error.message);
		assert.deepEqual(response.result.snapshots[0].tabs, [tab]);
	} finally {
		await server.stop();
	}
});
```

### Step 2: Run it, verify it fails for the right reason

Run: `npm test`
Expected: build/import error — `test-e2e/protocol/fake-orca-server.ts` does not exist yet.

### Step 3: Implement the handshake helper

Create `test-e2e/protocol/e2ee-server-connection.ts`:

```ts
import type { WebSocket } from "ws";
import type nacl from "tweetnacl";
import { deriveSharedKey, encrypt, decrypt, publicKeyFromBase64 } from "../../src/orca-remote/e2ee-crypto";

export interface ServerConnection {
	deviceToken: string;
	sendEncrypted(payload: unknown): void;
}

// Host side of the same E2EE handshake src/orca-remote/remote-runtime-request-socket.ts drives from
// the client: plaintext hello/ready, then an encrypted auth/authenticated exchange. Every decrypted
// frame received after that is handed to `onRpc` as a parsed JSON object.
export function acceptOrcaConnection(
	ws: WebSocket,
	serverKeyPair: nacl.BoxKeyPair,
	onRpc: (conn: ServerConnection, request: Record<string, unknown>) => void,
): void {
	let sharedKey: Uint8Array | null = null;
	let conn: ServerConnection | null = null;

	ws.on("message", (raw) => {
		const text = raw.toString("utf-8");

		if (!sharedKey) {
			const hello = JSON.parse(text) as { type?: string; publicKeyB64?: string };
			if (hello.type !== "e2ee_hello" || !hello.publicKeyB64) return;
			sharedKey = deriveSharedKey(serverKeyPair.secretKey, publicKeyFromBase64(hello.publicKeyB64));
			ws.send(JSON.stringify({ type: "e2ee_ready" }));
			return;
		}

		const plaintext = decrypt(text, sharedKey);
		if (plaintext === null) return;
		const frame = JSON.parse(plaintext) as Record<string, unknown>;

		if (!conn) {
			if (frame.type !== "e2ee_auth") return;
			const key = sharedKey;
			conn = {
				deviceToken: String(frame.deviceToken ?? ""),
				sendEncrypted: (payload) => ws.send(encrypt(JSON.stringify(payload), key)),
			};
			conn.sendEncrypted({ type: "e2ee_authenticated" });
			return;
		}

		onRpc(conn, frame);
	});
}
```

### Step 4: Implement the server, with `session.tabs.listAll` only

Create `test-e2e/protocol/fake-orca-server.ts`:

```ts
import { WebSocketServer, type WebSocket } from "ws";
import nacl from "tweetnacl";
import { generateKeyPair, publicKeyToBase64 } from "../../src/orca-remote/e2ee-crypto";
import { acceptOrcaConnection, type ServerConnection } from "./e2ee-server-connection";
import type { PairingOffer } from "../../src/orca-remote/pairing";
import type {
	AgentSessionTab,
	AgentSessionHistoryPage,
	AgentSessionSubscribeEvent,
	AgentJournalRenderItem,
	NativeChatRole,
	AgentJournalPromptOption,
} from "../../src/orca-remote-client";

export function historyPage(sessionId: string, items: AgentJournalRenderItem[], fence = 1): AgentSessionHistoryPage {
	return {
		sessionId,
		epoch: "e2e",
		fence,
		direction: "tail",
		items,
		removedItemIds: [],
		submissions: [],
		window: { oldest: null, newest: null, nextCursor: { epoch: "e2e", sequence: items.length } },
		hasOlder: false,
		hasNewer: false,
	};
}

export function textMessageItem(itemId: string, sequence: number, role: NativeChatRole, text: string): AgentJournalRenderItem {
	return {
		itemId,
		revision: 1,
		sequence,
		observedAt: Date.now(),
		body: { kind: "message", role, blocks: [{ type: "text", text }] },
	};
}

export function approvalItem(
	itemId: string,
	sequence: number,
	title: string,
	options: AgentJournalPromptOption[],
): AgentJournalRenderItem {
	return {
		itemId,
		revision: 1,
		sequence,
		observedAt: Date.now(),
		body: {
			kind: "approval",
			title,
			detail: null,
			options,
			resolution: { state: "pending", selectedOptionId: null, resolvedBy: null, resolvedAt: null },
		},
	};
}

export function agentSessionTab(sessionId: string, title: string, agent: "claude" | "codex" = "claude"): AgentSessionTab {
	return { type: "agent-session", id: sessionId, title, sessionId, agent, isActive: true };
}

function minimalSubmission(clientMessageId: string) {
	return {
		clientMessageId,
		fence: 1,
		payloadFingerprint: "",
		dispatchState: "accepted" as const,
		providerItemId: null,
		reason: null,
		submittedAt: Date.now(),
		resolvedAt: null,
	};
}

interface Subscription {
	conn: ServerConnection;
	requestId: string;
	sessionId: string;
}

export class FakeOrcaServer {
	private readonly wss: WebSocketServer;
	private readonly keyPair: nacl.BoxKeyPair;
	private tabs: AgentSessionTab[] = [];
	private historyBySession = new Map<string, AgentSessionHistoryPage>();
	private subscriptions: Subscription[] = [];
	private receivedCalls = new Map<string, unknown[]>();

	private constructor(wss: WebSocketServer, keyPair: nacl.BoxKeyPair) {
		this.wss = wss;
		this.keyPair = keyPair;
	}

	static async start(): Promise<FakeOrcaServer> {
		const keyPair = generateKeyPair();
		const wss = new WebSocketServer({ port: 0 });
		await new Promise<void>((resolve) => wss.once("listening", resolve));
		const server = new FakeOrcaServer(wss, keyPair);
		wss.on("connection", (ws) => server.handleConnection(ws));
		return server;
	}

	get port(): number {
		const address = this.wss.address();
		if (typeof address === "string" || address === null) throw new Error("FakeOrcaServer has no port");
		return address.port;
	}

	get credential(): PairingOffer {
		return {
			v: 2,
			endpoint: `ws://127.0.0.1:${this.port}`,
			deviceToken: "fake-e2e-device-token",
			publicKeyB64: publicKeyToBase64(this.keyPair.publicKey),
			scope: "runtime",
		};
	}

	setSessionTabs(tabs: AgentSessionTab[]): void {
		this.tabs = tabs;
	}

	setSessionHistory(sessionId: string, page: AgentSessionHistoryPage): void {
		this.historyBySession.set(sessionId, page);
	}

	pushHistoryEvent(sessionId: string, event: AgentSessionSubscribeEvent): void {
		for (const sub of this.subscriptions) {
			if (sub.sessionId !== sessionId) continue;
			sub.conn.sendEncrypted({ id: sub.requestId, ok: true, result: event, _meta: { runtimeId: "fake-orca" } });
		}
	}

	received(method: string): unknown[] {
		return this.receivedCalls.get(method) ?? [];
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve, reject) => this.wss.close((err) => (err ? reject(err) : resolve())));
	}

	private handleConnection(ws: WebSocket): void {
		acceptOrcaConnection(ws, this.keyPair, (conn, request) => {
			const method = String(request.method);
			const calls = this.receivedCalls.get(method) ?? [];
			calls.push(request.params);
			this.receivedCalls.set(method, calls);
			this.handleRpc(conn, request);
		});
	}

	private handleRpc(conn: ServerConnection, request: Record<string, unknown>): void {
		const id = String(request.id);
		const method = String(request.method);
		const params = (request.params ?? {}) as Record<string, unknown>;
		const reply = (result: unknown) => conn.sendEncrypted({ id, ok: true, result, _meta: { runtimeId: "fake-orca" } });
		const fail = (code: string, message: string) => conn.sendEncrypted({ id, ok: false, error: { code, message } });

		switch (method) {
			case "session.tabs.listAll":
				reply({ snapshots: [{ worktree: "", tabs: this.tabs }] });
				return;
			case "agentSession.history": {
				const sessionId = String(params.sessionId);
				const page = this.historyBySession.get(sessionId) ?? historyPage(sessionId, []);
				reply({ ok: true, page });
				return;
			}
			case "agentSession.subscribe": {
				const sessionId = String(params.sessionId);
				this.subscriptions.push({ conn, requestId: id, sessionId });
				return;
			}
			case "agentSession.send":
				reply({
					ok: true,
					replayed: false,
					fence: 1,
					cursor: { epoch: "e2e", sequence: 1 },
					value: { clientMessageId: id, submission: minimalSubmission(id) },
				});
				return;
			case "agentSession.respondToApproval":
			case "agentSession.respondToQuestion":
				reply({ ok: true, replayed: false, fence: 1, cursor: { epoch: "e2e", sequence: 1 }, value: null });
				return;
			default:
				fail("unknown_method", `Fake Orca server has no handler for ${method}`);
		}
	}
}
```

### Step 5: Run the test, verify it passes

Run: `npm test`
Expected: PASS (all existing tests plus the new one).

### Step 6: Write the failing test for `agentSession.history`

Add to `test/fake-orca-server.protocol.test.ts`:

```ts
test("agentSession.history returns the page configured on the fake server", async () => {
	const server = await FakeOrcaServer.start();
	try {
		const item = textMessageItem("item-1", 1, "user", "hello");
		server.setSessionHistory("sess-1", historyPage("sess-1", [item], 7));
		const response = await sendRemoteRuntimeRequest<{ ok: true; page: { items: unknown[]; fence?: number } }>(
			server.credential,
			"agentSession.history",
			{ sessionId: "sess-1", direction: "tail" },
			5000,
		);
		if (!response.ok) throw new Error(response.error.message);
		assert.deepEqual(response.result.page.items, [item]);
		assert.equal(response.result.page.fence, 7);
	} finally {
		await server.stop();
	}
});
```

This one already passes against Step 4's implementation (the handler was written up front) — that's fine; run it anyway to confirm.

Run: `npm test`
Expected: PASS.

### Step 7: Write the failing test for `sendAgentSessionMessage`

Add:

```ts
test("sendAgentSessionMessage delivers the text to the fake server", async () => {
	const server = await FakeOrcaServer.start();
	try {
		server.setSessionHistory("sess-1", historyPage("sess-1", [], 1));
		const client = new OrcaRemoteClient();
		await client.connect(server.credential);
		await client.sendAgentSessionMessage("sess-1", "hello from a test");
		const calls = server.received("agentSession.send") as { body: { blocks: { text: string }[] } }[];
		assert.equal(calls.length, 1);
		assert.equal(calls[0].body.blocks[0].text, "hello from a test");
	} finally {
		await server.stop();
	}
});
```

Run: `npm test`
Expected: PASS (the send handler was also written in Step 4). Confirms the full `sendAgentSessionMessage` → internal history-fence-read → `agentSession.send` path works end to end through the real client class, not just the raw transport function.

### Step 8: Write the failing test for `respondToPrompt`

Add:

```ts
test("respondToPrompt delivers the chosen option to the fake server", async () => {
	const server = await FakeOrcaServer.start();
	try {
		server.setSessionHistory("sess-1", historyPage("sess-1", [], 1));
		const client = new OrcaRemoteClient();
		await client.connect(server.credential);
		await client.respondToPrompt("sess-1", "approval", "item-1", 1, "opt-yes");
		const calls = server.received("agentSession.respondToApproval") as { optionId: string }[];
		assert.equal(calls.length, 1);
		assert.equal(calls[0].optionId, "opt-yes");
	} finally {
		await server.stop();
	}
});
```

Run: `npm test`
Expected: PASS.

### Step 9: Write the failing test for subscription push

Add:

```ts
test("pushHistoryEvent delivers a batch to an open subscription", async () => {
	const server = await FakeOrcaServer.start();
	try {
		const client = new OrcaRemoteClient();
		await client.connect(server.credential);
		const events: unknown[] = [];
		const unsubscribe = client.subscribeAgentSessionHistory("sess-1", (event) => events.push(event));
		// ponytail: fixed delay to let the subscribe handshake land — OrcaRemoteClient exposes no
		// "subscription is open" callback. Upgrade to a real ready-signal if this proves flaky.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const item = textMessageItem("item-2", 1, "assistant", "hi there");
		const batchEvent = {
			type: "batch" as const,
			sessionId: "sess-1",
			batch: { cursor: { epoch: "e2e", sequence: 1 }, items: [item], removedItemIds: [], submissions: [] },
		};
		server.pushHistoryEvent("sess-1", batchEvent);
		await new Promise((resolve) => setTimeout(resolve, 300));
		unsubscribe();
		assert.deepEqual(events, [batchEvent]);
	} finally {
		await server.stop();
	}
});
```

Run: `npm test`
Expected: PASS — this exercises the one piece of Step 4 not yet covered (the `agentSession.subscribe` handler recording the subscription, then `pushHistoryEvent` finding and using it).

### Step 10: Commit

```bash
git add test-e2e/protocol/e2ee-server-connection.ts test-e2e/protocol/fake-orca-server.ts test/fake-orca-server.protocol.test.ts
git commit -m "Add fake Orca protocol server for E2E testing

Reuses the plugin's own E2EE crypto/envelope code (src/orca-remote/) to
play the host side of the protocol, verified against the real client
transport functions in a hermetic node:test suite (no Electron needed)."
```

---

## Task 2: Playwright + Obsidian launcher, and Scenario 1 (session picker + history rendering)

**Files:**
- Modify: `package.json` (add `@playwright/test` devDependency, `test:e2e` script)
- Modify: `.gitignore`
- Create: `playwright.config.ts`
- Create: `test-e2e/global-setup.ts`
- Create: `test-e2e/fixture-vault/.obsidian/community-plugins.json`
- Create: `test-e2e/fixture-vault/.obsidian/plugins/orca-chat/.gitkeep`
- Create: `test-e2e/fixture-vault/Welcome.md`
- Create: `test-e2e/helpers/obsidian-fixture.ts`
- Create: `test-e2e/chat-pane.spec.ts`

**Interfaces:**
- Consumes: `FakeOrcaServer`, `agentSessionTab`, `historyPage`, `textMessageItem` from Task 1 (`test-e2e/protocol/fake-orca-server.ts`).
- Produces (consumed by Tasks 3–6): the `test` and `expect` exports of `test-e2e/helpers/obsidian-fixture.ts`, providing `{ server: FakeOrcaServer, obsidian: Page }` fixtures to every spec test.

### Step 1: Add the Playwright dependency and script

Edit `package.json` — add to `"scripts"`:

```json
"test:e2e": "playwright test"
```

Add to `"devDependencies"`:

```json
"@playwright/test": "^1.48.0"
```

Run: `npm install`
Expected: installs cleanly, `node_modules/@playwright/test` exists.

### Step 2: Add `.gitignore` entries

Edit `.gitignore`, append:

```
test-e2e/fixture-vault/.obsidian/plugins/orca-chat/*
!test-e2e/fixture-vault/.obsidian/plugins/orca-chat/.gitkeep
playwright-report/
test-results/
```

### Step 3: Create the fixture vault template

Create `test-e2e/fixture-vault/.obsidian/community-plugins.json`:

```json
["orca-chat"]
```

Create `test-e2e/fixture-vault/.obsidian/plugins/orca-chat/.gitkeep` (empty file — keeps the directory in git; the `.gitignore` rule above ignores everything else global-setup copies in here).

Create `test-e2e/fixture-vault/Welcome.md`:

```markdown
# Fixture vault

Used by the Playwright E2E suite in `test-e2e/`. Not meant to be opened by hand — every test run
copies this directory into a fresh temp location.
```

### Step 4: Write `global-setup.ts`

Create `test-e2e/global-setup.ts`:

```ts
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// Runs once before the whole Playwright suite: builds the plugin, then copies its output into the
// checked-in fixture vault template so every per-test temp copy (see obsidian-fixture.ts) already
// has a working plugin install.
export default function globalSetup(): void {
	const root = path.resolve(import.meta.dirname, "..");
	execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });

	const pluginDir = path.join(root, "test-e2e", "fixture-vault", ".obsidian", "plugins", "orca-chat");
	mkdirSync(pluginDir, { recursive: true });
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		copyFileSync(path.join(root, file), path.join(pluginDir, file));
	}
}
```

### Step 5: Write `playwright.config.ts`

Create `playwright.config.ts` at the repo root:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./test-e2e",
	timeout: 60_000,
	fullyParallel: true,
	globalSetup: "./test-e2e/global-setup.ts",
	use: {
		screenshot: "only-on-failure",
	},
});
```

### Step 6: Write the launcher fixture

Create `test-e2e/helpers/obsidian-fixture.ts`:

```ts
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { test as base } from "@playwright/test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeOrcaServer } from "../protocol/fake-orca-server";

const FIXTURE_VAULT = path.resolve(import.meta.dirname, "../fixture-vault");
const OBSIDIAN_BINARY = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";

export const test = base.extend<{ server: FakeOrcaServer; obsidian: Page }>({
	server: async ({}, use) => {
		const server = await FakeOrcaServer.start();
		await use(server);
		await server.stop();
	},

	// Fresh vault copy + fresh Electron --user-data-dir per test: avoids colliding with the real,
	// already-running Obsidian on this machine (Electron's single-instance lock is scoped to
	// --user-data-dir, so without this every _electron.launch() would just hand its argv to the
	// user's real Obsidian process instead of opening its own window) and keeps tests parallel-safe.
	obsidian: async ({ server }, use) => {
		const vaultDir = mkdtempSync(path.join(tmpdir(), "orca-chat-e2e-vault-"));
		const userDataDir = mkdtempSync(path.join(tmpdir(), "orca-chat-e2e-userdata-"));
		cpSync(FIXTURE_VAULT, vaultDir, { recursive: true });
		writeFileSync(
			path.join(vaultDir, ".obsidian", "plugins", "orca-chat", "data.json"),
			JSON.stringify({ pairedCredential: server.credential }),
		);

		let app: ElectronApplication | undefined;
		try {
			app = await electron.launch({
				executablePath: OBSIDIAN_BINARY,
				args: [vaultDir, `--user-data-dir=${userDataDir}`],
			});
			const page = await app.firstWindow();
			await dismissFirstRunPrompts(page);
			await page.evaluate(() => {
				const win = window as unknown as { app: { commands: { executeCommandById: (id: string) => void } } };
				win.app.commands.executeCommandById("orca-chat:open-orca-chat");
			});
			await page.waitForSelector(".orca-chat-session-select");
			await use(page);
		} finally {
			await app?.close();
			rmSync(vaultDir, { recursive: true, force: true });
			rmSync(userDataDir, { recursive: true, force: true });
		}
	},
});

// ponytail: text-based best-effort dismissal of Obsidian's first-run "trust author" prompt, which
// reappears every run because each test launches with a brand-new --user-data-dir. Not a documented
// API — update the pattern here if a future Obsidian version changes the wording.
async function dismissFirstRunPrompts(page: Page): Promise<void> {
	const trustButton = page.getByRole("button", { name: /trust author/i });
	if (await trustButton.isVisible({ timeout: 5000 }).catch(() => false)) {
		await trustButton.click();
	}
}

export { expect } from "@playwright/test";
```

### Step 7: Write the first (failing) spec test

Create `test-e2e/chat-pane.spec.ts`:

```ts
import { test, expect } from "./helpers/obsidian-fixture";
import { agentSessionTab, historyPage, textMessageItem } from "./protocol/fake-orca-server";

test("session picker lists configured sessions and selecting one renders its history", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory("sess-1", historyPage("sess-1", [textMessageItem("item-1", 1, "user", "hello there")]));

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus(); // triggers the pane's onfocus refresh, which re-fetches session tabs
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");

	await expect(obsidian.locator(".orca-chat-message-body")).toHaveText("hello there");
});
```

### Step 8: Run it, watch it fail, and fix the launch mechanics

Run: `npx playwright test test-e2e/chat-pane.spec.ts`

This is a real environment-dependent step, not a placeholder: the exact way to make a *freshly launched* Obsidian.app open a specific vault directly (skipping any vault-picker screen) has not been run end-to-end yet. Expected failure modes and fixes, in order of likelihood:

1. **Electron never produces a window / times out on `firstWindow()`.** Means the single-instance lock still applied despite `--user-data-dir`. Fix: confirm no other process is holding that exact temp `--user-data-dir` (it's fresh per test, so this should not recur) — if it does, check Obsidian's own startup logs (`app.on('second-instance', ...)`) aren't matching on something else.
2. **Obsidian opens its vault-picker screen instead of the fixture vault directly.** Fix: replace the plain positional `vaultDir` arg with an `obsidian://open?path=<encodeURIComponent(vaultDir)>` URL as the launch arg instead (Obsidian's registered deep-link scheme, parsed from `process.argv` on a fresh launch same as a clicked link):
   ```ts
   app = await electron.launch({
   	executablePath: OBSIDIAN_BINARY,
   	args: [`obsidian://open?path=${encodeURIComponent(vaultDir)}`, `--user-data-dir=${userDataDir}`],
   });
   ```
3. **The "trust author" prompt's actual button text doesn't match `/trust author/i`.** Take the failure screenshot Playwright saves (`test-results/.../test-failed-1.png` per `use.screenshot` config) and update the pattern in `dismissFirstRunPrompts` to match what's actually shown.
4. **`window.app` isn't defined when `page.evaluate` runs.** Means the renderer hadn't finished bootstrapping yet — add `await page.waitForFunction(() => 'app' in window)` immediately after `dismissFirstRunPrompts(page)`, before the `executeCommandById` call.

Iterate on `test-e2e/helpers/obsidian-fixture.ts` against real output until this step passes — do not move on while guessing.

### Step 9: Verify it passes

Run: `npx playwright test test-e2e/chat-pane.spec.ts`
Expected: PASS, 1 test.

### Step 10: Commit

```bash
git add package.json package-lock.json .gitignore playwright.config.ts test-e2e/
git commit -m "Add Playwright E2E harness: launcher fixture + session-picker/history scenario"
```

---

## Task 3: Send round trip (Scenario 2)

**Files:**
- Modify: `test-e2e/chat-pane.spec.ts`

**Interfaces:**
- Consumes: `test`/`expect` from `test-e2e/helpers/obsidian-fixture.ts`; `agentSessionTab`/`historyPage` from `test-e2e/protocol/fake-orca-server.ts` (both from Task 2).

### Step 1: Write the failing test

Add to `test-e2e/chat-pane.spec.ts`:

```ts
test("sending a message clears the input and reaches the fake server", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory("sess-1", historyPage("sess-1", []));

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus();
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");

	const input = obsidian.locator(".orca-chat-input-row input");
	await input.fill("hello from playwright");
	await input.press("Enter");

	await expect(input).toHaveValue("");
	await expect.poll(() => server.received("agentSession.send").length).toBe(1);
	const [call] = server.received("agentSession.send") as { body: { blocks: { text: string }[] } }[];
	expect(call.body.blocks[0].text).toBe("hello from playwright");
});
```

### Step 2: Run it, verify it fails

Run: `npx playwright test test-e2e/chat-pane.spec.ts -g "sending a message"`
Expected: FAIL if the fixture/server plumbing has any gap for this path — otherwise this may pass immediately since Task 1/2 already built the full send path. If it passes immediately, that's fine; it's still confirming real, previously-unexercised UI behavior (input clearing, Enter-to-send) end to end. Run it and read the result either way — don't skip this step because you expect a pass.

### Step 3: Fix forward if it failed

If it failed, the gap is almost always in `obsidian-fixture.ts` or `fake-orca-server.ts` from Task 1/2, not new product code — this plan adds no new `src/` behavior here. Fix whichever file the failure points at.

### Step 4: Verify green

Run: `npx playwright test test-e2e/chat-pane.spec.ts`
Expected: PASS, 2 tests.

### Step 5: Commit

```bash
git add test-e2e/chat-pane.spec.ts
git commit -m "Add E2E coverage for the send-message round trip"
```

---

## Task 4: Approval prompt buttons (Scenario 3)

**Files:**
- Modify: `test-e2e/chat-pane.spec.ts`

**Interfaces:**
- Consumes: `approvalItem` from `test-e2e/protocol/fake-orca-server.ts` (Task 1), plus everything Task 3 consumes.

### Step 1: Write the failing test

Add to `test-e2e/chat-pane.spec.ts` (add `approvalItem` to the existing import from `./protocol/fake-orca-server`):

```ts
test("clicking an approval option notifies the fake server and reflects a pushed resolution", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory(
		"sess-1",
		historyPage("sess-1", [
			approvalItem("item-1", 1, "Allow file write?", [
				{ id: "opt-yes", label: "Yes" },
				{ id: "opt-no", label: "No" },
			]),
		]),
	);

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus();
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");

	await obsidian.getByRole("button", { name: "Yes" }).click();
	await expect.poll(() => server.received("agentSession.respondToApproval").length).toBe(1);
	const [call] = server.received("agentSession.respondToApproval") as { optionId: string }[];
	expect(call.optionId).toBe("opt-yes");

	// Simulate the host pushing back the resolved item, the same way a real Orca host would after
	// accepting the response — clicking alone doesn't locally mark an item resolved (see
	// chat-view.ts's renderPromptItem: it disables the buttons, but the "resolved" bubble state
	// comes from the item's own data, which only updates via a subscription push).
	const resolvedItem = {
		itemId: "item-1",
		revision: 2,
		sequence: 1,
		observedAt: Date.now(),
		body: {
			kind: "approval" as const,
			title: "Allow file write?",
			detail: null,
			options: [
				{ id: "opt-yes", label: "Yes" },
				{ id: "opt-no", label: "No" },
			],
			resolution: { state: "resolved" as const, selectedOptionId: "opt-yes", resolvedBy: "test", resolvedAt: Date.now() },
		},
	};
	server.pushHistoryEvent("sess-1", {
		type: "batch",
		sessionId: "sess-1",
		batch: { cursor: { epoch: "e2e", sequence: 2 }, items: [resolvedItem], removedItemIds: [], submissions: [] },
	});

	await expect(obsidian.locator(".orca-chat-prompt-resolved")).toHaveText("✓ Yes");
});
```

### Step 2: Run it, verify it fails or passes for the right reason

Run: `npx playwright test test-e2e/chat-pane.spec.ts -g "clicking an approval option"`
Expected: same as Task 3 Step 2 — read the actual result, fix forward against `fake-orca-server.ts`/`obsidian-fixture.ts` if it fails, don't assume.

### Step 3: Verify green

Run: `npx playwright test test-e2e/chat-pane.spec.ts`
Expected: PASS, 3 tests.

### Step 4: Commit

```bash
git add test-e2e/chat-pane.spec.ts
git commit -m "Add E2E coverage for approval-prompt buttons and resolution rendering"
```

---

## Task 5: Live update via subscription push (Scenario 4)

**Files:**
- Modify: `test-e2e/chat-pane.spec.ts`

**Interfaces:**
- Consumes: same as Task 3.

### Step 1: Write the failing test

Add:

```ts
test("a pushed batch event renders a new bubble without reopening the pane", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory("sess-1", historyPage("sess-1", [textMessageItem("item-1", 1, "user", "first message")]));

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus();
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");
	await expect(obsidian.locator(".orca-chat-message-body")).toHaveText("first message");

	server.pushHistoryEvent("sess-1", {
		type: "batch",
		sessionId: "sess-1",
		batch: {
			cursor: { epoch: "e2e", sequence: 2 },
			items: [textMessageItem("item-2", 2, "assistant", "pushed reply")],
			removedItemIds: [],
			submissions: [],
		},
	});

	await expect(obsidian.locator(".orca-chat-message-body")).toHaveText(["first message", "pushed reply"]);
});
```

### Step 2: Run it, verify the result

Run: `npx playwright test test-e2e/chat-pane.spec.ts -g "pushed batch event"`
Fix forward against `fake-orca-server.ts` (subscription tracking) or `chat-view.ts` (auto-scroll/re-render) if it fails — read the actual failure first.

### Step 3: Verify green

Run: `npx playwright test test-e2e/chat-pane.spec.ts`
Expected: PASS, 4 tests.

### Step 4: Commit

```bash
git add test-e2e/chat-pane.spec.ts
git commit -m "Add E2E coverage for live subscription push updates"
```

---

## Task 6: Session ends / "previous session ended" notice (Scenario 5)

**Files:**
- Modify: `test-e2e/chat-pane.spec.ts`

**Interfaces:**
- Consumes: same as Task 3.

### Step 1: Write the failing test

Add:

```ts
test("a session disappearing from the tab list shows a notice and doesn't crash the pane", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory("sess-1", historyPage("sess-1", [textMessageItem("item-1", 1, "user", "hello")]));

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus();
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");

	server.setSessionTabs([]);
	await dropdown.blur();
	await dropdown.focus(); // re-triggers populateSessions, the same as any real refresh

	await expect(obsidian.getByText("Orca Chat: previous session ended — pick another")).toBeVisible();
	await expect(dropdown).toHaveValue("");
});
```

### Step 2: Run it, verify the result

Run: `npx playwright test test-e2e/chat-pane.spec.ts -g "disappearing from the tab list"`
Fix forward if it fails — read the actual failure first.

### Step 3: Verify green — full suite

Run: `npx playwright test`
Expected: PASS, 5 tests.

### Step 4: Also confirm the harness actually catches a regression

This is the spec's own acceptance criterion for the harness (not a normal TDD step, but required before calling this plan done): temporarily comment out the `this.scrollToBottom()` call at the end of `renderOutput()` in `src/chat-view.ts`, rerun `npx playwright test`, confirm at least one test's assertions still pass fine (scroll position isn't directly asserted, so this specific tweak may not fail anything — instead, temporarily change `chat-view.ts`'s `renderOutput()` to skip rendering `approval`/`question` items via `renderPromptItem` and confirm Task 4's test fails). Revert the temporary change afterward — do not commit it.

Run: `npx playwright test test-e2e/chat-pane.spec.ts -g "clicking an approval option"` (against the temporarily broken code)
Expected: FAIL.

Then revert, rerun, confirm PASS again.

### Step 5: Commit

```bash
git add test-e2e/chat-pane.spec.ts
git commit -m "Add E2E coverage for session-ended notice; harness verified to catch regressions"
```
