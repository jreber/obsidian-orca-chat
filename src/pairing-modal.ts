import { App, Modal, Notice, Plugin } from "obsidian";
import { decodePairingUrl, savePairedCredential } from "./orca-pairing";
import { versionLabel } from "./version";

const PAIRING_STEPS = [
	"In Orca, open Settings and find \"Remote server workflow\".",
	"Choose \"Share this host\".",
	"Under \"Where will this link be opened?\", pick \"This computer only\" (not Orca Mobile).",
	"Generate the link, then paste it below. Use only the newest link.",
];

export class PairingModal extends Modal {
	private plugin: Plugin;
	// Called after a successful pair, once the credential is saved (the plugin refreshes open panes).
	private onPaired?: () => void | Promise<void>;

	constructor(app: App, plugin: Plugin, onPaired?: () => void | Promise<void>) {
		super(app);
		this.plugin = plugin;
		this.onPaired = onPaired;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Pair with Orca" });
		// A mobile-scope pairing can't add the vault or list its workspaces, so New session fails;
		// these steps lead to the "This computer only" (runtime-scope) link it needs.
		const steps = contentEl.createEl("ol", { cls: "setting-item-description" });
		for (const step of PAIRING_STEPS) steps.createEl("li", { text: step });
		const input = contentEl.createEl("input", { type: "text", placeholder: "Paste Orca pairing URL…" });
		input.style.width = "100%";
		input.focus();

		const buttonRow = contentEl.createDiv();
		const pairButton = buttonRow.createEl("button", { text: "Pair", cls: "mod-cta" });
		// Which build is installed, for bug reports.
		contentEl.createDiv({ cls: "orca-chat-version", text: versionLabel() });

		let submitting = false;
		const submit = async () => {
			if (submitting) return;
			const url = input.value.trim();
			if (!url) return;
			submitting = true;
			pairButton.disabled = true;
			try {
				try {
					const credential = decodePairingUrl(url);
					await savePairedCredential(this.plugin, credential);
				} catch (err) {
					new Notice(err instanceof Error ? err.message : "Failed to pair with Orca");
					return;
				}
				new Notice("Paired with Orca");
				this.close();
				// The pairing is saved; only refreshing open panes can fail from here.
				try {
					await this.onPaired?.();
				} catch (err) {
					new Notice("Paired with Orca, but open Orca Chat panes couldn't refresh — reopen the pane.");
					// The error object only: never the pairing URL or credential.
					console.error("[orca-chat] couldn't refresh open panes after pairing", err);
				}
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
