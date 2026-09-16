import { DropdownComponent, ItemView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { scrapeToMessages } from "./chat-scrape";
import { listTerminals, readScreen, sendText, OrcaCommandError, OrcaUnreachableError, type OrcaTerminal } from "./orca-cli";
import { loadPairedCredential, OrcaPairingError, type PairedCredential } from "./orca-pairing";
import {
	OrcaRemoteClient,
	OrcaRemoteError,
	type NativeChatBlock,
	type NativeChatMessage,
	type NativeChatRole,
} from "./orca-remote-client";

export const ORCA_CHAT_VIEW_TYPE = "orca-chat-view";

const NO_SESSION_VALUE = "";
type RenderMode = "chat" | "raw";

const NATIVE_CHAT_ROLE_LABELS: Record<NativeChatRole, string> = {
	user: "You",
	assistant: "Agent",
	tool: "Tool",
	reasoning: "Thinking",
	system: "System",
};

// AgentSessionTab.agent is only 'claude' | 'codex'. OrcaTerminal.agentIdentity is Orca's much
// larger TuiAgent union (e.g. 'claude-agent-teams', 'openclaude', 'gemini', ...). Only an exact
// (case-insensitive) match on 'claude'/'codex' is treated as native-chat-capable — anything else
// falls back to the scrape heuristic rather than guessing ('openclaude' is NOT 'claude').
function normalizeAgentForNativeChat(agentIdentity: string): "claude" | "codex" | null {
	const id = agentIdentity.trim().toLowerCase();
	return id === "claude" || id === "codex" ? id : null;
}

// Minimal readable stringification of a native-chat block — this is a bonus data source on top
// of the scrape fallback, not a rich renderer.
function renderNativeChatBlock(block: NativeChatBlock): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "tool-call":
			return `[tool: ${block.name}(${JSON.stringify(block.input)})]`;
		case "tool-result":
			return `[tool result: ${block.output}]`;
		case "image-ref":
			return `[image${block.alt ? `: ${block.alt}` : ""}]`;
		case "subagent-group":
			return block.agents.map((a) => `[subagent ${a.label}: ${a.state}]`).join("\n");
	}
}

export class OrcaChatView extends ItemView {
	private dropdown!: DropdownComponent;
	private modeButton!: HTMLButtonElement;
	private statusLabel!: HTMLSpanElement;
	private outputContainer!: HTMLDivElement;
	private input!: HTMLInputElement;
	private hasWarnedThisPoll = false;
	private pollInFlight = false;
	private renderMode: RenderMode = "chat";
	private lastLines: string[] = [];
	private terminals: OrcaTerminal[] = [];

	private readonly plugin: Plugin;
	private credential: PairedCredential | null = null;
	private remoteClient: OrcaRemoteClient | null = null;
	private hasRemote = false;
	private nativeChatHandle: string | null = null;
	private nativeChatUnsubscribe: (() => void) | null = null;
	private nativeMessages: NativeChatMessage[] = [];
	private usingNativeChat = false;
	private statusReason = "Not connected";

	constructor(leaf: WorkspaceLeaf, plugin: Plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	private modeButtonLabel(): string {
		return this.renderMode === "chat" ? "Raw view" : "Chat view";
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
		this.dropdown.onChange(() => void this.ensureNativeChat());

		this.modeButton = headerRow.createEl("button", { text: this.modeButtonLabel() });
		this.modeButton.onclick = () => {
			this.renderMode = this.renderMode === "chat" ? "raw" : "chat";
			this.modeButton.setText(this.modeButtonLabel());
			void this.ensureNativeChat();
		};

		this.statusLabel = headerRow.createEl("span", { cls: "orca-chat-status-label" });

		this.outputContainer = container.createDiv({ cls: "orca-chat-output" });

		const inputRow = container.createDiv({ cls: "orca-chat-input-row" });
		this.input = inputRow.createEl("input", { type: "text", placeholder: "Message the selected session…" });
		const sendButton = inputRow.createEl("button", { text: "Send" });

		const send = () => void this.handleSend();
		sendButton.onclick = send;
		this.input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") send();
		});

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
		this.registerInterval(window.setInterval(() => void this.pollScreen(), 500));
	}

	async onClose(): Promise<void> {
		this.teardownNativeChat();
		this.remoteClient?.disconnect();
	}

	getSelectedHandle(): string | null {
		return this.dropdown?.getValue() || null;
	}

	focusPicker(): void {
		this.dropdown?.selectEl.focus();
	}

	async sendToSelected(text: string): Promise<boolean> {
		const handle = this.getSelectedHandle();
		if (!handle) {
			new Notice("Pick a session in the Orca Chat pane first");
			return false;
		}
		try {
			await sendText(handle, text);
			return true;
		} catch (err) {
			this.reportError(err);
			return false;
		}
	}

	private async populateSessions(): Promise<void> {
		const previousValue = this.getSelectedHandle();
		try {
			const terminals = await listTerminals();
			this.terminals = terminals;
			this.dropdown.selectEl.empty();
			const stillExists = terminals.some((t) => t.handle === previousValue);
			if (!stillExists) {
				this.dropdown.addOption(NO_SESSION_VALUE, "— pick a session —");
				if (previousValue) new Notice("Orca Chat: previous session ended — pick another");
			}
			for (const terminal of terminals) {
				this.dropdown.addOption(terminal.handle, `${terminal.agentIdentity} — ${terminal.title}`);
			}
			if (stillExists && previousValue) this.dropdown.setValue(previousValue);
		} catch (err) {
			this.reportError(err);
		}
		// dropdown.setValue() above doesn't fire the change event, so re-check native-chat state
		// explicitly (handles a session ending / selection resetting to none).
		await this.ensureNativeChat();
	}

	private async handleSend(): Promise<void> {
		const text = this.input.value;
		if (!text) return;
		if (await this.sendToSelected(text)) {
			this.input.value = "";
		}
	}

	private async pollScreen(): Promise<void> {
		if (this.pollInFlight) return;
		if (this.outputContainer.offsetParent === null) return;
		const handle = this.getSelectedHandle();
		if (!handle) return;
		this.pollInFlight = true;
		try {
			this.lastLines = await readScreen(handle);
			this.renderOutput();
			this.hasWarnedThisPoll = false;
		} catch (err) {
			if (!this.hasWarnedThisPoll) {
				this.reportError(err);
				this.hasWarnedThisPoll = true;
			}
		} finally {
			this.pollInFlight = false;
		}
	}

	private renderOutput(): void {
		this.outputContainer.empty();
		if (this.renderMode === "raw") {
			this.statusLabel.setText("Raw view (terminal screen)");
			return;
		}
		this.statusLabel.setText(this.usingNativeChat ? "● Live chat" : `○ Scrape fallback — ${this.statusReason}`);
		if (this.usingNativeChat) {
			for (const message of this.nativeMessages) {
				const bubble = this.outputContainer.createDiv({
					cls: `orca-chat-message orca-chat-message-${message.role}`,
				});
				bubble.createDiv({ cls: "orca-chat-message-role", text: NATIVE_CHAT_ROLE_LABELS[message.role] });
				bubble.createEl("pre", {
					cls: "orca-chat-message-body",
					text: message.blocks.map(renderNativeChatBlock).join("\n"),
				});
			}
			return;
		}
		// Approximate: same coarse scrape heuristic Orca's own Chat View falls
		// back to when it has no local transcript to read. Guesses turn
		// boundaries and roles from blank lines and prompt markers — it will
		// misclassify some content, especially on the currently-visible screen
		// alone (no full scrollback).
		const messages = scrapeToMessages(this.lastLines);
		for (const message of messages) {
			const bubble = this.outputContainer.createDiv({
				cls: `orca-chat-message orca-chat-message-${message.role}`,
			});
			bubble.createDiv({ cls: "orca-chat-message-role", text: message.role === "user" ? "You" : "Agent" });
			bubble.createEl("pre", { cls: "orca-chat-message-body", text: message.text });
		}
	}

	// Called on terminal-selection change and on mode toggle. Re-subscribes to native chat only
	// when the effective terminal actually changed (nativeChatHandle tracks what we last set up
	// for) — toggling chat/raw back and forth doesn't tear down and re-fetch every time.
	private async ensureNativeChat(): Promise<void> {
		if (this.renderMode !== "chat") {
			this.renderOutput();
			return;
		}
		if (!this.hasRemote) {
			this.statusReason = this.credential ? "not connected (see console)" : "not paired — run \"Pair with Orca\"";
			this.renderOutput();
			return;
		}
		const handle = this.getSelectedHandle();
		if (!handle) {
			this.statusReason = "no session selected";
			this.renderOutput();
			return;
		}
		if (handle === this.nativeChatHandle) {
			this.renderOutput();
			return;
		}
		this.teardownNativeChat();
		this.nativeChatHandle = handle;
		await this.trySetupNativeChat(handle);
		this.renderOutput();
	}

	private async trySetupNativeChat(handle: string): Promise<void> {
		const terminal = this.terminals.find((t) => t.handle === handle);
		if (!terminal || !this.remoteClient) {
			this.statusReason = "internal error: terminal/client missing";
			return;
		}
		const wantedAgent = normalizeAgentForNativeChat(terminal.agentIdentity);
		if (!wantedAgent) {
			this.statusReason = `agent "${terminal.agentIdentity}" has no native chat support`;
			console.debug(`Orca Chat: ${this.statusReason}`);
			return;
		}
		try {
			const tabs = await this.remoteClient.listAgentTabs(terminal.worktreePath);
			const matches = tabs.filter((t) => t.agent === wantedAgent);
			const tab = matches.find((t) => t.isActive) ?? matches[0];
			if (!tab) {
				this.statusReason = `no matching session tab for worktree "${terminal.worktreePath}" (found ${tabs.length} tab(s) total)`;
				console.debug(`Orca Chat: ${this.statusReason}`);
				return;
			}
			this.nativeMessages = await this.remoteClient.readNativeChat(tab.agent, tab.sessionId);
			this.usingNativeChat = true;
			this.nativeChatUnsubscribe = this.remoteClient.subscribeNativeChat(
				tab.agent,
				tab.sessionId,
				(messages, kind) => {
					this.nativeMessages = kind === "appended" ? [...this.nativeMessages, ...messages] : messages;
					this.renderOutput();
				},
				(err) => this.reportError(err),
			);
		} catch (err) {
			this.statusReason = err instanceof Error ? err.message : "unknown error";
			this.reportError(err);
		}
	}

	private teardownNativeChat(): void {
		this.nativeChatUnsubscribe?.();
		this.nativeChatUnsubscribe = null;
		this.nativeChatHandle = null;
		this.usingNativeChat = false;
		this.nativeMessages = [];
	}

	private reportError(err: unknown): void {
		if (
			err instanceof OrcaUnreachableError ||
			err instanceof OrcaCommandError ||
			err instanceof OrcaRemoteError ||
			err instanceof OrcaPairingError
		) {
			new Notice(err.message);
		} else {
			new Notice("Orca Chat: unexpected error, see console");
			console.error(err);
		}
	}
}
