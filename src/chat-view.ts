import { DropdownComponent, ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { scrapeToMessages } from "./chat-scrape";
import { listTerminals, readScreen, sendText, OrcaCommandError, OrcaUnreachableError } from "./orca-cli";

export const ORCA_CHAT_VIEW_TYPE = "orca-chat-view";

const NO_SESSION_VALUE = "";
type RenderMode = "chat" | "raw";

export class OrcaChatView extends ItemView {
	private dropdown!: DropdownComponent;
	private modeButton!: HTMLButtonElement;
	private outputContainer!: HTMLDivElement;
	private input!: HTMLInputElement;
	private hasWarnedThisPoll = false;
	private pollInFlight = false;
	private renderMode: RenderMode = "chat";
	private lastLines: string[] = [];

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
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

		this.modeButton = headerRow.createEl("button", { text: "Chat view" });
		this.modeButton.onclick = () => {
			this.renderMode = this.renderMode === "chat" ? "raw" : "chat";
			this.modeButton.setText(this.renderMode === "chat" ? "Chat view" : "Raw view");
			this.renderOutput();
		};

		this.outputContainer = container.createDiv({ cls: "orca-chat-output" });

		const inputRow = container.createDiv({ cls: "orca-chat-input-row" });
		this.input = inputRow.createEl("input", { type: "text", placeholder: "Message the selected session…" });
		const sendButton = inputRow.createEl("button", { text: "Send" });

		const send = () => void this.handleSend();
		sendButton.onclick = send;
		this.input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") send();
		});

		await this.populateSessions();
		this.registerInterval(window.setInterval(() => void this.pollScreen(), 500));
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
			this.outputContainer.createEl("pre", { text: this.lastLines.join("\n") });
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

	private reportError(err: unknown): void {
		if (err instanceof OrcaUnreachableError || err instanceof OrcaCommandError) {
			new Notice(err.message);
		} else {
			new Notice("Orca Chat: unexpected error, see console");
			console.error(err);
		}
	}
}
