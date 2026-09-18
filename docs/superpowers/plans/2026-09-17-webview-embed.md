# Webview Embed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `chat-view.ts`'s hand-built chat renderer with an embedded `<webview>` pointed at Orca's chrome-free single-session web entry point.

**Architecture:** `chat-view.ts` keeps its session-picker dropdown but stops rendering chat itself. A new pure module (`embed-url.ts`) builds the `single-session-index.html` URL from the plugin's existing `PairedCredential` + selected session's `{sessionId, agent}`. On session selection, `chat-view.ts` mounts a fresh `<webview>` with that URL and a non-persistent partition; on selection change or pane close, it tears the webview down (no reuse).

**Tech Stack:** TypeScript, Obsidian plugin API (`ItemView`, `DropdownComponent`), Electron `<webview>` tag, existing `orca-remote-client.ts`/`orca-pairing.ts`.

**Spec:** `docs/superpowers/specs/2026-09-17-webview-embed-design.md`

## Global Constraints

- The embed URL's `pairing` query param must be produced by `encodePairingOffer` from `src/orca-remote/pairing.ts` (already validates against `PairingOfferSchema`) so it round-trips through Orca's `parseSingleSessionLocation`.
- `pairing.endpoint` is a `ws://`/`wss://` URL; the static HTTP server for `single-session-index.html` lives at the same host:port, so the embed origin is derived by scheme substitution only (`ws:`→`http:`, `wss:`→`https:`), never a separate lookup.
- The `<webview>`'s `partition` attribute must NOT use the `persist:` prefix — this keeps Electron from writing the pairing token to disk, matching the "no localStorage cross-contamination" requirement in Orca's own design doc.
- No two-way `postMessage`/webview-IPC wiring — out of scope per spec.
- `getSelectedHandle()` and `focusPicker()` on `OrcaChatView` must keep their exact current signatures — `main.ts`'s annotate flow depends on them unchanged.

---

### Task 1: `embed-url.ts` — pure URL builder

**Files:**
- Create: `src/embed-url.ts`
- Test: `src/embed-url.test.ts`

**Interfaces:**
- Consumes: `PairedCredential` (`type PairedCredential = PairingOffer` from `src/orca-pairing.ts`, fields include `endpoint: string`), `encodePairingOffer` from `src/orca-remote/pairing.ts` — note `encodePairingOffer` returns a full `orca://pair?code=<base64url>` deep-link string, not a bare encoded blob.
- Produces: `buildSingleSessionEmbedUrl(pairing: PairedCredential, sessionId: string, agent: string): string` — used by Task 2.

The plan needs the *pairing offer itself* JSON-encoded as a URL query value, not the `orca://` deep link. `encodePairingOffer` only produces the deep-link form. So `embed-url.ts` encodes the offer directly (same base64url-of-JSON approach `encodePairingOffer` uses internally, minus the `orca://pair?code=` wrapper), validating through the same schema for consistency.

- [ ] **Step 1: Write the failing test**

```typescript
// src/embed-url.test.ts
import { describe, expect, it } from "vitest";
import { buildSingleSessionEmbedUrl } from "./embed-url";
import { PairingOfferSchema, type PairingOffer } from "./orca-remote/mobile-relay-pairing-offer";

const baseOffer: PairingOffer = PairingOfferSchema.parse({
	deviceToken: "token-abc",
	publicKeyB64: "cHVibGljS2V5",
	endpoint: "ws://192.168.1.50:4931",
});

describe("buildSingleSessionEmbedUrl", () => {
	it("derives an http origin from a ws:// endpoint", () => {
		const url = buildSingleSessionEmbedUrl(baseOffer, "session-1", "claude");
		expect(url.startsWith("http://192.168.1.50:4931/single-session-index.html?")).toBe(true);
	});

	it("derives an https origin from a wss:// endpoint", () => {
		const offer = { ...baseOffer, endpoint: "wss://orca.example.com:9443" };
		const url = buildSingleSessionEmbedUrl(offer, "session-1", "claude");
		expect(url.startsWith("https://orca.example.com:9443/single-session-index.html?")).toBe(true);
	});

	it("includes sessionId and agent as query params", () => {
		const url = buildSingleSessionEmbedUrl(baseOffer, "session-42", "codex");
		const parsed = new URL(url);
		expect(parsed.searchParams.get("sessionId")).toBe("session-42");
		expect(parsed.searchParams.get("agent")).toBe("codex");
	});

	it("encodes the pairing offer such that it round-trips through JSON.parse(atob(...))", () => {
		const url = buildSingleSessionEmbedUrl(baseOffer, "session-1", "claude");
		const parsed = new URL(url);
		const pairingParam = parsed.searchParams.get("pairing");
		expect(pairingParam).toBeTruthy();
		const base64 = (pairingParam as string).replace(/-/g, "+").replace(/_/g, "/");
		const decoded = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
		expect(decoded.deviceToken).toBe("token-abc");
		expect(decoded.endpoint).toBe("ws://192.168.1.50:4931");
	});

	it("throws for an endpoint with an unrecognized scheme", () => {
		const offer = { ...baseOffer, endpoint: "tcp://192.168.1.50:4931" };
		expect(() => buildSingleSessionEmbedUrl(offer, "session-1", "claude")).toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/embed-url.test.ts`
Expected: FAIL — `Cannot find module './embed-url'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/embed-url.ts
import { PairingOfferSchema, type PairingOffer } from "./orca-remote/mobile-relay-pairing-offer";

type PairedCredential = PairingOffer;

// Base64url-encodes the pairing offer's JSON for use as a URL query value —
// deliberately NOT encodePairingOffer() from orca-remote/pairing.ts, which
// wraps the same encoding in an `orca://pair?code=...` deep link meant for a
// different transport (clipboard/QR paste), not a query param.
function encodeOfferForQuery(offer: PairedCredential): string {
	const json = JSON.stringify(PairingOfferSchema.parse(offer));
	return Buffer.from(json, "utf-8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function deriveHttpOrigin(endpoint: string): string {
	if (endpoint.startsWith("wss://")) return `https://${endpoint.slice("wss://".length)}`;
	if (endpoint.startsWith("ws://")) return `http://${endpoint.slice("ws://".length)}`;
	throw new Error(`Unrecognized pairing endpoint scheme: ${endpoint}`);
}

export function buildSingleSessionEmbedUrl(
	pairing: PairedCredential,
	sessionId: string,
	agent: string,
): string {
	const origin = deriveHttpOrigin(pairing.endpoint);
	const params = new URLSearchParams({
		pairing: encodeOfferForQuery(pairing),
		sessionId,
		agent,
	});
	return `${origin}/single-session-index.html?${params.toString()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/embed-url.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/embed-url.ts src/embed-url.test.ts
git commit -m "feat: add single-session embed URL builder"
```

---

### Task 2: Replace `chat-view.ts`'s renderer with a `<webview>` host

**Files:**
- Modify: `src/chat-view.ts` (whole file — see exact replacement content below)
- Test: `src/chat-view.test.ts` (create if it doesn't already exist; if it exists, extend it — check first)

**Interfaces:**
- Consumes: `buildSingleSessionEmbedUrl` from `./embed-url` (Task 1); existing `loadPairedCredential`, `OrcaPairingError`, `PairedCredential` from `./orca-pairing`; existing `OrcaRemoteClient`, `OrcaRemoteError`, `StructuredSessionTab` from `./orca-remote-client` (note: `AgentJournalRenderItem`, `NativeChatBlock`, `NativeChatRole` imports are dropped — no longer used).
- Produces: `OrcaChatView` keeps its exact existing public surface: `getViewType()`, `getDisplayText()`, `getIcon()`, `onOpen()`, `onClose()`, `getSelectedHandle(): string | null`, `focusPicker(): void`. `sendToSelected`, `handleSend`, the composer input/button, and all journal-rendering methods (`renderOutput`, `renderPromptItem`, `mergeJournalItems`, `renderAgentJournalItem`, `ensureStructuredSession`/`trySetupStructuredSession`/`teardownStructuredSession`) are removed — the embedded webview owns composing and rendering.

Check `src/main.ts` for any other call into `OrcaChatView` beyond `getSelectedHandle`/`focusPicker`/`sendToSelected` before removing `sendToSelected` — if `main.ts`'s annotate flow calls `sendToSelected` (it does, per the existing design doc: "sends `${selection}\n\n${question}` ... to the chat pane's currently targeted session"), **keep `sendToSelected` and the underlying `remoteClient`/`hasRemote` wiring**; only remove the *rendering* and *composer* pieces, not the send-message RPC path.

- [ ] **Step 1: Write the failing test**

```typescript
// src/chat-view.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { OrcaChatView, ORCA_CHAT_VIEW_TYPE } from "./chat-view";
import type { WorkspaceLeaf, Plugin } from "obsidian";

// Minimal fakes — obsidian is not runnable outside Obsidian itself, so these
// mirror only the surface OrcaChatView touches, matching the existing repo's
// established pattern for testing ItemView subclasses (see any prior
// *.test.ts using obsidian mocks in this repo, e.g. jsdom-based DOM).
function makeLeaf(): WorkspaceLeaf {
	return {} as WorkspaceLeaf;
}
function makePlugin(): Plugin {
	return { loadData: vi.fn().mockResolvedValue(null), saveData: vi.fn() } as unknown as Plugin;
}

describe("OrcaChatView webview embedding", () => {
	let view: OrcaChatView;

	beforeEach(() => {
		view = new OrcaChatView(makeLeaf(), makePlugin());
	});

	it("has the expected view type", () => {
		expect(view.getViewType()).toBe(ORCA_CHAT_VIEW_TYPE);
	});

	it("getSelectedHandle returns null with no session picked", () => {
		expect(view.getSelectedHandle()).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/chat-view.test.ts`
Expected: FAIL if `src/chat-view.test.ts` doesn't exist yet, or PASS-then-mismatch once Step 3 changes behavior — run it now purely to confirm it executes against the *current* (pre-change) file without a crash, establishing the baseline before rewriting `chat-view.ts`. (If a `chat-view.test.ts` already exists in the repo, read it first and fold these two cases in rather than overwriting.)

- [ ] **Step 3: Replace `src/chat-view.ts` with the webview-hosting version**

```typescript
import { DropdownComponent, ItemView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { buildSingleSessionEmbedUrl } from "./embed-url";
import { loadPairedCredential, OrcaPairingError, type PairedCredential } from "./orca-pairing";
import { OrcaRemoteClient, OrcaRemoteError, type StructuredSessionTab } from "./orca-remote-client";

export const ORCA_CHAT_VIEW_TYPE = "orca-chat-view";

const NO_SESSION_VALUE = "";

export class OrcaChatView extends ItemView {
	private dropdown!: DropdownComponent;
	private statusLabel!: HTMLSpanElement;
	private embedContainer!: HTMLDivElement;
	private currentWebview: HTMLElement | null = null;
	private entries: StructuredSessionTab[] = [];

	private readonly plugin: Plugin;
	private credential: PairedCredential | null = null;
	private remoteClient: OrcaRemoteClient | null = null;
	private hasRemote = false;

	constructor(leaf: WorkspaceLeaf, plugin: Plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return ORCA_CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Orca Chat";
	}

	getIcon(): string {
		return "message-circle";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("orca-chat-view");

		const headerRow = container.createDiv({ cls: "orca-chat-header-row" });
		this.dropdown = new DropdownComponent(headerRow);
		this.dropdown.selectEl.addClass("orca-chat-session-select");
		this.dropdown.selectEl.onfocus = () => void this.populateSessions();
		this.dropdown.onChange(() => this.updateEmbed());

		this.statusLabel = headerRow.createEl("span", { cls: "orca-chat-status-label" });

		this.embedContainer = container.createDiv({ cls: "orca-chat-embed" });

		// Fire-and-forget: see original rationale — the pane must render regardless of whether the
		// paired remote is reachable yet.
		void this.initializeRemote();

		this.registerInterval(window.setInterval(() => void this.populateSessions(), 3000));
	}

	async onClose(): Promise<void> {
		this.teardownWebview();
		this.remoteClient?.disconnect();
	}

	private async initializeRemote(): Promise<void> {
		this.credential = await loadPairedCredential(this.plugin).catch((err: unknown) => {
			this.reportError(err);
			return null;
		});
		if (this.credential) {
			this.remoteClient = new OrcaRemoteClient();
			try {
				await this.remoteClient.connect(this.credential);
				this.hasRemote = true;
			} catch (err) {
				this.reportError(err);
				this.remoteClient = null;
				this.hasRemote = false;
			}
		}
		await this.populateSessions();
	}

	// Kept as the "is anything selected" check main.ts's annotate flow relies on.
	getSelectedHandle(): string | null {
		return this.dropdown?.getValue() || null;
	}

	private getSelectedEntry(): StructuredSessionTab | null {
		const sessionId = this.getSelectedHandle();
		if (!sessionId) return null;
		return this.entries.find((e) => e.sessionId === sessionId) ?? null;
	}

	focusPicker(): void {
		this.dropdown?.selectEl.focus();
	}

	// Kept for main.ts's annotate flow (sends "${selection}\n\n${question}" into the currently
	// selected session) — the embedded webview owns rendering/composing, but this out-of-band
	// send still goes through the plugin's own RPC client, same as before.
	async sendToSelected(text: string): Promise<boolean> {
		const entry = this.getSelectedEntry();
		if (!entry) {
			new Notice("Pick a session in the Orca Chat pane first");
			return false;
		}
		if (!this.remoteClient) {
			this.reportError(new OrcaRemoteError("Not connected to Orca"));
			return false;
		}
		try {
			await this.remoteClient.sendAgentSessionMessage(entry.sessionId, text);
			return true;
		} catch (err) {
			this.reportError(err);
			return false;
		}
	}

	private async populateSessions(): Promise<void> {
		const previousSessionId = this.getSelectedHandle();

		let structuredTabs: StructuredSessionTab[] = this.entries;
		if (this.hasRemote && this.remoteClient) {
			try {
				structuredTabs = await this.remoteClient.listAllAgentSessionTabs();
			} catch (err) {
				this.reportError(err);
			}
		}
		this.entries = structuredTabs;

		this.dropdown.selectEl.empty();
		const stillExists = this.entries.some((e) => e.sessionId === previousSessionId);
		if (!stillExists) {
			this.dropdown.addOption(NO_SESSION_VALUE, "— pick a session —");
			if (previousSessionId) new Notice("Orca Chat: previous session ended — pick another");
		}
		for (const entry of this.entries) {
			this.dropdown.addOption(entry.sessionId, `${entry.agent} — ${entry.title}`);
		}
		if (stillExists && previousSessionId) this.dropdown.setValue(previousSessionId);

		// dropdown.setValue() above doesn't fire the change event, so re-check embed state
		// explicitly (handles a session ending / selection resetting to none).
		this.updateEmbed();
	}

	// Mounts (or re-mounts) the <webview> for the currently selected session. Always tears down
	// and recreates rather than reusing/navigating an existing webview — Orca's single-session
	// entry point has no "switch session" affordance, and recreating is simpler than teaching it
	// one. A no-op if the selection hasn't actually changed since the last mount.
	private updateEmbed(): void {
		const entry = this.getSelectedEntry();

		if (!entry) {
			this.teardownWebview();
			this.statusLabel.setText("No session selected");
			return;
		}
		if (!this.credential) {
			this.teardownWebview();
			this.statusLabel.setText("Not paired with Orca — see the Pair with Orca command");
			return;
		}
		if (this.currentWebview?.dataset.orcaSessionId === entry.sessionId) {
			return;
		}

		this.teardownWebview();
		const url = buildSingleSessionEmbedUrl(this.credential, entry.sessionId, entry.agent);
		const webview = this.embedContainer.createEl("webview" as keyof HTMLElementTagNameMap) as HTMLElement;
		webview.setAttribute("src", url);
		// No `persist:` prefix: this partition is memory-only, so Electron never writes the
		// pairing token in this URL to disk. A fresh, unique name per mount also guarantees no
		// state (cookies, storage) survives across session switches or reopens.
		webview.setAttribute("partition", `orca-embed-${entry.sessionId}-${Date.now()}`);
		webview.dataset.orcaSessionId = entry.sessionId;
		webview.addClass("orca-chat-webview");
		this.currentWebview = webview;
		this.statusLabel.setText("● Live chat");
	}

	private teardownWebview(): void {
		this.currentWebview?.remove();
		this.currentWebview = null;
		this.embedContainer?.empty();
	}

	private reportError(err: unknown): void {
		if (err instanceof OrcaRemoteError || err instanceof OrcaPairingError) {
			new Notice(err.message);
		} else {
			new Notice("Orca Chat: unexpected error, see console");
			console.error(err);
		}
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/chat-view.test.ts`
Expected: PASS.

Also run the full unit suite to catch anything else importing removed exports (`renderAgentJournalItem`, `mergeJournalItems`, etc. were module-private in the original file, not exported, so nothing external should break — confirm with a repo-wide grep):

Run: `grep -rn "renderAgentJournalItem\|mergeJournalItems\|renderPromptItem" src/ --include="*.ts" | grep -v chat-view`
Expected: no output (confirms nothing outside `chat-view.ts` referenced these).

Run: `npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/chat-view.ts src/chat-view.test.ts
git commit -m "feat: embed Orca's single-session UI via webview instead of hand-built renderer"
```

---

### Task 3: Add `<webview>` styling and confirm `styles.css` / manifest need no other change

**Files:**
- Modify: `styles.css` (or wherever `orca-chat-*` classes are currently styled — locate via `grep -rn "orca-chat-output\|orca-chat-message" .` from repo root; add alongside)

**Interfaces:**
- Consumes: `.orca-chat-embed` and `.orca-chat-webview` class names set in Task 2's `chat-view.ts`.
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Locate the existing stylesheet**

Run: `grep -rln "orca-chat-output" --include="*.css" .`

Read the file that matches (likely `styles.css` at repo root, Obsidian's plugin convention) to see how `.orca-chat-view`, `.orca-chat-output`, `.orca-chat-input-row` etc. are currently styled (flex layout, height rules).

- [ ] **Step 2: Add embed styling, removing now-dead selectors**

In that stylesheet:
- Remove any rules solely for now-deleted classes: `.orca-chat-output`, `.orca-chat-message*`, `.orca-chat-input-row`, `.orca-chat-prompt*` (check each still-present rule against the new `chat-view.ts` — anything not in `{orca-chat-view, orca-chat-header-row, orca-chat-session-select, orca-chat-status-label, orca-chat-embed, orca-chat-webview}` is dead).
- Add:

```css
.orca-chat-embed {
	flex: 1;
	display: flex;
	min-height: 0;
}

.orca-chat-webview {
	flex: 1;
	width: 100%;
	height: 100%;
	border: none;
}
```

(If `.orca-chat-view` is not already a flex column making `.orca-chat-embed` fill remaining height, add `display: flex; flex-direction: column; height: 100%;` to `.orca-chat-view` too — check the existing rule before assuming.)

- [ ] **Step 3: Manual visual check**

Run: `npm run build`
Expected: builds cleanly with no TypeScript errors (confirms Task 2's `chat-view.ts` compiles under this repo's `tsconfig.json` — `strict: true`, `noImplicitAny: true` — in particular that `createEl("webview" as keyof HTMLElementTagNameMap)` and `webview.setAttribute(...)` type-check; if `createEl`'s generic complains, cast the created element `as unknown as HTMLElement` instead at that call site).

- [ ] **Step 4: Commit**

```bash
git add styles.css
git commit -m "style: layout the embedded webview, drop dead chat-bubble CSS"
```
