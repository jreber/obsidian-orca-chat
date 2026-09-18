// Minimal runtime stand-in for the `electron` module, which is only ever real inside Obsidian's
// own process (see esbuild.config.mjs's `external: [..., "electron"]`) — there's nothing to
// install for tests. Extend as tests need more of the surface.
export const shell = {
	async openExternal(_url: string): Promise<void> {},
};
