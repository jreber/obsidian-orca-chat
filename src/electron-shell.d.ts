// Minimal ambient typing for the one Electron API this plugin actually uses. Electron itself
// ships as part of Obsidian's runtime (already marked `external` in esbuild.config.mjs) — adding
// the real `electron` package here just for its types would pull in a multi-hundred-MB dependency
// for a single function signature.
declare module "electron" {
	export const shell: {
		openExternal(url: string): Promise<void>;
	};
}
