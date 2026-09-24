import test from "node:test";
import assert from "node:assert/strict";
import { App, FileSystemAdapter } from "./fakes/obsidian.ts";
import { getVaultRootPath } from "../src/vault-path.ts";

test("returns the base path on a desktop (filesystem) vault", () => {
	const app = new App();
	(app.vault as { adapter: unknown }).adapter = new FileSystemAdapter("/Users/x/Vault");
	assert.equal(getVaultRootPath(app as never), "/Users/x/Vault");
});

test("returns null when the vault has no filesystem adapter (mobile)", () => {
	const app = new App();
	(app.vault as { adapter: unknown }).adapter = {};
	assert.equal(getVaultRootPath(app as never), null);
});
