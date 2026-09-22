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
const { OrcaChatView, ORCA_CHAT_VIEW_TYPE, interceptObsidianLinks, watchEmbedLoad } = await import(
	"../src/chat-view.ts"
);
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

// A <webview> that 404s still "loads" (Chromium renders the error body and fires did-finish-load),
// so load failure has to be read from the main frame's HTTP status as well as did-fail-load.
function webviewEvent(type: string, fields: Record<string, unknown>): Event {
	return Object.assign(new Event(type), fields);
}

function watch() {
	const webview = makeFakeWebview();
	const outcomes: string[] = [];
	watchEmbedLoad(webview, {
		onLoaded: () => outcomes.push("loaded"),
		onFailed: (reason) => outcomes.push(`failed: ${reason}`),
	});
	return { webview, outcomes };
}

test("watchEmbedLoad reports loaded after a 200 main-frame navigation finishes", () => {
	const { webview, outcomes } = watch();
	webview.dispatchEvent(webviewEvent("did-start-loading", {}));
	webview.dispatchEvent(
		webviewEvent("did-frame-navigate", { isMainFrame: true, httpResponseCode: 200, httpStatusText: "OK" }),
	);
	webview.dispatchEvent(webviewEvent("did-finish-load", {}));
	assert.deepEqual(outcomes, ["loaded"]);
});

test("watchEmbedLoad reports an HTTP 404 main frame as a failure, not as loaded", () => {
	const { webview, outcomes } = watch();
	webview.dispatchEvent(webviewEvent("did-start-loading", {}));
	webview.dispatchEvent(
		webviewEvent("did-frame-navigate", { isMainFrame: true, httpResponseCode: 404, httpStatusText: "Not Found" }),
	);
	webview.dispatchEvent(
		webviewEvent("did-fail-load", {
			isMainFrame: true,
			errorCode: -379,
			errorDescription: "ERR_HTTP_RESPONSE_CODE_FAILURE",
		}),
	);
	webview.dispatchEvent(webviewEvent("did-finish-load", {}));
	assert.deepEqual(outcomes, ["failed: HTTP 404 Not Found"]);
});

test("watchEmbedLoad reports a network-level did-fail-load", () => {
	const { webview, outcomes } = watch();
	webview.dispatchEvent(
		webviewEvent("did-fail-load", {
			isMainFrame: true,
			errorCode: -102,
			errorDescription: "ERR_CONNECTION_REFUSED",
		}),
	);
	assert.deepEqual(outcomes, ["failed: ERR_CONNECTION_REFUSED (-102)"]);
});

test("watchEmbedLoad ignores aborted loads and subframe failures", () => {
	const { webview, outcomes } = watch();
	webview.dispatchEvent(
		webviewEvent("did-fail-load", { isMainFrame: true, errorCode: -3, errorDescription: "ERR_ABORTED" }),
	);
	webview.dispatchEvent(
		webviewEvent("did-fail-load", { isMainFrame: false, errorCode: -102, errorDescription: "ERR_CONNECTION_REFUSED" }),
	);
	webview.dispatchEvent(
		webviewEvent("did-frame-navigate", { isMainFrame: false, httpResponseCode: 500, httpStatusText: "" }),
	);
	webview.dispatchEvent(webviewEvent("did-finish-load", {}));
	assert.deepEqual(outcomes, ["loaded"]);
});

test("watchEmbedLoad re-arms on a new load so a reload can recover", () => {
	const { webview, outcomes } = watch();
	webview.dispatchEvent(webviewEvent("did-start-loading", {}));
	webview.dispatchEvent(
		webviewEvent("did-frame-navigate", { isMainFrame: true, httpResponseCode: 503, httpStatusText: "" }),
	);
	webview.dispatchEvent(webviewEvent("did-finish-load", {}));
	webview.dispatchEvent(webviewEvent("did-start-loading", {}));
	webview.dispatchEvent(
		webviewEvent("did-frame-navigate", { isMainFrame: true, httpResponseCode: 200, httpStatusText: "OK" }),
	);
	webview.dispatchEvent(webviewEvent("did-finish-load", {}));
	assert.deepEqual(outcomes, ["failed: HTTP 503", "loaded"]);
});
