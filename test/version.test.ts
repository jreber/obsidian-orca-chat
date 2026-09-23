// The plugin's version (manifest.json, which Obsidian requires to be plain x.y.z) plus the build's
// git hash, shown in the Pair with Orca dialog and logged on load.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const { versionLabel, PLUGIN_VERSION, BUILD_HASH } = await import("../src/version.ts");

const root = path.resolve(import.meta.dirname, "..");
const readJson = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

test("versionLabel is 'Orca Chat v<semver> (<short hash, maybe -dirty, or unknown>)'", () => {
	assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/);
	assert.match(BUILD_HASH, /^([0-9a-f]{7,40}(-dirty)?|unknown)$/);
	assert.equal(versionLabel(), `Orca Chat v${PLUGIN_VERSION} (${BUILD_HASH})`);
	assert.match(versionLabel(), /^Orca Chat v\d+\.\d+\.\d+ \(([0-9a-f]{7,40}(-dirty)?|unknown)\)$/);
});

// Only meaningful in a git checkout: a source tarball or `git archive` export builds as "unknown".
const inGitCheckout = (() => {
	try {
		execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

test("the test build is stamped with the git hash, not 'unknown'", { skip: !inGitCheckout && "not a git checkout" }, () => {
	assert.notEqual(BUILD_HASH, "unknown");
});

test("manifest.json, package.json, package-lock.json and versions.json agree on the version", () => {
	const manifest = readJson("manifest.json");
	const pkg = readJson("package.json");
	const lock = readJson("package-lock.json");
	const versions = readJson("versions.json");
	assert.equal(PLUGIN_VERSION, manifest.version);
	assert.equal(pkg.version, manifest.version);
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages[""].version, manifest.version);
	assert.equal(versions[manifest.version], manifest.minAppVersion);
	for (const [version, minApp] of Object.entries(versions)) {
		assert.match(version, /^\d+\.\d+\.\d+$/);
		assert.match(String(minApp), /^\d+\.\d+\.\d+$/);
	}
});
