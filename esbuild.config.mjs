import esbuild from "esbuild";
import process from "node:process";

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
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
