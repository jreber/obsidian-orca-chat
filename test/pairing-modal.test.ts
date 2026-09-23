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

test("a failed pair doesn't call onPaired", async () => {
	let calls = 0;
	const modal = new PairingModal(new App(), new Plugin(new App()), () => void calls++);
	await submit(modal, "orca://pair?code=not-valid");
	assert.equal(calls, 0);
});
