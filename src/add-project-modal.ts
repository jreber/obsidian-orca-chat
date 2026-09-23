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
	onClose(): void {
		this.contentEl.empty();
		this.finish(false);
	}
	private finish(ok: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.done(ok);
		this.close();
	}
}

export function confirmAddVaultProject(app: App, vaultName: string, vaultPath: string): Promise<boolean> {
	return new Promise((resolve) => new AddProjectModal(app, vaultName, vaultPath, resolve).open());
}
