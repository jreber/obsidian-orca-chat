import esbuild from "esbuild";
import process from "node:process";
import { buildHash } from "./scripts/build-hash.mjs";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron"],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	outfile: "main.js",
	platform: "node",
	// The git hash in the plugin's version label (src/version.ts); fixed when the build starts.
	define: { __ORCA_CHAT_BUILD__: JSON.stringify(buildHash(import.meta.dirname)) },
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
