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

test("normalizeVaultPath collapses repeated POSIX separators", () => {
	assert.equal(normalizeVaultPath("/a//b/"), "/a/b");
	assert.equal(normalizeVaultPath("/a//b/"), normalizeVaultPath("/a/b"));
});

test("normalizeVaultPath leaves backslashes alone in a POSIX path (a valid filename character)", () => {
	assert.equal(normalizeVaultPath("/a/b\\c"), "/a/b\\c");
});

test("normalizeVaultPath folds Windows drive paths: separators and case, like Orca", () => {
	assert.equal(normalizeVaultPath("C:\\Users\\x\\Vault\\"), "c:/users/x/vault");
	assert.equal(normalizeVaultPath("C:\\Users\\x\\Vault\\"), normalizeVaultPath("c:/users/x/vault"));
	assert.equal(normalizeVaultPath("C:\\Users\\\\x\\Vault"), "c:/users/x/vault");
});

test("normalizeVaultPath folds UNC paths: separators and case, like Orca", () => {
	assert.equal(normalizeVaultPath("\\\\Server\\Share\\Vault"), "//server/share/vault");
	assert.equal(normalizeVaultPath("\\\\Server\\Share\\Vault\\"), normalizeVaultPath("//server/share/vault"));
});

test("normalizeVaultPath folds only the distro name of a WSL UNC path, like Orca", () => {
	assert.equal(normalizeVaultPath("\\\\wsl.localhost\\Ubuntu\\home\\Me\\Vault"), "//wsl/ubuntu/home/Me/Vault");
	assert.equal(normalizeVaultPath("//wsl$/Ubuntu/home/Me/Vault/"), "//wsl/ubuntu/home/Me/Vault");
});

test("normalizeVaultPath keeps filesystem roots intact", () => {
	assert.equal(normalizeVaultPath("/"), "/");
	assert.equal(normalizeVaultPath("C:\\"), "c:/");
	assert.equal(normalizeVaultPath("C:/"), "c:/");
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

test("findVaultRepo matches a Windows vault registered with different case and separators", () => {
	const repos = [{ id: "r1", path: "c:/users/x/vault", kind: "folder" as const }];
	assert.equal(findVaultRepo(repos, "C:\\Users\\x\\Vault\\")?.id, "r1");
});
