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
		const submit = () => {
			if (submitting) return;
			const question = input.value.trim();
			if (!question) return;
			submitting = true;
			// Close immediately: the send is a network round-trip, and waiting for
			// it here just makes the modal feel laggy. sendToSelected/reportError
			// already surface delivery failures via Notice.
			void this.onSubmit(question);
			this.close();
		};

		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") submit();
		});
		sendButton.onclick = () => submit();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
