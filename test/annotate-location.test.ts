import test from "node:test";
import assert from "node:assert/strict";
import {
	formatLocation,
	buildAnnotateMessage,
	buildObsidianOpenUri,
	lineRangeFromEditorCursors,
	sectionInfoToLineTag,
	parseLineTag,
	readingModeLineRange,
} from "../src/annotate-location.ts";

test("formatLocation joins file and a single-line range with one line number", () => {
	assert.equal(formatLocation("notes/foo.md", { start: 5, end: 5 }), "notes/foo.md:5");
});

test("formatLocation joins file and a multi-line range with a dash", () => {
	assert.equal(formatLocation("notes/foo.md", { start: 5, end: 8 }), "notes/foo.md:5-8");
});

test("formatLocation returns just the file path when there is no line range", () => {
	assert.equal(formatLocation("notes/foo.md", null), "notes/foo.md");
});

test("formatLocation returns null when there is no file", () => {
	assert.equal(formatLocation(null, { start: 5, end: 5 }), null);
	assert.equal(formatLocation(null, null), null);
});

test("buildAnnotateMessage quotes the selection as a blockquote when there is no location", () => {
	assert.equal(buildAnnotateMessage("hi", "why?", null), "> hi\n\nwhy?");
});

test("buildAnnotateMessage quotes the selection with a bracketed citation appended", () => {
	assert.equal(buildAnnotateMessage("hi", "why?", "notes/foo.md:5"), "> hi [notes/foo.md:5]\n\nwhy?");
});

test("buildAnnotateMessage quotes every line of a multi-line selection, with the citation on the last line", () => {
	assert.equal(
		buildAnnotateMessage("line one\nline two", "why?", "notes/foo.md:5-6"),
		"> line one\n> line two [notes/foo.md:5-6]\n\nwhy?",
	);
});

test("buildAnnotateMessage renders the citation as a clickable obsidian:// link when a URI is given", () => {
	assert.equal(
		buildAnnotateMessage("hi", "why?", "notes/foo.md:5", "obsidian://open?vault=Vault&file=notes%2Ffoo.md"),
		"> hi [notes/foo.md:5](obsidian://open?vault=Vault&file=notes%2Ffoo.md)\n\nwhy?",
	);
});

test("buildAnnotateMessage falls back to a plain bracketed citation without a URI", () => {
	assert.equal(buildAnnotateMessage("hi", "why?", "notes/foo.md:5", null), "> hi [notes/foo.md:5]\n\nwhy?");
});

test("buildObsidianOpenUri builds an obsidian://open deep link for a vault-relative file path", () => {
	assert.equal(
		buildObsidianOpenUri("My Vault", "notes/foo.md"),
		"obsidian://open?vault=My+Vault&file=notes%2Ffoo.md",
	);
});

test("buildObsidianOpenUri percent-encodes characters that would otherwise break a markdown link", () => {
	assert.equal(
		buildObsidianOpenUri("Vault", "notes/a (draft).md"),
		"obsidian://open?vault=Vault&file=notes%2Fa+%28draft%29.md",
	);
});

test("lineRangeFromEditorCursors converts 0-indexed editor lines to a 1-indexed inclusive range", () => {
	assert.deepEqual(lineRangeFromEditorCursors(4, 4), { start: 5, end: 5 });
	assert.deepEqual(lineRangeFromEditorCursors(4, 7), { start: 5, end: 8 });
});

test("sectionInfoToLineTag converts 0-indexed section info to a 1-indexed dash-joined tag", () => {
	assert.equal(sectionInfoToLineTag(2, 2), "3-3");
	assert.equal(sectionInfoToLineTag(2, 5), "3-6");
});

test("parseLineTag parses a dash-joined tag back into a range", () => {
	assert.deepEqual(parseLineTag("3-6"), { start: 3, end: 6 });
});

test("parseLineTag returns null for missing or malformed tags", () => {
	assert.equal(parseLineTag(undefined), null);
	assert.equal(parseLineTag(null), null);
	assert.equal(parseLineTag("garbage"), null);
});

test("readingModeLineRange spans from the start block's start line to the end block's end line", () => {
	assert.deepEqual(readingModeLineRange("3-3", "3-3"), { start: 3, end: 3 });
	assert.deepEqual(readingModeLineRange("3-4", "6-6"), { start: 3, end: 6 });
});

test("readingModeLineRange returns null when either block couldn't be tagged", () => {
	assert.equal(readingModeLineRange(undefined, "6-6"), null);
	assert.equal(readingModeLineRange("3-3", undefined), null);
});
