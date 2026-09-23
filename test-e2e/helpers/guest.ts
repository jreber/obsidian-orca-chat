// Reading and driving the page inside the chat pane's <webview> (the guest), plus the workspace
// leaves around it.
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { SCREENSHOT_DIR } from "./pane";

export type Anchor = { parent: string; link: string; text: string; dead: boolean; title: string | null };

// Runs `code` inside the guest page.
export function inGuest<T>(obsidian: Page, code: string): Promise<T> {
	return obsidian.evaluate(async (js) => {
		const webview = document.querySelector("webview.orca-chat-webview") as HTMLElement & {
			executeJavaScript: (code: string) => Promise<unknown>;
		};
		return webview.executeJavaScript(js);
	}, code) as Promise<T>;
}

export const guestAnchors = (obsidian: Page) =>
	inGuest<Anchor[]>(
		obsidian,
		`Array.from(document.querySelectorAll("a.orca-wikilink")).map((a) => ({
			parent: a.parentElement.id,
			link: a.getAttribute("data-orca-link"),
			text: a.textContent,
			dead: a.classList.contains("is-unresolved"),
			title: a.getAttribute("title"),
		}))`,
	);

export async function captureGuest(obsidian: Page, name: string): Promise<void> {
	if (!SCREENSHOT_DIR) return;
	const png = await obsidian.evaluate(async () => {
		const webview = document.querySelector("webview.orca-chat-webview") as HTMLElement & {
			capturePage: () => Promise<{ toDataURL: () => string }>;
		};
		return (await webview.capturePage()).toDataURL();
	});
	writeFileSync(path.join(SCREENSHOT_DIR, `${name}.png`), Buffer.from(png.split(",")[1], "base64"));
}

export type LeafInfo = { type: string; file: string | null; inMain: boolean; active: boolean };

// Every leaf: its view type, open file, whether it is in the main editor area, and whether active.
export const leaves = (obsidian: Page) =>
	obsidian.evaluate(() => {
		type Leaf = { view: { getViewType: () => string; file?: { path: string } | null }; getRoot: () => unknown };
		const ws = (window as unknown as {
			app: { workspace: { rootSplit: unknown; activeLeaf: Leaf | null; iterateAllLeaves: (cb: (leaf: Leaf) => void) => void } };
		}).app.workspace;
		const out: LeafInfo[] = [];
		// A truthy return would stop the iteration: keep the callback's body a statement.
		ws.iterateAllLeaves((leaf) => {
			out.push({
				type: leaf.view.getViewType(),
				file: leaf.view.file?.path ?? null,
				inMain: leaf.getRoot() === ws.rootSplit,
				active: leaf === ws.activeLeaf,
			});
		});
		return out;
	});

// A click inside the webview makes the chat's leaf the active one; do the same before clicking.
export const activateChatLeaf = (obsidian: Page) =>
	obsidian.evaluate(() => {
		const ws = (window as unknown as {
			app: { workspace: { getLeavesOfType: (t: string) => unknown[]; setActiveLeaf: (l: unknown, p: unknown) => void } };
		}).app.workspace;
		ws.setActiveLeaf(ws.getLeavesOfType("orca-chat-view")[0], { focus: true });
	});
