// White-box test mirroring the pattern in the (now-removed) chat-view.send-clears-input.test.ts:
// exercises OrcaChatView's public surface without a live Obsidian runtime, via test/fakes/obsidian.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	HTMLElement: dom.window.HTMLElement,
});

const obsidianFake = await import("./fakes/obsidian.ts");
obsidianFake.installDomExtensions();
const { WorkspaceLeaf, App, Plugin } = obsidianFake;
const { OrcaChatView, ORCA_CHAT_VIEW_TYPE } = await import("../src/chat-view.ts");

function makeView() {
	return new OrcaChatView(new WorkspaceLeaf(), new Plugin(new App()));
}

test("has the expected view type", () => {
	const view = makeView();
	assert.equal(view.getViewType(), ORCA_CHAT_VIEW_TYPE);
});

test("getSelectedHandle returns null with no session picked", () => {
	const view = makeView();
	assert.equal(view.getSelectedHandle(), null);
});
