import { App, Modal } from "obsidian";

export class AnnotateModal extends Modal {
	private onSubmit: (question: string) => Promise<boolean>;

	constructor(app: App, onSubmit: (question: string) => Promise<boolean>) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Ask Orca about this selection" });
		const input = contentEl.createEl("input", { type: "text", placeholder: "Your question…" });
		input.style.width = "100%";
		input.focus();

		const buttonRow = contentEl.createDiv();
		const sendButton = buttonRow.createEl("button", { text: "Send", cls: "mod-cta" });

		let submitting = false;
		const submit = async () => {
			if (submitting) return;
			const question = input.value.trim();
			if (!question) return;
			submitting = true;
			sendButton.disabled = true;
			await this.onSubmit(question);
			submitting = false;
			sendButton.disabled = false;
			this.close();
		};

		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") void submit();
		});
		sendButton.onclick = () => void submit();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
