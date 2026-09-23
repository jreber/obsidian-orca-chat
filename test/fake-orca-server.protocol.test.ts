import test from "node:test";
import assert from "node:assert/strict";
import { sendRemoteRuntimeRequest } from "../src/orca-remote/remote-runtime-client.ts";
import { FakeOrcaServer, agentSessionTab, historyPage, textMessageItem } from "../test-e2e/protocol/fake-orca-server.ts";
import { buildCreateEnvelope, OrcaRemoteClient } from "../src/orca-remote-client.ts";
import {
	CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	type RuntimeCapability,
} from "../src/orca-remote/protocol-version.ts";

type TabsResult = { snapshots: { worktree: string; tabs: { sessionId?: string }[] }[] };

async function listAllWith(server: FakeOrcaServer, capabilities: readonly RuntimeCapability[]): Promise<string[]> {
	const response = await sendRemoteRuntimeRequest<TabsResult>(
		server.credential,
		"session.tabs.listAll",
		null,
		5000,
		undefined,
		undefined,
		capabilities,
	);
	if (!response.ok) throw new Error(response.error.message);
	return response.result.snapshots.flatMap((s) => s.tabs.map((t) => String(t.sessionId)));
}

test("session.tabs.listAll returns the tabs configured on the fake server", async () => {
	const server = await FakeOrcaServer.start();
	try {
		const tab = agentSessionTab("sess-1", "My chat");
		server.setSessionTabs([tab]);
		const response = await sendRemoteRuntimeRequest<{ snapshots: { worktree: string; tabs: unknown[] }[] }>(
			server.credential,
			"session.tabs.listAll",
			null,
			5000,
			undefined,
			undefined,
			[STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
		);
		if (!response.ok) throw new Error(response.error.message);
		assert.deepEqual(response.result.snapshots[0].tabs, [tab]);
	} finally {
		await server.stop();
	}
});

// Mirrors Orca's projectSessionTabAgentStatus for a paired runtime client: no structured capability
// hides every agent-session tab; the structured capability alone shows only Codex tabs; Claude tabs
// also need the Claude capability.
test("session.tabs.listAll hides agent-session tabs the client didn't advertise support for", async () => {
	const server = await FakeOrcaServer.start();
	try {
		server.setSessionTabs([agentSessionTab("claude-1", "C", "claude"), agentSessionTab("codex-1", "X", "codex")]);
		assert.deepEqual(await listAllWith(server, []), []);
		assert.deepEqual(await listAllWith(server, [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]), ["codex-1"]);
		assert.deepEqual(
			await listAllWith(server, [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]),
			["claude-1", "codex-1"],
		);
		// The Claude capability means nothing without the base one.
		assert.deepEqual(await listAllWith(server, [CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]), []);
	} finally {
		await server.stop();
	}
});

test("agentSession.history returns the page configured on the fake server", async () => {
	const server = await FakeOrcaServer.start();
	try {
		const item = textMessageItem("item-1", 1, "user", "hello");
		server.setSessionHistory("sess-1", historyPage("sess-1", [item], 7));
		const response = await sendRemoteRuntimeRequest<{ ok: true; page: { items: unknown[]; fence?: number } }>(
			server.credential,
			"agentSession.history",
			{ sessionId: "sess-1", direction: "tail" },
			5000,
		);
		if (!response.ok) throw new Error(response.error.message);
		assert.deepEqual(response.result.page.items, [item]);
		assert.equal(response.result.page.fence, 7);
	} finally {
		await server.stop();
	}
});

test("sendAgentSessionMessage delivers the text to the fake server", async () => {
	const server = await FakeOrcaServer.start();
	try {
		server.setSessionHistory("sess-1", historyPage("sess-1", [], 1));
		const client = new OrcaRemoteClient();
		await client.connect(server.credential);
		await client.sendAgentSessionMessage("sess-1", "hello from a test");
		const calls = server.received("agentSession.send") as { body: { blocks: { text: string }[] } }[];
		assert.equal(calls.length, 1);
		assert.equal(calls[0].body.blocks[0].text, "hello from a test");
	} finally {
		await server.stop();
	}
});

test("respondToPrompt delivers the chosen option to the fake server", async () => {
	const server = await FakeOrcaServer.start();
	try {
		server.setSessionHistory("sess-1", historyPage("sess-1", [], 1));
		const client = new OrcaRemoteClient();
		await client.connect(server.credential);
		await client.respondToPrompt("sess-1", "approval", "item-1", 1, "opt-yes");
		const calls = server.received("agentSession.respondToApproval") as { optionId: string }[];
		assert.equal(calls.length, 1);
		assert.equal(calls[0].optionId, "opt-yes");
	} finally {
		await server.stop();
	}
});

test("pushHistoryEvent delivers a batch to an open subscription", async () => {
	const server = await FakeOrcaServer.start();
	try {
		const client = new OrcaRemoteClient();
		await client.connect(server.credential);
		const events: unknown[] = [];
		const unsubscribe = client.subscribeAgentSessionHistory("sess-1", (event) => events.push(event));
		await server.waitForSubscription("sess-1");
		const item = textMessageItem("item-2", 1, "assistant", "hi there");
		const batchEvent = {
			type: "batch" as const,
			sessionId: "sess-1",
			batch: { cursor: { epoch: "e2e", sequence: 1 }, items: [item], removedItemIds: [], submissions: [] },
		};
		server.pushHistoryEvent("sess-1", batchEvent);
		await new Promise((resolve) => setTimeout(resolve, 300));
		unsubscribe();
		assert.deepEqual(events, [batchEvent]);
	} finally {
		await server.stop();
	}
});

// Real Orca's agentSession.create calls requireStructuredCapability first: a client that didn't
// advertise agent-session.structured.v1 gets the RPC error structured_agent_session_unsupported.
test("agentSession.create is refused without the structured capability, like Orca", async () => {
	const server = await FakeOrcaServer.start();
	try {
		const params = { envelope: buildCreateEnvelope("sess-x", "id:ws-1", "claude"), worktree: "id:ws-1", agent: "claude" };
		const bare = await sendRemoteRuntimeRequest(server.credential, "agentSession.create", params, 5000);
		assert.equal(bare.ok, false);
		if (!bare.ok) assert.equal(bare.error.code, "structured_agent_session_unsupported");
		const capable = await sendRemoteRuntimeRequest(
			server.credential,
			"agentSession.create",
			params,
			5000,
			undefined,
			undefined,
			[STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
		);
		assert.equal(capable.ok, true);
	} finally {
		await server.stop();
	}
});
