// The host half of wikilinks in the embedded chat: what the pane accepts from the guest page (whose
// content the agent influences, so every message is untrusted), how it answers dead-link checks, and
// where a clicked note opens.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event });

const { Events, FakeNoticeLog, WorkspaceLeaf } = await import("./fakes/obsidian.ts");
const {
	WIKILINK_CHECK_MARKER,
	WIKILINK_OPEN_MARKER,
	interceptWikilinks,
	openWikilink,
	parseWikilinkCheck,
	parseWikilinkOpen,
	unresolvedLinks,
	wikilinkMarkScript,
} = await import("../src/wikilinks.ts");

const open = (payload: unknown) => WIKILINK_OPEN_MARKER + (typeof payload === "string" ? payload : JSON.stringify(payload));
const check = (payload: unknown) => WIKILINK_CHECK_MARKER + (typeof payload === "string" ? payload : JSON.stringify(payload));

test("a well-formed open message yields its link", () => {
	assert.equal(parseWikilinkOpen(open({ link: "Welcome" })), "Welcome");
	assert.equal(parseWikilinkOpen(open({ link: "Folder/Note#Heading" })), "Folder/Note#Heading");
});

test("malformed, oversized, non-string and control-character open messages are ignored", () => {
	for (const message of [
		undefined,
		42,
		"Welcome",
		"orca-chat:obsidian-link:obsidian://open?file=x",
		open("{not json"),
		open("null"),
		open('"Welcome"'),
		open(["Welcome"]),
		open({}),
		open({ link: 5 }),
		open({ link: "" }),
		open({ link: "   " }),
		open({ link: "a".repeat(513) }),
		open({ link: "Wel\ncome" }),
		open({ link: "Wel\u0000come" }),
		open({ link: "Wel\u007fcome" }),
		open({ link: "Welcome" }) + "x".repeat(10_000),
	]) {
		assert.equal(parseWikilinkOpen(message), null, `rejects ${JSON.stringify(message)?.slice(0, 80)}`);
	}
	assert.equal(parseWikilinkOpen(open({ link: "a".repeat(512) })), "a".repeat(512));
});

test("a check message yields its valid targets; bad ones are dropped, bad messages ignored", () => {
	assert.deepEqual(parseWikilinkCheck(check(["Welcome", "Nope"])), ["Welcome", "Nope"]);
	assert.deepEqual(parseWikilinkCheck(check(["Welcome", 5, "", "x\ny", "a".repeat(513), "Nope"])), ["Welcome", "Nope"]);
	for (const message of [null, "Welcome", check("{"), check({ link: "x" }), check("\"x\""), check(Array.from({ length: 201 }, (_, i) => `n${i}`))]) {
		assert.equal(parseWikilinkCheck(message), null);
	}
	assert.equal(parseWikilinkCheck(check(Array.from({ length: 200 }, (_, i) => `n${i}`)))?.length, 200);
});

test("unresolvedLinks resolves each link by its path, without the heading", () => {
	const asked: string[] = [];
	const result = unresolvedLinks(["Welcome#Setup", "Nope", "Welcome"], (linkpath) => {
		asked.push(linkpath);
		return linkpath === "Welcome";
	});
	assert.deepEqual(result, ["Nope"]);
	assert.deepEqual(asked, ["Welcome", "Nope", "Welcome"]);
});

test("the mark script embeds the targets as JSON data, not code", () => {
	const script = wikilinkMarkScript(['"); alert(1); ("', "</script>"]);
	assert.match(script, /__orcaWikilinksMark/);
	const json = script.slice(script.indexOf("(") + 1, script.lastIndexOf(")"));
	assert.ok(script.includes(JSON.stringify(['"); alert(1); ("', "</script>"])));
	assert.ok(json.length > 0);
});

type Call = [string, ...unknown[]];

function fakeApp(opts: { recent: unknown; resolves?: (p: string) => boolean }) {
	const calls: Call[] = [];
	const rootSplit = { root: true };
	const app = {
		vault: new Events(),
		metadataCache: Object.assign(new Events(), {
			getFirstLinkpathDest: (linkpath: string, source: string) => {
				calls.push(["getFirstLinkpathDest", linkpath, source]);
				return (opts.resolves ?? (() => true))(linkpath) ? { path: `${linkpath}.md` } : null;
			},
		}),
		workspace: {
			rootSplit,
			getMostRecentLeaf: (root?: unknown) => {
				calls.push(["getMostRecentLeaf", root === rootSplit ? "rootSplit" : root]);
				return opts.recent;
			},
			setActiveLeaf: (leaf: unknown, params?: unknown) => void calls.push(["setActiveLeaf", leaf, params]),
			openLinkText: async (link: string, source: string, newLeaf?: unknown) => void calls.push(["openLinkText", link, source, newLeaf]),
		},
	};
	return { app, calls };
}

const leafOfType = (type: string) => Object.assign(new WorkspaceLeaf(), { view: { getViewType: () => type } });

test("a click opens the note in the most recent main-area leaf, made active first", async () => {
	const chat = leafOfType("orca-chat-view");
	const main = leafOfType("markdown");
	const { app, calls } = fakeApp({ recent: main });
	await openWikilink(app as never, chat as never, "Welcome#Setup");
	assert.deepEqual(calls, [
		["getFirstLinkpathDest", "Welcome", ""],
		["getMostRecentLeaf", "rootSplit"],
		["setActiveLeaf", main, { focus: true }],
		["openLinkText", "Welcome#Setup", "", false],
	]);
});

test("the chat leaf itself is never navigated: a new tab opens instead", async () => {
	const chat = leafOfType("orca-chat-view");
	for (const recent of [chat, leafOfType("orca-chat-view"), null]) {
		const { app, calls } = fakeApp({ recent });
		await openWikilink(app as never, chat as never, "Welcome");
		assert.deepEqual(
			calls.filter((c) => c[0] === "setActiveLeaf" || c[0] === "openLinkText"),
			[["openLinkText", "Welcome", "", "tab"]],
		);
	}
});

test("a note that isn't in the vault shows a Notice and opens (or creates) nothing", async () => {
	const { app, calls } = fakeApp({ recent: leafOfType("markdown"), resolves: () => false });
	FakeNoticeLog.length = 0;
	await openWikilink(app as never, leafOfType("orca-chat-view") as never, "Missing note#Part");
	assert.deepEqual(FakeNoticeLog, ['Orca Chat: no note named "Missing note" in this vault']);
	assert.deepEqual(calls.filter((c) => c[0] !== "getFirstLinkpathDest"), []);
});

function fakeWebview() {
	const webview = document.createElement("webview") as HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> };
	const scripts: string[] = [];
	webview.executeJavaScript = async (code: string) => void scripts.push(code);
	const say = (message: unknown) => {
		const event = new Event("console-message");
		(event as unknown as { message: unknown }).message = message;
		webview.dispatchEvent(event);
	};
	return { webview, scripts, say };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("interceptWikilinks injects the guest script on dom-ready", () => {
	const { webview, scripts } = fakeWebview();
	const { app } = fakeApp({ recent: null });
	interceptWikilinks(webview, app as never, leafOfType("orca-chat-view") as never);
	webview.dispatchEvent(new Event("dom-ready"));
	assert.equal(scripts.length, 1);
	assert.match(scripts[0], /__orcaWikilinksInstalled/);
});

test("interceptWikilinks answers a check with the unresolved targets only", async () => {
	const { webview, scripts, say } = fakeWebview();
	const { app } = fakeApp({ recent: null, resolves: (p) => p === "Welcome" });
	interceptWikilinks(webview, app as never, leafOfType("orca-chat-view") as never);
	say(check(["Welcome", "Nope#x", "Other"]));
	await flush();
	assert.deepEqual(scripts, [wikilinkMarkScript(["Nope#x", "Other"])]);
	// All resolve: nothing to send.
	say(check(["Welcome"]));
	say(check("garbage"));
	await flush();
	assert.equal(scripts.length, 1);
});

test("interceptWikilinks opens a clicked link, and ignores anything malformed", async () => {
	const { webview, say } = fakeWebview();
	const main = leafOfType("markdown");
	const { app, calls } = fakeApp({ recent: main });
	interceptWikilinks(webview, app as never, leafOfType("orca-chat-view") as never);
	say(open({ link: "Wel\u0007come" }));
	say(open("{"));
	say("orca-chat:obsidian-link:obsidian://open?file=Welcome");
	await flush();
	assert.deepEqual(calls, []);
	say(open({ link: "Welcome" }));
	await flush();
	assert.deepEqual(calls.at(-1), ["openLinkText", "Welcome", "", false]);
});

test("a vault change re-checks the page's targets and sends only what changed, both ways", async () => {
	const { webview, scripts, say } = fakeWebview();
	const existing = new Set(["Welcome", "Gone"]);
	const { app } = fakeApp({ recent: null, resolves: (p) => existing.has(p) });
	const stop = interceptWikilinks(webview, app as never, leafOfType("orca-chat-view") as never);
	say(check(["Welcome", "Gone", "Plan#Steps"]));
	await flush();
	assert.deepEqual(scripts, [wikilinkMarkScript(["Plan#Steps"])]);

	// The agent creates Plan.md and deletes Gone.md.
	existing.add("Plan");
	existing.delete("Gone");
	app.vault.trigger("create");
	app.metadataCache.trigger("resolved");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.deepEqual(scripts.slice(1), [wikilinkMarkScript(["Gone"], ["Plan#Steps"])], "one debounced update");

	// Nothing changed since: nothing sent.
	app.metadataCache.trigger("resolved");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(scripts.length, 2);

	stop();
	assert.equal(app.vault.listenerCount() + app.metadataCache.listenerCount(), 0, "stop() removes every listener");
	existing.delete("Welcome");
	app.vault.trigger("delete");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(scripts.length, 2);
});

test("a rejected injection is caught (the guest navigated or the webview went away)", async () => {
	const { webview } = fakeWebview();
	webview.executeJavaScript = () => Promise.reject(new Error("gone"));
	const { app } = fakeApp({ recent: null, resolves: () => false });
	let unhandled = 0;
	const onUnhandled = () => void unhandled++;
	process.on("unhandledRejection", onUnhandled);
	try {
		interceptWikilinks(webview, app as never, leafOfType("orca-chat-view") as never);
		webview.dispatchEvent(new Event("dom-ready"));
		const event = new Event("console-message");
		(event as unknown as { message: unknown }).message = check(["Nope"]);
		webview.dispatchEvent(event);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(unhandled, 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
