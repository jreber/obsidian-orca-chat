// The "Add chat guidelines to AGENTS.md" command in a real Obsidian, against the vault root on disk.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/obsidian-fixture";
import { screenshotWindow } from "./helpers/pane";
import { guidelinesBlock } from "../src/agents-guidance";

const runCommand = (obsidian: Page) =>
	obsidian.evaluate(() =>
		(window as unknown as { app: { commands: { executeCommandById: (id: string) => boolean } } }).app.commands.executeCommandById(
			"orca-chat:add-chat-guidelines",
		),
	);

test("Add chat guidelines creates AGENTS.md at the vault root once, then leaves it alone", async ({ obsidian, vaultDir }) => {
	const agentsFile = path.join(vaultDir, "AGENTS.md");
	expect(existsSync(agentsFile)).toBe(false);
	expect(existsSync(path.join(vaultDir, "CLAUDE.md"))).toBe(false);

	expect(await runCommand(obsidian)).toBe(true);
	const created = obsidian.locator(".notice", { hasText: "created AGENTS.md with the chat guidelines" });
	await expect(created).toBeVisible();
	// No CLAUDE.md in the vault: the Notice says how to have Claude Code read AGENTS.md.
	await expect(created).toContainText('add a line "@AGENTS.md"');
	await screenshotWindow(obsidian, "agents-guidance-created");
	await expect.poll(() => existsSync(agentsFile)).toBe(true);
	const first = readFileSync(agentsFile);
	expect(first.toString("utf8")).toBe(guidelinesBlock("\n"));
	expect(existsSync(path.join(vaultDir, "CLAUDE.md")), "CLAUDE.md is never created").toBe(false);

	expect(await runCommand(obsidian)).toBe(true);
	await expect(obsidian.locator(".notice", { hasText: "already there" })).toBeVisible();
	expect(readFileSync(agentsFile).equals(first), "AGENTS.md is byte-identical after the second run").toBe(true);
});
