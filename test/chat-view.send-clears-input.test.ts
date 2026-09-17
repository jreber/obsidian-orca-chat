// @ts-nocheck -- white-box test: reaches private fields via bracket access since OrcaChatView has
// no constructor seam for injecting a fake send function. TS privacy is compile-time only, so this
// works at runtime; esbuild (which builds this file, see test/run.mjs) doesn't type-check tests.
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
const { OrcaChatView } = await import("../src/chat-view.ts");

function makeView() {
	const view = new OrcaChatView(new WorkspaceLeaf(), new Plugin(new App()));
	// Only what handleSend touches — not the full onOpen() build, which shells out to the real
	// `orca` CLI and opens a real network connection. That's what made this bug hard to pin down
	// by hand: reproducing it required a live paired Orca plus a live agent session. This does not.
	view["input"] = document.createElement("input");
	return view;
}

test("handleSend clears the input before the send resolves, not after", async () => {
	const view = makeView();
	let resolveSend;
	view["sendToSelected"] = () => new Promise((resolve) => (resolveSend = resolve));

	view["input"].value = "nom nom cookie";
	const done = view["handleSend"]();

	assert.equal(view["input"].value, "", "input should clear synchronously, before the network round trip settles");
	resolveSend(true);
	await done;
});

test("handleSend does not restore the text when sendToSelected reports failure", async () => {
	// Regression test: this transport opens a fresh socket per RPC call with no persistent
	// connection, so a client-visible error does not reliably mean the message never reached the
	// host (the ack can be lost after the mutation already applied). An earlier version of
	// handleSend restored the typed text on a reported failure, which — for a message that had in
	// fact been delivered (visible via the live subscription) — silently retyped it into the box as
	// if nothing had been sent. See chat-view.ts's handleSend comment.
	const view = makeView();
	view["sendToSelected"] = async () => false;

	view["input"].value = "nom nom cookie";
	await view["handleSend"]();

	assert.equal(view["input"].value, "", "input must stay cleared even when the send is reported as failed");
});

test("handleSend does nothing for an empty input", async () => {
	const view = makeView();
	let called = false;
	view["sendToSelected"] = async () => {
		called = true;
		return true;
	};
	view["input"].value = "";
	await view["handleSend"]();
	assert.equal(called, false);
});
