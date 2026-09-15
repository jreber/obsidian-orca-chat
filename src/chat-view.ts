import { DropdownComponent, ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { listTerminals, readScreen, sendText, OrcaCommandError, OrcaUnreachableError } from "./orca-cli";

export const ORCA_CHAT_VIEW_TYPE = "orca-chat-view";

const NO_SESSION_VALUE = "";

export class OrcaChatView extends ItemView {
	private dropdown!: DropdownComponent;
	private output!: HTMLPreElement;
	private input!: HTMLInputElement;
	private hasWarnedThisPoll = false;
	private pollInFlight = false;

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

		this.dropdown = new DropdownComponent(container);
		this.dropdown.selectEl.addClass("orca-chat-session-select");
		this.dropdown.selectEl.onfocus = () => void this.populateSessions();

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
		if (this.output.offsetParent === null) return;
		const handle = this.getSelectedHandle();
		if (!handle) return;
		this.pollInFlight = true;
		try {
			const lines = await readScreen(handle);
			this.output.textContent = lines.join("\n");
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

	private reportError(err: unknown): void {
		if (err instanceof OrcaUnreachableError || err instanceof OrcaCommandError) {
			new Notice(err.message);
		} else {
			new Notice("Orca Chat: unexpected error, see console");
			console.error(err);
		}
	}
}
