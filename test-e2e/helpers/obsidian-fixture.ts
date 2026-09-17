import { chromium, type Browser, type Page } from "playwright";
import { test as base } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeOrcaServer } from "../protocol/fake-orca-server";

const FIXTURE_VAULT = path.resolve(import.meta.dirname, "../fixture-vault");
const OBSIDIAN_BINARY = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";

export const test = base.extend<{ server: FakeOrcaServer; obsidian: Page }>({
	server: async ({}, use) => {
		const server = await FakeOrcaServer.start();
		await use(server);
		await server.stop();
	},

	// Fresh vault copy + fresh Electron --user-data-dir per test: avoids colliding with the real,
	// already-running Obsidian on this machine (Electron's single-instance lock is scoped to
	// --user-data-dir, so without this every launch would just hand its argv to the user's real
	// Obsidian process instead of opening its own window) and keeps tests parallel-safe.
	//
	// This does NOT use Playwright's `_electron.launch()` helper. That helper requires attaching a
	// Node.js inspector (--inspect) to the Electron *main* process to bridge into Electron's own
	// app/BrowserWindow APIs. The real, notarized Obsidian.app ships with Electron's
	// `EnableNodeCliInspectArguments` fuse disabled (verified via `@electron/fuses read --app
	// Obsidian.app`) — a build-time hardening flag that makes `--inspect` permanently inert, no
	// matter what CLI args are passed. `_electron.launch()` therefore hangs forever waiting for a
	// "Debugger listening on ws://" line that will never be printed.
	//
	// Workaround: we don't need the main-process bridge at all — every interaction in this suite is
	// plain renderer-side `page.evaluate()`. So we spawn Obsidian ourselves, read the *renderer*
	// DevTools websocket URL it prints on startup (`--remote-debugging-port`, a separate, still-
	// enabled mechanism), and attach with `chromium.connectOverCDP()`, which talks pure CDP and never
	// touches the main-process Node inspector. Teardown kills the child process directly instead of
	// going through an ElectronApplication handle.
	//
	// We also pre-register the vault directly in `<userDataDir>/obsidian.json` (`vaults: { id: {
	// path, open: true } }`) rather than passing the vault path as a launch arg or an
	// `obsidian://open?path=` URI. Verified empirically (and by reading the unpacked obsidian.asar):
	// a bare positional path arg is never parsed as "open this vault" by Obsidian's own argv
	// handling, and the `obsidian://open?path=` URI only resolves against *already-registered*
	// vaults — neither works for a brand-new vault directory on a fresh --user-data-dir. Obsidian's
	// own startup routine (`ke()` in main.js) opens whichever vaults are marked `open: true` in its
	// vault registry, which is exactly what pre-seeding the config accomplishes, with no vault-picker
	// screen in between.
	obsidian: async ({ server }, use) => {
		const vaultDir = mkdtempSync(path.join(tmpdir(), "orca-chat-e2e-vault-"));
		const userDataDir = mkdtempSync(path.join(tmpdir(), "orca-chat-e2e-userdata-"));
		cpSync(FIXTURE_VAULT, vaultDir, { recursive: true });
		writeFileSync(
			path.join(vaultDir, ".obsidian", "plugins", "orca-chat", "data.json"),
			JSON.stringify({ pairedCredential: server.credential }),
		);
		writeFileSync(
			path.join(userDataDir, "obsidian.json"),
			JSON.stringify({
				updateDisabled: true,
				vaults: { e2efixture1: { path: vaultDir, ts: Date.now(), open: true } },
			}),
		);

		let child: ChildProcess | undefined;
		let browser: Browser | undefined;
		try {
			child = spawn(
				OBSIDIAN_BINARY,
				[`--remote-debugging-port=0`, `--user-data-dir=${userDataDir}`],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);

			const wsEndpoint = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Timed out waiting for Obsidian's DevTools listening line")), 20_000);
				const onData = (buf: Buffer) => {
					const match = buf.toString().match(/DevTools listening on (ws:\/\/\S+)/);
					if (match) {
						clearTimeout(timer);
						resolve(match[1]);
					}
				};
				child?.stdout?.on("data", onData);
				child?.stderr?.on("data", onData);
			});

			browser = await chromium.connectOverCDP(wsEndpoint);
			const page = await waitForFirstPage(browser);
			await dismissFirstRunPrompts(page);
			await page.waitForFunction(() => "app" in window);
			await page.evaluate(() => {
				const win = window as unknown as { app: { commands: { executeCommandById: (id: string) => void } } };
				win.app.commands.executeCommandById("orca-chat:open-orca-chat");
			});
			await page.waitForSelector(".orca-chat-session-select");
			await use(page);
		} finally {
			await browser?.close().catch(() => {});
			if (child) {
				child.kill();
				await waitForChildExit(child, 5_000);
			}
			rmSync(vaultDir, { recursive: true, force: true });
			rmSync(userDataDir, { recursive: true, force: true });
		}
	},
});

// Obsidian's Electron helpers (renderer, GPU, network service, utility) keep the vault/userData
// dirs open for a brief window after the main process receives SIGTERM. child.kill() returns
// immediately, so without this wait the rmSync calls right after it race the still-shutting-down
// process and intermittently fail with ENOTEMPTY. SIGKILL escalation bounds the wait for a process
// that ignores SIGTERM entirely.
async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function waitForFirstPage(browser: Browser): Promise<Page> {
	for (let attempt = 0; attempt < 40; attempt++) {
		const page = browser.contexts().flatMap((ctx) => ctx.pages())[0];
		if (page) return page;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error("Obsidian's renderer window never appeared over CDP");
}

// ponytail: text-based best-effort dismissal of Obsidian's first-run "trust author" prompt, which
// reappears every run because each test launches with a brand-new --user-data-dir. Not a documented
// API — update the pattern here if a future Obsidian version changes the wording.
//
// Uses waitFor (polls/retries) rather than isVisible (a single immediate, non-waiting check) — the
// modal renders asynchronously a beat after the renderer page itself is reachable over CDP, so a bare
// isVisible() check here was observed to fire before the dialog existed and skip the click entirely.
async function dismissFirstRunPrompts(page: Page): Promise<void> {
	const trustButton = page.getByRole("button", { name: /trust author/i });
	await trustButton.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
	if (await trustButton.isVisible().catch(() => false)) {
		await trustButton.click();
	}
}

export { expect } from "@playwright/test";
