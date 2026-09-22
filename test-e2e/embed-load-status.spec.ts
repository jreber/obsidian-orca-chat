import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/obsidian-fixture";
import { agentSessionTab, type FakeOrcaServer } from "./protocol/fake-orca-server";

// Where the pane's screenshots go; unset → none are written.
const SCREENSHOT_DIR = process.env.ORCA_CHAT_E2E_SCREENSHOT_DIR;

async function selectSession(obsidian: Page, server: FakeOrcaServer): Promise<void> {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus();
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");
	await expect(obsidian.locator("webview.orca-chat-webview")).toBeAttached();
}

async function screenshotPane(obsidian: Page, name: string): Promise<void> {
	if (!SCREENSHOT_DIR) return;
	await obsidian.locator(".orca-chat-view").screenshot({ path: `${SCREENSHOT_DIR}/plugin-e2e-${name}.png` });
}

const status = (obsidian: Page) => obsidian.locator(".orca-chat-status-label");

test("a 404 from Orca's embed page is reported as a failed load, not a live chat", async ({ server, obsidian }) => {
	server.setEmbedPage("missing");
	await selectSession(obsidian, server);

	await expect(status(obsidian)).toHaveText("⚠ Chat failed to load");
	await expect(obsidian.locator(".notice", { hasText: "couldn't load the chat" })).toContainText("404");
	await screenshotPane(obsidian, "404");
});

test("a connection that drops before answering is reported as a failed load", async ({ server, obsidian }) => {
	server.setEmbedPage("drop");
	await selectSession(obsidian, server);

	await expect(status(obsidian)).toHaveText("⚠ Chat failed to load");
	await expect(obsidian.locator(".notice", { hasText: "couldn't load the chat" })).toBeVisible();
	await screenshotPane(obsidian, "failed");
});

test("a working embed page shows as a live chat and renders inside the webview", async ({ server, obsidian }) => {
	server.setEmbedPage({
		html: '<!doctype html><title>Orca Session</title><body style="background:#fff"><h1 id="probe">Embedded Orca chat</h1></body>',
	});
	await selectSession(obsidian, server);

	await expect(status(obsidian)).toHaveText("● Live chat");
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
