export type OrcaRepoSummary = {
	id: string;
	path: string;
	kind?: "git" | "folder";
	displayName?: string;
};

// A comparison key only — the raw path is what gets sent to Orca. Mirrors Orca's
// normalizeRuntimePathForComparison (src/shared/cross-platform-path.ts) so the plugin finds the
// same project Orca would: Unicode NFC everywhere; a Windows drive or UNC path (C:\…, \\…, //…)
// has its backslashes folded to "/", repeated separators collapsed, the trailing separator trimmed
// (keeping a "C:/" root) and is then lowercased, since Windows paths are case-insensitive; a POSIX
// path only has repeated "/" collapsed and a trailing "/" trimmed (keeping the "/" root), case
// preserved and backslashes left alone (they are a valid POSIX filename character). No symlink
// resolution, so on macOS a differently-cased vault path still registers as a second project.
export function normalizeVaultPath(rawPath: string): string {
	const value = rawPath.normalize("NFC");
	const isWindowsPath = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
	const normalized = trimTrailingSlash(isWindowsPath ? foldWindowsSeparators(value) : collapseSlashes(value));
	const wslUnc = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/[\s\S]*)?$/i);
	if (wslUnc) {
		// Orca: both WSL UNC aliases front the same case-sensitive Linux filesystem; only the distro
		// name folds.
		return `//wsl/${wslUnc[1].toLowerCase()}${wslUnc[2] ?? ""}`;
	}
	return isWindowsPath ? normalized.toLowerCase() : normalized;
}

function collapseSlashes(value: string): string {
	return value.replace(/\/+/g, "/");
}

function foldWindowsSeparators(value: string): string {
	const collapsed = collapseSlashes(value.replace(/\\/g, "/"));
	return value.startsWith("\\\\") || value.startsWith("//") ? `//${collapsed.replace(/^\/+/, "")}` : collapsed;
}

function trimTrailingSlash(value: string): string {
	if (!value.endsWith("/") || value === "/" || /^[A-Za-z]:\/$/.test(value)) return value;
	return value.replace(/\/+$/, "");
}

export function findVaultRepo(repos: OrcaRepoSummary[], vaultPath: string): OrcaRepoSummary | null {
	const wanted = normalizeVaultPath(vaultPath);
	return repos.find((repo) => normalizeVaultPath(repo.path) === wanted) ?? null;
}
