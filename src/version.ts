import manifest from "../manifest.json";

// Stamped by the build (esbuild.config.mjs, test/run.mjs) with the short git hash. Obsidian needs a
// plain x.y.z in manifest.json, so the hash travels beside the version rather than in it.
declare const __ORCA_CHAT_BUILD__: string | undefined;

export const PLUGIN_VERSION: string = manifest.version;
export const BUILD_HASH: string = typeof __ORCA_CHAT_BUILD__ === "string" ? __ORCA_CHAT_BUILD__ : "unknown";

// "Orca Chat v0.2.0 (abc1234)"
export function versionLabel(): string {
	return `Orca Chat v${PLUGIN_VERSION} (${BUILD_HASH})`;
}
