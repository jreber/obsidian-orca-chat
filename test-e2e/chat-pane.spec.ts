import { test, expect } from "./helpers/obsidian-fixture";
import { agentSessionTab } from "./protocol/fake-orca-server";

test("selecting a session mounts a webview pointed at Orca's single-session UI", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus(); // triggers the pane's onfocus refresh, which re-fetches session tabs
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");

	const webview = obsidian.locator("webview.orca-chat-webview");
	await expect(webview).toBeAttached();
	const src = await webview.getAttribute("src");
	const expectedOrigin = server.credential.endpoint.replace(/^ws/, "http");
	expect(src).toMatch(new RegExp(`^${expectedOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/single-session-index\\.html\\?`));
	expect(src).toContain("sessionId=sess-1");
	expect(src).toMatch(/[?&]pairing=/);

	const partition = await webview.getAttribute("partition");
	expect(partition).toBeTruthy();
	expect(partition).not.toMatch(/^persist:/);
});
