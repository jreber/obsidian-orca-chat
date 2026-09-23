import test from "node:test";
import assert from "node:assert/strict";
import { findVaultRepo, normalizeVaultPath } from "../src/vault-project.ts";

test("normalizeVaultPath applies NFC and trims trailing slashes but keeps case", () => {
	assert.equal(normalizeVaultPath("/Users/x/Vault/"), "/Users/x/Vault");
	assert.equal(normalizeVaultPath("/Users/x/Vault///"), "/Users/x/Vault");
	assert.equal(normalizeVaultPath("/Users/x/Vault"), "/Users/x/Vault");
	assert.equal(normalizeVaultPath("/u/cafe\u0301"), "/u/caf\u00e9");
	assert.notEqual(normalizeVaultPath("/Users/x/Vault"), normalizeVaultPath("/users/x/vault"));
});

test("normalizeVaultPath treats backslashes as separators for Windows paths", () => {
	assert.equal(normalizeVaultPath("C:\\Users\\x\\Vault\\"), "C:\\Users\\x\\Vault");
});

test("normalizeVaultPath keeps a filesystem root intact", () => {
	assert.equal(normalizeVaultPath("/"), "/");
});

test("findVaultRepo matches by normalized path across kinds", () => {
	const repos = [
		{ id: "r1", path: "/a/other", kind: "git" as const },
		{ id: "r2", path: "/Users/x/Vault/", kind: "folder" as const },
	];
	assert.equal(findVaultRepo(repos, "/Users/x/Vault")?.id, "r2");
	assert.equal(findVaultRepo(repos, "/nope"), null);
	assert.equal(findVaultRepo([], "/Users/x/Vault"), null);
});
