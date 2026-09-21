import { App, TFile } from "obsidian";

export function isReviewModalOpen(doc: Document): boolean {
	return doc.querySelector(".sr-modal-content") !== null;
}

export function extractCardFrontBack(card: unknown): { front: string; back: string } | null {
	if (card === null || typeof card !== "object") return null;
	const maybe = card as { front?: unknown; back?: unknown };
	if (typeof maybe.front !== "string" || typeof maybe.back !== "string") return null;
	return { front: maybe.front, back: maybe.back };
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
		const rawCard = srPlugin?.uiManager?.contentManager?.reviewSequencer?.currentCard;
		const card = extractCardFrontBack(rawCard);
		if (!card) return null;

		const storageInfo = (rawCard as { storageInfo?: { notePath?: unknown } }).storageInfo;
		const notePath = storageInfo?.notePath;
		let sourceLink: string | null = null;
		if (typeof notePath === "string") {
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
