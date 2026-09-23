import { shell } from "electron";
import { ItemView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { confirmAddVaultProject } from "./add-project-modal";
import { buildSingleSessionEmbedUrl } from "./embed-url";
import {
	createVaultSession,
	NewSessionCancelled,
	NewSessionError,
	newSessionFailureMessage,
	type NewSessionClient,
} from "./new-session";
import {
	compareAndSaveLastSessionId,
	loadLastSessionId,
	loadPairedCredential,
	OrcaPairingError,
	saveLastSessionId,
	saveLastSessionIdIf,
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

// Status texts stay short: the label ellipsizes past ~25 characters at the default sidebar width.
const NO_SESSION_STATUS = "No session yet";
const NOT_PAIRED_STATUS = "Not paired with Orca";
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
	// Load state of currentWebview, so a status can be derived from it (see currentStatus).
	private embedLoadState: "loading" | "loaded" | "failed" = "loading";
	private busy = false;
	// Bumped when the pane's session state is replaced out from under in-flight async work: a New
	// session committing, or the pane closing. Restores, existence checks and creates capture it
	// when they start and drop their results (mount, stored-id write, Notice) if it has changed.
	private generation = 0;
	// Stored-id writes are serialized (saveLastSessionId is a read-modify-write) and each is dropped
	// if its generation went stale while it waited, so a late clear can't overwrite a newer id.
	private storedIdWrites: Promise<void> = Promise.resolve();
	// The last restore couldn't reach Orca, so whether the stored session is still live is unknown.
	// The liveness tick and the next New session click try the restore again; cleared once a restore
	// gets an answer or a session is mounted.
	private restorePending = false;

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
		this.generation++;
		this.teardownWebview();
		this.remoteClient?.disconnect();
		this.remoteClient = null;
		this.credential = null;
		this.currentSessionId = null;
		this.restorePending = false;
	}

	private async initializeRemote(): Promise<void> {
		const gen = this.generation;
		const credential = await loadPairedCredential(this.plugin).catch((err: unknown) => {
			this.reportError(err);
			return null;
		});
		if (gen !== this.generation) return;
		this.credential = credential;
		if (credential) {
			const client = new OrcaRemoteClient();
			try {
				await client.connect(credential);
				if (gen !== this.generation) {
					client.disconnect();
					return;
				}
				this.remoteClient = client;
			} catch (err) {
				if (gen !== this.generation) return;
				this.reportError(err);
			}
		}
		await this.restoreLastSession();
	}

	// Public for tests. Reattaches to the vault's last session if Orca still has it. A retry (the
	// liveness tick, or a New session click) doesn't repeat the "can't reach Orca" Notice; nor is
	// "previous session ended" announced while a New session is underway.
	async restoreLastSession(retry = false): Promise<void> {
		const gen = this.generation;
		const id = await this.readStoredSessionId();
		if (gen !== this.generation) return;
		if (!id) {
			this.restorePending = false;
			if (!this.currentSessionId) this.statusLabel.setText(NO_SESSION_STATUS);
			return;
		}
		if (!this.remoteClient) {
			// Unpaired or unreachable: keep the stored id so a later open can reattach.
			this.statusLabel.setText(this.credential ? "Can't reach Orca" : NOT_PAIRED_STATUS);
			return;
		}
		let tabs: StructuredSessionTab[];
		try {
			tabs = await this.remoteClient.listAllAgentSessionTabs();
		} catch (err) {
			if (gen !== this.generation || this.currentSessionId) return;
			// Keep the stored id, and try again later.
			this.restorePending = true;
			if (!retry) this.reportError(err, (message) => `Orca Chat: ${message}`);
			this.statusLabel.setText("Can't reach Orca");
			return;
		}
		// A New session that finished (or the pane closing) while the list was in flight wins.
		if (gen !== this.generation || this.currentSessionId) return;
		this.restorePending = false;
		const tab = tabs.find((t) => t.sessionId === id);
		if (tab) {
			this.mountSession(id, tab.agent);
			return;
		}
		await this.clearStoredSessionIdIf(id, gen);
		if (gen !== this.generation || this.currentSessionId) return;
		if (!this.busy) new Notice("Orca Chat: previous session ended — click New session");
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
			// Paired but no client: only while the pane is still initializing (connect can't fail).
			new Notice("Orca Chat: can't reach Orca — is it running?");
			return;
		}
		this.busy = true;
		this.newSessionButton.disabled = true;
		// The generation this click's results belong to; advanced when the new session commits.
		let gen = this.generation;
		try {
			// Orca was unreachable when the pane last tried to reattach: if the stored session turns
			// out to be live, reattach it rather than create another and lose track of it.
			if (this.restorePending) {
				await this.restoreLastSession(true);
				if (gen !== this.generation) return;
				if (this.currentSessionId) {
					new Notice("Orca Chat: reattached your previous session");
					return;
				}
			}
			// The stored id at click time: a session created after the pane closed is kept only if
			// nothing newer has been stored since.
			const storedAtClick = await this.readStoredSessionId();
			const vaultName = app.vault.getName();
			const { sessionId } = await createVaultSession({
				client,
				vaultPath,
				vaultName,
				confirmAddProject: () => confirmAddVaultProject(app, vaultName, vaultPath),
				onCreating: () => {
					if (gen === this.generation) this.statusLabel.setText("Creating session…");
				},
			});
			if (gen !== this.generation) {
				// The pane closed meanwhile.
				await this.storeOrphanedSessionId(sessionId, storedAtClick);
				return;
			}
			gen = ++this.generation;
			let written: boolean;
			try {
				written = await this.writeStoredSessionId(sessionId, gen);
			} catch (err) {
				// Orca has the chat; only remembering it across a restart failed. Show it anyway.
				console.error("[orca-chat] couldn't store the new session id", err);
				if (gen !== this.generation) return;
				this.mountSession(sessionId, "claude");
				new Notice("Orca Chat: chat created, but this pane couldn't remember it after a restart");
				return;
			}
			if (gen !== this.generation) {
				if (!written) await this.storeOrphanedSessionId(sessionId, storedAtClick);
				return;
			}
			this.mountSession(sessionId, "claude");
		} catch (err) {
			if (gen !== this.generation) return;
			if (err instanceof NewSessionCancelled) {
				this.statusLabel.setText(this.currentStatus());
			} else {
				this.reportError(err, newSessionFailureMessage);
				this.statusLabel.setText("⚠ Session not created");
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
		const gen = this.generation;
		const sessionId = this.currentSessionId;
		if (!this.remoteClient) return;
		if (!sessionId) {
			// Nothing mounted: retry a restore that couldn't reach Orca (not while a New session runs,
			// which retries it itself).
			if (this.restorePending && !this.busy) await this.restoreLastSession(true);
			return;
		}
		let tabs: StructuredSessionTab[];
		try {
			tabs = await this.remoteClient.listAllAgentSessionTabs();
		} catch {
			return;
		}
		// The user may have created a different session (or closed the pane) while the list was
		// in flight.
		if (gen !== this.generation || this.currentSessionId !== sessionId) return;
		if (tabs.some((t) => t.sessionId === sessionId)) return;
		this.teardownWebview();
		this.currentSessionId = null;
		await this.clearStoredSessionIdIf(sessionId, gen);
		if (gen !== this.generation) return;
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
			this.statusLabel.setText(NOT_PAIRED_STATUS);
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
				if (this.currentWebview !== webview) return;
				this.embedLoadState = "loaded";
				this.statusLabel.setText(this.currentStatus());
			},
			onFailed: (reason) => {
				if (this.currentWebview !== webview) return;
				this.embedLoadState = "failed";
				this.statusLabel.setText(this.currentStatus());
				new Notice(`Orca Chat: couldn't load the chat from Orca — ${reason}`);
				// The URL carries the pairing token, so log the session and reason only.
				console.error(`[orca-chat] embed failed to load for session ${sessionId}: ${reason}`);
			},
		});
		this.embedContainer.appendChild(webview);
		this.currentWebview = webview;
		this.currentSessionId = sessionId;
		this.restorePending = false;
		this.embedLoadState = "loading";
		this.statusLabel.setText(this.currentStatus());
	}

	// The status for what is mounted right now.
	private currentStatus(): string {
		if (!this.currentWebview) return NO_SESSION_STATUS;
		if (this.embedLoadState === "loaded") return "● Live chat";
		if (this.embedLoadState === "failed") return "⚠ Chat failed to load";
		return "Connecting…";
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

	// Queued behind earlier writes; skipped if `gen` is no longer current when its turn comes.
	// Resolves to whether it wrote.
	private writeStoredSessionId(sessionId: string | null, gen: number): Promise<boolean> {
		const write = this.storedIdWrites.then(async () => {
			if (gen !== this.generation) return false;
			if (this.storedSessionOverride !== undefined) {
				this.storedSessionOverride = sessionId;
				return true;
			}
			await saveLastSessionId(this.plugin, sessionId);
			return true;
		});
		this.storedIdWrites = write.then(() => {}, () => {});
		return write;
	}

	// Clears the stored id only if it is still `deadId`, the one found gone: an id stored since (say,
	// a session a closed pane created late) is newer and stays. Queued like writeStoredSessionId.
	private clearStoredSessionIdIf(deadId: string, gen: number): Promise<boolean> {
		const write = this.storedIdWrites.then(async () => {
			if (gen !== this.generation) return false;
			if (this.storedSessionOverride !== undefined) {
				if (this.storedSessionOverride !== deadId) return false;
				this.storedSessionOverride = null;
				return true;
			}
			return compareAndSaveLastSessionId(this.plugin, deadId, null);
		});
		this.storedIdWrites = write.then(() => {}, () => {});
		return write;
	}

	// A session created after the pane closed exists in Orca but no pane shows it (a reopened pane is
	// a new view). Store it for the next open to restore if the stored id is still the one at click
	// time (`expected`) or was cleared since; a different id stored since is a newer session and
	// wins. Never mounts or Notices.
	private storeOrphanedSessionId(sessionId: string, expected: string | null): Promise<void> {
		const accept = (stored: string | null) => stored === expected || stored === null;
		const write = this.storedIdWrites.then(async () => {
			if (this.storedSessionOverride !== undefined) {
				if (accept(this.storedSessionOverride)) this.storedSessionOverride = sessionId;
				return;
			}
			try {
				await saveLastSessionIdIf(this.plugin, accept, sessionId);
			} catch (err) {
				console.error("[orca-chat] couldn't keep a session created after the pane closed", err);
			}
		});
		this.storedIdWrites = write.catch(() => {});
		return write;
	}

	// --- Test seams (unit tests only; not used by the plugin) ---
	// Injecting a client or credential supersedes the pane's own initializeRemote (still loading
	// the real credential in the background), exactly as closing the pane would.
	setClientForTest(client: ChatViewClient): void {
		this.generation++;
		this.remoteClient = client;
	}
	setCredentialForTest(credential: PairedCredential): void {
		this.generation++;
		this.credential = credential;
	}
	setStoredSessionIdForTest(sessionId: string | null): void {
		this.storedSessionOverride = sessionId;
	}
	getStoredSessionIdForTest(): string | null | undefined {
		return this.storedSessionOverride;
	}

	private reportError(err: unknown, describe: (message: string) => string = (message) => message): void {
		if (err instanceof OrcaRemoteError || err instanceof OrcaPairingError || err instanceof NewSessionError) {
			new Notice(describe(err.message));
		} else {
			new Notice("Orca Chat: unexpected error, see console");
			console.error(err);
		}
	}
}
