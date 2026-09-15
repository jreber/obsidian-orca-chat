import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { listTerminals, readScreen, sendText, OrcaCommandError, OrcaUnreachableError } from "./orca-cli";

export const ORCA_CHAT_VIEW_TYPE = "orca-chat-view";

export class OrcaChatView extends ItemView {
	private select!: HTMLSelectElement;
	private output!: HTMLPreElement;
	private input!: HTMLInputElement;
	private pollHandle: number | null = null;
	private hasWarnedThisPoll = false;

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

		this.select = container.createEl("select", { cls: "orca-chat-session-select" });
		this.select.onfocus = () => void this.populateSessions();

		this.output = container.createEl("pre", { cls: "orca-chat-output" });

		const inputRow = container.createDiv({ cls: "orca-chat-input-row" });
		this.input = inputRow.createEl("input", { type: "text", placeholder: "Message the selected session…" });
		const sendButton = inputRow.createEl("button", { text: "Send" });

		const send = () => void this.handleSend();
		sendButton.onclick = send;
		this.input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") send();
		});

		await this.populateSessions();
		this.pollHandle = window.setInterval(() => void this.pollScreen(), 500);
	}

	async onClose(): Promise<void> {
		if (this.pollHandle !== null) {
			window.clearInterval(this.pollHandle);
			this.pollHandle = null;
		}
	}

	getSelectedHandle(): string | null {
		return this.select?.value || null;
	}

	focusPicker(): void {
		this.select?.focus();
	}

	async sendToSelected(text: string): Promise<void> {
		const handle = this.getSelectedHandle();
		if (!handle) {
			new Notice("Pick a session in the Orca Chat pane first");
			return;
		}
		try {
			await sendText(handle, text);
		} catch (err) {
			this.reportError(err);
		}
	}

	private async populateSessions(): Promise<void> {
		const previousValue = this.select.value;
		try {
			const terminals = await listTerminals();
			this.select.empty();
			for (const terminal of terminals) {
				const option = this.select.createEl("option", {
					value: terminal.handle,
					text: `${terminal.agentIdentity} — ${terminal.title}`,
				});
				if (terminal.handle === previousValue) option.selected = true;
			}
		} catch (err) {
			this.reportError(err);
		}
	}

	private async handleSend(): Promise<void> {
		const text = this.input.value;
		if (!text) return;
		const handle = this.getSelectedHandle();
		if (!handle) {
			new Notice("Pick a session first");
			return;
		}
		try {
			await sendText(handle, text);
			this.input.value = "";
		} catch (err) {
			this.reportError(err);
		}
	}

	private async pollScreen(): Promise<void> {
		if (this.output.offsetParent === null) return;
		const handle = this.getSelectedHandle();
		if (!handle) return;
		try {
			const lines = await readScreen(handle);
			this.output.textContent = lines.join("\n");
			this.hasWarnedThisPoll = false;
		} catch (err) {
			if (!this.hasWarnedThisPoll) {
				this.reportError(err);
				this.hasWarnedThisPoll = true;
			}
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
