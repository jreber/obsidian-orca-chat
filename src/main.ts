import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { addChatGuidelinesToVault } from "./agents-guidance";
import { AnnotateModal } from "./annotate-modal";
import { buildAnnotateMessage, buildObsidianOpenUri, formatLocation, lineRangeFromEditorCursors, readingModeLineRange, sectionInfoToLineTag } from "./annotate-location";
import { buildFlashcardAskMessage, FlashcardContext, isReviewModalOpen, resolveCurrentFlashcard } from "./flashcard-context";
import { ORCA_CHAT_VIEW_TYPE, OrcaChatView, reloadChatViewCredentials } from "./chat-view";
import { PairingModal } from "./pairing-modal";
import { getVaultRootPath } from "./vault-path";

const ORCA_LINE_TAG_ATTR = "orcaLine";

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
			name: "Ask Orca about this",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "H" }],
			// Plain callback, not editorCallback: editorCallback only fires when
			// workspace.activeEditor is set, which Reading Mode never does (there is no CodeMirror
			// instance behind rendered markdown). Resolving the selection by hand lets one command
			// work in both Edit and Reading mode.
			//
			// Branches on flashcard-review context first: if a spaced-repetition review modal is
			// open, that's always stronger intent than a leftover text selection in a background
			// editor, so it wins unconditionally rather than checking selection first.
			callback: () => {
				if (isReviewModalOpen(document)) {
					const card = resolveCurrentFlashcard(this.app);
					if (!card) {
						new Notice("Couldn't read the current flashcard — the Spaced Repetition plugin may have changed");
						return;
					}
					void this.runFlashcardAsk(card);
					return;
				}
				const resolved = this.resolveSelectionWithLocation();
				if (!resolved) {
					new Notice("Select text first");
					return;
				}
				void this.runAnnotate(resolved.text, resolved.location, resolved.filePath);
			},
		});

		// Tags every top-level rendered block with its source line range (as a data attribute) so
		// Reading Mode annotate can recover line numbers from a plain DOM Selection, the same as
		// Edit Mode gets for free from the editor's cursor positions. Reading Mode has no CodeMirror
		// instance to ask, but MarkdownPostProcessorContext.getSectionInfo is public API for exactly
		// this block-to-source-line mapping.
		this.registerMarkdownPostProcessor((el, ctx) => {
			for (const child of Array.from(el.children)) {
				const info = ctx.getSectionInfo(child as HTMLElement);
				if (info) (child as HTMLElement).dataset[ORCA_LINE_TAG_ATTR] = sectionInfoToLineTag(info.lineStart, info.lineEnd);
			}
		});

		this.addCommand({
			id: "pair-with-orca",
			name: "Pair with Orca",
			// Open panes read the pairing when they open; after a (re-)pair, have them read it again.
			callback: () => new PairingModal(this.app, this, () => reloadChatViewCredentials(this.app.workspace)).open(),
		});

		this.addCommand({
			id: "add-chat-guidelines",
			name: "Add chat guidelines to AGENTS.md",
			callback: () => void this.addChatGuidelines(),
		});
	}

	// Writes the chat guidelines block into AGENTS.md at the vault root (see agents-guidance.ts).
	private async addChatGuidelines(): Promise<void> {
		if (!getVaultRootPath(this.app)) {
			new Notice("Orca Chat needs desktop Obsidian");
			return;
		}
		try {
			new Notice(await addChatGuidelinesToVault(this.app.vault.adapter), 10_000);
		} catch (err) {
			new Notice("Orca Chat: couldn't update AGENTS.md, see console");
			console.error("[orca-chat] couldn't add the chat guidelines to AGENTS.md", err);
		}
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

	private resolveSelectionWithLocation(): { text: string; filePath: string | null; location: string | null } | null {
		const activeEditor = this.app.workspace.activeEditor;
		if (activeEditor?.editor) {
			const text = activeEditor.editor.getSelection();
			if (!text) return null;
			const from = activeEditor.editor.getCursor("from");
			const to = activeEditor.editor.getCursor("to");
			const filePath = activeEditor.file?.path ?? null;
			const location = formatLocation(filePath, lineRangeFromEditorCursors(from.line, to.line));
			return { text, filePath, location };
		}

		// Reading Mode: no editor, but the rendered markdown is still a normal DOM selection. Line
		// numbers come from the data attributes the markdown post-processor above stamped onto each
		// rendered block.
		const selection = window.getSelection();
		const text = selection?.toString().trim() ?? "";
		if (!text || !selection || selection.rangeCount === 0) return null;
		const range = selection.getRangeAt(0);
		const filePath = this.app.workspace.getActiveFile()?.path ?? null;
		const location = formatLocation(
			filePath,
			readingModeLineRange(this.nearestLineTag(range.startContainer), this.nearestLineTag(range.endContainer)),
		);
		return { text, filePath, location };
	}

	private nearestLineTag(node: Node): string | undefined {
		const el = node instanceof Element ? node : node.parentElement;
		return (el?.closest("[data-orca-line]") as HTMLElement | null)?.dataset[ORCA_LINE_TAG_ATTR];
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

	private async ensureChatViewReady(): Promise<OrcaChatView | null> {
		let chatView = await this.getChatView();
		if (!chatView) {
			const leaf = await this.activateChatView();
			chatView = await this.resolveChatView(leaf);
			if (!chatView) {
				new Notice("Orca Chat: could not open the chat pane");
				return null;
			}
		}
		if (!chatView.getSelectedHandle()) {
			chatView.focusNewSessionButton();
		}
		return chatView;
	}

	private async runAnnotate(selection: string, location: string | null, filePath: string | null): Promise<void> {
		const view = await this.ensureChatViewReady();
		if (!view) return;
		const citationUri = filePath ? buildObsidianOpenUri(this.app.vault.getName(), filePath) : null;
		new AnnotateModal(this.app, async (question) => {
			return view.sendToSelected(buildAnnotateMessage(selection, question, location, citationUri));
		}).open();
	}

	private async runFlashcardAsk(card: FlashcardContext): Promise<void> {
		const view = await this.ensureChatViewReady();
		if (!view) return;
		new AnnotateModal(
			this.app,
			async (question) => view.sendToSelected(buildFlashcardAskMessage(card.front, card.back, card.sourceLink, question)),
			"Ask Orca about this flashcard",
		).open();
	}
}
