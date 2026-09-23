import { App, FileSystemAdapter } from "obsidian";

// getBasePath exists only on the desktop filesystem adapter; mobile vaults have no host path.
export function getVaultRootPath(app: App): string | null {
	const adapter = app.vault.adapter;
	return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
}
