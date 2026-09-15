import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { AnnotateModal } from "./annotate-modal";
import { ORCA_CHAT_VIEW_TYPE, OrcaChatView } from "./chat-view";

export default class OrcaChatPlugin extends Plugin {
	async onload() {
		this.registerView(ORCA_CHAT_VIEW_TYPE, (leaf) => new OrcaChatView(leaf));

		this.addCommand({
			id: "open-orca-chat",
			name: "Open Orca chat",
			callback: () => void this.activateChatView(),
		});

		this.addCommand({
			id: "annotate-selection-with-orca",
			name: "Annotate selection with Orca",
			editorCallback: (editor) => {
				const selection = editor.getSelection();
				if (!selection) {
					new Notice("Select text first");
					return;
				}
				void this.runAnnotate(selection);
			},
		});
	}

	onunload() {}

	async activateChatView(): Promise<WorkspaceLeaf> {
		const existing = this.app.workspace.getLeavesOfType(ORCA_CHAT_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return existing[0];
		}
		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: ORCA_CHAT_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
		return leaf;
	}

	private getChatView(): OrcaChatView | null {
		const leaves = this.app.workspace.getLeavesOfType(ORCA_CHAT_VIEW_TYPE);
		if (leaves.length === 0) return null;
		return leaves[0].view as OrcaChatView;
	}

	private async runAnnotate(selection: string): Promise<void> {
		let chatView = this.getChatView();
		if (!chatView) {
			const leaf = await this.activateChatView();
			chatView = leaf.view as OrcaChatView;
			chatView.focusPicker();
		}
		const view = chatView;
		new AnnotateModal(this.app, (question) => {
			void view.sendToSelected(`${selection}\n\n${question}`);
		}).open();
	}
}
