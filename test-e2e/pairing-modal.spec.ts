import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./helpers/obsidian-fixture";
import { screenshotWindow } from "./helpers/pane";

const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../manifest.json"), "utf8")) as { version: string };

// The Pair with Orca dialog walks the user to the "This computer only" link a New session needs.
test("Pair with Orca shows the four steps above the paste box", async ({ obsidian }) => {
	await obsidian.evaluate(() =>
		(window as unknown as { app: { commands: { executeCommandById: (id: string) => boolean } } }).app.commands.executeCommandById(
			"orca-chat:pair-with-orca",
		),
	);
	const modal = obsidian.locator(".modal", { hasText: "Pair with Orca" });
	await expect(modal).toBeVisible();

	const steps = modal.locator("ol > li");
	await expect(steps).toHaveText([
		'In Orca, open Settings and find "Remote server workflow".',
		'Choose "Share this host".',
		'Under "Where will this link be opened?", pick "This computer only".',
		'Click "Generate Access Link", then paste the link below. Use only the newest link.',
	]);

	// Steps read top to bottom, then the paste box, then the Pair button, then the version footer.
	const listBox = await modal.locator("ol").boundingBox();
	const inputBox = await modal.locator("input").boundingBox();
	const buttonBox = await modal.getByRole("button", { name: "Pair" }).boundingBox();
	expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(inputBox!.y);
	expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(buttonBox!.y);
	// Last, a small footer naming the installed version and build.
	const footer = modal.locator(".orca-chat-version");
	await expect(footer).toHaveText(new RegExp(`^Orca Chat v${manifest.version.replace(/\./g, "\\.")} \\(([0-9a-f]{7,}(-dirty)?|unknown)\\)$`));
	const footerBox = await footer.boundingBox();
	expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(footerBox!.y);
	// Nothing is clipped: the dialog is at least as wide as its content.
	const overflow = await modal.evaluate((el) => el.scrollWidth - el.clientWidth);
	expect(overflow).toBeLessThanOrEqual(0);

	await screenshotWindow(obsidian, "pairing-modal");
});
