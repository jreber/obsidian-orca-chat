// The whole chain with nothing faked on either side: a real Obsidian running this plugin, paired
// (through the same "This computer only" runtime pairing link Orca's Settings hand a user) with a
// real Orca built from an Orca checkout in e2e mode. Only Claude itself is a stub.
//
// Needs ORCA_E2E_ORCA_DIR=<Orca checkout with an `electron-vite build --mode e2e` + web client
// build>; skipped otherwise. Screenshots go to ORCA_CHAT_E2E_SCREENSHOT_DIR as combined-*.png.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test as base, expect } from "./helpers/obsidian-fixture";
import { chatWebview, newSessionButton, reopenPane, SCREENSHOT_DIR, statusLabel, storedSessionId } from "./helpers/pane";
import { enableStructuredChatDashboard, launchRealOrca, ORCA_DIR, REAL_ORCA_UNSUPPORTED_REASON, type RealOrca } from "./helpers/real-orca";
import { OrcaRemoteClient } from "../src/orca-remote-client";
import { decodePairingUrl } from "../src/orca-pairing";
import { MOBILE_PAIRING_NOTICE, newSessionFailureMessage } from "../src/new-session";
import { sendRemoteRuntimeRequest } from "../src/orca-remote/remote-runtime-client";
import {
	CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	type RuntimeCapability,
} from "../src/orca-remote/protocol-version";

const E2E_ROOT = path.join(homedir(), ".cache", "orca-chat-e2e");
const SEED_TEXT = "You've just been started in this workspace";
const STUB_REPLY = "Ready when you are.";
const LIVE = "● Live chat";
// The pane's liveness check runs every 15 s; past this, a session the check can't see is gone.
const ONE_LIVENESS_CYCLE_MS = 21_000;

const test = base.extend<{ realOrca: RealOrca; orcaClaudeOnPath: "stub-first" | "no-claude" }>({
	orcaClaudeOnPath: ["stub-first", { option: true }],
	realOrca: async ({ orcaClaudeOnPath }, use) => {
		const orca = await launchRealOrca({ root: E2E_ROOT, claudeOnPath: orcaClaudeOnPath });
		try {
			await enableStructuredChatDashboard(orca.page);
			await use(orca);
		} finally {
			await orca.close();
		}
	},
	// Obsidian is paired with the real Orca's credential; no fake server is started.
	pairedCredential: async ({ realOrca }, use) => {
		await use(realOrca.credential);
	},
});

test.skip(!ORCA_DIR, "set ORCA_E2E_ORCA_DIR to an Orca checkout with an e2e build");
test.skip(REAL_ORCA_UNSUPPORTED_REASON !== null, REAL_ORCA_UNSUPPORTED_REASON ?? "");

// Evidence for the report, printed as one JSON line per finding.
function record(finding: string, data: unknown): void {
	console.log(`[combined-e2e] ${finding}: ${JSON.stringify(data)}`);
}

async function shoot(target: Page | Locator, name: string): Promise<void> {
	if (!SCREENSHOT_DIR) return;
	await target.screenshot({ path: path.join(SCREENSHOT_DIR, `combined-${name}.png`) });
}

// Orca's window stays hidden (as in Orca's own e2e runs), where a page screenshot never settles;
// its webContents can still paint one.
async function shootOrcaWindow(orca: RealOrca, name: string): Promise<void> {
	if (!SCREENSHOT_DIR) return;
	const png = await orca.app.evaluate(async ({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows().find((w: { isDestroyed: () => boolean }) => !w.isDestroyed());
		return win ? (await win.webContents.capturePage()).toPNG().toString("base64") : null;
	});
	if (png) writeFileSync(path.join(SCREENSHOT_DIR, `combined-${name}.png`), Buffer.from(png, "base64"));
}

// Notices vanish after a few seconds; keep every one Obsidian shows.
async function recordNotices(obsidian: Page): Promise<void> {
	await obsidian.evaluate(() => {
		const win = window as unknown as { __orcaChatNotices?: string[] };
		win.__orcaChatNotices = [];
		// A notice element can be inserted more than once (moved into its container): count it once.
		const seen = new WeakSet<Element>();
		new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of Array.from(mutation.addedNodes)) {
					if (!(node instanceof HTMLElement)) continue;
					const notices = node.matches(".notice") ? [node] : Array.from(node.querySelectorAll(".notice"));
					for (const notice of notices) {
						if (seen.has(notice)) continue;
						seen.add(notice);
						win.__orcaChatNotices!.push(notice.textContent ?? "");
					}
				}
			}
		}).observe(document.body, { childList: true, subtree: true });
	});
}

const noticesSeen = (obsidian: Page) =>
	obsidian.evaluate(() => (window as unknown as { __orcaChatNotices?: string[] }).__orcaChatNotices ?? []);

type WebviewElement = HTMLElement & {
	executeJavaScript: (code: string) => Promise<unknown>;
	capturePage: () => Promise<{ toDataURL: () => string }>;
	getURL: () => string;
};

// The guest page's own text and pixels. Host screenshots do not include the <webview> guest layer,
// so the picture comes from the webview's capturePage().
async function readWebview(obsidian: Page, screenshotName?: string): Promise<{ text: string; url: string }> {
	const { text, url, png } = await obsidian.evaluate(async (wantPng) => {
		const webview = document.querySelector("webview.orca-chat-webview") as unknown as WebviewElement;
		const text = String(await webview.executeJavaScript("document.body ? document.body.innerText : ''"));
		const url = webview.getURL();
		const png = wantPng ? (await webview.capturePage()).toDataURL() : null;
		return { text, url, png };
	}, Boolean(screenshotName && SCREENSHOT_DIR));
	if (png && screenshotName && SCREENSHOT_DIR) {
		writeFileSync(path.join(SCREENSHOT_DIR, `combined-${screenshotName}.png`), Buffer.from(png.split(",")[1], "base64"));
	}
	return { text, url };
}

async function expectWebviewShowsChat(obsidian: Page, screenshotName: string): Promise<string> {
	let text = "";
	await expect
		.poll(
			async () => {
				text = (await readWebview(obsidian)).text;
				return text.includes(SEED_TEXT) && text.includes(STUB_REPLY);
			},
			{ timeout: 30_000, message: "the embedded chat shows the seed turn and Claude's reply" },
		)
		.toBe(true);
	const { url } = await readWebview(obsidian, screenshotName);
	expect(new URL(url).pathname).toBe("/single-session-index.html");
	// The guest lays out at the size of the <webview> box it is shown in.
	const geometry = await obsidian.evaluate(async () => {
		const webview = document.querySelector("webview.orca-chat-webview") as unknown as WebviewElement;
		const box = webview.getBoundingClientRect();
		const guest = (await webview.executeJavaScript("[window.innerWidth, window.innerHeight]")) as [number, number];
		return { box: [Math.round(box.width), Math.round(box.height)], guest };
	});
	record(`webview geometry (${screenshotName})`, geometry);
	expect(Math.abs(geometry.guest[0] - geometry.box[0])).toBeLessThanOrEqual(1);
	return text;
}

type Repo = { id: string; path: string; kind?: string; displayName?: string };
type Inventory = { snapshots: { worktree: string; tabs: { type: string; sessionId?: string; title?: string }[] }[] };

async function orcaResult<T>(orca: RealOrca, method: string, params?: unknown): Promise<T> {
	const response = await orca.runtimeCall<T>(method, params);
	expect(response, `${method}: ${JSON.stringify(response)}`).toMatchObject({ ok: true });
	return (response as { result: T }).result;
}

async function orcaSessionIds(orca: RealOrca): Promise<string[]> {
	const inventory = await orcaResult<Inventory>(orca, "session.tabs.listAll");
	return inventory.snapshots.flatMap((s) => s.tabs.filter((t) => t.type === "agent-session").map((t) => t.sessionId!));
}

async function openDashboard(orca: RealOrca): Promise<Locator> {
	const dashboard = orca.page.locator("[data-agent-dashboard-sheet]");
	if (!(await dashboard.isVisible())) {
		await orca.page.getByRole("button", { name: /Agent Dashboard/ }).click();
		await dashboard.waitFor({ state: "visible" });
	}
	return dashboard;
}

async function clickNewSessionAndAddVault(obsidian: Page, vaultPath: string): Promise<void> {
	await newSessionButton(obsidian).click();
	const modal = obsidian.locator(".modal", { hasText: "Add this vault to Orca?" });
	await expect(modal).toBeVisible();
	await expect(modal).toContainText(vaultPath);
	await shoot(obsidian, "obsidian-add-project-modal");
	await modal.getByRole("button", { name: "Add to Orca" }).click();
	await expect(modal).toHaveCount(0);
}

const mountedSessionId = (obsidian: Page) => chatWebview(obsidian).getAttribute("data-orca-session-id");

test("New session in a real Obsidian creates a session a real Orca shows", async ({ realOrca, obsidian, vaultPath }) => {
	test.setTimeout(300_000);
	await recordNotices(obsidian);
	const vaultName = path.basename(vaultPath);
	record("pairing", { endpoint: realOrca.credential.endpoint, scope: realOrca.credential.scope, port: realOrca.port });
	await expect(statusLabel(obsidian)).toHaveText("No session yet");

	// ── (1) First New session: the fresh Orca does not know the vault, so the plugin asks first.
	await clickNewSessionAndAddVault(obsidian, vaultPath);
	await expect(statusLabel(obsidian)).toHaveText(LIVE, { timeout: 30_000 });
	const liveAt = Date.now();
	const sid1 = await mountedSessionId(obsidian);
	expect(sid1).toMatch(/^[0-9a-f-]{36}$/);
	expect(await storedSessionId(obsidian)).toBe(sid1);
	// (b) The real /single-session-index.html, from the real Orca, inside the real Obsidian webview.
	const firstText = await expectWebviewShowsChat(obsidian, "obsidian-webview-session1");
	record("webview text (session 1)", firstText.slice(0, 400));
	await shoot(obsidian, "obsidian-session1");

	// Orca's side of the same session.
	const repos = (await orcaResult<{ repos: Repo[] }>(realOrca, "repo.list")).repos;
	record("repo.list", repos);
	expect(repos).toContainEqual(expect.objectContaining({ path: vaultPath, kind: "folder", displayName: vaultName }));
	expect(await orcaSessionIds(realOrca)).toContain(sid1);
	const launches = realOrca.stubInvocations().filter((i) => !i.argv.includes("--version"));
	record("claude stub launches", launches.map((l) => ({ entry: l.entry, cwd: l.cwd })));
	expect(launches.map((l) => l.cwd)).toContain(vaultPath);

	const dashboard = await openDashboard(realOrca);
	await expect(dashboard.getByText("Claude Chat").first()).toBeVisible({ timeout: 30_000 });
	await expect(dashboard.getByText(vaultName, { exact: true }).first()).toBeVisible();
	await expect(dashboard.getByText(/just been started in this workspace/).first()).toBeVisible();
	const cardTitles = dashboard.getByText("Claude Chat", { exact: true });
	await expect(cardTitles).toHaveCount(1);
	record("dashboard text (1 session)", (await dashboard.innerText()).slice(0, 600));
	await shoot(dashboard, "orca-dashboard-1-card");

	// ── (a) What the plugin's paired client may call: the flow above already needed repo.list,
	// repo.add, worktree.list, agentSession.create and session.tabs.listAll to succeed. Repeat the
	// non-creating ones from Node with the same credential for the record.
	const client = new OrcaRemoteClient();
	await client.connect(realOrca.credential);
	const probeRepos = await client.listRepos();
	const vaultRepo = probeRepos.find((r) => r.path === vaultPath)!;
	const readded = await client.addFolderRepo(vaultPath, vaultName);
	const workspaces = await client.listWorkspaces(vaultRepo.id);
	const pluginTabs = await client.listAllAgentSessionTabs();
	record("runtime-scope client calls", {
		repoList: probeRepos.length,
		repoAddIdempotent: readded.id === vaultRepo.id,
		worktreeList: workspaces,
		listAll: pluginTabs.map((t) => t.sessionId),
	});
	expect(readded.id).toBe(vaultRepo.id);
	// What the pane's reattach and 15 s liveness check rely on: the plugin's own client must see
	// the session it created. Orca hides Claude chat tabs from paired clients that do not advertise
	// agent-session.structured.claude.v1, so this needs the plugin's client to send it.
	expect(pluginTabs.map((t) => t.sessionId), "the plugin's client sees its session in session.tabs.listAll").toContain(sid1);
	expect(workspaces).toContainEqual(expect.objectContaining({ path: vaultPath }));
	client.disconnect();
	// session.tabs.listAll as a paired client sees it, with and without Claude-structured support
	// advertised: Orca projects Claude chat tabs out for clients that do not advertise it.
	const remoteSessionIds = async (capabilities: RuntimeCapability[]) => {
		const response = await sendRemoteRuntimeRequest<Inventory>(realOrca.credential, "session.tabs.listAll", null, 10_000, undefined, undefined, capabilities);
		if (!response.ok) return response.error;
		return response.result.snapshots.flatMap((s) => s.tabs.map((t) => `${t.type}:${t.sessionId ?? t.title}`));
	};
	const withoutClaudeCapability = await remoteSessionIds([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]);
	const withClaudeCapability = await remoteSessionIds([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]);
	record("remote session.tabs.listAll tabs", { withoutClaudeCapability, withClaudeCapability });
	expect(withClaudeCapability).toEqual([`agent-session:${sid1}`]);
	const inProcessListAll = await realOrca.runtimeCall("session.tabs.listAll");
	record("in-process session.tabs.listAll (raw)", inProcessListAll);

	// A mobile-scope pairing (Settings → Mobile) gets Orca's mobile allowlist instead.
	const mobileOffer = await realOrca.page.evaluate(() =>
		(window as unknown as {
			api: { mobile: { getPairingQR: (a: unknown) => Promise<{ available: boolean; pairingUrl?: string }> } };
		}).api.mobile.getPairingQR({ address: "127.0.0.1", connectionMode: "local-only" }),
	);
	if (mobileOffer.available && mobileOffer.pairingUrl) {
		const mobile = new OrcaRemoteClient();
		await mobile.connect(decodePairingUrl(mobileOffer.pairingUrl));
		const outcome = async (label: string, call: () => Promise<unknown>) =>
			call().then(
				() => [label, "allowed"],
				(err: unknown) => [label, `refused: ${err instanceof Error ? err.message : String(err)}`],
			);
		const results = Object.fromEntries(
			await Promise.all([
				outcome("repo.list", () => mobile.listRepos()),
				outcome("repo.add", () => mobile.addFolderRepo(vaultPath, vaultName)),
				outcome("worktree.list", () => mobile.listWorkspaces(vaultRepo.id)),
				outcome("session.tabs.listAll", () => mobile.listAllAgentSessionTabs()),
			]),
		);
		record("mobile-scope client calls", results);
		mobile.disconnect();
		// The refusal a mobile-scope pairing gets is the one the plugin maps to its re-pair hint.
		const refusal = String(results["repo.add"]).replace(/^refused: /, "");
		expect(newSessionFailureMessage(refusal)).toBe(MOBILE_PAIRING_NOTICE);
	} else {
		record("mobile-scope client calls", { skipped: mobileOffer });
	}

	// The regression this spec found: the first liveness check tore the new chat down ("session
	// ended") because Orca's listAll hid it from the plugin. After a full cycle it must still be live.
	const waitMs = ONE_LIVENESS_CYCLE_MS - (Date.now() - liveAt);
	if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
	record("session 1 after one liveness cycle", {
		sinceLiveMs: Date.now() - liveAt,
		status: await statusLabel(obsidian).textContent(),
		notices: await noticesSeen(obsidian),
	});
	expect(Date.now() - liveAt).toBeGreaterThan(20_000);
	await expect(statusLabel(obsidian)).toHaveText(LIVE);
	await expect(chatWebview(obsidian)).toHaveAttribute("data-orca-session-id", sid1!);
	expect(await storedSessionId(obsidian)).toBe(sid1);
	expect((await noticesSeen(obsidian)).filter((n) => /session ended/.test(n))).toEqual([]);

	// ── (2) Second New session: the vault is registered now, so no prompt.
	await newSessionButton(obsidian).click();
	await expect(chatWebview(obsidian)).not.toHaveAttribute("data-orca-session-id", sid1!, { timeout: 30_000 });
	await expect(obsidian.locator(".modal", { hasText: "Add this vault to Orca?" })).toHaveCount(0);
	await expect(statusLabel(obsidian)).toHaveText(LIVE, { timeout: 30_000 });
	const sid2 = await mountedSessionId(obsidian);
	expect(sid2).not.toBe(sid1);
	await expectWebviewShowsChat(obsidian, "obsidian-webview-session2");
	await expect(cardTitles).toHaveCount(2, { timeout: 30_000 });
	await shoot(dashboard, "orca-dashboard-2-cards");
	await shootOrcaWindow(realOrca, "orca-window-2-cards");
	expect(await orcaSessionIds(realOrca)).toEqual(expect.arrayContaining([sid1, sid2]));

	// ── (3) Close and reopen the pane: it reattaches to the second session; nothing new is created.
	await reopenPane(obsidian);
	await expect(statusLabel(obsidian)).not.toHaveText("", { timeout: 30_000 });
	await expect(statusLabel(obsidian)).not.toHaveText("Connecting…", { timeout: 30_000 });
	record("pane reopened", {
		status: await statusLabel(obsidian).textContent(),
		stored: await storedSessionId(obsidian),
		notices: await noticesSeen(obsidian),
	});
	await expect(chatWebview(obsidian)).toHaveAttribute("data-orca-session-id", sid2!, { timeout: 30_000 });
	await expect(statusLabel(obsidian)).toHaveText(LIVE, { timeout: 30_000 });
	await expectWebviewShowsChat(obsidian, "obsidian-webview-reopened");
	await shoot(obsidian, "obsidian-reopened");
	const afterReopen = await orcaSessionIds(realOrca);
	record("sessions after reopen", afterReopen);
	expect(afterReopen).toHaveLength(2);
	await expect(cardTitles).toHaveCount(2);
	expect(await storedSessionId(obsidian)).toBe(sid2);
	record("notices so far", await noticesSeen(obsidian));

	// ── (c) Startup transient: restart only this Orca and watch session.tabs.listAll, from Node with
	// the plugin's own client, from before the new server accepts connections until it settles.
	const poller = new OrcaRemoteClient();
	await poller.connect(realOrca.credential);
	type Sample = { t: number; phase: string; ok: boolean; ids?: string[]; error?: string };
	const samples: Sample[] = [];
	let phase = "stopping";
	let polling = true;
	let firstSuccess = (): void => {};
	const answered = new Promise<void>((resolve) => (firstSuccess = resolve));
	const t0 = Date.now();
	const pollLoop = (async () => {
		while (polling) {
			const t = Date.now() - t0;
			try {
				const tabs = await poller.listAllAgentSessionTabs();
				samples.push({ t, phase, ok: true, ids: tabs.map((tab) => tab.sessionId) });
				if (phase !== "stopping") firstSuccess();
			} catch (err) {
				samples.push({ t, phase, ok: false, error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	})();
	const restarting = realOrca.restart(() => (phase = "launched"));
	// Wait until the old Orca is gone before treating an answer as the new one's.
	await expect.poll(() => samples.some((s) => s.phase === "launched"), { timeout: 90_000 }).toBe(true);
	await Promise.race([answered, restarting]);
	// The moment the restarted Orca first answers: open the pane, as a user would.
	const reopenAt = Date.now() - t0;
	await obsidian.evaluate(() => {
		const win = window as unknown as {
			app: { workspace: { detachLeavesOfType: (t: string) => void }; commands: { executeCommandById: (id: string) => void } };
		};
		win.app.workspace.detachLeavesOfType("orca-chat-view");
		win.app.commands.executeCommandById("orca-chat:open-orca-chat");
	});
	await restarting;
	phase = "window-ready";
	await expect(statusLabel(obsidian)).not.toHaveText("", { timeout: 30_000 });
	// Past the pane's own 15 s liveness check, so a torn-down session would show.
	await new Promise((resolve) => setTimeout(resolve, 17_000));
	polling = false;
	await pollLoop;
	poller.disconnect();

	const successes = samples.filter((s) => s.ok && s.phase !== "stopping");
	const partial = successes.filter((s) => !(s.ids?.includes(sid1!) && s.ids?.includes(sid2!)));
	const notices = await noticesSeen(obsidian);
	const paneStatus = await statusLabel(obsidian).textContent();
	const paneSession = await chatWebview(obsidian).getAttribute("data-orca-session-id").catch(() => null);
	const stored = await storedSessionId(obsidian);
	record("restart samples", {
		total: samples.length,
		reopenAtMs: reopenAt,
		firstSuccessMs: successes[0]?.t,
		errorsByPhase: Object.fromEntries(
			["stopping", "launched", "window-ready"].map((p) => [p, samples.filter((s) => s.phase === p && !s.ok).length]),
		),
		answersByPhase: Object.fromEntries(
			["stopping", "launched", "window-ready"].map((p) => [p, samples.filter((s) => s.phase === p && s.ok).length]),
		),
		distinctErrors: [...new Set(samples.filter((s) => !s.ok).map((s) => s.error))],
		lastErrorMs: samples.filter((s) => !s.ok).at(-1)?.t,
		partialOrEmptyAnswers: partial.map((s) => ({ t: s.t, phase: s.phase, ids: s.ids })),
		firstAnswers: successes.slice(0, 5),
		lastAnswer: successes.at(-1),
	});
	record("pane after restart", { paneStatus, paneSession, stored, notices });
	await shoot(obsidian, "obsidian-after-restart");
	await shootOrcaWindow(realOrca, "orca-window-after-restart");

	const finalIds = successes.at(-1)?.ids ?? [];
	expect(finalIds, "both sessions survive an Orca restart").toEqual(expect.arrayContaining([sid1, sid2]));
	expect(partial, "listAll never answered without a live session").toEqual([]);
	expect(stored, "the pane keeps its session pointer across the restart").toBe(sid2);
	expect(notices.filter((n) => /session ended/.test(n))).toEqual([]);
	expect(paneSession).toBe(sid2);
});

test.describe("no `claude` on Orca's PATH", () => {
	test.use({ orcaClaudeOnPath: "no-claude" });

	test("New session launches agentCmdOverrides.claude (absolute and ~/ forms)", async ({ realOrca, obsidian, vaultPath }) => {
		test.setTimeout(240_000);
		await recordNotices(obsidian);
		const launchPath = (await realOrca.app.evaluate(() => process.env.PATH ?? "")).split(":");
		record("orca PATH", launchPath);
		expect(launchPath).not.toContain(realOrca.stubDir);

		// Custom launchers in the isolated HOME, as the user's ~/bin/local-claude.
		const stubScript = path.join(realOrca.stubDir, "claude-stub.cjs");
		const launcher = (name: string) => {
			const file = path.join(realOrca.home, "bin", name);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, `#!/bin/sh\nCLAUDE_STUB_ENTRY="$0" exec node ${JSON.stringify(stubScript)} "$@"\n`);
			chmodSync(file, 0o755);
			return file;
		};
		const absoluteLauncher = launcher("abs-claude");
		const homeLauncher = launcher("local-claude");
		const sessionLaunchEntries = () =>
			realOrca.stubInvocations()
				.filter((i) => !i.argv.includes("--version"))
				.map((i) => i.entry);

		// Without an override there is nothing to run: record what the user would see.
		await clickNewSessionAndAddVault(obsidian, vaultPath);
		await expect(statusLabel(obsidian)).not.toHaveText(/Creating session/, { timeout: 30_000 });
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		record("no override", {
			orcaSessions: await orcaSessionIds(realOrca),
			status: await statusLabel(obsidian).textContent(),
			notices: await noticesSeen(obsidian),
			webview: await chatWebview(obsidian).count(),
			launches: sessionLaunchEntries(),
		});
		await shoot(obsidian, "obsidian-no-claude-no-override");

		for (const [form, override, expectedEntry] of [
			["absolute", absoluteLauncher, absoluteLauncher],
			["home-relative", "~/bin/local-claude", homeLauncher],
		] as const) {
			await enableStructuredChatDashboard(realOrca.page, { agentCmdOverrides: { claude: override } });
			const before = (await chatWebview(obsidian).count()) ? await mountedSessionId(obsidian) : null;
			await newSessionButton(obsidian).click({ timeout: 15_000 });
			await expect(chatWebview(obsidian)).toHaveAttribute("data-orca-session-id", /.+/, { timeout: 30_000 });
			if (before) await expect(chatWebview(obsidian)).not.toHaveAttribute("data-orca-session-id", before);
			await expect(statusLabel(obsidian)).toHaveText(LIVE, { timeout: 30_000 });
			await expectWebviewShowsChat(obsidian, `obsidian-webview-override-${form}`);
			await expect.poll(sessionLaunchEntries, { timeout: 30_000 }).toContain(expectedEntry);
			record(`override ${form}`, { override, launches: sessionLaunchEntries(), session: await mountedSessionId(obsidian) });
		}
		const dashboard = await openDashboard(realOrca);
		await expect(dashboard.getByText("Claude Chat", { exact: true }).first()).toBeVisible();
		await shoot(dashboard, "orca-dashboard-override");
	});
});
