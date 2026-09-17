import { test, expect } from "./helpers/obsidian-fixture";
import { agentSessionTab, historyPage, textMessageItem, approvalItem } from "./protocol/fake-orca-server";

test("session picker lists configured sessions and selecting one renders its history", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory("sess-1", historyPage("sess-1", [textMessageItem("item-1", 1, "user", "hello there")]));

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus(); // triggers the pane's onfocus refresh, which re-fetches session tabs
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");

	await expect(obsidian.locator(".orca-chat-message-body")).toHaveText("hello there");
});

test("sending a message clears the input and reaches the fake server", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory("sess-1", historyPage("sess-1", []));

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus();
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");

	const input = obsidian.locator(".orca-chat-input-row input");
	await input.fill("hello from playwright");
	await input.press("Enter");

	await expect(input).toHaveValue("");
	await expect.poll(() => server.received("agentSession.send").length).toBe(1);
	const [call] = server.received("agentSession.send") as { body: { blocks: { text: string }[] } }[];
	expect(call.body.blocks[0].text).toBe("hello from playwright");
});

test("clicking an approval option notifies the fake server and reflects a pushed resolution", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory(
		"sess-1",
		historyPage("sess-1", [
			approvalItem("item-1", 1, "Allow file write?", [
				{ id: "opt-yes", label: "Yes" },
				{ id: "opt-no", label: "No" },
			]),
		]),
	);

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus();
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");

	await obsidian.getByRole("button", { name: "Yes" }).click();
	await expect.poll(() => server.received("agentSession.respondToApproval").length).toBe(1);
	const [call] = server.received("agentSession.respondToApproval") as { optionId: string }[];
	expect(call.optionId).toBe("opt-yes");

	// Simulate the host pushing back the resolved item, the same way a real Orca host would after
	// accepting the response — clicking alone doesn't locally mark an item resolved (see
	// chat-view.ts's renderPromptItem: it disables the buttons, but the "resolved" bubble state
	// comes from the item's own data, which only updates via a subscription push).
	const resolvedItem = {
		itemId: "item-1",
		revision: 2,
		sequence: 1,
		observedAt: Date.now(),
		body: {
			kind: "approval" as const,
			title: "Allow file write?",
			detail: null,
			options: [
				{ id: "opt-yes", label: "Yes" },
				{ id: "opt-no", label: "No" },
			],
			resolution: { state: "resolved" as const, selectedOptionId: "opt-yes", resolvedBy: "test", resolvedAt: Date.now() },
		},
	};
	server.pushHistoryEvent("sess-1", {
		type: "batch",
		sessionId: "sess-1",
		batch: { cursor: { epoch: "e2e", sequence: 2 }, items: [resolvedItem], removedItemIds: [], submissions: [] },
	});

	await expect(obsidian.locator(".orca-chat-prompt-resolved")).toHaveText("✓ Yes");
});

test("a pushed batch event renders a new bubble without reopening the pane", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory("sess-1", historyPage("sess-1", [textMessageItem("item-1", 1, "user", "first message")]));

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus();
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");
	await expect(obsidian.locator(".orca-chat-message-body")).toHaveText("first message");

	await server.waitForSubscription("sess-1");

	server.pushHistoryEvent("sess-1", {
		type: "batch",
		sessionId: "sess-1",
		batch: {
			cursor: { epoch: "e2e", sequence: 2 },
			items: [textMessageItem("item-2", 2, "assistant", "pushed reply")],
			removedItemIds: [],
			submissions: [],
		},
	});

	await expect(obsidian.locator(".orca-chat-message-body")).toHaveText(["first message", "pushed reply"]);
});

test("a session disappearing from the tab list shows a notice and doesn't crash the pane", async ({ server, obsidian }) => {
	server.setSessionTabs([agentSessionTab("sess-1", "My chat")]);
	server.setSessionHistory("sess-1", historyPage("sess-1", [textMessageItem("item-1", 1, "user", "hello")]));

	const dropdown = obsidian.locator(".orca-chat-session-select");
	await dropdown.focus();
	await expect(dropdown.locator('option[value="sess-1"]')).toBeAttached();
	await dropdown.selectOption("sess-1");

	server.setSessionTabs([]);
	await dropdown.blur();
	await dropdown.focus(); // re-triggers populateSessions, the same as any real refresh

	await expect(obsidian.getByText("Orca Chat: previous session ended — pick another")).toBeVisible();
	await expect(dropdown).toHaveValue("");
});
