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

export async function createVaultSession(args: {
	client: NewSessionClient;
	vaultPath: string;
	vaultName: string;
	confirmAddProject: () => Promise<boolean>;
}): Promise<{ sessionId: string }> {
	const { client, vaultPath } = args;
	let repo = findVaultRepo(await client.listRepos(), vaultPath);
	if (!repo) {
		if (!(await args.confirmAddProject())) throw new NewSessionCancelled();
		repo = await client.addFolderRepo(vaultPath, args.vaultName);
	}
	const workspaces = await client.listWorkspaces(repo.id);
	const wanted = normalizeVaultPath(vaultPath);
	const workspace = workspaces.find((w) => normalizeVaultPath(w.path) === wanted) ?? workspaces[0];
	if (!workspace) {
		throw new NewSessionError("Orca has no workspace for this vault — open the project in Orca once, then try again.");
	}
	return client.createClaudeSession(workspace.id);
}
