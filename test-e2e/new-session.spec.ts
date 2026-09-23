import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
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
import { generateKeyPair, publicKeyToBase64 } from "../src/orca-remote/e2ee-crypto";

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
	// reports is the host directory the fixture created. Both sides are resolved: on macOS the temp
	// directory is behind a symlink (/var -> /private/var).
	expect(realpathSync(vaultPath)).toBe(realpathSync(vaultDir));
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

// Escape closes the modal through Obsidian's own close path (onClose), not the Cancel button.
test("unregistered vault: dismissing the prompt with Escape creates nothing and shows no notice", async ({
	server,
	obsidian,
}) => {
	await newSessionButton(obsidian).click();
	const modal = addProjectModal(obsidian);
	await expect(modal).toBeVisible();
	await obsidian.keyboard.press("Escape");

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

// The regression a real Orca found: its session.tabs.listAll hides Claude tabs from a client that
// doesn't advertise the Claude capability (the fake mirrors that), so the first 15 s check tore down
// every chat the plugin had just created. A live session must survive a full check cycle.
test("a new Claude session is still live after the periodic check has run", async ({ server, obsidian, vaultPath }) => {
	test.setTimeout(90_000);
	server.setEmbedPage(EMBED_PAGE);
	await startNewSession(obsidian, server, vaultPath);
	const sessionId = createCalls(server)[0].envelope.sessionId;
	await expect(statusLabel(obsidian)).toHaveText("● Live chat");
	const listsBefore = server.received("session.tabs.listAll").length;

	// The pane checks every 15 s; wait until a check has been answered, plus margin for it to act.
	await expect.poll(() => server.received("session.tabs.listAll").length, { timeout: 25_000 }).toBeGreaterThan(listsBefore);
	await obsidian.waitForTimeout(2_000);

	await expect(statusLabel(obsidian)).toHaveText("● Live chat");
	await expect(chatWebview(obsidian)).toHaveAttribute("data-orca-session-id", sessionId);
	await expect(obsidian.locator(".notice", { hasText: "session ended" })).toHaveCount(0);
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

// Orca can finish a create whose answer never reaches the plugin (here the socket drops right after
// the create commits). The pane must adopt that session, not report "not created" and leave it
// orphaned in Orca.
test("a create whose answer is lost is recovered and attached, not orphaned", async ({ server, obsidian, vaultPath }) => {
	server.setEmbedPage(EMBED_PAGE);
	await registerVault(server, vaultPath);
	server.loseCreateReplies(1, "drop");

	await newSessionButton(obsidian).click();

	await expect(chatWebview(obsidian)).toBeAttached();
	const creates = createCalls(server);
	expect(creates).toHaveLength(2);
	expect(creates[1].envelope).toEqual(creates[0].envelope);
	const sessionId = creates[0].envelope.sessionId;
	await expect(chatWebview(obsidian)).toHaveAttribute("data-orca-session-id", sessionId);
	await expect(statusLabel(obsidian)).toHaveText("● Live chat");
	await expect(obsidian.locator(".notice", { hasText: /not created|error/i })).toHaveCount(0);
	expect(await storedSessionId(obsidian)).toBe(sessionId);
});

test("a refused create reports Orca's reason and stores nothing", async ({ server, obsidian, vaultPath }) => {
	await registerVault(server, vaultPath);
	server.setCreateRefusal({ code: "agent_session_unsupported", message: "nope" });

	await newSessionButton(obsidian).click();

	await expect(obsidian.locator(".notice", { hasText: "nope" })).toBeVisible();
	await expect(statusLabel(obsidian)).toHaveText("⚠ Session not created");
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

// The pairing and last session are per device (Obsidian's local storage), never in the synced
// data.json. The fixture seeds the pairing into data.json as an older version kept it.
test("a pairing in data.json from an older version is moved to this device's storage", async ({ server, obsidian, vaultDir, vaultPath }) => {
	const dataFile = path.join(vaultDir, ".obsidian", "plugins", "orca-chat", "data.json");
	await expect.poll(() => readFileSync(dataFile, "utf8")).not.toContain("pairedCredential");
	const local = await obsidian.evaluate(() => {
		const win = window as unknown as { app: { loadLocalStorage: (key: string) => unknown } };
		return win.app.loadLocalStorage("orca-chat:paired-credential") as { endpoint?: string } | null;
	});
	expect(local?.endpoint).toBe(server.credential.endpoint);

	await startNewSession(obsidian, server, vaultPath);
	const sessionId = createCalls(server)[0].envelope.sessionId;
	expect(await storedSessionId(obsidian)).toBe(sessionId);
	expect(readFileSync(dataFile, "utf8")).not.toContain(sessionId);
	expect(readFileSync(dataFile, "utf8")).not.toContain(server.credential.deviceToken);
});

// The vault used to sync the pairing, so after the update one computer can hold the pairing (and last
// session) another computer made with its own Orca. That Orca's key doesn't match this one's.
test.describe("another computer's pairing", () => {
	test.use({
		pairedCredential: async ({ server }, use) => {
			await use({ ...server.credential, publicKeyB64: publicKeyToBase64(generateKeyPair().publicKey) });
		},
		legacyLastSessionId: "session-from-the-other-computer",
	});

	test("the pane says to re-pair this computer, and New session creates nothing", async ({ server, obsidian, vaultPath }) => {
		await registerVault(server, vaultPath);
		const notice = obsidian.locator(".notice", { hasText: "Orca didn't accept this computer's pairing" });
		await expect(notice).toBeVisible();
		await expect(notice).toContainText("Pair with Orca");
		await expect(notice).toContainText("This computer only");
		await expect(statusLabel(obsidian)).toHaveText("⚠ Re-pair this computer");
		await expectStatusFits(obsidian);
		await screenshotWindow(obsidian, "pairing-rejected");
		// The stored session is kept: it may still be good once this computer is re-paired.
		expect(await storedSessionId(obsidian)).toBe("session-from-the-other-computer");

		// The Notice sits over the pane's header; clicking it dismisses it.
		await notice.click();
		await expect(notice).toHaveCount(0);
		await newSessionButton(obsidian).click();
		await expect(notice).toBeVisible();
		await expect(statusLabel(obsidian)).toHaveText("⚠ Re-pair this computer");
		expect(server.received("agentSession.create")).toHaveLength(0);
		await expect(chatWebview(obsidian)).toHaveCount(0);
	});
});
