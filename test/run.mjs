// Bundles test/**/*.test.ts with esbuild (aliasing the real, types-only `obsidian` package to
// test/fakes/obsidian.ts) and runs the result with Node's built-in test runner. No test framework
// dependency needed — node:test + node:assert cover this plugin's needs.
import { build } from "esbuild";
import { readdirSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const testDir = path.join(root, "test");
const outDir = path.join(root, ".test-build");

function findTestFiles(dir) {
	return readdirSync(dir, { recursive: true })
		.filter((f) => f.endsWith(".test.ts"))
		.map((f) => path.join(dir, f));
}

const entryPoints = findTestFiles(testDir);
if (entryPoints.length === 0) {
	console.log("No test files found under test/.");
	process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
	entryPoints,
	outdir: outDir,
	outbase: testDir,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "es2022",
	outExtension: { ".js": ".mjs" },
	alias: { obsidian: path.join(testDir, "fakes", "obsidian.ts") },
	// Bundle only our own source (relative/absolute imports); leave every node_modules package
	// (ws, tweetnacl, jsdom, zod, ...) as a real `import` for Node to resolve at runtime. Several
	// of them (ws, tweetnacl) do dynamic `require()`s of Node built-ins that esbuild cannot bundle
	// into ESM — alias still wins for "obsidian" since it resolves to a local file before this
	// check runs.
	packages: "external",
	// packages:"external" mangles "node:test"/"node:assert" into the bare (wrong) specifiers
	// "test"/"assert" — list them explicitly so esbuild leaves the `node:`-prefixed form alone.
	external: ["node:test", "node:assert", "node:assert/strict"],
	logLevel: "info",
});

const outFiles = readdirSync(outDir, { recursive: true })
	.filter((f) => f.endsWith(".mjs"))
	.map((f) => path.join(outDir, f));

const result = spawnSync(process.execPath, ["--test", ...outFiles], { stdio: "inherit" });
process.exit(result.status ?? 1);
