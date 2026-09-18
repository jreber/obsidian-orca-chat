// Exercises AnnotateModal without a live Obsidian runtime, via test/fakes/obsidian.ts — same
// pattern as chat-view.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	HTMLElement: dom.window.HTMLElement,
	KeyboardEvent: dom.window.KeyboardEvent,
	MouseEvent: dom.window.MouseEvent,
});

const obsidianFake = await import("./fakes/obsidian.ts");
obsidianFake.installDomExtensions();
const { App } = obsidianFake;
const { AnnotateModal } = await import("../src/annotate-modal.ts");

test("closes immediately on submit, without waiting for onSubmit to resolve", async () => {
	let resolveSubmit!: (value: boolean) => void;
	const submitted = new Promise<boolean>((resolve) => {
		resolveSubmit = resolve;
	});
	const modal = new AnnotateModal(new App(), () => submitted);
	let closed = false;
	modal.close = () => {
		closed = true;
	};

	modal.open();
	const input = modal.contentEl.querySelector("input") as HTMLInputElement;
	input.value = "why?";
	const button = modal.contentEl.querySelector("button") as HTMLButtonElement;
	button.click();

	// The modal must close synchronously on submit — before the send RPC (onSubmit) resolves.
	assert.equal(closed, true);

	resolveSubmit(true);
	await Promise.resolve();
});
