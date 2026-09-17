import { DropdownComponent, ItemView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { loadPairedCredential, OrcaPairingError, type PairedCredential } from "./orca-pairing";
import {
	OrcaRemoteClient,
	OrcaRemoteError,
	type AgentJournalRenderItem,
	type NativeChatBlock,
	type NativeChatRole,
	type StructuredSessionTab,
} from "./orca-remote-client";

export const ORCA_CHAT_VIEW_TYPE = "orca-chat-view";

const NO_SESSION_VALUE = "";

const NATIVE_CHAT_ROLE_LABELS: Record<NativeChatRole, string> = {
	user: "You",
	assistant: "Agent",
	tool: "Tool",
	reasoning: "Thinking",
	system: "System",
};

// Minimal readable stringification of a chat block — not a rich renderer.
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

// Pulls out whatever looks like the "main" argument of a tool call (first string-valued field —
// file_path, command, pattern, query, ... all happen to be exactly that) so the always-visible
// summary line reads like "Read — /some/file" instead of a full JSON blob. The full input/output
// is never lost — renderOutput puts it behind a collapsible <details> — this is only about what's
// shown by default.
function summarizeToolInput(input: unknown): string {
	if (input && typeof input === "object") {
		for (const value of Object.values(input as Record<string, unknown>)) {
			if (typeof value === "string" && value.length > 0) {
				return value.length > 80 ? `${value.slice(0, 80)}…` : value;
			}
		}
	}
	return "";
}

// Same "minimal readable stringification" principle applied to the structured-session journal's
// item bodies. `role` is reused as the bubble CSS class, same as native chat messages. `summary`
// is always shown; `detail`, when present, goes behind a collapsible disclosure (renderOutput) —
// approval/question are handled separately by renderPromptItem (interactive), not here.
function renderAgentJournalItem(item: AgentJournalRenderItem): { role: NativeChatRole; label: string; summary: string; detail?: string } {
	const body = item.body;
	switch (body.kind) {
		case "message":
			return {
				role: body.role,
				label: NATIVE_CHAT_ROLE_LABELS[body.role],
				summary: body.blocks.map(renderNativeChatBlock).join("\n"),
			};
		case "tool-call": {
			const arg = summarizeToolInput(body.input);
			const output = body.output ? `${body.output.head}${body.output.truncated ? "…" : ""}` : "";
			return {
				role: "tool",
				label: "Tool",
				summary: `${body.name}${arg ? ` — ${arg}` : ""} (${body.state})`,
				detail: [JSON.stringify(body.input, null, 2), output].filter(Boolean).join("\n\n"),
			};
		}
		case "diff":
			return {
				role: "tool",
				label: "Diff",
				summary: body.path,
				detail: `${body.patch.head}${body.patch.truncated ? "…" : ""}`,
			};
		case "approval": {
			const options = body.options.map((o) => o.label).join(", ");
			return {
				role: "system",
				label: "Approval",
				summary: `${body.title}${body.detail ? `: ${body.detail}` : ""} [${body.resolution.state}]${
					options ? ` (options: ${options})` : ""
				}`,
			};
		}
		case "question": {
			const options = body.options.map((o) => o.label).join(", ");
			return {
				role: "system",
				label: "Question",
				summary: `${body.question}${options ? ` (options: ${options})` : ""} [${body.resolution.state}]`,
			};
		}
		case "status":
			return { role: "system", label: "Status", summary: body.text };
	}
}

// Batches carry only new/changed rows (merge by itemId, keep the higher revision) plus removed
// ids — not a full replacement list. snapshot/reset events, by contrast, ARE the full list and
// should replace outright (handled at the call site, not here).
// ponytail: sorts by `sequence` only, ignoring `observedAt`/`recovered` crash-reordering nuance
// documented on AgentJournalRenderItem — add if live testing shows recovered rows landing out of
// visual order.
function mergeJournalItems(
	existing: AgentJournalRenderItem[],
	incoming: AgentJournalRenderItem[],
	removedItemIds: readonly string[] = [],
): AgentJournalRenderItem[] {
	const byId = new Map(existing.map((item) => [item.itemId, item]));
	for (const id of removedItemIds) byId.delete(id);
	for (const item of incoming) {
		const prev = byId.get(item.itemId);
		if (!prev || item.revision >= prev.revision) byId.set(item.itemId, item);
	}
	return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

export class OrcaChatView extends ItemView {
	private dropdown!: DropdownComponent;
	private statusLabel!: HTMLSpanElement;
	private outputContainer!: HTMLDivElement;
	private input!: HTMLInputElement;
	private entries: StructuredSessionTab[] = [];

	private readonly plugin: Plugin;
	private credential: PairedCredential | null = null;
	private remoteClient: OrcaRemoteClient | null = null;
	private hasRemote = false;
	private structuredSessionId: string | null = null;
	private structuredUnsubscribe: (() => void) | null = null;
	private structuredItems: AgentJournalRenderItem[] = [];
	private structuredLive = false;
	private statusReason = "";

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
		this.dropdown.onChange(() => void this.ensureStructuredSession());

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

		// Fire-and-forget: pairing + the first structured-session fetch both go over the network
		// (fresh E2EE handshake, see orca-remote-client.ts) and can hang for the full request
		// timeout if the paired endpoint is unreachable (stale LAN IP after a network change, host
		// asleep, etc). Awaiting that here would make onOpen() itself hang, which Obsidian surfaces
		// as "nothing happened, click the command again" — the pane must render regardless of
		// whether the remote side ever answers.
		void this.initializeRemote();

		// Structured sessions refresh on every dropdown focus (above) and on open; the RPC client
		// opens a brand-new E2EE handshake per call with no persistent connection, so this
		// background refresh is intentionally slow (3s) rather than a tight poll — competing with
		// real traffic (sends, live subscriptions) caused "timed out waiting for the remote Orca
		// runtime" under load when this was tighter.
		this.registerInterval(window.setInterval(() => void this.populateSessions(), 3000));
	}

	async onClose(): Promise<void> {
		this.teardownStructuredSession();
		this.remoteClient?.disconnect();
	}

	// Split out of onOpen() so the pane's DOM never waits on the network — see the fire-and-forget
	// call site above.
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

		// dropdown.setValue() above doesn't fire the change event, so re-check structured-session
		// state explicitly (handles a session ending / selection resetting to none).
		await this.ensureStructuredSession();
	}

	// Clears immediately and unconditionally, like every standard chat client. Does NOT restore
	// the text on a reported failure: this transport opens a fresh socket per call with no
	// persistent connection, so a client-visible error does not reliably mean the message never
	// reached the host — restoring text here has produced exactly that contradiction (message
	// visibly delivered via the live subscription, but the compose box quietly got its text back
	// as if it hadn't been). sendToSelected still raises a Notice on real failures.
	private async handleSend(): Promise<void> {
		const text = this.input.value;
		if (!text) return;
		this.input.value = "";
		await this.sendToSelected(text);
	}

	private renderOutput(): void {
		this.outputContainer.empty();
		const entry = this.getSelectedEntry();

		if (!entry) {
			this.statusLabel.setText("No session selected");
			return;
		}

		this.statusLabel.setText(this.structuredLive ? "● Live chat" : `○ Structured chat unavailable — ${this.statusReason}`);
		// Adjacent-only dedup: collapses runs of the identical status text (e.g. repeated
		// "message:system:init" lines from multiple provider (re)starts in one session's real
		// history) without hiding a status that recurs after something else happened in between.
		let lastStatusText: string | null = null;
		for (const item of this.structuredItems) {
			if (item.body.kind === "approval" || item.body.kind === "question") {
				lastStatusText = null;
				this.renderPromptItem(item);
				continue;
			}
			if (item.body.kind === "status") {
				if (item.body.text === lastStatusText) continue;
				lastStatusText = item.body.text;
			} else {
				lastStatusText = null;
			}
			const { role, label, summary, detail } = renderAgentJournalItem(item);
			const bubble = this.outputContainer.createDiv({ cls: `orca-chat-message orca-chat-message-${role}` });
			bubble.createDiv({ cls: "orca-chat-message-role", text: label });
			bubble.createDiv({ cls: "orca-chat-message-body", text: summary });
			if (detail) {
				const details = bubble.createEl("details", { cls: "orca-chat-message-detail" });
				details.createEl("summary", { text: "Details" });
				details.createEl("pre", { cls: "orca-chat-message-body orca-chat-body-code", text: detail });
			}
		}
		this.scrollToBottom();
	}

	// Always jump to the newest message — every renderOutput() call is either a fresh send, a
	// pushed update, or a selection change, so "most recent" is what the user wants visible each
	// time. No "stick to bottom only if already near it" nuance (yet): add if scrolling up to read
	// history while new messages keep arriving turns out to fight the user.
	private scrollToBottom(): void {
		this.outputContainer.scrollTop = this.outputContainer.scrollHeight;
	}

	// Approval/question items are the one thing in the journal the user can act on — Orca's own
	// chat surfaces them as buttons, not text, so this renders them the same way instead of routing
	// through renderAgentJournalItem's plain-text summary. Only meaningful while a structured
	// session is selected (structuredSessionId is set), which is the only time this is called.
	private renderPromptItem(item: AgentJournalRenderItem): void {
		if (item.body.kind !== "approval" && item.body.kind !== "question") return;
		const body = item.body;
		const isApproval = body.kind === "approval";
		const bubble = this.outputContainer.createDiv({ cls: "orca-chat-message orca-chat-message-system orca-chat-prompt" });
		bubble.createDiv({ cls: "orca-chat-message-role", text: isApproval ? "Permission needed" : "Question" });
		const questionText = isApproval ? `${body.title}${body.detail ? `\n${body.detail}` : ""}` : body.question;
		bubble.createDiv({ cls: "orca-chat-message-body", text: questionText });

		if (body.resolution.state !== "pending") {
			const chosen = body.options.find((o) => o.id === body.resolution.selectedOptionId);
			bubble.createDiv({
				cls: "orca-chat-prompt-resolved",
				text:
					body.resolution.state === "resolved"
						? `✓ ${chosen?.label ?? body.resolution.selectedOptionId ?? "resolved"}`
						: "Cancelled",
			});
			return;
		}

		const sessionId = this.structuredSessionId;
		const buttonRow = bubble.createDiv({ cls: "orca-chat-prompt-options" });
		for (const option of body.options) {
			const button = buttonRow.createEl("button", { text: option.label, cls: "mod-cta" });
			button.onclick = () => {
				if (!this.remoteClient || !sessionId) return;
				for (const b of Array.from(buttonRow.querySelectorAll("button"))) b.disabled = true;
				this.remoteClient
					.respondToPrompt(sessionId, isApproval ? "approval" : "question", item.itemId, item.revision, option.id)
					.catch((err) => {
						this.reportError(err);
						for (const b of Array.from(buttonRow.querySelectorAll("button"))) b.disabled = false;
					});
			};
		}
	}

	// Called on selection change and on dropdown repopulation. Re-subscribes to the structured
	// session only when the effective selection actually changed (structuredSessionId tracks what
	// we last set up for).
	private async ensureStructuredSession(): Promise<void> {
		const entry = this.getSelectedEntry();
		if (!entry) {
			this.teardownStructuredSession();
			this.renderOutput();
			return;
		}
		if (!this.remoteClient) {
			// Can't happen per design (entries only exist when hasRemote), but don't crash.
			this.teardownStructuredSession();
			this.statusReason = "not connected (see console)";
			this.renderOutput();
			return;
		}
		if (entry.sessionId === this.structuredSessionId) {
			this.renderOutput();
			return;
		}
		this.teardownStructuredSession();
		this.structuredSessionId = entry.sessionId;
		await this.trySetupStructuredSession(entry.sessionId);
		this.renderOutput();
	}

	private async trySetupStructuredSession(sessionId: string): Promise<void> {
		if (!this.remoteClient) return;
		try {
			const result = await this.remoteClient.readAgentSessionHistory(sessionId);
			this.structuredItems = mergeJournalItems([], result.page.items);
			this.structuredLive = true;
			if (!result.ok) {
				this.statusReason = `session reset (${result.reset}) — showing latest known state`;
				console.debug(`Orca Chat: structured session ${sessionId} reset: ${result.reset}`);
			}
			this.structuredUnsubscribe = this.remoteClient.subscribeAgentSessionHistory(
				sessionId,
				(event) => {
					if (event.type === "snapshot" || event.type === "reset") {
						this.structuredItems = mergeJournalItems([], event.page.items);
					} else {
						this.structuredItems = mergeJournalItems(this.structuredItems, event.batch.items, event.batch.removedItemIds);
					}
					this.structuredLive = true;
					this.renderOutput();
				},
				(err) => this.reportError(err),
			);
		} catch (err) {
			this.structuredLive = false;
			this.statusReason = err instanceof Error ? err.message : "unknown error";
			this.reportError(err);
		}
	}

	private teardownStructuredSession(): void {
		this.structuredUnsubscribe?.();
		this.structuredUnsubscribe = null;
		this.structuredSessionId = null;
		this.structuredLive = false;
		this.structuredItems = [];
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
