import { execFile } from "node:child_process";

export interface OrcaTerminal {
	handle: string;
	title: string;
	agentIdentity: string;
	worktreePath: string;
}

export class OrcaUnreachableError extends Error {
	readonly cause: unknown;

	constructor(cause: unknown) {
		super("Orca not reachable — is Orca or Orca Dev running?");
		this.name = "OrcaUnreachableError";
		this.cause = cause;
	}
}

export class OrcaCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrcaCommandError";
	}
}

// Tried in order; whichever answers first is cached and tried first next time,
// so the plugin keeps working whether the user has the stable Orca app, the
// Orca Dev build, or (during Orca development) both running at once.
const ORCA_BINARIES = ["orca-dev", "orca"] as const;
let preferredBinary: string = ORCA_BINARIES[0];

function execOnce(binary: string, args: string[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		execFile(
			binary,
			[...args, "--json"],
			{ timeout: 10_000, maxBuffer: 10 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					if ((err as NodeJS.ErrnoException).code === "ENOENT") {
						reject(new OrcaUnreachableError(err));
						return;
					}
					reject(new OrcaCommandError(stderr.trim() || err.message));
					return;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(stdout);
				} catch (parseErr) {
					reject(new OrcaCommandError(`Could not parse Orca output: ${(parseErr as Error).message}`));
					return;
				}
				const body = parsed as { ok?: boolean; error?: { message?: string }; result?: unknown };
				if (body.ok === false) {
					reject(new OrcaCommandError(body.error?.message ?? "Orca reported an error"));
					return;
				}
				resolve(body.result);
			},
		);
	});
}

async function runOrca(args: string[]): Promise<unknown> {
	const order = [preferredBinary, ...ORCA_BINARIES.filter((b) => b !== preferredBinary)];
	let lastErr: unknown;
	for (const binary of order) {
		try {
			const result = await execOnce(binary, args);
			preferredBinary = binary;
			return result;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}

export async function listTerminals(): Promise<OrcaTerminal[]> {
	const result = await runOrca(["terminal", "list"]);
	const terminals = (result as { terminals?: unknown } | undefined)?.terminals;
	if (!Array.isArray(terminals)) {
		throw new OrcaCommandError("Unexpected response from `orca terminal list` (missing terminals array)");
	}
	return terminals.map((entry) => {
		const t = entry as {
			handle?: unknown;
			title?: unknown;
			agentIdentity?: unknown;
			worktreePath?: unknown;
		};
		if (typeof t.handle !== "string") {
			throw new OrcaCommandError("Unexpected response from `orca terminal list` (terminal missing handle)");
		}
		return {
			handle: t.handle,
			title: typeof t.title === "string" ? t.title : "",
			agentIdentity: typeof t.agentIdentity === "string" ? t.agentIdentity : "",
			worktreePath: typeof t.worktreePath === "string" ? t.worktreePath : "",
		};
	});
}

export async function sendText(handle: string, text: string): Promise<void> {
	await runOrca(["terminal", "send", "--terminal", handle, "--text", text, "--enter"]);
}

export async function readScreen(handle: string): Promise<string[]> {
	const result = await runOrca(["terminal", "read", "--terminal", handle, "--screen"]);
	const tail = (result as { terminal?: { tail?: unknown } } | undefined)?.terminal?.tail;
	if (!Array.isArray(tail)) {
		throw new OrcaCommandError("Unexpected response from `orca terminal read` (missing tail lines)");
	}
	return tail as string[];
}
