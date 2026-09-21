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
