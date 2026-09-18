import { shell } from "electron";
import { DropdownComponent, ItemView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { buildSingleSessionEmbedUrl } from "./embed-url";
import { loadPairedCredential, OrcaPairingError, type PairedCredential } from "./orca-pairing";
import { OrcaRemoteClient, OrcaRemoteError, type StructuredSessionTab } from "./orca-remote-client";

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
		// Electron only honors `<webview partition>` if it's present before the element is attached
		// to the DOM — set attributes on a detached element first, then append, rather than using
		// createEl (which attaches immediately).
		const webview = document.createElement("webview") as unknown as HTMLElement;
		webview.setAttribute("src", url);
		// No `persist:` prefix: this partition is memory-only, so Electron never writes the
		// pairing token in this URL to disk. A fresh, unique name per mount also guarantees no
		// state (cookies, storage) survives across session switches or reopens.
		webview.setAttribute("partition", `orca-embed-${entry.sessionId}-${Date.now()}`);
		webview.dataset.orcaSessionId = entry.sessionId;
		webview.addClass("orca-chat-webview");
		interceptObsidianLinks(webview);
		this.embedContainer.appendChild(webview);
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
