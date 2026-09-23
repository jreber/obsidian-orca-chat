import test from "node:test";
import assert from "node:assert/strict";
import { createVaultSession, NewSessionCancelled, NewSessionError, type NewSessionClient } from "../src/new-session.ts";

function fakeClient(over: Partial<NewSessionClient> = {}, log: string[] = []): NewSessionClient {
	return {
		listRepos: async () => (log.push("listRepos"), [{ id: "r1", path: "/v", kind: "folder" as const }]),
		addFolderRepo: async (path, name) => (log.push(`add ${path} ${name}`), { id: "r2", path, kind: "folder" as const }),
		listWorkspaces: async (id) => (log.push(`workspaces ${id}`), [{ id: "ws-" + id, path: "/v" }]),
		createClaudeSession: async (ws) => (log.push(`create ${ws}`), { sessionId: "sess-1" }),
		...over,
	};
}
const args = (client: NewSessionClient, confirm = async () => true) => ({
	client, vaultPath: "/v/", vaultName: "My Vault", confirmAddProject: confirm,
});

test("registered vault: no prompt, no add, creates in its workspace", async () => {
	const log: string[] = [];
	let prompted = false;
	const out = await createVaultSession(args(fakeClient({}, log), async () => ((prompted = true), true)));
	assert.deepEqual(out, { sessionId: "sess-1" });
	assert.equal(prompted, false);
	assert.deepEqual(log, ["listRepos", "workspaces r1", "create ws-r1"]);
});

test("unregistered vault: asks once, adds as folder project, then creates", async () => {
	const log: string[] = [];
	const client = fakeClient({ listRepos: async () => (log.push("listRepos"), []) }, log);
	const out = await createVaultSession(args(client));
	assert.equal(out.sessionId, "sess-1");
	assert.deepEqual(log, ["listRepos", "add /v/ My Vault", "workspaces r2", "create ws-r2"]);
});

test("declining the add-project prompt creates nothing", async () => {
	const log: string[] = [];
	const client = fakeClient({ listRepos: async () => (log.push("listRepos"), []) }, log);
	await assert.rejects(createVaultSession(args(client, async () => false)), NewSessionCancelled);
	assert.deepEqual(log, ["listRepos"]);
});

test("a project with no workspace is a clear error and creates nothing", async () => {
	const log: string[] = [];
	const client = fakeClient({ listWorkspaces: async () => [] }, log);
	await assert.rejects(createVaultSession(args(client)), (e: unknown) => e instanceof NewSessionError && /workspace/i.test((e as Error).message));
	assert.ok(!log.some((l) => l.startsWith("create")));
});

test("prefers the workspace whose path is the vault root when several exist", async () => {
	const log: string[] = [];
	const client = fakeClient({
		listWorkspaces: async () => [{ id: "other", path: "/elsewhere" }, { id: "root", path: "/v" }],
	}, log);
	await createVaultSession(args(client));
	assert.ok(log.includes("create root"));
});

test("falls back to the first workspace when none is at the vault root", async () => {
	const log: string[] = [];
	const client = fakeClient({
		listWorkspaces: async () => [{ id: "first", path: "/elsewhere" }, { id: "second", path: "/other" }],
	}, log);
	await createVaultSession(args(client));
	assert.deepEqual(log, ["listRepos", "create first"]);
});

test("addFolderRepo failure propagates unchanged and nothing is listed or created", async () => {
	const log: string[] = [];
	const failure = new Error("repo.add refused");
	const client = fakeClient({
		listRepos: async () => (log.push("listRepos"), []),
		addFolderRepo: async () => { throw failure; },
	}, log);
	await assert.rejects(createVaultSession(args(client)), (e: unknown) => e === failure);
	assert.deepEqual(log, ["listRepos"]);
});

test("listWorkspaces failure propagates unchanged and nothing is created", async () => {
	const log: string[] = [];
	const failure = new Error("worktree.list refused");
	const client = fakeClient({ listWorkspaces: async () => { throw failure; } }, log);
	await assert.rejects(createVaultSession(args(client)), (e: unknown) => e === failure);
	assert.deepEqual(log, ["listRepos"]);
});

test("listRepos failure propagates and nothing is added or created", async () => {
	const log: string[] = [];
	const client = fakeClient({ listRepos: async () => { throw new Error("offline"); } }, log);
	await assert.rejects(createVaultSession(args(client)), /offline/);
	assert.deepEqual(log, []);
});

// onCreating marks the point creation is actually underway (the pane shows "Creating session…"
// from it), so it must not fire while the add-project prompt is still open or after a decline.
test("onCreating: registered vault calls it once, before the workspace lookup", async () => {
	const log: string[] = [];
	await createVaultSession({ ...args(fakeClient({}, log)), onCreating: () => log.push("onCreating") });
	assert.deepEqual(log, ["listRepos", "onCreating", "workspaces r1", "create ws-r1"]);
});

test("onCreating: unregistered vault calls it once, only after the prompt is confirmed", async () => {
	const log: string[] = [];
	const client = fakeClient({ listRepos: async () => (log.push("listRepos"), []) }, log);
	const confirm = async () => (log.push("confirm"), true);
	await createVaultSession({ ...args(client, confirm), onCreating: () => log.push("onCreating") });
	assert.deepEqual(log, ["listRepos", "confirm", "onCreating", "add /v/ My Vault", "workspaces r2", "create ws-r2"]);
});

test("onCreating: never called when the prompt is declined", async () => {
	let calls = 0;
	const client = fakeClient({ listRepos: async () => [] });
	await assert.rejects(
		createVaultSession({ ...args(client, async () => false), onCreating: () => calls++ }),
		NewSessionCancelled,
	);
	assert.equal(calls, 0);
});

test("onCreating: never called when listRepos fails", async () => {
	let calls = 0;
	const client = fakeClient({ listRepos: async () => { throw new Error("offline"); } });
	await assert.rejects(createVaultSession({ ...args(client), onCreating: () => calls++ }), /offline/);
	assert.equal(calls, 0);
});

test("a mobile-scope refusal is mapped to the re-pair hint; other failures keep their message", async () => {
	const { newSessionFailureMessage, MOBILE_PAIRING_NOTICE } = await import("../src/new-session.ts");
	assert.equal(
		MOBILE_PAIRING_NOTICE,
		"Orca Chat needs the \"This computer only\" pairing link — re-pair from Orca's settings.",
	);
	assert.equal(newSessionFailureMessage("Method 'repo.add' is not available to mobile clients"), MOBILE_PAIRING_NOTICE);
	assert.equal(newSessionFailureMessage("Method 'worktree.list' is not available to mobile clients"), MOBILE_PAIRING_NOTICE);
	assert.equal(newSessionFailureMessage("nope"), "nope");
});
