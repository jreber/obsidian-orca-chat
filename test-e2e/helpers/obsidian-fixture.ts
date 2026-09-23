import { chromium, type Browser, type Page } from "playwright";
import { test as base } from "@playwright/test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { FakeOrcaServer } from "../protocol/fake-orca-server";

const FIXTURE_VAULT = path.resolve(import.meta.dirname, "../fixture-vault");
const FLATPAK_APP_ID = "md.obsidian.Obsidian";

type ObsidianLauncher = { command: string; args: string[]; flatpak: boolean };

// OBSIDIAN_BINARY overrides the executable; OBSIDIAN_BINARY_ARGS (space-separated) is prepended to
// Obsidian's own args, e.g. OBSIDIAN_BINARY=flatpak OBSIDIAN_BINARY_ARGS="run md.obsidian.Obsidian".
function resolveObsidianLauncher(): ObsidianLauncher {
	const override = process.env.OBSIDIAN_BINARY;
	if (override) {
		const args = (process.env.OBSIDIAN_BINARY_ARGS ?? "").split(" ").filter(Boolean);
		return { command: override, args, flatpak: path.basename(override) === "flatpak" };
	}
	if (process.platform === "darwin") {
		return { command: "/Applications/Obsidian.app/Contents/MacOS/Obsidian", args: [], flatpak: false };
	}
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
		return { command: path.join(localAppData, "Programs", "Obsidian", "Obsidian.exe"), args: [], flatpak: false };
	}
	// Looked up rather than probed: running Obsidian to check it exists would open a window.
	const onPath = (process.env.PATH ?? "")
		.split(path.delimiter)
		.map((dir) => path.join(dir, "obsidian"))
		.find((candidate) => existsSync(candidate));
	if (onPath) {
		return { command: onPath, args: [], flatpak: false };
	}
	if (spawnSync("flatpak", ["info", FLATPAK_APP_ID], { stdio: "ignore" }).status === 0) {
		return { command: "flatpak", args: ["run", FLATPAK_APP_ID], flatpak: true };
	}
	throw new Error("Obsidian not found: install it (flatpak, AppImage on PATH as `obsidian`) or set OBSIDIAN_BINARY");
}

const LAUNCHER = resolveObsidianLauncher();

// Flatpak apps get a private /tmp, so a vault under the host's tmpdir() is invisible to the sandboxed
// Obsidian; its default permissions do include the home directory.
function e2eTempRoot(): string {
	if (!LAUNCHER.flatpak) return tmpdir();
	const root = path.join(homedir(), ".cache", "orca-chat-e2e");
	mkdirSync(root, { recursive: true });
	return root;
}

// `flatpak run` execs bwrap, which does not forward SIGTERM into the sandbox, so killing the child
// leaves Obsidian running. Stop exactly the instance whose bwrap pid is our child — never
// `flatpak kill <app id>`, which would also take down the user's own Obsidian.
async function killOwnFlatpakInstance(child: ChildProcess): Promise<void> {
	if (!LAUNCHER.flatpak || child.pid === undefined) return;
	const ownInstance = () =>
		execFileSync("flatpak", ["ps", "--columns=instance,pid"], { encoding: "utf8" })
			.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.find(([instance, pid]) => instance && pid === String(child.pid))?.[0];
	const instance = ownInstance();
	if (!instance) return;
	spawnSync("flatpak", ["kill", instance], { stdio: "ignore" });
	// `flatpak kill` returns before the sandbox exits; removing the vault while it still runs races.
	for (let attempt = 0; attempt < 20 && ownInstance(); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

type Fixtures = {
	server: FakeOrcaServer;
	obsidian: Page;
	// The temp vault copy's directory on the host.
	vaultDir: string;
	// The vault root exactly as Obsidian reports it (FileSystemAdapter#getBasePath) — the value the
	// plugin sends to repo.add and matches repo.list against. Register repos on the fake with this.
	vaultPath: string;
	// Option: false launches with no pairedCredential in the plugin's data.json.
	paired: boolean;
};

export const test = base.extend<Fixtures>({
	paired: [true, { option: true }],

	server: async ({}, use) => {
		const server = await FakeOrcaServer.start();
		await use(server);
		await server.stop();
	},

	vaultDir: async ({}, use) => {
		const vaultDir = mkdtempSync(path.join(e2eTempRoot(), "orca-chat-e2e-vault-"));
		try {
			await use(vaultDir);
		} finally {
			rmSync(vaultDir, { recursive: true, force: true });
		}
	},

	vaultPath: async ({ obsidian }, use) => {
		const basePath = await obsidian.evaluate(() => {
			const win = window as unknown as { app: { vault: { adapter: { getBasePath: () => string } } } };
			return win.app.vault.adapter.getBasePath();
		});
		await use(basePath);
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
	obsidian: async ({ server, vaultDir, paired }, use) => {
		const userDataDir = mkdtempSync(path.join(e2eTempRoot(), "orca-chat-e2e-userdata-"));
		cpSync(FIXTURE_VAULT, vaultDir, { recursive: true });
		writeFileSync(
			path.join(vaultDir, ".obsidian", "plugins", "orca-chat", "data.json"),
			JSON.stringify(paired ? { pairedCredential: server.credential } : {}),
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
				LAUNCHER.command,
				[...LAUNCHER.args, `--remote-debugging-port=0`, `--user-data-dir=${userDataDir}`],
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
			await closeStrayWindows(browser, page);
			await page.evaluate(() => {
				const win = window as unknown as { app: { commands: { executeCommandById: (id: string) => void } } };
				win.app.commands.executeCommandById("orca-chat:open-orca-chat");
			});
			await page.waitForSelector(".orca-chat-new-session");
			// The pane sets its status once the credential has loaded and any stored session was
			// checked; clicking New session before that would see "not paired".
			await page.waitForFunction(() => (document.querySelector(".orca-chat-status-label")?.textContent ?? "") !== "");
			await use(page);
		} finally {
			await browser?.close().catch(() => {});
			if (child) {
				await killOwnFlatpakInstance(child);
				child.kill();
				await waitForChildExit(child, 5_000);
			}
			rmSync(userDataDir, { recursive: true, force: true });
		}
	},
});

// Obsidian's Electron helpers (renderer, GPU, network service, utility) keep the vault/userData
// dirs open for a brief window after the main process receives SIGTERM. child.kill() returns
// immediately, so without this wait the rmSync calls right after it race the still-shutting-down
// process and intermittently fail with ENOTEMPTY.
//
// If the process doesn't exit within `timeoutMs`, escalate to SIGKILL — but even SIGKILL isn't
// instant from this process's point of view: Electron's helper processes typically only tear down
// once they notice their IPC pipe to the main process has closed, which is an async step, not a
// synchronous side effect of the kill syscall. So we give SIGKILL its own short, bounded
// `killTimeoutMs` window to actually produce an "exit" event before giving up. Either way the total
// wait is capped at `timeoutMs + killTimeoutMs` — this never blocks forever on a process that
// refuses to die.
async function waitForChildExit(child: ChildProcess, timeoutMs: number, killTimeoutMs = 3_000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(sigtermTimer);
			clearTimeout(killTimer);
			child.off("exit", onExit);
			resolve();
		};
		const onExit = () => finish();
		const sigtermTimer = setTimeout(() => {
			child.kill("SIGKILL");
			killTimer = setTimeout(finish, killTimeoutMs);
		}, timeoutMs);
		child.once("exit", onExit);
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

// On a fresh --user-data-dir, Obsidian (seen on 1.13) can open its Settings in a second, focused
// window during first run. Obsidian renders Notices into `activeDocument` — the focused window — so
// while that window lives, every Notice lands there instead of the main window under test.
async function closeStrayWindows(browser: Browser, mainPage: Page): Promise<void> {
	for (const page of browser.contexts().flatMap((ctx) => ctx.pages())) {
		if (page !== mainPage) await page.close().catch(() => {});
	}
	// A single bringToFront can lose to the window manager while the closed window's focus is still
	// being handed back (seen as an occasional 10 s timeout), so re-request focus until it sticks.
	const deadline = Date.now() + 15_000;
	for (;;) {
		await mainPage.bringToFront();
		const focused = await mainPage
			.waitForFunction(() => (window as unknown as { activeDocument?: Document }).activeDocument === document, undefined, {
				timeout: 1_000,
			})
			.then(() => true, () => false);
		if (focused) return;
		if (Date.now() > deadline) throw new Error("Obsidian's main window never took focus after closing stray windows");
	}
}

export { expect } from "@playwright/test";
