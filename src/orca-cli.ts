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
		super("Orca not reachable — is it running?");
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

function runOrca(args: string[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		execFile(
			"orca",
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

export async function listTerminals(): Promise<OrcaTerminal[]> {
	const result = (await runOrca(["terminal", "list"])) as {
		terminals: Array<{ handle: string; title: string; agentIdentity: string; worktreePath: string }>;
	};
	return result.terminals.map((t) => ({
		handle: t.handle,
		title: t.title,
		agentIdentity: t.agentIdentity,
		worktreePath: t.worktreePath,
	}));
}

export async function sendText(handle: string, text: string): Promise<void> {
	await runOrca(["terminal", "send", "--terminal", handle, "--text", text, "--enter"]);
}

export async function readScreen(handle: string): Promise<string[]> {
	const result = (await runOrca(["terminal", "read", "--terminal", handle, "--screen"])) as {
		terminal: { tail: string[] };
	};
	return result.terminal.tail;
}
