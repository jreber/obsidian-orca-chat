// Launches a real Orca (an Orca checkout's `--mode e2e` build) for the combined Obsidian + Orca
// specs, isolated the way Orca's own e2e harness isolates it (tests/e2e/helpers/orca-app.ts there):
// its own userData dir and HOME, hidden window, a stub Claude CLI, and a pinned loopback runtime
// port so a restart keeps the same pairing endpoint. It never touches the developer's own Orca: the
// profile lives under `root`, and teardown only stops the process tree this helper started (plus
// the detached daemons whose pid files sit in that profile).
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { build } from "esbuild";
import { decodePairingUrl, type PairedCredential } from "../../src/orca-pairing";

// The Orca checkout whose `out/` holds an e2e-mode build and whose tests/e2e fixtures provide the
// stub Claude. Unset → the combined specs skip.
export const ORCA_DIR = process.env.ORCA_E2E_ORCA_DIR;

const STUB_SUBDIR = path.join("tests", "e2e", "fixtures", "structured-claude-stub");

export type RuntimeCallResponse<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export type ClaudeStubInvocation = { entry: string; cwd: string; argv: string[] };

export type RealOrca = {
	/** Current app and window; replaced by restart(). */
	readonly app: ElectronApplication;
	readonly page: Page;
	readonly userDataDir: string;
	readonly home: string;
	readonly port: number;
	readonly pairingUrl: string;
	readonly credential: PairedCredential;
	readonly stubDir: string;
	/** Every Claude-stub launch so far (the stub appends one JSON line per run). */
	stubInvocations(): ClaudeStubInvocation[];
	/** window.api.runtime.call in Orca's own renderer (the in-process caller, not a paired client). */
	runtimeCall<T>(method: string, params?: unknown): Promise<RuntimeCallResponse<T>>;
	/**
	 * Quits Orca and starts it again on the same profile and port. Resolves once the new window's
	 * store exists; `onLaunched` runs as soon as the new process is spawned (before its window).
	 */
	restart(onLaunched?: () => void): Promise<void>;
	close(): Promise<void>;
};

export type LaunchRealOrcaOptions = {
	/** Parent of the per-launch profile dir. */
	root: string;
	/**
	 * "stub-first": the stub's directory first on PATH (it answers as `claude`).
	 * "no-claude": every PATH directory holding a `claude` is dropped and the stub is not on PATH, so
	 * only `agentCmdOverrides.claude` can reach it.
	 */
	claudeOnPath: "stub-first" | "no-claude";
};

function requireOrcaDir(): string {
	if (!ORCA_DIR) throw new Error("ORCA_E2E_ORCA_DIR is not set");
	if (!existsSync(path.join(ORCA_DIR, "out", "main", "index.js"))) {
		throw new Error(`${ORCA_DIR} has no out/main/index.js: build it with --mode e2e first`);
	}
	return ORCA_DIR;
}

async function reserveLoopbackPort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

// Orca's own e2e profile (onboarding completed, first-run tips seen), built from its source so it
// tracks Orca's constants instead of a stale copy.
async function completedOnboardingProfile(orcaDir: string): Promise<unknown> {
	const entry = path.join(orcaDir, "tests", "e2e", "helpers", "e2e-completed-onboarding-profile.ts");
	const out = await build({ entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent" });
	const mod = { exports: {} as { getE2ECompletedOnboardingProfile: () => unknown } };
	new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, createRequire(entry));
	return mod.exports.getE2ECompletedOnboardingProfile();
}

// Mirrors Orca's electron-home-isolation.ts: nothing that points at the developer's home leaks in.
const HOME_ENV_KEYS = new Set(["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "CODEX_HOME", "ORCA_CODEX_HOME", "ZDOTDIR", "ORCA_ORIG_ZDOTDIR", "BASH_ENV", "ENV", "ELECTRON_RUN_AS_NODE"]);

function launchPath(claudeOnPath: LaunchRealOrcaOptions["claudeOnPath"], stubDir: string): string {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	if (claudeOnPath === "stub-first") return [stubDir, ...dirs].join(path.delimiter);
	return dirs.filter((dir) => !existsSync(path.join(dir, "claude"))).join(path.delimiter);
}

function descendantPids(rootPid: number): number[] {
	const children = new Map<number, number[]>();
	for (const line of execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).split("\n")) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number);
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
		children.set(ppid, [...(children.get(ppid) ?? []), pid]);
	}
	const out: number[] = [];
	const stack = [...(children.get(rootPid) ?? [])];
	while (stack.length) {
		const pid = stack.pop()!;
		out.push(pid);
		stack.push(...(children.get(pid) ?? []));
	}
	return out;
}

function killTree(rootPid: number): void {
	for (const pid of [...descendantPids(rootPid), rootPid].reverse()) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

// Processes whose command line names this profile: only ever ones this helper started.
function profileProcessPids(userDataDir: string): number[] {
	try {
		return execFileSync("pgrep", ["-f", userDataDir], { encoding: "utf8" })
			.split("\n")
			.map(Number)
			.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
	} catch {
		return [];
	}
}

// Detached PTY daemons outlive the app by design (warm reattach); Orca's harness kills them from
// their pid files, as does this.
function daemonPids(userDataDir: string): number[] {
	const dir = path.join(userDataDir, "daemon");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".pid"))
		.map((name) => {
			const raw = readFileSync(path.join(dir, name), "utf8").trim();
			try {
				return Number((JSON.parse(raw) as { pid?: unknown }).pid);
			} catch {
				return Number(raw);
			}
		})
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function quitApp(app: ElectronApplication): Promise<void> {
	const pid = app.process().pid;
	const closed = await Promise.race([
		app.close().then(() => true, () => false),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
	]);
	if (!closed && pid) killTree(pid);
}

export async function launchRealOrca(options: LaunchRealOrcaOptions): Promise<RealOrca> {
	const orcaDir = requireOrcaDir();
	const electronPath = createRequire(path.join(orcaDir, "package.json"))("electron") as string;
	mkdirSync(options.root, { recursive: true });
	const userDataDir = realpathSync(mkdtempSync(path.join(options.root, "orca-userdata-")));
	const home = path.join(userDataDir, "home");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const stubDir = path.join(orcaDir, STUB_SUBDIR);
	const stubLog = path.join(userDataDir, "claude-stub.log");
	const port = await reserveLoopbackPort();
	writeFileSync(path.join(userDataDir, "orca-data.json"), `${JSON.stringify(await completedOnboardingProfile(orcaDir), null, 2)}\n`);

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !HOME_ENV_KEYS.has(key.toUpperCase())) env[key] = value;
	}
	Object.assign(env, {
		HOME: home,
		USERPROFILE: home,
		ORCA_E2E_USER_DATA_DIR: userDataDir,
		ORCA_E2E_HOME_DIR: home,
		ORCA_E2E_RUNTIME_WS_PORT: String(port),
		ORCA_E2E_HEADLESS: "1",
		NODE_ENV: "development",
		CLAUDE_STUB_LOG: stubLog,
		PATH: launchPath(options.claudeOnPath, stubDir),
	});
	const args = ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing", "--disable-gpu-sandbox", "--disable-dev-shm-usage", "--in-process-gpu", orcaDir];

	let app!: ElectronApplication;
	let page!: Page;
	const start = async (onLaunched?: () => void) => {
		app = await electron.launch({ executablePath: electronPath, args, env, cwd: orcaDir });
		onLaunched?.();
		const resolvedHome = await app.evaluate(({ app: electronApp }) => electronApp.getPath("home"));
		if (resolvedHome !== home) throw new Error("Orca's HOME escaped the isolated profile");
		page = await app.firstWindow({ timeout: 120_000 });
		await page.waitForFunction(() => Boolean((window as unknown as { __store?: unknown }).__store), null, { timeout: 60_000 });
		await page.waitForFunction(
			() => (window as unknown as { __store: { getState: () => { workspaceSessionReady?: boolean } } }).__store.getState().workspaceSessionReady === true,
			null,
			{ timeout: 60_000 },
		);
	};

	const stop = async () => {
		const pid = app.process().pid;
		await quitApp(app);
		if (pid) killTree(pid);
	};

	const cleanup = async () => {
		await stop().catch(() => {});
		for (const pid of daemonPids(userDataDir)) killTree(pid);
		for (const pid of profileProcessPids(userDataDir)) killTree(pid);
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				rmSync(userDataDir, { recursive: true, force: true });
				return;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}
	};

	let pairingUrl: string;
	try {
		await start();
		// Exactly what Settings → "pair a device" with "This computer only" asks main for.
		const offer = await page.evaluate(() =>
			(window as unknown as {
				api: { mobile: { getRuntimePairingUrl: (args: unknown) => Promise<{ available: boolean; pairingUrl?: string }> } };
			}).api.mobile.getRuntimePairingUrl({ address: "127.0.0.1", rotate: true, reach: "this-computer" }),
		);
		if (!offer.available || !offer.pairingUrl) throw new Error(`Orca offered no pairing URL: ${JSON.stringify(offer)}`);
		pairingUrl = offer.pairingUrl;
	} catch (err) {
		await cleanup();
		throw err;
	}
	const credential = decodePairingUrl(pairingUrl);

	return {
		get app() {
			return app;
		},
		get page() {
			return page;
		},
		userDataDir,
		home,
		port,
		pairingUrl,
		credential,
		stubDir,
		stubInvocations() {
			if (!existsSync(stubLog)) return [];
			return readFileSync(stubLog, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ClaudeStubInvocation);
		},
		runtimeCall<T>(method: string, params?: unknown) {
			return page.evaluate(
				(request) =>
					(window as unknown as { api: { runtime: { call: (r: unknown) => Promise<unknown> } } }).api.runtime.call(request),
				params === undefined ? { method } : { method, params },
			) as Promise<RuntimeCallResponse<T>>;
		},
		async restart(onLaunched) {
			await stop();
			await start(onLaunched);
		},
		close: cleanup,
	};
}

/** Structured chat and the in-window Agent Dashboard with idle cards (Orca's enableStructuredChatDashboard). */
export async function enableStructuredChatDashboard(page: Page, extraSettings: Record<string, unknown> = {}): Promise<void> {
	await page.evaluate(async (extra) => {
		const win = window as unknown as {
			api: { settings: { set: (s: unknown) => Promise<unknown> } };
			__store?: { setState: (s: unknown) => void };
		};
		const settings = await win.api.settings.set({
			experimentalNativeChat: true,
			experimentalStructuredNativeChat: true,
			experimentalAgentDashboardPopout: true,
			experimentalAgentDashboardMode: "in-window",
			experimentalAgentDashboardShowIdle: true,
			...extra,
		});
		win.__store?.setState({ settings });
	}, extraSettings);
}
