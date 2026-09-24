import { App, Modal } from "obsidian";

class AddProjectModal extends Modal {
	private settled = false;
	constructor(app: App, private vaultName: string, private vaultPath: string, private done: (ok: boolean) => void) {
		super(app);
	}
	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Add this vault to Orca?" });
		contentEl.createEl("p", {
			text: `Orca Chat will add “${this.vaultName}” (${this.vaultPath}) to Orca as a project so chats can run in your vault. You'll only be asked once.`,
		});
		const row = contentEl.createDiv();
		const add = row.createEl("button", { text: "Add to Orca", cls: "mod-cta" });
		const cancel = row.createEl("button", { text: "Cancel" });
		add.onclick = () => this.finish(true);
		cancel.onclick = () => this.finish(false);
	}
	// Obsidian calls this for every close, including Escape and a click outside: an unanswered
	// prompt is a decline. It must not call close() itself (it is already inside close()).
	onClose(): void {
		this.contentEl.empty();
		this.settle(false);
	}
	private finish(ok: boolean): void {
		if (!this.settle(ok)) return;
		this.close();
	}
	// Reports the answer once; returns whether this call was the one that did.
	private settle(ok: boolean): boolean {
		if (this.settled) return false;
		this.settled = true;
		this.done(ok);
		return true;
	}
}

export function confirmAddVaultProject(app: App, vaultName: string, vaultPath: string): Promise<boolean> {
	return new Promise((resolve) => new AddProjectModal(app, vaultName, vaultPath, resolve).open());
}
