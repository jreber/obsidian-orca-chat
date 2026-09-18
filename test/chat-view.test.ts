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
	Event: dom.window.Event,
});

const obsidianFake = await import("./fakes/obsidian.ts");
obsidianFake.installDomExtensions();
const { WorkspaceLeaf, App, Plugin } = obsidianFake;
const { OrcaChatView, ORCA_CHAT_VIEW_TYPE, interceptObsidianLinks } = await import("../src/chat-view.ts");
const { shell } = await import("electron");

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

// A target="_blank" click on an unregistered custom scheme (obsidian://) never reaches Electron's
// webview "new-window"/popup machinery at all — Chromium silently drops it before any host-level
// hook fires (verified empirically: an identical click on an https:// link does fire "new-window";
// obsidian:// produces nothing). So interception has to happen *inside* the guest's own click
// handling, which — since Obsidian's will-attach-webview strips the guest's preload script — can
// only be reached via `webview.executeJavaScript()` (a host-side <webview> API, unaffected by the
// guest's sandbox) plus the "console-message" DOM event as the guest->host signal back, since
// there's no preload for ipc-message and no window.parent for postMessage.
function makeFakeWebview(): HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> } {
	const webview = document.createElement("webview") as HTMLElement & {
		executeJavaScript: (code: string) => Promise<unknown>;
	};
	webview.executeJavaScript = async () => undefined;
	return webview;
}

test("interceptObsidianLinks injects a click-interception script once the guest finishes loading", () => {
	const webview = makeFakeWebview();
	const calls: string[] = [];
	webview.executeJavaScript = async (code: string) => {
		calls.push(code);
	};
	interceptObsidianLinks(webview);

	webview.dispatchEvent(new Event("dom-ready"));

	assert.equal(calls.length, 1);
	assert.match(calls[0], /obsidian:\/\//);
	assert.match(calls[0], /addEventListener\(.click./);
});

test("interceptObsidianLinks opens obsidian:// links reported back via console-message", () => {
	const webview = makeFakeWebview();
	const calls: string[] = [];
	const original = shell.openExternal;
	shell.openExternal = async (url: string) => {
		calls.push(url);
	};
	try {
		interceptObsidianLinks(webview);
		const event = new Event("console-message");
		Object.assign(event, { message: "orca-chat:obsidian-link:obsidian://open?vault=Vault&file=notes%2Ffoo.md" });
		webview.dispatchEvent(event);

		assert.deepEqual(calls, ["obsidian://open?vault=Vault&file=notes%2Ffoo.md"]);
	} finally {
		shell.openExternal = original;
	}
});

test("interceptObsidianLinks ignores console-message events without the marker prefix", () => {
	const webview = makeFakeWebview();
	const calls: string[] = [];
	const original = shell.openExternal;
	shell.openExternal = async (url: string) => {
		calls.push(url);
	};
	try {
		interceptObsidianLinks(webview);
		const event = new Event("console-message");
		Object.assign(event, { message: "some unrelated guest console output" });
		webview.dispatchEvent(event);

		assert.deepEqual(calls, []);
	} finally {
		shell.openExternal = original;
	}
});
