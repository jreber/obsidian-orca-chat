import { App, TFile } from "obsidian";

export function isReviewModalOpen(doc: Document): boolean {
	return doc.querySelector(".sr-modal-content, .sr-tab-view-content") !== null;
}

export function extractCardFrontBack(card: unknown): { front: string; back: string } | null {
	if (card === null || typeof card !== "object") return null;
	const maybe = card as { front?: unknown; back?: unknown };
	if (typeof maybe.front !== "string" || typeof maybe.back !== "string") return null;
	return { front: maybe.front, back: maybe.back };
}

export function extractNotePath(card: unknown): string | null {
	if (card === null || typeof card !== "object") return null;
	const notePath = (card as { question?: { note?: { filePath?: unknown } } }).question?.note?.filePath;
	return typeof notePath === "string" ? notePath : null;
}

export function buildFlashcardAskMessage(
	front: string,
	back: string,
	sourceLink: string | null,
	question: string,
): string {
	const header = sourceLink ? `Flashcard from ${sourceLink}:` : "Flashcard:";
	return `${header}\nQ: ${front}\nA: ${back}\n\n${question}`;
}

export interface FlashcardContext {
	front: string;
	back: string;
	sourceLink: string | null;
}

interface SRPluginLike {
	uiManager?: {
		uiState?: unknown;
		contentManager?: {
			reviewSequencer?: {
				currentCard?: unknown;
			};
		};
	};
}

// Reaches into obsidian-spaced-repetition's live plugin instance to read the card currently
// under review. app.plugins is real at runtime but absent from Obsidian's public type
// declarations (undocumented API), hence the cast. Every property access below is optional-
// chained and the whole thing is wrapped in try/catch: a plugin update that restructures these
// internals should make this return null, never throw.
export function resolveCurrentFlashcard(app: App): FlashcardContext | null {
	try {
		const pluginsHost = app as unknown as { plugins: { plugins: Record<string, unknown> } };
		const srPlugin = pluginsHost.plugins.plugins["obsidian-spaced-repetition"] as SRPluginLike | undefined;

		// SR's reviewSequencer pre-positions on the first card as soon as a deck's queue loads,
		// before the user has chosen a deck or left the deck-list screen — so currentCard alone
		// isn't "a card is actually on screen." uiState 2/3 are SR's own CardFront/CardBack
		// states (verified against the installed plugin's setUIState call sites); anything else
		// (0 Closed, 1 DeckList, 4 EditModal) means no card is actually being shown right now.
		const uiState = srPlugin?.uiManager?.uiState;
		if (uiState !== 2 && uiState !== 3) return null;

		const rawCard = srPlugin?.uiManager?.contentManager?.reviewSequencer?.currentCard;
		const card = extractCardFrontBack(rawCard);
		if (!card) return null;

		// Card.storageInfo is always null in the installed plugin (verified: the one place a
		// Card is constructed never sets it) — the note path instead comes through the card's
		// back-link to its source Question and that Question's Note, which SR's own "jump to
		// card" feature uses the same way.
		const notePath = extractNotePath(rawCard);
		let sourceLink: string | null = null;
		if (notePath) {
			const file = app.vault.getAbstractFileByPath(notePath);
			if (file instanceof TFile) {
				const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
				if (typeof frontmatter?.source === "string") sourceLink = frontmatter.source;
			}
		}
		return { front: card.front, back: card.back, sourceLink };
	} catch {
		return null;
	}
}
