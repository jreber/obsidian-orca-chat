import { App, Modal, Notice, Plugin } from "obsidian";
import { decodePairingUrl, savePairedCredential } from "./orca-pairing";

export class PairingModal extends Modal {
	private plugin: Plugin;

	constructor(app: App, plugin: Plugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Pair with Orca" });
		const input = contentEl.createEl("input", { type: "text", placeholder: "Paste Orca pairing URL…" });
		input.style.width = "100%";
		input.focus();

		const buttonRow = contentEl.createDiv();
		const pairButton = buttonRow.createEl("button", { text: "Pair", cls: "mod-cta" });

		let submitting = false;
		const submit = async () => {
			if (submitting) return;
			const url = input.value.trim();
			if (!url) return;
			submitting = true;
			pairButton.disabled = true;
			try {
				const credential = decodePairingUrl(url);
				await savePairedCredential(this.plugin, credential);
				new Notice("Paired with Orca");
				this.close();
			} catch (err) {
				new Notice(err instanceof Error ? err.message : "Failed to pair with Orca");
			} finally {
				submitting = false;
				pairButton.disabled = false;
			}
		};

		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") void submit();
		});
		pairButton.onclick = () => void submit();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
