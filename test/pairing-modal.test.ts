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
// can't work with it; the modal walks through getting the right ("This computer only") link.
test("the pairing modal lists the four steps for getting a \"This computer only\" link, above the input", () => {
	const modal = new PairingModal(new App(), new Plugin(new App()));
	modal.open();
	const steps = Array.from(modal.contentEl.querySelectorAll("ol > li")).map((li) => li.textContent);
	assert.deepEqual(steps, [
		"In Orca, open Settings and find \"Remote server workflow\".",
		"Choose \"Share this host\".",
		"Under \"Where will this link be opened?\", pick \"This computer only\" (not Orca Mobile).",
		"Generate the link, then paste it below. Use only the newest link.",
	]);
	const list = modal.contentEl.querySelector("ol")!;
	const input = modal.contentEl.querySelector("input")!;
	assert.ok(list.compareDocumentPosition(input) & 4 /* DOCUMENT_POSITION_FOLLOWING */, "steps come before the input");
});

const { encodePairingOffer } = await import("../src/orca-remote/pairing.ts");
const { FakeOrcaServer } = await import("../test-e2e/protocol/fake-orca-server.ts");

async function validPairingUrl(): Promise<string> {
	const server = await FakeOrcaServer.start();
	try {
		return encodePairingOffer(server.credential);
	} finally {
		await server.stop();
	}
}

async function submit(modal: InstanceType<typeof PairingModal>, url: string) {
	modal.open();
	modal.contentEl.querySelector("input")!.value = url;
	(modal.contentEl.querySelector("button.mod-cta") as HTMLButtonElement).click();
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

// Open Orca Chat panes read the pairing once, when they open; a successful pair tells them to
// re-read it, so a re-pair (say, from the mobile link to "This computer only") takes effect at once.
test("a successful pair calls onPaired after saving the credential", async () => {
	const plugin = new Plugin(new App());
	const seen: unknown[] = [];
	const modal = new PairingModal(new App(), plugin, async () => {
		seen.push(((await plugin.loadData()) as { pairedCredential?: unknown }).pairedCredential);
	});
	await submit(modal, await validPairingUrl());
	assert.equal(seen.length, 1);
	assert.ok(seen[0], "the credential was saved before onPaired ran");
});

// The pair itself succeeded; only refreshing open panes failed, so don't say pairing failed.
test("a pair whose pane refresh fails says so once, not that pairing failed, and keeps the credential", async () => {
	const { FakeNoticeLog } = obsidianFake;
	const plugin = new Plugin(new App());
	const modal = new PairingModal(new App(), plugin, async () => {
		throw new Error("loadData failed");
	});
	const url = await validPairingUrl();
	FakeNoticeLog.length = 0;
	const logged: unknown[][] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => void logged.push(args);
	try {
		await submit(modal, url);
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(FakeNoticeLog, [
		"Paired with Orca",
		"Paired with Orca, but open Orca Chat panes couldn't refresh — reopen the pane.",
	]);
	assert.ok(((await plugin.loadData()) as { pairedCredential?: unknown }).pairedCredential, "credential still saved");
	assert.equal(logged.length, 1);
	assert.ok(!logged[0].map(String).join(" ").includes(url), "the pairing URL isn't logged");
});

test("a failed pair doesn't call onPaired", async () => {
	let calls = 0;
	const modal = new PairingModal(new App(), new Plugin(new App()), () => void calls++);
	await submit(modal, "orca://pair?code=not-valid");
	assert.equal(calls, 0);
});
