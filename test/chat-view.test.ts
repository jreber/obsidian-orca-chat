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
const { OrcaChatView, ORCA_CHAT_VIEW_TYPE, ADVICE_BUTTON_TOOLTIP, interceptObsidianLinks, watchEmbedLoad } = await import(
	"../src/chat-view.ts"
);
const { shell } = await import("electron");
const { OrcaRemoteError } = await import("../src/orca-remote-client.ts");
const { DEVICE_STORAGE_MIGRATED_KEY, LAST_SESSION_ID_KEY } = await import("../src/orca-pairing.ts");

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
	interceptObsidianLinks(webview, "Vault");

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
		interceptObsidianLinks(webview, "Vault");
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
		interceptObsidianLinks(webview, "Vault");
		const event = new Event("console-message");
		Object.assign(event, { message: "some unrelated guest console output" });
		webview.dispatchEvent(event);

		assert.deepEqual(calls, []);
	} finally {
		shell.openExternal = original;
	}
});

test("interceptObsidianLinks catches a rejected injection", async () => {
	const webview = makeFakeWebview();
	webview.executeJavaScript = () => Promise.reject(new Error("guest navigated"));
	let unhandled = 0;
	const onUnhandled = () => void unhandled++;
	process.on("unhandledRejection", onUnhandled);
	try {
		interceptObsidianLinks(webview, "Vault");
		webview.dispatchEvent(new Event("dom-ready"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(unhandled, 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("interceptObsidianLinks passes on only obsidian://open links to this vault", () => {
	const webview = makeFakeWebview();
	const calls: string[] = [];
	const warnings: unknown[] = [];
	const original = shell.openExternal;
	const originalWarn = console.warn;
	shell.openExternal = async (url: string) => {
		calls.push(url);
	};
	console.warn = (...args: unknown[]) => void warnings.push(args);
	const rejected = [
		"file:///Applications/Calculator.app",
		"https://example.com/",
		"smb://host/share",
		"x-apple.systempreferences:com.apple.preference",
		"obsidian://open?vault=Other&file=a",
		"obsidian://open?file=a",
		"obsidian://open?vault=Vault&vault=Other&file=a",
		"obsidian://open?vault=Vault&path=%2Fetc%2Fpasswd",
		"obsidian://advanced-uri?vault=Vault&commandid=x",
		"obsidian://open?vault=Vault&file=a\nb",
		"obsidian://open?vault=Vault&file=a b",
		"obsidian://open?vault=Vault&file=" + "x".repeat(5000),
		"OBSIDIAN://open?vault=Vault&file=a",
		// Anything after '#' that could be read as a parameter: what is passed on must be what was checked.
		"obsidian://open?vault=Vault#&path=%2FUsers%2Fx%2FOther%2Fsecret.md",
		"obsidian://open?vault=Vault&file=a#x=1",
		"obsidian://open?file=a#&vault=Vault",
	];
	try {
		interceptObsidianLinks(webview, "Vault");
		for (const link of rejected) {
			const event = new Event("console-message");
			Object.assign(event, { message: "orca-chat:obsidian-link:" + link });
			webview.dispatchEvent(event);
		}
		assert.deepEqual(calls, []);
		assert.equal(warnings.length, rejected.length);
		const ok = new Event("console-message");
		Object.assign(ok, { message: "orca-chat:obsidian-link:obsidian://open?vault=Vault&file=a#h" });
		webview.dispatchEvent(ok);
		assert.deepEqual(calls, ["obsidian://open?vault=Vault&file=a#h"]);
	} finally {
		shell.openExternal = original;
		console.warn = originalWarn;
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

// A desktop App whose vault holds `files` (vault-relative path -> text), with the Vault calls the
// advice button makes. `gate`, when given, holds every process/create until it resolves.
function appWithVaultFiles(files: Record<string, string>, gate?: Promise<void>) {
	const app = new App();
	const writes: string[] = [];
	Object.assign(app.vault, {
		adapter: Object.assign(new obsidianFake.FileSystemAdapter("/vault"), { exists: async (p: string) => p in files }),
		getFileByPath: (p: string) => (p in files ? { path: p } : null),
		read: async (f: { path: string }) => files[f.path],
		process: async (f: { path: string }, fn: (data: string) => string) => {
			await gate;
			writes.push(f.path);
			return (files[f.path] = fn(files[f.path]));
		},
		create: async (p: string, data: string) => {
			await gate;
			writes.push(p);
			files[p] = data;
		},
	});
	return { app, writes };
}

// Beside New session: writes the plugin's advice block into the vault root's AGENTS.md.
test("the Append AGENTS.md advice button sits right after New session, is secondary, and writes AGENTS.md", async () => {
	const files: Record<string, string> = { "AGENTS.md": "# Mine\n" };
	const { app } = appWithVaultFiles(files);
	const view = new OrcaChatView(new WorkspaceLeaf(), new Plugin(app));
	await view.onOpen();
	const newSession = view.contentEl.querySelector("button.orca-chat-new-session")!;
	const advice = view.contentEl.querySelector("button.orca-chat-agents-advice") as HTMLButtonElement;
	assert.equal(advice.textContent, "Append AGENTS.md advice");
	assert.equal(newSession.nextElementSibling, advice);
	assert.ok(newSession.classList.contains("mod-cta"), "New session is the pane's one CTA");
	assert.ok(!advice.classList.contains("mod-cta"), "the advice button is a plain, secondary button");
	assert.equal(advice.getAttribute("title"), ADVICE_BUTTON_TOOLTIP);
	assert.match(ADVICE_BUTTON_TOOLTIP, /AGENTS\.md/);

	FakeNoticeLog.length = 0;
	advice.click();
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(FakeNoticeLog, ["Added Orca Chat advice to AGENTS.md"]);
	assert.match(files["AGENTS.md"], /^# Mine\n\n<!-- orca-chat:advice:start -->/);
	advice.click();
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(FakeNoticeLog, ["Added Orca Chat advice to AGENTS.md", "Updated Orca Chat advice in AGENTS.md"]);
	assert.equal(files["AGENTS.md"].split("<!-- orca-chat:advice:start -->").length, 2);
});

test("Append AGENTS.md advice: a second click while the first is writing does nothing", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const files: Record<string, string> = {};
	const { app, writes } = appWithVaultFiles(files, gate);
	const view = new OrcaChatView(new WorkspaceLeaf(), new Plugin(app));
	await view.onOpen();
	const advice = view.contentEl.querySelector("button.orca-chat-agents-advice") as HTMLButtonElement;
	FakeNoticeLog.length = 0;
	const first = view.onAppendAgentsAdvice();
	assert.equal(advice.disabled, true);
	await view.onAppendAgentsAdvice();
	release();
	await first;
	assert.equal(advice.disabled, false);
	assert.deepEqual(writes, ["AGENTS.md"]);
	assert.deepEqual(FakeNoticeLog, ["Added Orca Chat advice to AGENTS.md"]);
});

test("Append AGENTS.md advice needs desktop Obsidian", async () => {
	const view = makeView();
	await view.onOpen();
	FakeNoticeLog.length = 0;
	(view.contentEl.querySelector("button.orca-chat-agents-advice") as HTMLButtonElement).click();
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
	assert.ok(FakeNoticeLog.includes("Orca Chat needs desktop Obsidian"));
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

// Another computer's pairing (a synced vault used to share one): Orca rejects the token, or can't
// decrypt the auth frame and closes with 4001. The pane says to re-pair this computer, once.
const { RemoteRuntimeClientError } = await import("../src/orca-remote/remote-runtime-client-error.ts");
const { PAIRING_REJECTED_NOTICE } = await import("../src/chat-view.ts");
const REJECTIONS = [
	new RemoteRuntimeClientError("unauthorized", "Remote Orca runtime rejected the pairing token.", { pairingStage: "access-grant" }),
	new RemoteRuntimeClientError("remote_runtime_unavailable", "Remote Orca runtime closed the connection (4001: Unauthorized).", {
		pairingStage: "host-identity",
		closeCode: 4001,
	}),
];

test("a rejected pairing at open says to re-pair this computer, once, and keeps the stored id", async () => {
	assert.match(PAIRING_REJECTED_NOTICE, /Pair with Orca/);
	assert.match(PAIRING_REJECTED_NOTICE, /This computer only/);
	for (const rejection of REJECTIONS) {
		const view = makeView();
		await view.onOpen();
		view.setCredentialForTest(FAKE_CREDENTIAL);
		view.setClientForTest({
			listAllAgentSessionTabs: async () => {
				throw new OrcaRemoteError(rejection.message, rejection);
			},
		});
		view.setStoredSessionIdForTest("s1");
		FakeNoticeLog.length = 0;
		await view.restoreLastSession();
		assert.deepEqual(FakeNoticeLog, [PAIRING_REJECTED_NOTICE]);
		const status = () => view.contentEl.querySelector(".orca-chat-status-label")!.textContent;
		assert.equal(status(), "⚠ Re-pair this computer");
		// The liveness tick retries quietly and keeps the status.
		await view.checkCurrentSession();
		assert.deepEqual(FakeNoticeLog, [PAIRING_REJECTED_NOTICE]);
		assert.equal(status(), "⚠ Re-pair this computer");
		assert.equal(view.getStoredSessionIdForTest(), "s1");
	}
});

test("Orca down (connection refused, or closed without an auth code) still says it can't reach Orca", async () => {
	for (const down of [
		new RemoteRuntimeClientError("remote_runtime_unavailable", "Could not connect to the remote Orca runtime.", { pairingStage: "connect" }),
		new RemoteRuntimeClientError("remote_runtime_unavailable", "Remote Orca runtime closed the connection.", { pairingStage: "connect", closeCode: 1006 }),
		new RemoteRuntimeClientError("runtime_timeout", "Timed out waiting for the remote Orca runtime to respond.", { pairingStage: "connect" }),
	]) {
		const view = makeView();
		await view.onOpen();
		view.setCredentialForTest(FAKE_CREDENTIAL);
		view.setClientForTest({
			listAllAgentSessionTabs: async () => {
				throw new OrcaRemoteError(down.message, down);
			},
		});
		view.setStoredSessionIdForTest("s1");
		FakeNoticeLog.length = 0;
		await view.restoreLastSession();
		assert.deepEqual(FakeNoticeLog, [`Orca Chat: ${down.message}`]);
		assert.equal(view.contentEl.querySelector(".orca-chat-status-label")!.textContent, "Can't reach Orca");
	}
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

test("New session: a mobile-scope pairing refusal Notices the re-pair hint", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const { client } = fakeCreateClient({
		listWorkspaces: async () => {
			throw new OrcaRemoteError("Method 'worktree.list' is not available to mobile clients");
		},
	});
	view.setClientForTest(client);
	view.setStoredSessionIdForTest(null);
	FakeNoticeLog.length = 0;
	await view.onNewSession();
	assert.deepEqual(FakeNoticeLog, [
		"Orca Chat needs the \"This computer only\" pairing link — re-pair from Orca's settings.",
	]);
	assert.equal(view.contentEl.querySelector(".orca-chat-status-label")!.textContent, "⚠ Session not created");
});

test("New session: a rejected pairing says to re-pair this computer", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const { client } = fakeCreateClient({
		listRepos: async () => {
			throw new OrcaRemoteError(REJECTIONS[0].message, REJECTIONS[0]);
		},
	});
	view.setClientForTest(client);
	view.setStoredSessionIdForTest(null);
	FakeNoticeLog.length = 0;
	await view.onNewSession();
	assert.deepEqual(FakeNoticeLog, [PAIRING_REJECTED_NOTICE]);
	assert.equal(view.contentEl.querySelector(".orca-chat-status-label")!.textContent, "⚠ Re-pair this computer");
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

// A desktop view backed by the fake app's real device storage (not the stored-id override), so the
// stored id goes through saveLastSessionId's queued read-modify-write like it does in Obsidian.
async function openDesktopViewWithData(data: { lastSessionId: string | null }) {
	const app = new App();
	app.vault.adapter = new obsidianFake.FileSystemAdapter("/vault");
	const plugin = new Plugin(app);
	app.saveLocalStorage(DEVICE_STORAGE_MIGRATED_KEY, true);
	app.saveLocalStorage(LAST_SESSION_ID_KEY, data.lastSessionId);
	const view = new OrcaChatView(new WorkspaceLeaf(), plugin);
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const storedId = async () => (app.loadLocalStorage(LAST_SESSION_ID_KEY) as string | null) ?? null;
	return { view, plugin, storedId };
}

// Holds this plugin's stored-id writes as `hold` says (a slow write, in Obsidian terms).
function holdSessionIdWrites(plugin: InstanceType<typeof Plugin>, hold: (write: () => void) => Promise<void>): void {
	const app = plugin.app;
	const realSave = app.saveLocalStorage.bind(app);
	app.saveLocalStorage = (key: string, data: unknown) =>
		key === LAST_SESSION_ID_KEY ? hold(() => void realSave(key, data)) : realSave(key, data);
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
	const heldSave = deferred<void>();
	let saves = 0;
	holdSessionIdWrites(plugin, async (write) => {
		if (saves++ === 0) await heldSave.promise; // the restore's clear lands late
		write();
	});
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
	const heldSave = deferred<void>();
	let saves = 0;
	holdSessionIdWrites(plugin, async (write) => {
		write();
		if (saves++ === 0) await heldSave.promise; // the restore's clear is stored but still pending
	});
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

// --- A restore that couldn't reach Orca is retried (final review I1) ---

// listAll fails `failures` times, then lists `tabs`.
function flakyList(failures: number, tabs: unknown[]) {
	let calls = 0;
	const listAllAgentSessionTabs = async () => {
		calls++;
		if (calls <= failures) throw new OrcaRemoteError("connect ECONNREFUSED");
		return tabs;
	};
	return { listAllAgentSessionTabs, calls: () => calls };
}

test("a restore that couldn't reach Orca is retried by the liveness tick and mounts once Orca answers", async () => {
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const list = flakyList(2, [{ sessionId: "s1", agent: "claude", title: "t" }]);
	view.setClientForTest({ listAllAgentSessionTabs: list.listAllAgentSessionTabs, disconnect: () => {} });
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(statusText(view), "Can't reach Orca");
	FakeNoticeLog.length = 0;
	await view.checkCurrentSession(); // Orca still down
	assert.equal(list.calls(), 2);
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(view.getStoredSessionIdForTest(), "s1");
	assert.deepEqual(FakeNoticeLog, [], "a failed retry is quiet");
	await view.checkCurrentSession(); // Orca is up
	assert.equal(view.getSelectedHandle(), "s1");
	assert.ok(view.contentEl.querySelector("webview.orca-chat-webview"));
	assert.equal(view.getStoredSessionIdForTest(), "s1");
});

test("the liveness tick stops retrying once a restore gets a definitive answer", async () => {
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const list = flakyList(1, []);
	view.setClientForTest({ listAllAgentSessionTabs: list.listAllAgentSessionTabs, disconnect: () => {} });
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	await view.checkCurrentSession(); // s1 is gone: cleared
	assert.equal(view.getStoredSessionIdForTest(), null);
	await view.checkCurrentSession();
	await view.checkCurrentSession();
	assert.equal(list.calls(), 2);
});

test("the liveness tick does not retry a restore that succeeded", async () => {
	const view = makeView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const list = flakyList(0, []);
	view.setClientForTest({ listAllAgentSessionTabs: list.listAllAgentSessionTabs, disconnect: () => {} });
	view.setStoredSessionIdForTest(null);
	await view.restoreLastSession();
	await view.checkCurrentSession();
	assert.equal(list.calls(), 0);
});

test("New session while a restore is pending reattaches a live stored session instead of creating one", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const list = flakyList(1, [{ sessionId: "s1", agent: "claude", title: "t" }]);
	const { client, calls } = fakeCreateClient({ listAllAgentSessionTabs: list.listAllAgentSessionTabs });
	view.setClientForTest(client);
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	assert.equal(view.getSelectedHandle(), null);
	FakeNoticeLog.length = 0;
	await view.onNewSession();
	assert.deepEqual(calls, []);
	assert.equal(view.getSelectedHandle(), "s1");
	assert.equal(view.getStoredSessionIdForTest(), "s1");
	assert.deepEqual(FakeNoticeLog, ["Orca Chat: reattached your previous session"]);
	assert.equal((view.contentEl.querySelector(".orca-chat-new-session") as HTMLButtonElement).disabled, false);
	// ...and the next click creates normally.
	await view.onNewSession();
	assert.ok(calls.includes("createClaudeSession"));
	assert.equal(view.getSelectedHandle(), "new1");
});

test("New session while a restore is pending and Orca still unreachable runs the create path and surfaces its error", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const list = flakyList(99, []);
	const { client, calls } = fakeCreateClient({
		listAllAgentSessionTabs: list.listAllAgentSessionTabs,
		listRepos: async () => {
			calls.push("listRepos");
			throw new OrcaRemoteError("connect ECONNREFUSED");
		},
	});
	view.setClientForTest(client);
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	FakeNoticeLog.length = 0;
	await view.onNewSession();
	assert.equal(list.calls(), 2, "the restore was tried again first");
	assert.deepEqual(calls, ["listRepos"]);
	assert.deepEqual(FakeNoticeLog, ["connect ECONNREFUSED"]);
	assert.equal(statusText(view), "⚠ Session not created");
	assert.equal(view.getStoredSessionIdForTest(), "s1");
	// Still pending: the tick keeps trying.
	await view.checkCurrentSession();
	assert.equal(list.calls(), 3);
	assert.equal(view.getStoredSessionIdForTest(), "s1");
});

test("New session while a restore is pending and the stored session is gone creates a new one", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const list = flakyList(1, []);
	const { client, calls } = fakeCreateClient({ listAllAgentSessionTabs: list.listAllAgentSessionTabs });
	view.setClientForTest(client);
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession();
	FakeNoticeLog.length = 0;
	await view.onNewSession();
	assert.ok(calls.includes("createClaudeSession"));
	assert.equal(view.getSelectedHandle(), "new1");
	assert.equal(view.getStoredSessionIdForTest(), "new1");
	assert.deepEqual(FakeNoticeLog, []);
});

// The tick's retry starts listing before the click; the click's own retry fails (Orca flapping) so
// it goes on to create; the tick's list then finds s1 alive. Mounting s1 there would reattach it
// only for the create to replace it a moment later, leaving s1 untracked — the tick must stand down.
test("a tick restore that answers while New session is creating doesn't mount the stored session", async () => {
	const view = makeDesktopView();
	await view.onOpen();
	view.setCredentialForTest(FAKE_CREDENTIAL);
	const tickListed = deferred<unknown[]>();
	const created = deferred<{ sessionId: string }>();
	let listCalls = 0;
	const { client, calls } = fakeCreateClient({
		listAllAgentSessionTabs: () => {
			listCalls++;
			if (listCalls === 2) return tickListed.promise; // the tick's retry
			return Promise.reject(new OrcaRemoteError("connect ECONNREFUSED")); // open, and the click's retry
		},
		createClaudeSession: () => {
			calls.push("createClaudeSession");
			return created.promise;
		},
	});
	view.setClientForTest(client);
	view.setStoredSessionIdForTest("s1");
	await view.restoreLastSession(); // Orca unreachable: restore pending
	FakeNoticeLog.length = 0;
	const ticking = view.checkCurrentSession();
	await flush();
	assert.equal(listCalls, 2, "the tick's restore is listing");
	const creating = view.onNewSession();
	await flush();
	assert.equal(listCalls, 3, "the click retried the restore first");
	assert.ok(calls.includes("createClaudeSession"), "the click went on to create");
	tickListed.resolve([{ sessionId: "s1", agent: "claude", title: "t" }]);
	await ticking;
	await flush();
	assert.equal(view.getSelectedHandle(), null, "the tick didn't mount s1 under the running create");
	assert.equal(view.contentEl.querySelector("webview"), null);
	assert.equal(view.getStoredSessionIdForTest(), "s1");
	created.resolve({ sessionId: "new1" });
	await creating;
	assert.equal(view.getSelectedHandle(), "new1");
	assert.equal(view.contentEl.querySelector("webview")?.getAttribute("data-orca-session-id"), "new1");
	assert.equal(view.getStoredSessionIdForTest(), "new1");
	assert.ok(!FakeNoticeLog.some((m) => /reattach/i.test(m)), `unexpected Notice: ${FakeNoticeLog.join(" | ")}`);
});

// --- Stored-id clears only clear the id they found dead (final review M1) ---

// Pane A clicks New session with Z stored and closes; the reopened pane B's slow restore reads Z;
// A's late session X is stored (Z still stored); B's list then says Z is gone. B must not erase X.
test("a slow restore that read a dead id doesn't erase a session stored after it read", async () => {
	const { view: paneA, plugin, storedId } = await openDesktopViewWithData({ lastSessionId: "Z" });
	const created = deferred<{ sessionId: string }>();
	paneA.setClientForTest(fakeCreateClient({ createClaudeSession: () => created.promise }).client);
	const creating = paneA.onNewSession();
	await flush();
	await paneA.onClose();
	const paneB = new OrcaChatView(new WorkspaceLeaf(), plugin);
	await paneB.onOpen();
	paneB.setCredentialForTest(FAKE_CREDENTIAL);
	const listed = deferred<unknown[]>();
	paneB.setClientForTest({ listAllAgentSessionTabs: () => listed.promise, disconnect: () => {} });
	const restoring = paneB.restoreLastSession();
	await flush(); // B has read Z and is listing
	created.resolve({ sessionId: "X" });
	await creating;
	await flush();
	assert.equal(await storedId(), "X");
	listed.resolve([]); // Z is gone
	await restoring;
	await flush();
	assert.equal(await storedId(), "X");
});

// The other order: B clears the dead Z first, then A's late X arrives. X is kept (nothing newer).
test("a session created after close is kept when the stored id was cleared meanwhile", async () => {
	const { view: paneA, plugin, storedId } = await openDesktopViewWithData({ lastSessionId: "Z" });
	const created = deferred<{ sessionId: string }>();
	paneA.setClientForTest(fakeCreateClient({ createClaudeSession: () => created.promise }).client);
	const creating = paneA.onNewSession();
	await flush();
	await paneA.onClose();
	const paneB = new OrcaChatView(new WorkspaceLeaf(), plugin);
	await paneB.onOpen();
	paneB.setCredentialForTest(FAKE_CREDENTIAL);
	paneB.setClientForTest({ listAllAgentSessionTabs: async () => [], disconnect: () => {} });
	await paneB.restoreLastSession();
	await flush();
	assert.equal(await storedId(), null);
	created.resolve({ sessionId: "X" });
	await creating;
	await flush();
	assert.equal(await storedId(), "X");
});

test("the liveness check's clear doesn't erase an id stored after the session was mounted", async () => {
	const { view, plugin, storedId } = await openDesktopViewWithData({ lastSessionId: "s1" });
	let listAll = async () => [{ sessionId: "s1", agent: "claude", title: "t" }] as unknown[];
	view.setClientForTest({ listAllAgentSessionTabs: () => listAll(), disconnect: () => {} });
	await view.restoreLastSession();
	assert.equal(view.getSelectedHandle(), "s1");
	listAll = async () => [];
	plugin.app.saveLocalStorage(LAST_SESSION_ID_KEY, "other"); // e.g. another pane
	await view.checkCurrentSession();
	assert.equal(view.getSelectedHandle(), null);
	assert.equal(await storedId(), "other");
});

// --- A failed stored-id write after Orca created the session (final review M2) ---

test("New session: a stored-id write failure still mounts the created chat and says it won't be remembered", async () => {
	const { view, plugin } = await openDesktopViewWithData({ lastSessionId: null });
	view.setClientForTest(fakeCreateClient().client);
	holdSessionIdWrites(plugin, async () => {
		throw new Error("quota exceeded");
	});
	FakeNoticeLog.length = 0;
	const originalError = console.error;
	console.error = () => {};
	try {
		await view.onNewSession();
	} finally {
		console.error = originalError;
	}
	assert.equal(view.getSelectedHandle(), "new1");
	assert.ok(view.contentEl.querySelector("webview.orca-chat-webview"));
	assert.equal(statusText(view), "Connecting…");
	assert.deepEqual(FakeNoticeLog, ["Orca Chat: chat created, but this pane couldn't remember it after a restart"]);
});

// --- Re-pairing refreshes open panes (final review M4) ---

test("reloadCredential picks up a pairing saved after the pane opened", async () => {
	const app = new App();
	app.vault.adapter = new obsidianFake.FileSystemAdapter("/vault");
	const plugin = new Plugin(app);
	const view = new OrcaChatView(new WorkspaceLeaf(), plugin);
	await view.onOpen();
	await flush();
	FakeNoticeLog.length = 0;
	await view.onNewSession();
	assert.ok(FakeNoticeLog.some((m) => /Not paired/.test(m)), "unpaired before the reload");
	const { savePairedCredential } = await import("../src/orca-pairing.ts");
	await savePairedCredential(plugin as never, FAKE_CREDENTIAL as never);
	await view.reloadCredential();
	assert.equal(statusText(view), "No session yet");
	FakeNoticeLog.length = 0;
	const { client, calls } = fakeCreateClient();
	view.setClientForTest(client); // stands in for the reachable Orca the new pairing points at
	await view.onNewSession();
	assert.ok(!FakeNoticeLog.some((m) => /Not paired/.test(m)), FakeNoticeLog.join(" | "));
	assert.ok(calls.includes("createClaudeSession"));
	await view.onClose();
});

// main.ts's Pair with Orca callback: refresh every open Orca Chat pane, and only those.
test("reloadChatViewCredentials reloads only Orca Chat panes, and one failing doesn't stop the others", async () => {
	const { reloadChatViewCredentials } = await import("../src/chat-view.ts");
	const reloaded: string[] = [];
	const failing = makeView();
	failing.reloadCredential = async () => {
		reloaded.push("failing");
		throw new Error("loadData failed");
	};
	const ok = makeView();
	ok.reloadCredential = async () => void reloaded.push("ok");
	// Another view type that happens to have the same method name must be left alone.
	const other = { reloadCredential: async () => void reloaded.push("other") };
	const leaves = [{ view: failing }, { view: other }, { view: ok }];
	const requested: string[] = [];
	const workspace = {
		getLeavesOfType: (type: string) => {
			requested.push(type);
			return leaves;
		},
	};
	await assert.rejects(reloadChatViewCredentials(workspace as never), /loadData failed/);
	assert.deepEqual(requested, [ORCA_CHAT_VIEW_TYPE]);
	assert.deepEqual(reloaded.sort(), ["failing", "ok"]);
	reloaded.length = 0;
	leaves.splice(0, 1);
	await reloadChatViewCredentials(workspace as never);
	assert.deepEqual(reloaded, ["ok"]);
});
