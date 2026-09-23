import { shell } from "electron";
import { ItemView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { confirmAddVaultProject } from "./add-project-modal";
import { buildSingleSessionEmbedUrl } from "./embed-url";
import { createVaultSession, NewSessionCancelled, NewSessionError, type NewSessionClient } from "./new-session";
import {
	loadLastSessionId,
	loadPairedCredential,
	OrcaPairingError,
	saveLastSessionId,
	type PairedCredential,
} from "./orca-pairing";
import { OrcaRemoteClient, OrcaRemoteError, type StructuredSessionTab } from "./orca-remote-client";
import { getVaultRootPath } from "./vault-path";

export const ORCA_CHAT_VIEW_TYPE = "orca-chat-view";

// The single-session embed's chat transcript cites vault files as real obsidian://open links
// (see annotate-location.ts's buildObsidianOpenUri) so they're both clickable and demonstrate the
// link format to the agent in-context.
//
// A target="_blank" click on an *unregistered custom scheme* never reaches Electron's webview
// "new-window"/popup machinery — verified empirically, Chromium silently drops the attempt before
// any host-level hook fires (an identical click on an https:// link does fire "new-window";
// obsidian:// produces nothing at all). So interception has to happen inside the guest's own click
// handling. Obsidian's will-attach-webview strips the guest's preload script, so there's no
// ipc-message channel, and a <webview> guest is a separate top-level browsing context (no
// window.parent), so there's no postMessage either. The one channel that survives both
// restrictions: `webview.executeJavaScript()` is a host-side <webview> API (unaffected by the
// guest's own sandbox) that injects a click listener into the guest, and the guest reports back by
// console.log-ing a marker string, which Electron proxies to the host as a "console-message" DOM
// event on the <webview> element — no preload needed on either side of that round trip.
const OBSIDIAN_LINK_CONSOLE_MARKER = "orca-chat:obsidian-link:";

function obsidianLinkInterceptorScript(marker: string): string {
	return `(function () {
		if (window.__orcaObsidianLinkInterceptorInstalled) return;
		window.__orcaObsidianLinkInterceptorInstalled = true;
		document.addEventListener("click", function (event) {
			var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
			if (!anchor) return;
			var href = anchor.getAttribute("href") || "";
			if (href.indexOf("obsidian://") !== 0) return;
			event.preventDefault();
			console.log(${JSON.stringify(marker)} + href);
		}, true);
	})();`;
}

export function interceptObsidianLinks(
	webview: HTMLElement & { executeJavaScript?: (code: string) => Promise<unknown> },
): void {
	webview.addEventListener("dom-ready", () => {
		void webview.executeJavaScript?.(obsidianLinkInterceptorScript(OBSIDIAN_LINK_CONSOLE_MARKER));
	});
	webview.addEventListener("console-message", ((event: Event) => {
		const message = (event as unknown as { message?: unknown }).message;
		if (typeof message !== "string" || !message.startsWith(OBSIDIAN_LINK_CONSOLE_MARKER)) return;
		void shell.openExternal(message.slice(OBSIDIAN_LINK_CONSOLE_MARKER.length));
	}) as EventListener);
}

// Chromium's "navigation aborted" code: a superseded or cancelled load, not a failure.
const ERR_ABORTED = -3;

// A <webview> whose page 404s still fires did-finish-load (Chromium renders the error body), so
// did-fail-load alone can't tell a missing page from a working one; the main frame's HTTP status
// from did-frame-navigate covers that case. Reports at most once per load; did-start-loading re-arms.
export function watchEmbedLoad(
	webview: HTMLElement,
	handlers: { onLoaded: () => void; onFailed: (reason: string) => void },
): void {
	let failed = false;
	const fail = (reason: string) => {
		if (failed) return;
		failed = true;
		handlers.onFailed(reason);
	};
	webview.addEventListener("did-start-loading", () => {
		failed = false;
	});
	webview.addEventListener("did-frame-navigate", ((event: Event) => {
		const { isMainFrame, httpResponseCode, httpStatusText } = event as unknown as {
			isMainFrame?: boolean;
			httpResponseCode?: number;
			httpStatusText?: string;
		};
		if (!isMainFrame || typeof httpResponseCode !== "number" || httpResponseCode < 400) return;
		fail(`HTTP ${httpResponseCode}${httpStatusText ? ` ${httpStatusText}` : ""}`);
	}) as EventListener);
	webview.addEventListener("did-fail-load", ((event: Event) => {
		const { isMainFrame, errorCode, errorDescription } = event as unknown as {
			isMainFrame?: boolean;
			errorCode?: number;
			errorDescription?: string;
		};
		if (!isMainFrame || errorCode === ERR_ABORTED) return;
		fail(`${errorDescription || "load failed"} (${errorCode})`);
	}) as EventListener);
	webview.addEventListener("did-finish-load", () => {
		if (!failed) handlers.onLoaded();
	});
}

const NO_SESSION_STATUS = "No session — click New session";
const SESSION_CHECK_INTERVAL_MS = 15_000;

// What the pane needs from the Orca RPC client: session creation (NewSessionClient) plus the
// liveness list, the out-of-band send, and disconnect. OrcaRemoteClient satisfies it structurally.
type ChatViewClient = NewSessionClient &
	Pick<OrcaRemoteClient, "listAllAgentSessionTabs" | "sendAgentSessionMessage" | "disconnect">;

export class OrcaChatView extends ItemView {
	private newSessionButton!: HTMLButtonElement;
	private statusLabel!: HTMLSpanElement;
	private embedContainer!: HTMLDivElement;
	private currentWebview: HTMLElement | null = null;
	private currentSessionId: string | null = null;
	private busy = false;

	private readonly plugin: Plugin;
	private credential: PairedCredential | null = null;
	private remoteClient: ChatViewClient | null = null;
	// Test seam: when not undefined, replaces plugin data as the stored last-session id.
	private storedSessionOverride: string | null | undefined = undefined;

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
		this.newSessionButton = headerRow.createEl("button", {
			text: "New session",
			cls: "mod-cta orca-chat-new-session",
		});
		this.newSessionButton.onclick = () => void this.onNewSession();

		this.statusLabel = headerRow.createEl("span", { cls: "orca-chat-status-label" });

		this.embedContainer = container.createDiv({ cls: "orca-chat-embed" });

		// Fire-and-forget: the pane must render regardless of whether the paired remote is
		// reachable yet.
		void this.initializeRemote();

		this.registerInterval(window.setInterval(() => void this.checkCurrentSession(), SESSION_CHECK_INTERVAL_MS));
	}

	async onClose(): Promise<void> {
		this.teardownWebview();
		this.remoteClient?.disconnect();
	}

	private async initializeRemote(): Promise<void> {
		const credential = await loadPairedCredential(this.plugin).catch((err: unknown) => {
			this.reportError(err);
			return null;
		});
		// Anything injected through the test seams while the credential was loading wins.
		if (this.remoteClient || this.credential) return;
		this.credential = credential;
		if (credential) {
			const client = new OrcaRemoteClient();
			try {
				await client.connect(credential);
				this.remoteClient = client;
			} catch (err) {
				this.reportError(err);
			}
		}
		await this.restoreLastSession();
	}

	// Public for tests. Reattaches to the vault's last session if Orca still has it.
	async restoreLastSession(): Promise<void> {
		const id = await this.readStoredSessionId();
		if (!id) {
			this.statusLabel.setText(NO_SESSION_STATUS);
			return;
		}
		if (!this.remoteClient) {
			// Unpaired or unreachable: keep the stored id so a later open can reattach.
			this.statusLabel.setText(this.credential ? "Can't reach Orca" : "Not paired with Orca — see the Pair with Orca command");
			return;
		}
		let tabs: StructuredSessionTab[];
		try {
			tabs = await this.remoteClient.listAllAgentSessionTabs();
		} catch (err) {
			this.reportError(err);
			this.statusLabel.setText("Can't reach Orca");
			return; // keep the stored id
		}
		// A New session click that finished while the list was in flight takes precedence.
		if (this.currentSessionId) return;
		const tab = tabs.find((t) => t.sessionId === id);
		if (tab) {
			this.mountSession(id, tab.agent);
			return;
		}
		await this.writeStoredSessionId(null);
		new Notice("Orca Chat: previous session ended — click New session");
		this.statusLabel.setText(NO_SESSION_STATUS);
	}

	// Public for tests (the button's onclick calls it).
	async onNewSession(): Promise<void> {
		if (this.busy) return;
		// plugin.app is the same App as ItemView#app (and is what the test fakes provide).
		const app = this.plugin.app;
		const vaultPath = getVaultRootPath(app);
		if (!vaultPath) {
			new Notice("Orca Chat needs desktop Obsidian");
			return;
		}
		if (!this.credential) {
			new Notice("Not paired with Orca — see the Pair with Orca command");
			return;
		}
		const client = this.remoteClient;
		if (!client) {
			// Paired, but the connection at open failed.
			new Notice("Orca Chat: can't reach Orca — is it running? Reopen the pane to retry");
			return;
		}
		this.busy = true;
		this.newSessionButton.disabled = true;
		const previousStatus = this.statusLabel.textContent ?? "";
		this.statusLabel.setText("Creating session…");
		try {
			const vaultName = app.vault.getName();
			const { sessionId } = await createVaultSession({
				client,
				vaultPath,
				vaultName,
				confirmAddProject: () => confirmAddVaultProject(app, vaultName, vaultPath),
			});
			await this.writeStoredSessionId(sessionId);
			this.mountSession(sessionId, "claude");
		} catch (err) {
			if (err instanceof NewSessionCancelled) {
				this.statusLabel.setText(this.currentSessionId ? previousStatus : NO_SESSION_STATUS);
			} else {
				this.reportError(err);
				this.statusLabel.setText("⚠ Couldn't create a session");
			}
		} finally {
			this.busy = false;
			this.newSessionButton.disabled = false;
		}
	}

	// Public for tests. Detects the current session being closed in Orca. A failed list is treated
	// as transient (Orca restarting, network blip) and ignored; only a successful list that no
	// longer contains the session tears it down.
	async checkCurrentSession(): Promise<void> {
		const sessionId = this.currentSessionId;
		if (!sessionId || !this.remoteClient) return;
		let tabs: StructuredSessionTab[];
		try {
			tabs = await this.remoteClient.listAllAgentSessionTabs();
		} catch {
			return;
		}
		// The user may have created a different session while the list was in flight.
		if (this.currentSessionId !== sessionId) return;
		if (tabs.some((t) => t.sessionId === sessionId)) return;
		this.teardownWebview();
		this.currentSessionId = null;
		await this.writeStoredSessionId(null);
		new Notice("Orca Chat: session ended — click New session");
		this.statusLabel.setText(NO_SESSION_STATUS);
	}

	// Kept as the "is anything selected" check main.ts's annotate flow relies on; returns the
	// current session id.
	getSelectedHandle(): string | null {
		return this.currentSessionId;
	}

	focusNewSessionButton(): void {
		this.newSessionButton?.focus();
	}

	// Kept for main.ts's annotate flow (sends "${selection}\n\n${question}" into the current
	// session) — the embedded webview owns rendering/composing, but this out-of-band send still
	// goes through the plugin's own RPC client.
	async sendToSelected(text: string): Promise<boolean> {
		const sessionId = this.currentSessionId;
		if (!sessionId) {
			new Notice("Click New session in the Orca Chat pane first");
			return false;
		}
		if (!this.remoteClient) {
			this.reportError(new OrcaRemoteError("Not connected to Orca"));
			return false;
		}
		try {
			await this.remoteClient.sendAgentSessionMessage(sessionId, text);
			return true;
		} catch (err) {
			this.reportError(err);
			return false;
		}
	}

	// Mounts the <webview> for a session. Always tears down and recreates rather than
	// reusing/navigating an existing webview — Orca's single-session entry point has no "switch
	// session" affordance, and recreating is simpler than teaching it one. A no-op if that session
	// is already mounted.
	private mountSession(sessionId: string, agent: string): void {
		if (!this.credential) {
			this.teardownWebview();
			this.currentSessionId = null;
			this.statusLabel.setText("Not paired with Orca — see the Pair with Orca command");
			return;
		}
		if (this.currentWebview?.dataset.orcaSessionId === sessionId) {
			this.currentSessionId = sessionId;
			return;
		}

		this.teardownWebview();
		const url = buildSingleSessionEmbedUrl(this.credential, sessionId, agent);
		// Electron only honors `<webview partition>` if it's present before the element is attached
		// to the DOM — set attributes on a detached element first, then append, rather than using
		// createEl (which attaches immediately).
		const webview = document.createElement("webview") as unknown as HTMLElement;
		webview.setAttribute("src", url);
		// No `persist:` prefix: this partition is memory-only, so Electron never writes the
		// pairing token in this URL to disk. A fresh, unique name per mount also guarantees no
		// state (cookies, storage) survives across session switches or reopens.
		webview.setAttribute("partition", `orca-embed-${sessionId}-${Date.now()}`);
		webview.dataset.orcaSessionId = sessionId;
		webview.addClass("orca-chat-webview");
		interceptObsidianLinks(webview);
		watchEmbedLoad(webview, {
			onLoaded: () => {
				if (this.currentWebview === webview) this.statusLabel.setText("● Live chat");
			},
			onFailed: (reason) => {
				if (this.currentWebview !== webview) return;
				this.statusLabel.setText("⚠ Chat failed to load");
				new Notice(`Orca Chat: couldn't load the chat from Orca — ${reason}`);
				// The URL carries the pairing token, so log the session and reason only.
				console.error(`[orca-chat] embed failed to load for session ${sessionId}: ${reason}`);
			},
		});
		this.embedContainer.appendChild(webview);
		this.currentWebview = webview;
		this.currentSessionId = sessionId;
		this.statusLabel.setText("Connecting…");
	}

	private teardownWebview(): void {
		this.currentWebview?.remove();
		this.currentWebview = null;
		this.embedContainer?.empty();
	}

	private async readStoredSessionId(): Promise<string | null> {
		if (this.storedSessionOverride !== undefined) return this.storedSessionOverride;
		return loadLastSessionId(this.plugin);
	}

	private async writeStoredSessionId(sessionId: string | null): Promise<void> {
		if (this.storedSessionOverride !== undefined) {
			this.storedSessionOverride = sessionId;
			return;
		}
		await saveLastSessionId(this.plugin, sessionId);
	}

	// --- Test seams (unit tests only; not used by the plugin) ---
	setClientForTest(client: ChatViewClient): void {
		this.remoteClient = client;
	}
	setCredentialForTest(credential: PairedCredential): void {
		this.credential = credential;
	}
	setStoredSessionIdForTest(sessionId: string | null): void {
		this.storedSessionOverride = sessionId;
	}
	getStoredSessionIdForTest(): string | null | undefined {
		return this.storedSessionOverride;
	}

	private reportError(err: unknown): void {
		if (err instanceof OrcaRemoteError || err instanceof OrcaPairingError || err instanceof NewSessionError) {
			new Notice(err.message);
		} else {
			new Notice("Orca Chat: unexpected error, see console");
			console.error(err);
		}
	}
}
