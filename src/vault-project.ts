export type OrcaRepoSummary = {
	id: string;
	path: string;
	kind?: "git" | "folder";
	displayName?: string;
};

// Mirrors how Orca compares repo paths: Unicode NFC, collapsed trailing separators, exact case,
// no symlink resolution. Deliberately NOT case-folded (Orca does not either), so on a
// case-insensitive filesystem a differently-cased vault path registers as a second project.
export function normalizeVaultPath(p: string): string {
	const nfc = p.normalize("NFC");
	const trimmed = nfc.replace(/[\\/]+$/, "");
	return trimmed === "" ? nfc.slice(0, 1) : trimmed;
}

export function findVaultRepo(repos: OrcaRepoSummary[], vaultPath: string): OrcaRepoSummary | null {
	const wanted = normalizeVaultPath(vaultPath);
	return repos.find((repo) => normalizeVaultPath(repo.path) === wanted) ?? null;
}
