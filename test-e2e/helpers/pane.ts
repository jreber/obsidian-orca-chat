import type { Page } from "@playwright/test";
import { expect } from "./obsidian-fixture";
import type { FakeOrcaServer } from "../protocol/fake-orca-server";

// Where the pane's screenshots go; unset → none are written.
export const SCREENSHOT_DIR = process.env.ORCA_CHAT_E2E_SCREENSHOT_DIR;

export async function screenshotPane(obsidian: Page, name: string): Promise<void> {
	if (!SCREENSHOT_DIR) return;
	await obsidian.locator(".orca-chat-view").screenshot({ path: `${SCREENSHOT_DIR}/plugin-e2e-${name}.png` });
}

export async function screenshotWindow(obsidian: Page, name: string): Promise<void> {
	if (!SCREENSHOT_DIR) return;
	await obsidian.screenshot({ path: `${SCREENSHOT_DIR}/plugin-e2e-${name}.png` });
}

export const statusLabel = (obsidian: Page) => obsidian.locator(".orca-chat-status-label");

// The status label ellipsizes text wider than the room beside the New session button; every
// status must fit at the default sidebar width.
export async function expectStatusFits(obsidian: Page): Promise<void> {
	const { text, scrollWidth, clientWidth } = await statusLabel(obsidian).evaluate((el) => ({
		text: el.textContent,
		scrollWidth: el.scrollWidth,
		clientWidth: el.clientWidth,
	}));
	expect(scrollWidth, `status "${text}" is truncated`).toBeLessThanOrEqual(clientWidth);
}
export const newSessionButton = (obsidian: Page) => obsidian.locator(".orca-chat-new-session");
export const chatWebview = (obsidian: Page) => obsidian.locator("webview.orca-chat-webview");

// Registers the vault as an Orca folder project with one workspace, then clicks New session and
// waits for the pane to mount the created session's webview.
export async function registerVault(server: FakeOrcaServer, vaultPath: string): Promise<void> {
	server.setRepos([{ id: "r1", path: vaultPath, kind: "folder" }]);
	server.setWorkspaces("r1", [{ id: "ws1", path: vaultPath }]);
}

export async function startNewSession(obsidian: Page, server: FakeOrcaServer, vaultPath: string): Promise<void> {
	await registerVault(server, vaultPath);
	await newSessionButton(obsidian).click();
	await expect(chatWebview(obsidian)).toBeAttached();
}

// Closes every Orca Chat pane and opens a fresh one, as a user reopening it would; the new view
// reads the stored last-session id from this device's local storage.
export async function reopenPane(obsidian: Page): Promise<void> {
	await obsidian.evaluate(() => {
		const win = window as unknown as {
			app: {
				workspace: { detachLeavesOfType: (type: string) => void };
				commands: { executeCommandById: (id: string) => void };
			};
		};
		win.app.workspace.detachLeavesOfType("orca-chat-view");
		win.app.commands.executeCommandById("orca-chat:open-orca-chat");
	});
	await obsidian.waitForSelector(".orca-chat-new-session");
}

// The stored last-session id as the plugin itself reads it: from this device's local storage.
export async function storedSessionId(obsidian: Page): Promise<string | null> {
	return obsidian.evaluate(() => {
		const win = window as unknown as { app: { loadLocalStorage: (key: string) => unknown } };
		const id = win.app.loadLocalStorage("orca-chat:last-session-id");
		return typeof id === "string" ? id : null;
	});
}
