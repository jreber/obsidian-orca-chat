// A create whose outcome never reaches the client (a timeout, a dropped socket) must not be reported
// as "not created" while Orca goes on to finish it: the client replays the same envelope, then
// looks the generated session id up, before giving up.
import test from "node:test";
import assert from "node:assert/strict";
import { FakeOrcaServer } from "../test-e2e/protocol/fake-orca-server.ts";
import { buildCreateEnvelope, OrcaRemoteClient, OrcaRemoteError } from "../src/orca-remote-client.ts";
import { sendRemoteRuntimeRequest } from "../src/orca-remote/remote-runtime-client.ts";
import {
	CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
} from "../src/orca-remote/protocol-version.ts";

const STRUCTURED_AGENT_SESSION_CAPABILITIES = [
	STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
];

type CreateParams = { envelope: { sessionId: string; clientOperationId: string; payloadFingerprint: string } };

async function withServer(run: (server: FakeOrcaServer, client: OrcaRemoteClient) => Promise<void>): Promise<void> {
	const server = await FakeOrcaServer.start();
	const client = new OrcaRemoteClient({ createTimeoutMs: 400 });
	await client.connect(server.credential);
	const warn = console.warn;
	console.warn = () => {};
	try {
		await run(server, client);
	} finally {
		console.warn = warn;
		client.disconnect();
		await server.stop();
	}
}

const creates = (server: FakeOrcaServer) => server.received("agentSession.create") as CreateParams[];
const listedIds = async (client: OrcaRemoteClient) => (await client.listAllAgentSessionTabs()).map((t) => t.sessionId);

for (const mode of ["silent", "drop"] as const) {
	test(`create (${mode} reply lost): replays the same envelope and returns the committed session`, async () => {
		await withServer(async (server, client) => {
			server.loseCreateReplies(1, mode);
			const { sessionId } = await client.createClaudeSession("ws1");
			const calls = creates(server);
			assert.equal(calls.length, 2);
			assert.deepEqual(calls[1].envelope, calls[0].envelope, "the replay is the same operation");
			assert.equal(calls[0].envelope.sessionId, sessionId);
			assert.deepEqual(await listedIds(client), [sessionId], "one session, not two");
		});
	});
}

test("create: when the replay's answer is lost too, finds the session in session.tabs.listAll", async () => {
	await withServer(async (server, client) => {
		server.loseCreateReplies(2, "drop");
		const { sessionId } = await client.createClaudeSession("ws1");
		assert.equal(creates(server).length, 2);
		assert.ok(server.received("session.tabs.listAll").length >= 1);
		assert.deepEqual(await listedIds(client), [sessionId]);
	});
});

test("create: a create Orca never made still fails, with the original error", async () => {
	await withServer(async (server, client) => {
		server.loseCreateReplies(2, "silent", { commit: false });
		await assert.rejects(client.createClaudeSession("ws1"), OrcaRemoteError);
		assert.deepEqual(await listedIds(client), []);
	});
});

test("create: a refusal is final (no replay, no lookup)", async () => {
	await withServer(async (server, client) => {
		server.setCreateRefusal({ code: "agent_session_unsupported", message: "nope" });
		await assert.rejects(client.createClaudeSession("ws1"), /nope/);
		assert.equal(creates(server).length, 1);
		assert.equal(server.received("session.tabs.listAll").length, 0);
	});
});

test("fake Orca: a replayed create returns replayed:true; a reused operation id with a new session is refused", async () => {
	await withServer(async (server) => {
		const send = async (sessionId: string, envelope: ReturnType<typeof buildCreateEnvelope>) => {
			const response = await sendRemoteRuntimeRequest<{ ok: boolean; replayed?: boolean; refusal?: { code: string } }>(
				server.credential, "agentSession.create", { envelope: { ...envelope, sessionId }, worktree: "id:ws1", agent: "claude" },
				2000, undefined, undefined, STRUCTURED_AGENT_SESSION_CAPABILITIES,
			);
			if (!response.ok) throw new Error(response.error.message);
			return response.result;
		};
		const envelope = buildCreateEnvelope("s1", "id:ws1", "claude");
		assert.deepEqual([(await send("s1", envelope)).replayed, (await send("s1", envelope)).replayed], [false, true]);
		assert.equal((await send("s2", envelope)).refusal?.code, "agent_session_operation_conflict");
	});
});

test("fake Orca: repo.add of an existing path returns that project instead of adding another", async () => {
	await withServer(async (server, client) => {
		const first = await client.addFolderRepo("/v", "V");
		const second = await client.addFolderRepo("/v", "V");
		assert.deepEqual(second, first);
		assert.equal((await client.listRepos()).length, 1);
	});
});
