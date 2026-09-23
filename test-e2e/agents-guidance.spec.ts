// The pane's "Append AGENTS.md advice" button in a real Obsidian, against the vault root on disk.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/obsidian-fixture";
import { expectStatusFits, newSessionButton, screenshotPane, statusLabel } from "./helpers/pane";
import { adviceBlock, ADVICE_START } from "../src/agents-guidance";

const adviceButton = (obsidian: Page) => obsidian.locator(".orca-chat-agents-advice");

// Both buttons are whole, inside the pane, side by side or wrapped, and nothing scrolls sideways.
async function expectHeaderFits(obsidian: Page): Promise<void> {
	const layout = await obsidian.locator(".orca-chat-view").evaluate((view) => {
		const rect = (sel: string) => view.querySelector(sel)!.getBoundingClientRect();
		const header = view.querySelector(".orca-chat-header-row") as HTMLElement;
		const box = view.getBoundingClientRect();
		const buttons = [".orca-chat-new-session", ".orca-chat-agents-advice"].map((sel) => {
			const el = view.querySelector(sel) as HTMLElement;
			const r = rect(sel);
			return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, clipped: el.scrollWidth > el.clientWidth };
		});
		return {
			pane: { left: box.left, right: box.right },
			headerOverflow: header.scrollWidth - header.clientWidth,
			viewOverflow: view.scrollWidth - view.clientWidth,
			buttons,
		};
	});
	expect(layout.headerOverflow, JSON.stringify(layout)).toBeLessThanOrEqual(0);
	expect(layout.viewOverflow, JSON.stringify(layout)).toBeLessThanOrEqual(0);
	for (const b of layout.buttons) {
		expect(b.clipped, JSON.stringify(layout)).toBe(false);
		expect(b.left).toBeGreaterThanOrEqual(layout.pane.left);
		expect(b.right).toBeLessThanOrEqual(layout.pane.right + 0.5);
	}
	const [a, b] = layout.buttons;
	const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
	expect(overlap, "the buttons don't overlap").toBe(false);
}

async function setSidebarWidth(obsidian: Page, width: number): Promise<void> {
	await obsidian.evaluate((w) => {
		const split = (window as unknown as { app: { workspace: { rightSplit: { setSize?: (w: number) => void; containerEl: HTMLElement } } } }).app
			.workspace.rightSplit;
		if (split.setSize) split.setSize(w);
		else split.containerEl.style.width = `${w}px`;
	}, width);
	await expect.poll(() => obsidian.locator(".orca-chat-view").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBeLessThanOrEqual(width);
}

test("Append AGENTS.md advice writes the vault root's AGENTS.md: added once, then updated in place", async ({ obsidian, vaultDir }) => {
	const agentsFile = path.join(vaultDir, "AGENTS.md");
	expect(existsSync(agentsFile)).toBe(false);

	// Beside New session, same style, and the header fits at the default sidebar width.
	await expect(adviceButton(obsidian)).toHaveText("Append AGENTS.md advice");
	expect(await adviceButton(obsidian).getAttribute("class")).toContain("mod-cta");
	expect(await newSessionButton(obsidian).evaluate((el) => el.nextElementSibling?.classList.contains("orca-chat-agents-advice"))).toBe(true);
	await expectHeaderFits(obsidian);
	await expectStatusFits(obsidian);
	await screenshotPane(obsidian, "agents-advice-header");

	await adviceButton(obsidian).click();
	await expect(obsidian.locator(".notice", { hasText: "Added Orca Chat advice to AGENTS.md" })).toBeVisible();
	await expect.poll(() => existsSync(agentsFile)).toBe(true);
	expect(readFileSync(agentsFile, "utf8")).toBe(adviceBlock("\n"));
	expect(existsSync(path.join(vaultDir, "CLAUDE.md"))).toBe(false);

	// The user's own text around a stale block: the block is replaced in place, the rest kept.
	const mine = "# My agent notes\n\nKeep answers short.\n\n";
	const after = "\n\n## Later section\n\nStill mine.\n";
	writeFileSync(agentsFile, `${mine}${ADVICE_START}\nstale advice\n<!-- orca-chat:advice:end -->${after}`);
	await adviceButton(obsidian).click();
	await expect(obsidian.locator(".notice", { hasText: "Updated Orca Chat advice in AGENTS.md" })).toBeVisible();
	await expect.poll(() => readFileSync(agentsFile, "utf8")).toBe(`${mine}${adviceBlock("\n").slice(0, -1)}${after}`);

	// Again: nothing duplicated, file byte-identical.
	const before = readFileSync(agentsFile);
	await adviceButton(obsidian).click();
	await expect(obsidian.locator(".notice", { hasText: "Updated Orca Chat advice in AGENTS.md" }).first()).toBeVisible();
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(readFileSync(agentsFile).equals(before)).toBe(true);
	expect(readFileSync(agentsFile, "utf8").split(ADVICE_START)).toHaveLength(2);

	// A narrow pane: the buttons wrap instead of overflowing.
	await setSidebarWidth(obsidian, 220);
	await expectHeaderFits(obsidian);
	await expect(statusLabel(obsidian)).toBeVisible();
	await expect(obsidian.locator(".notice"), "notices gone before the screenshot").toHaveCount(0, { timeout: 15_000 });
	await screenshotPane(obsidian, "agents-advice-header-narrow");
});
