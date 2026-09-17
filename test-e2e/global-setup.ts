import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// Runs once before the whole Playwright suite: builds the plugin, then copies its output into the
// checked-in fixture vault template so every per-test temp copy (see obsidian-fixture.ts) already
// has a working plugin install.
export default function globalSetup(): void {
	const root = path.resolve(import.meta.dirname, "..");
	execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });

	const pluginDir = path.join(root, "test-e2e", "fixture-vault", ".obsidian", "plugins", "orca-chat");
	mkdirSync(pluginDir, { recursive: true });
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		copyFileSync(path.join(root, file), path.join(pluginDir, file));
	}
}
