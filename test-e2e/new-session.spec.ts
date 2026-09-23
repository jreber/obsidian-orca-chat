import { realpathSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/obsidian-fixture";
import {
	chatWebview,
	expectStatusFits,
	newSessionButton,
	registerVault,
	reopenPane,
	screenshotPane,
	screenshotWindow,
	startNewSession,
	statusLabel,
	storedSessionId,
} from "./helpers/pane";
import { computeAgentSessionPayloadFingerprint } from "../src/orca-remote/agent-session-mutation-envelope";

const NO_SESSION = "No session yet";
// Stands in for Orca's single-session page so mounted chats reach "● Live chat".
const EMBED_PAGE = { html: "<!doctype html><title>Orca Session</title><body><h1>Embedded Orca chat</h1></body>" };

type CreateParams = {
	worktree: string;
	agent: string;
	envelope: { sessionId: string; clientOperationId: string; expectedRuntimeFence: number | null; payloadFingerprint: string };
};

const createCalls = (server: { received: (method: string) => unknown[] }) => server.received("agentSession.create") as CreateParams[];

const addProjectModal = (obsidian: Page) =>
	obsidian.locator(".modal", { hasText: "Add this vault to Orca?" });

test("registered vault: New session creates a Claude chat in the vault's workspace", async ({
	server,
	obsidian,
	vaultDir,
	vaultPath,
}) => {
	// The flatpak sandbox exposes the home directory at the same path, so the vault root Obsidian
	// reports is the host directory the fixture created.
	expect(vaultPath).toBe(realpathSync(vaultDir));
	await expect(statusLabel(obsidian)).toHaveText(NO_SESSION);
	await expectStatusFits(obsidian);
	await screenshotPane(obsidian, "new-session-initial");

	await startNewSession(obsidian, server, vaultPath);

	expect(server.received("repo.add")).toHaveLength(0);
	expect(server.received("worktree.list")).toEqual([{ repo: "id:r1" }]);
	const creates = createCalls(server);
	expect(creates).toHaveLength(1);
	const create = creates[0];
	expect(create).toMatchObject({ worktree: "id:ws1", agent: "claude", envelope: { expectedRuntimeFence: null } });
	expect(create.envelope.clientOperationId).toMatch(/^\d{13}-[0-9a-f]{32}$/);
	// What Orca recomputes from the request to admit it; a mismatch would be refused.
	expect(create.envelope.payloadFingerprint).toBe(
		computeAgentSessionPayloadFingerprint({
			method: "agentSession.create",
			sessionId: create.envelope.sessionId,
			fields: { worktree: create.worktree, agent: create.agent },
		}),
	);

	const webview = chatWebview(obsidian);
	await expect(webview).toHaveAttribute("data-orca-session-id", create.envelope.sessionId);
	expect(await webview.getAttribute("src")).toContain(`session=${create.envelope.sessionId}`);
	expect(await storedSessionId(obsidian)).toBe(create.envelope.sessionId);
});

test("unregistered vault: confirming the prompt adds the vault as a folder project, then creates", async ({
	server,
	obsidian,
	vaultPath,
}) => {
	server.setEmbedPage(EMBED_PAGE);
	await newSessionButton(obsidian).click();

	const modal = addProjectModal(obsidian);
	await expect(modal).toBeVisible();
	await expect(modal).toContainText(vaultPath);
	// Nothing is being created until the user confirms.
	await expect(statusLabel(obsidian)).toHaveText(NO_SESSION);
	await screenshotWindow(obsidian, "new-session-add-project-modal");
	await modal.getByRole("button", { name: "Add to Orca" }).click();

	await expect(chatWebview(obsidian)).toBeAttached();
	await expect(modal).toHaveCount(0);
	const adds = server.received("repo.add");
	expect(adds).toHaveLength(1);
	expect(adds[0]).toMatchObject({ path: vaultPath, kind: "folder" });
	expect(server.received("worktree.list")).toEqual([{ repo: "id:repo-added" }]);
	expect(createCalls(server)).toHaveLength(1);
	expect(createCalls(server)[0]).toMatchObject({ worktree: "id:ws-added", agent: "claude" });
	await expect(statusLabel(obsidian)).toHaveText("● Live chat");
	await expectStatusFits(obsidian);
	await screenshotPane(obsidian, "new-session-live");
});

test("unregistered vault: cancelling the prompt creates nothing and shows no notice", async ({ server, obsidian }) => {
	await newSessionButton(obsidian).click();
	const modal = addProjectModal(obsidian);
	await expect(modal).toBeVisible();
	await modal.getByRole("button", { name: "Cancel" }).click();

	await expect(modal).toHaveCount(0);
	await expect(statusLabel(obsidian)).toHaveText(NO_SESSION);
	await expect(newSessionButton(obsidian)).toBeEnabled();
	expect(server.received("repo.add")).toHaveLength(0);
	expect(server.received("agentSession.create")).toHaveLength(0);
	await expect(chatWebview(obsidian)).toHaveCount(0);
	await expect(obsidian.locator(".notice")).toHaveCount(0);
});

test("reopening the pane reattaches to the stored session without creating another", async ({
	server,
	obsidian,
	vaultPath,
}) => {
	await startNewSession(obsidian, server, vaultPath);
	const sessionId = createCalls(server)[0].envelope.sessionId;

	await reopenPane(obsidian);

	const webview = chatWebview(obsidian);
	await expect(webview).toHaveAttribute("data-orca-session-id", sessionId);
	await expect(webview).toHaveCount(1);
	expect(createCalls(server)).toHaveLength(1);
	expect(await storedSessionId(obsidian)).toBe(sessionId);
});

test("a session closed in Orca is torn down by the periodic check", async ({ server, obsidian, vaultPath }) => {
	test.setTimeout(90_000);
	server.setEmbedPage(EMBED_PAGE);
	await startNewSession(obsidian, server, vaultPath);
	await expect(statusLabel(obsidian)).toHaveText("● Live chat");

	server.setSessionTabs([]);

	// The pane checks every 15 s.
	await expect(chatWebview(obsidian)).toHaveCount(0, { timeout: 25_000 });
	await expect(obsidian.locator(".notice", { hasText: "session ended" })).toBeVisible();
	await expect(statusLabel(obsidian)).toHaveText(NO_SESSION);
	await screenshotPane(obsidian, "new-session-ended");
	expect(await storedSessionId(obsidian)).toBeNull();

	await reopenPane(obsidian);
	await expect(statusLabel(obsidian)).toHaveText(NO_SESSION);
	await expect(chatWebview(obsidian)).toHaveCount(0);
});

test("a refused create reports Orca's reason and stores nothing", async ({ server, obsidian, vaultPath }) => {
	await registerVault(server, vaultPath);
	server.setCreateRefusal({ code: "agent_session_unsupported", message: "nope" });

	await newSessionButton(obsidian).click();

	await expect(obsidian.locator(".notice", { hasText: "nope" })).toBeVisible();
	await expect(statusLabel(obsidian)).toHaveText("⚠ Couldn't create a session");
	await expectStatusFits(obsidian);
	await expect(chatWebview(obsidian)).toHaveCount(0);
	expect(await storedSessionId(obsidian)).toBeNull();

	await reopenPane(obsidian);
	await expect(statusLabel(obsidian)).toHaveText(NO_SESSION);
	await expect(chatWebview(obsidian)).toHaveCount(0);
});

test.describe("not paired", () => {
	test.use({ paired: false });

	test("New session asks the user to pair first", async ({ server, obsidian }) => {
		await newSessionButton(obsidian).click();

		await expect(obsidian.locator(".notice", { hasText: "Not paired with Orca" })).toBeVisible();
		await expect(chatWebview(obsidian)).toHaveCount(0);
		expect(server.received("repo.list")).toHaveLength(0);
		expect(server.received("agentSession.create")).toHaveLength(0);
	});
});
