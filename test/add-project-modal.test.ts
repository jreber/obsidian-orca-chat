// Exercises AddProjectModal without a live Obsidian runtime, via test/fakes/obsidian.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });

const obsidianFake = await import("./fakes/obsidian.ts");
obsidianFake.installDomExtensions();
const { App, Modal } = obsidianFake;
const { confirmAddVaultProject } = await import("../src/add-project-modal.ts");

// Opens the prompt, hands back the modal and counts close() calls on it.
function openPrompt() {
	const originalOpen = Modal.prototype.open;
	const captured: { modal: InstanceType<typeof Modal> | null; closes: number } = { modal: null, closes: 0 };
	Modal.prototype.open = function (this: InstanceType<typeof Modal>) {
		captured.modal = this;
		const originalClose = this.close.bind(this);
		this.close = () => {
			captured.closes++;
			originalClose();
		};
		originalOpen.call(this);
	};
	try {
		const answer = confirmAddVaultProject(new App(), "Vault", "/vault");
		return { answer, captured };
	} finally {
		Modal.prototype.open = originalOpen;
	}
}

const button = (modal: InstanceType<typeof Modal>, text: string) =>
	[...modal.contentEl.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;

test("dismissing the prompt (Escape, click outside) declines without closing it again from onClose", async () => {
	const { answer, captured } = openPrompt();
	captured.modal!.close(); // what Obsidian does on Escape
	assert.equal(await answer, false);
	assert.equal(captured.closes, 1);
});

test("Add to Orca confirms and closes the prompt once", async () => {
	const { answer, captured } = openPrompt();
	button(captured.modal!, "Add to Orca").click();
	assert.equal(await answer, true);
	assert.equal(captured.closes, 1);
});

test("Cancel declines and closes the prompt once", async () => {
	const { answer, captured } = openPrompt();
	button(captured.modal!, "Cancel").click();
	assert.equal(await answer, false);
	assert.equal(captured.closes, 1);
});
