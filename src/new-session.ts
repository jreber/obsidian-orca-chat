import { findVaultRepo, normalizeVaultPath, type OrcaRepoSummary } from "./vault-project";

export interface NewSessionClient {
	listRepos(): Promise<OrcaRepoSummary[]>;
	addFolderRepo(path: string, displayName: string): Promise<OrcaRepoSummary>;
	listWorkspaces(repoId: string): Promise<{ id: string; path: string }[]>;
	createClaudeSession(workspaceId: string): Promise<{ sessionId: string }>;
}

export class NewSessionCancelled extends Error {
	constructor() {
		super("New session cancelled");
		this.name = "NewSessionCancelled";
	}
}

export class NewSessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NewSessionError";
	}
}

// Orca refuses repo.add / worktree.list to a mobile-scope pairing (its mobile QR) with "Method
// '<name>' is not available to mobile clients". New session needs the runtime-scope pairing link.
export const MOBILE_PAIRING_NOTICE = "Orca Chat needs the \"This computer only\" pairing link — re-pair from Orca's settings.";

// The Notice text for a failed New session: Orca's own message, except where there is a fix to name.
export function newSessionFailureMessage(message: string): string {
	return message.includes("not available to mobile clients") ? MOBILE_PAIRING_NOTICE : message;
}

export async function createVaultSession(args: {
	client: NewSessionClient;
	vaultPath: string;
	vaultName: string;
	confirmAddProject: () => Promise<boolean>;
	// Called once, when creation is actually underway: the vault is registered, or the user has
	// just confirmed adding it. Never called if the user declines.
	onCreating?: () => void;
}): Promise<{ sessionId: string }> {
	const { client, vaultPath } = args;
	const found = findVaultRepo(await client.listRepos(), vaultPath);
	if (!found && !(await args.confirmAddProject())) throw new NewSessionCancelled();
	args.onCreating?.();
	const repo = found ?? (await client.addFolderRepo(vaultPath, args.vaultName));
	const workspaces = await client.listWorkspaces(repo.id);
	const wanted = normalizeVaultPath(vaultPath);
	const workspace = workspaces.find((w) => normalizeVaultPath(w.path) === wanted) ?? workspaces[0];
	if (!workspace) {
		throw new NewSessionError("Orca has no workspace for this vault — open the project in Orca once, then try again.");
	}
	return client.createClaudeSession(workspace.id);
}
