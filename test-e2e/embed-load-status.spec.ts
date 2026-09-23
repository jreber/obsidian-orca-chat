import { writeFileSync } from "node:fs";
import { test, expect } from "./helpers/obsidian-fixture";
import { SCREENSHOT_DIR, screenshotPane, startNewSession, statusLabel } from "./helpers/pane";

test("a 404 from Orca's embed page is reported as a failed load, not a live chat", async ({ server, obsidian, vaultPath }) => {
	server.setEmbedPage("missing");
	await startNewSession(obsidian, server, vaultPath);

	await expect(statusLabel(obsidian)).toHaveText("⚠ Chat failed to load");
	await expect(obsidian.locator(".notice", { hasText: "couldn't load the chat" })).toContainText("404");
	await screenshotPane(obsidian, "404");
});

test("a connection that drops before answering is reported as a failed load", async ({ server, obsidian, vaultPath }) => {
	server.setEmbedPage("drop");
	await startNewSession(obsidian, server, vaultPath);

	await expect(statusLabel(obsidian)).toHaveText("⚠ Chat failed to load");
	await expect(obsidian.locator(".notice", { hasText: "couldn't load the chat" })).toBeVisible();
	await screenshotPane(obsidian, "failed");
});

test("a working embed page shows as a live chat and renders inside the webview", async ({ server, obsidian, vaultPath }) => {
	server.setEmbedPage({
		html: '<!doctype html><title>Orca Session</title><body style="background:#fff"><h1 id="probe">Embedded Orca chat</h1></body>',
	});
	await startNewSession(obsidian, server, vaultPath);

	await expect(statusLabel(obsidian)).toHaveText("● Live chat");
	const guestText = await obsidian.evaluate(async () => {
		const webview = document.querySelector("webview.orca-chat-webview") as HTMLElement & {
			executeJavaScript: (code: string) => Promise<unknown>;
		};
		return webview.executeJavaScript("document.getElementById('probe')?.textContent ?? null");
	});
	expect(guestText).toBe("Embedded Orca chat");
	await expect(obsidian.locator(".notice", { hasText: "couldn't load the chat" })).toHaveCount(0);
	await screenshotPane(obsidian, "live");
	// The host page's screenshot doesn't include the guest's separately composited surface, so
	// capture what the webview itself is showing too.
	if (SCREENSHOT_DIR) {
		const guestPng = await obsidian.evaluate(async () => {
			const webview = document.querySelector("webview.orca-chat-webview") as HTMLElement & {
				capturePage: () => Promise<{ toDataURL: () => string }>;
			};
			return (await webview.capturePage()).toDataURL();
		});
		writeFileSync(
			`${SCREENSHOT_DIR}/plugin-e2e-live-guest.png`,
			Buffer.from(guestPng.replace(/^data:image\/png;base64,/, ""), "base64"),
		);
	}
});
