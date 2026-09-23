// White-box test mirroring the pattern in the (now-removed) chat-view.send-clears-input.test.ts:
// exercises OrcaChatView's public surface without a live Obsidian runtime, via test/fakes/obsidian.ts.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
});

// onOpen registers the pane's session-check interval on this jsdom window; closing the window
// clears its timers so the test process can exit.
after(() => dom.window.close());

const obsidianFake = await import("./fakes/obsidian.ts");
obsidianFake.installDomExtensions();
const { WorkspaceLeaf, App, Plugin, FakeNoticeLog } = obsidianFake;
const { OrcaChatView, ORCA_CHAT_VIEW_TYPE, interceptObsidianLinks, watchEmbedLoad } = await import(
	"../src/chat-view.ts"
);
const { shell } = await import("electron");
const { OrcaRemoteError } = await import("../src/orca-remote-client.ts");

function makeView() {
	return new OrcaChatView(new WorkspaceLeaf(), new Plugin(new App()));
}

test("has the expected view type", () => {
	const view = makeView();
	assert.equal(view.getViewType(), ORCA_CHAT_VIEW_TYPE);
});

test("getSelectedHandle returns null with no current session", () => {
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

// --- New session button / restore / existence check ---

const FAKE_CREDENTIAL = { v: 2, endpoint: "ws://127.0.0.1:1", deviceToken: "t", publicKeyB64: "k", scope: "runtime" };

test("pane renders the New session button, status label and embed, with no session dropdown", async () => {
	const view = makeView();
	await view.onOpen();
	assert.ok(view.contentEl.querySelector("button.orca-chat-new-session"));
	assert.ok(view.contentEl.querySelector(".orca-chat-status-label"));
	assert.ok(view.contentEl.querySelector(".orca-chat-embed"));
	assert.equal(view.contentEl.querySelector(".orca-chat-session-select"), null);
	assert.equal(view.contentEl.querySelector("select"), null);
});

test("no stored session: shows the button state, mounts nothing", async () => {
	const view = makeView();
	await view.onOpen();
	view.setClientForTest({ listAllAgentSessionTabs: async () => [] });
	view.setStoredSessionIdForTest(null);
	await view.restoreLastSession();
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(view.contentEl.querySelector("webview"), null);
	assert.equal(view.contentEl.querySelector(".orca-chat-status-label")!.textContent, "No session yet");
});

test("stored session still in Orca: reattaches and mounts its webview", async () => {
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	view.setClientForTest({ listAllAgentSessionTabs: async () => [{ sessionId: "s1", agent: "claude", title: "t" }] });
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(view.getSelectedHandle(), "s1");
	assert.ok(view.contentEl.querySelector("webview.orca-chat-webview"));
	assert.equal(view.contentEl.querySelector(".orca-chat-status-label")!.textContent, "Connecting…");
});

test("stored session gone from Orca: clears it and says it ended", async () => {
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	view.setClientForTest({ listAllAgentSessionTabs: async () => [] });
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(view.getSelectedHandle(), null);
	assert.ok(FakeNoticeLog.some((m) => /ended/i.test(m)));
	assert.equal(view.getStoredSessionIdForTest(), null);
});

test("Orca unreachable at open keeps the stored id (does not forget the session)", async () => {
	const view = makeView();
	await view.onOpen();
	view.setClientForTest({ listAllAgentSessionTabs: async () => { throw new Error("offline"); } });
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(view.getStoredSessionIdForTest(), "s1");
	assert.equal(view.getSelectedHandle(), null);
});

async function openWithSession(tabs: () => Promise<unknown[]>) {
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	let listAll = async () => [{ sessionId: "s1", agent: "claude", title: "t" }] as unknown[];
	view.setClientForTest({ listAllAgentSessionTabs: () => listAll() });
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	listAll = tabs;
	return view;
}

test("existence check: a vanished session is torn down, cleared and announced", async () => {
	const view = await openWithSession(async () => []);
	FakeNoticeLog.length = 0;
	await view.checkCurrentSession();
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(view.contentEl.querySelector("webview"), null);
	assert.equal(view.getStoredSessionIdForTest(), null);
	assert.ok(FakeNoticeLog.some((m) => /session ended/i.test(m)));
	assert.equal(view.contentEl.querySelector(".orca-chat-status-label")!.textContent, "No session yet");
});

test("existence check: a transient list error leaves the session alone, with no Notice", async () => {
	const view = await openWithSession(async () => {
		throw new Error("blip");
	});
	FakeNoticeLog.length = 0;
	await view.checkCurrentSession();
	assert.equal(view.getSelectedHandle(), "s1");
	assert.ok(view.contentEl.querySelector("webview.orca-chat-webview"));
	assert.equal(view.getStoredSessionIdForTest(), "s1");
	assert.deepEqual(FakeNoticeLog, []);
});

test("existence check: a still-present session stays mounted", async () => {
	const view = await openWithSession(async () => [{ sessionId: "s1", agent: "claude", title: "t" }]);
	await view.checkCurrentSession();
	assert.equal(view.getSelectedHandle(), "s1");
	assert.ok(view.contentEl.querySelector("webview.orca-chat-webview"));
});

function fakeCreateClient(overrides: Record<string, unknown> = {}) {
	const calls: string[] = [];
	const client = {
		listAllAgentSessionTabs: async () => [],
		disconnect: () => {},
		listRepos: async () => {
			calls.push("listRepos");
			return [{ id: "r1", path: "/vault", displayName: "Vault" }];
		},
		addFolderRepo: async () => {
			calls.push("addFolderRepo");
			return { id: "r1", path: "/vault", displayName: "Vault" };
		},
		listWorkspaces: async () => {
			calls.push("listWorkspaces");
			return [{ id: "w1", path: "/vault" }];
		},
		createClaudeSession: async () => {
			calls.push("createClaudeSession");
			return { sessionId: "new1" };
		},
		...overrides,
	};
	return { client, calls };
}

function makeDesktopView() {
	const app = new App();
	app.vault.adapter = new obsidianFake.FileSystemAdapter("/vault");
	return new OrcaChatView(new WorkspaceLeaf(), new Plugin(app));
}

function clickNewSession(view: InstanceType<typeof OrcaChatView>) {
	(view.contentEl.querySelector(".orca-chat-new-session") as HTMLButtonElement).click();
}

test("New session: creates, stores and mounts the new session", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const { client, calls } = fakeCreateClient();
	view.setClientForTest(client);
	view.setStoredSessionIdForTest(null);
	await view.onNewSession();
	assert.deepEqual(calls, ["listRepos", "listWorkspaces", "createClaudeSession"]);
	assert.equal(view.getSelectedHandle(), "new1");
	assert.equal(view.getStoredSessionIdForTest(), "new1");
	assert.ok(view.contentEl.querySelector("webview.orca-chat-webview"));
});

test("New session: a double click creates only one session", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const { client, calls } = fakeCreateClient();
	view.setClientForTest(client);
	view.setStoredSessionIdForTest(null);
	const first = view.onNewSession();
	const second = view.onNewSession();
	await Promise.all([first, second]);
	assert.equal(calls.filter((c) => c === "createClaudeSession").length, 1);
	assert.equal((view.contentEl.querySelector(".orca-chat-new-session") as HTMLButtonElement).disabled, false);
});

test("New session: the button click triggers creation", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const { client, calls } = fakeCreateClient();
	view.setClientForTest(client);
	view.setStoredSessionIdForTest(null);
	clickNewSession(view);
	for (let i = 0; i < 20 && view.getSelectedHandle() === null; i++) await new Promise((r) => setTimeout(r, 0));
	assert.ok(calls.includes("createClaudeSession"));
	assert.equal(view.getSelectedHandle(), "new1");
});

test("New session: mobile (no vault root path) Notices and creates nothing", async () => {
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const { client, calls } = fakeCreateClient();
	view.setClientForTest(client);
	FakeNoticeLog.length = 0;
	await view.onNewSession();
	assert.deepEqual(calls, []);
	assert.ok(FakeNoticeLog.includes("Orca Chat needs desktop Obsidian"));
});

test("New session: unpaired Notices and creates nothing", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	const { client, calls } = fakeCreateClient();
	view.setClientForTest(client);
	FakeNoticeLog.length = 0;
	await view.onNewSession();
	assert.deepEqual(calls, []);
	assert.ok(FakeNoticeLog.includes("Not paired with Orca — see the Pair with Orca command"));
});

test("New session: declining the add-project prompt creates nothing and shows no error", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	// Vault not yet an Orca project -> the real AddProjectModal opens; the fake Modal lets us cancel it.
	const { client, calls } = fakeCreateClient({ listRepos: async () => [] });
	view.setClientForTest(client);
	view.setStoredSessionIdForTest(null);
	FakeNoticeLog.length = 0;
	const originalOpen = obsidianFake.Modal.prototype.open;
	obsidianFake.Modal.prototype.open = function (this: InstanceType<typeof obsidianFake.Modal>) {
		originalOpen.call(this);
		this.close();
	};
	try {
		await view.onNewSession();
	} finally {
		obsidianFake.Modal.prototype.open = originalOpen;
	}
	assert.deepEqual(calls, []);
	assert.deepEqual(FakeNoticeLog, []);
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(view.getStoredSessionIdForTest(), null);
	assert.equal(view.contentEl.querySelector(".orca-chat-status-label")!.textContent, "No session yet");
});

test("New session: a failure Notices, shows the warning status and stores nothing", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const { client } = fakeCreateClient({ listWorkspaces: async () => [] });
	view.setClientForTest(client);
	view.setStoredSessionIdForTest(null);
	FakeNoticeLog.length = 0;
	await view.onNewSession();
	assert.ok(FakeNoticeLog.some((m) => /no workspace for this vault/.test(m)));
	assert.equal(view.contentEl.querySelector(".orca-chat-status-label")!.textContent, "⚠ Session not created");
	assert.equal(view.getStoredSessionIdForTest(), null);
	assert.equal(view.getSelectedHandle(), null);
});

test("sendToSelected with no session tells the user to click New session", async () => {
	const view = makeView();
	await view.onOpen();
	FakeNoticeLog.length = 0;
	assert.equal(await view.sendToSelected("hi"), false);
	assert.ok(FakeNoticeLog.includes("Click New session in the Orca Chat pane first"));
});

test("sendToSelected targets the current session", async () => {
	const sent: [string, string][] = [];
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	view.setClientForTest({
		listAllAgentSessionTabs: async () => [{ sessionId: "s1", agent: "claude", title: "t" }],
		sendAgentSessionMessage: async (id: string, text: string) => {
			sent.push([id, text]);
		},
	});
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(await view.sendToSelected("hello"), true);
	assert.deepEqual(sent, [["s1", "hello"]]);
});

test("focusNewSessionButton focuses the button", async () => {
	const view = makeView();
	await view.onOpen();
	document.body.appendChild(view.containerEl);
	try {
		view.focusNewSessionButton();
		assert.equal(document.activeElement, view.contentEl.querySelector(".orca-chat-new-session"));
	} finally {
		view.containerEl.remove();
	}
});

test("New session: paired but Orca unreachable says so and creates nothing", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	FakeNoticeLog.length = 0;
	await view.onNewSession();
	assert.ok(FakeNoticeLog.some((m) => /can't reach Orca/i.test(m)));
	assert.equal(view.getSelectedHandle(), null);
});

// --- Races, stale results and close (review M1–M4) ---

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// Lets pending promise chains (fake RPCs, plugin data reads/writes) run to their next await.
async function flush() {
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

const statusText = (view: InstanceType<typeof OrcaChatView>) =>
	view.contentEl.querySelector(".orca-chat-status-label")!.textContent;

// Makes the next AddProjectModal stay open and hands it back, instead of the fake Modal's default.
function captureNextModal() {
	const originalOpen = obsidianFake.Modal.prototype.open;
	const captured: { modal: InstanceType<typeof obsidianFake.Modal> | null } = { modal: null };
	obsidianFake.Modal.prototype.open = function (this: InstanceType<typeof obsidianFake.Modal>) {
		originalOpen.call(this);
		captured.modal = this;
	};
	return { captured, restore: () => (obsidianFake.Modal.prototype.open = originalOpen) };
}

// A desktop view backed by the fake plugin's real loadData/saveData (not the stored-id override),
// so the stored id goes through saveLastSessionId's read-modify-write like it does in Obsidian.
async function openDesktopViewWithData(data: Record<string, unknown>) {
	const app = new App();
	app.vault.adapter = new obsidianFake.FileSystemAdapter("/vault");
	const plugin = new Plugin(app);
	await plugin.saveData(data);
	const view = new OrcaChatView(new WorkspaceLeaf(), plugin);
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const storedId = async () => ((await plugin.loadData()) as { lastSessionId?: string | null }).lastSessionId ?? null;
	return { view, plugin, storedId };
}

test("New session: 'Creating session…' only shows once the add-project prompt is confirmed", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const created = deferred<{ sessionId: string }>();
	const { client } = fakeCreateClient({ listRepos: async () => [], createClaudeSession: () => created.promise });
	view.setClientForTest(client);
	view.setStoredSessionIdForTest(null);
	await view.restoreLastSession();
	const { captured, restore } = captureNextModal();
	try {
		const creating = view.onNewSession();
		await flush();
		assert.ok(captured.modal, "the add-project prompt opened");
		assert.equal(statusText(view), "No session yet");
		(captured.modal!.contentEl.querySelector("button.mod-cta") as HTMLButtonElement).click();
		await flush();
		assert.equal(statusText(view), "Creating session…");
		created.resolve({ sessionId: "new1" });
		await creating;
		assert.equal(statusText(view), "Connecting…");
	} finally {
		restore();
	}
});

test("a slow restore that finishes after New session leaves the new session stored and mounted", async () => {
	const { view, storedId } = await openDesktopViewWithData({ lastSessionId: "s1" });
	const listed = deferred<unknown[]>();
	let first = true;
	const { client } = fakeCreateClient({
		listAllAgentSessionTabs: () => (first ? ((first = false), listed.promise) : Promise.resolve([])),
	});
	view.setClientForTest(client);
	FakeNoticeLog.length = 0;
	const restoring = view.restoreLastSession();
	await flush();
	await view.onNewSession();
	assert.equal(await storedId(), "new1");
	listed.resolve([]); // s1 is gone — but the user has already moved on to new1
	await restoring;
	assert.equal(await storedId(), "new1");
	assert.equal(view.getSelectedHandle(), "new1");
	assert.equal(view.contentEl.querySelector("webview")?.getAttribute("data-orca-session-id"), "new1");
	assert.equal(statusText(view), "Connecting…");
	assert.ok(!FakeNoticeLog.some((m) => /ended/i.test(m)), `unexpected Notice: ${FakeNoticeLog.join(" | ")}`);
});

test("a restore's clear still being written can't overwrite the id New session stores after it", async () => {
	const { view, plugin, storedId } = await openDesktopViewWithData({ lastSessionId: "s1" });
	const { client } = fakeCreateClient(); // listAll → [] so the restore clears s1
	view.setClientForTest(client);
	const realSave = plugin.saveData.bind(plugin);
	const heldSave = deferred<void>();
	let saves = 0;
	plugin.saveData = async (data: unknown) => {
		if (saves++ === 0) await heldSave.promise; // the restore's clear lands late
		return realSave(data);
	};
	FakeNoticeLog.length = 0;
	const restoring = view.restoreLastSession();
	await flush();
	assert.equal(saves, 1, "the restore is mid-write");
	const creating = view.onNewSession();
	await flush();
	heldSave.resolve();
	await Promise.all([restoring, creating]);
	assert.equal(await storedId(), "new1");
	assert.equal(view.getSelectedHandle(), "new1");
	assert.equal(statusText(view), "Connecting…");
	assert.ok(!FakeNoticeLog.some((m) => /ended/i.test(m)), `unexpected Notice: ${FakeNoticeLog.join(" | ")}`);
});

test("cancelling New session shows the current load state, not the one at click time", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const { client, calls } = fakeCreateClient({
		listRepos: async () => [],
		listAllAgentSessionTabs: async () => [{ sessionId: "s1", agent: "claude", title: "t" }],
	});
	view.setClientForTest(client);
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(statusText(view), "Connecting…");
	const { captured, restore } = captureNextModal();
	try {
		const creating = view.onNewSession();
		await flush();
		assert.ok(captured.modal);
		// The mounted chat finishes loading while the prompt is up.
		view.contentEl.querySelector("webview")!.dispatchEvent(new Event("did-finish-load"));
		captured.modal!.close();
		await creating;
	} finally {
		restore();
	}
	assert.deepEqual(calls, []);
	assert.equal(statusText(view), "● Live chat");
	assert.equal(view.getSelectedHandle(), "s1");
});

test("a New session that resolves after the pane closed mounts nothing and shows no Notice", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const created = deferred<{ sessionId: string }>();
	const { client } = fakeCreateClient({ createClaudeSession: () => created.promise });
	view.setClientForTest(client);
	view.setStoredSessionIdForTest(null);
	const creating = view.onNewSession();
	await flush();
	await view.onClose();
	FakeNoticeLog.length = 0;
	created.resolve({ sessionId: "new1" });
	await creating;
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(view.contentEl.querySelector("webview"), null);
	assert.deepEqual(FakeNoticeLog, []);
});

// A reopened pane is a new OrcaChatView, so a session created after close is kept only through
// the stored id: persisted if nothing newer was stored since the click, for the next open to restore.
test("a New session that resolves after the pane closed is stored for the next open, without mounting", async () => {
	const { view, storedId } = await openDesktopViewWithData({ lastSessionId: "s0" });
	const created = deferred<{ sessionId: string }>();
	const { client } = fakeCreateClient({ createClaudeSession: () => created.promise });
	view.setClientForTest(client);
	const creating = view.onNewSession();
	await flush();
	await view.onClose();
	FakeNoticeLog.length = 0;
	created.resolve({ sessionId: "new1" });
	await creating;
	assert.equal(await storedId(), "new1");
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(view.contentEl.querySelector("webview"), null);
	assert.deepEqual(FakeNoticeLog, []);
});

test("a New session that resolves after close doesn't overwrite a session a reopened pane stored", async () => {
	const { view, plugin, storedId } = await openDesktopViewWithData({ lastSessionId: null });
	const created = deferred<{ sessionId: string }>();
	view.setClientForTest(fakeCreateClient({ createClaudeSession: () => created.promise }).client);
	const creating = view.onNewSession();
	await flush();
	await view.onClose();
	// The pane is reopened (a new view instance on the same plugin data) and creates new2.
	const reopened = new OrcaChatView(new WorkspaceLeaf(), plugin);
	await reopened.onOpen();
	reopened.setCredentialForTest(FAKE_CREDENTIAL);
	reopened.setClientForTest(fakeCreateClient({ createClaudeSession: async () => ({ sessionId: "new2" }) }).client);
	await reopened.onNewSession();
	assert.equal(await storedId(), "new2");
	created.resolve({ sessionId: "new1" });
	await creating;
	await flush();
	assert.equal(await storedId(), "new2");
	assert.equal(reopened.getSelectedHandle(), "new2");
	assert.equal(view.contentEl.querySelector("webview"), null);
});

// The stored-id write is queued behind an earlier one from the same instance; the pane closes
// before it runs, so the write is skipped and the orphan fallback must keep the session.
test("a New session whose stored-id write was queued and skipped by a close still stores the session", async () => {
	const { view, plugin, storedId } = await openDesktopViewWithData({ lastSessionId: "s1" });
	const created = deferred<{ sessionId: string }>();
	const { client } = fakeCreateClient({
		listAllAgentSessionTabs: async () => [], // the restore clears s1
		createClaudeSession: () => created.promise,
	});
	view.setClientForTest(client);
	const realSave = plugin.saveData.bind(plugin);
	const heldSave = deferred<void>();
	let saves = 0;
	plugin.saveData = async (data: unknown) => {
		await realSave(data);
		if (saves++ === 0) await heldSave.promise; // the restore's clear is on disk but still pending
	};
	FakeNoticeLog.length = 0;
	const restoring = view.restoreLastSession();
	await flush();
	assert.equal(saves, 1, "the restore's clear is mid-write");
	assert.equal(await storedId(), null);
	const creating = view.onNewSession(); // reads null as the stored id at click time
	await flush();
	created.resolve({ sessionId: "new1" }); // the pane is still open: the write queues behind the clear
	await flush();
	await view.onClose(); // ...and the pane closes before that write runs
	heldSave.resolve();
	await Promise.all([restoring, creating]);
	await flush();
	assert.equal(await storedId(), "new1");
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(view.contentEl.querySelector("webview"), null);
	assert.deepEqual(FakeNoticeLog, []);
});

test("a New session that fails after the pane closed shows no Notice", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const created = deferred<{ sessionId: string }>();
	const { client } = fakeCreateClient({ createClaudeSession: () => created.promise });
	view.setClientForTest(client);
	view.setStoredSessionIdForTest(null);
	const creating = view.onNewSession();
	await flush();
	await view.onClose();
	FakeNoticeLog.length = 0;
	created.reject(new OrcaRemoteError("refused"));
	await creating;
	assert.deepEqual(FakeNoticeLog, []);
});

test("a restore that resolves after the pane closed neither mounts nor clears nor Notices", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const listed = deferred<unknown[]>();
	view.setClientForTest({ listAllAgentSessionTabs: () => listed.promise, disconnect: () => {} });
	view.setStoredSessionIdForTest("s1");
	const restoring = view.restoreLastSession();
	await flush();
	await view.onClose();
	FakeNoticeLog.length = 0;
	listed.resolve([]);
	await restoring;
	assert.deepEqual(FakeNoticeLog, []);
	assert.equal(view.getStoredSessionIdForTest(), "s1");
	assert.equal(view.getSelectedHandle(), null);
});

test("a restore that finds its session after the pane closed mounts nothing", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const listed = deferred<unknown[]>();
	view.setClientForTest({ listAllAgentSessionTabs: () => listed.promise, disconnect: () => {} });
	view.setStoredSessionIdForTest("s1");
	const restoring = view.restoreLastSession();
	await flush();
	await view.onClose();
	listed.resolve([{ sessionId: "s1", agent: "claude", title: "t" }]);
	await restoring;
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(view.contentEl.querySelector("webview"), null);
});

test("onClose forgets the client and session, so reopening initializes again", async () => {
	const view = makeView();
	await view.onOpen();
	let disconnected = 0;
	view.setCredentialForTest(FAKE_CREDENTIAL);
	view.setClientForTest({
		listAllAgentSessionTabs: async () => [{ sessionId: "s1", agent: "claude", title: "t" }],
		disconnect: () => disconnected++,
	});
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(view.getSelectedHandle(), "s1");
	await view.onClose();
	assert.equal(disconnected, 1);
	assert.equal(view.getSelectedHandle(), null);
	await view.onOpen();
	await flush();
	// The fake plugin has no pairedCredential, so a fresh initialization finds none; the stored-id
	// override still says s1, which it keeps.
	assert.equal(statusText(view), "Not paired with Orca");
	assert.equal(view.getStoredSessionIdForTest(), "s1");
	assert.equal(view.getSelectedHandle(), null);
});

test("restore with no client (unpaired or connect failed) keeps the stored id", async () => {
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(view.getStoredSessionIdForTest(), "s1");
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(statusText(view), "Can't reach Orca");
});
