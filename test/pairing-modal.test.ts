// Exercises PairingModal without a live Obsidian runtime, via test/fakes/obsidian.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	HTMLElement: dom.window.HTMLElement,
	KeyboardEvent: dom.window.KeyboardEvent,
});

const obsidianFake = await import("./fakes/obsidian.ts");
obsidianFake.installDomExtensions();
const { App, Plugin } = obsidianFake;
const { PairingModal } = await import("../src/pairing-modal.ts");

// A mobile-scope pairing (Orca's mobile QR) is refused repo.add / worktree.list, so New session
// can't work with it; the modal says which link to use.
test("the pairing modal says to use the \"This computer only\" link, under the input", () => {
	const modal = new PairingModal(new App(), new Plugin(new App()));
	modal.open();
	const input = modal.contentEl.querySelector("input")!;
	const hint = input.nextElementSibling;
	assert.equal(hint?.textContent, "Use Orca's \"This computer only\" pairing link (not the mobile QR).");
});
