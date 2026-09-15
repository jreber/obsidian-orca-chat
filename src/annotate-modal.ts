import { App, Modal } from "obsidian";

export class AnnotateModal extends Modal {
	private onSubmit: (question: string) => void;

	constructor(app: App, onSubmit: (question: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Ask Orca about this selection" });
		const input = contentEl.createEl("input", { type: "text", placeholder: "Your question…" });
		input.style.width = "100%";
		input.focus();

		const submit = () => {
			const question = input.value.trim();
			if (!question) return;
			this.onSubmit(question);
			this.close();
		};

		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") submit();
		});

		const buttonRow = contentEl.createDiv();
		buttonRow.createEl("button", { text: "Send", cls: "mod-cta" }).onclick = submit;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
