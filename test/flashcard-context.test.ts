import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { isReviewModalOpen, extractCardFrontBack, buildFlashcardAskMessage } from "../src/flashcard-context.ts";

test("isReviewModalOpen returns true when the SR modal's content element is present", () => {
	const dom = new JSDOM('<!doctype html><html><body><div class="sr-modal-content"></div></body></html>');
	assert.equal(isReviewModalOpen(dom.window.document), true);
});

test("isReviewModalOpen returns false when no SR modal element is present", () => {
	const dom = new JSDOM("<!doctype html><html><body></body></html>");
	assert.equal(isReviewModalOpen(dom.window.document), false);
});

test("extractCardFrontBack returns front/back when both are strings", () => {
	assert.deepEqual(extractCardFrontBack({ front: "Q", back: "A" }), { front: "Q", back: "A" });
});

test("extractCardFrontBack returns null when front is missing", () => {
	assert.equal(extractCardFrontBack({ back: "A" }), null);
});

test("extractCardFrontBack returns null when back is not a string", () => {
	assert.equal(extractCardFrontBack({ front: "Q", back: 5 }), null);
});

test("extractCardFrontBack returns null for null or undefined input", () => {
	assert.equal(extractCardFrontBack(null), null);
	assert.equal(extractCardFrontBack(undefined), null);
});

test("buildFlashcardAskMessage formats front/back with the source link when present", () => {
	assert.equal(
		buildFlashcardAskMessage("What is X?", "X is Y.", "[[X]]", "why does this matter?"),
		"Flashcard from [[X]]:\nQ: What is X?\nA: X is Y.\n\nwhy does this matter?",
	);
});

test("buildFlashcardAskMessage omits the source clause when there is no link", () => {
	assert.equal(
		buildFlashcardAskMessage("What is X?", "X is Y.", null, "why?"),
		"Flashcard:\nQ: What is X?\nA: X is Y.\n\nwhy?",
	);
});
