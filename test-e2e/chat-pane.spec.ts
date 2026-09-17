import { test, expect } from "./helpers/obsidian-fixture";
import { agentSessionTab, historyPage, textMessageItem } from "./protocol/fake-orca-server";

test("session picker lists configured sessions and selecting one renders its history", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory("sess-1", historyPage("sess-1", [textMessageItem("item-1", 1, "user", "hello there")]));

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus(); // triggers the pane's onfocus refresh, which re-fetches session tabs
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");

	await expect(obsidian.locator(".orca-chat-message-body")).toHaveText("hello there");
});
