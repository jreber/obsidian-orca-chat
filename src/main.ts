import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { AnnotateModal } from "./annotate-modal";
import { ORCA_CHAT_VIEW_TYPE, OrcaChatView } from "./chat-view";
import { PairingModal } from "./pairing-modal";

export default class OrcaChatPlugin extends Plugin {
	async onload() {
		this.registerView(ORCA_CHAT_VIEW_TYPE, (leaf) => new OrcaChatView(leaf, this));

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

		this.addCommand({
			id: "pair-with-orca",
			name: "Pair with Orca",
			callback: () => new PairingModal(this.app, this).open(),
		});
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(ORCA_CHAT_VIEW_TYPE);
	}

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

	private async resolveChatView(leaf: WorkspaceLeaf): Promise<OrcaChatView | null> {
		if (leaf.isDeferred) await leaf.loadIfDeferred();
		return leaf.view instanceof OrcaChatView ? leaf.view : null;
	}

	private async getChatView(): Promise<OrcaChatView | null> {
		const leaves = this.app.workspace.getLeavesOfType(ORCA_CHAT_VIEW_TYPE);
		if (leaves.length === 0) return null;
		return this.resolveChatView(leaves[0]);
	}

	private async runAnnotate(selection: string): Promise<void> {
		let chatView = await this.getChatView();
		if (!chatView) {
			const leaf = await this.activateChatView();
			chatView = await this.resolveChatView(leaf);
			if (!chatView) {
				new Notice("Orca Chat: could not open the chat pane");
				return;
			}
		}
		if (!chatView.getSelectedHandle()) {
			chatView.focusPicker();
		}
		const view = chatView;
		new AnnotateModal(this.app, async (question) => {
			return view.sendToSelected(`${selection}\n\n${question}`);
		}).open();
	}
}
