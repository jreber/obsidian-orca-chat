import test from "node:test";
import assert from "node:assert/strict";
import { OrcaRemoteClient, STRUCTURED_AGENT_SESSION_CAPABILITIES } from "../src/orca-remote-client.ts";
import {
	CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
	STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
} from "../src/orca-remote/protocol-version.ts";
import { FakeOrcaServer, agentSessionTab } from "../test-e2e/protocol/fake-orca-server.ts";

// Regression pin. Orca's session.tabs.listAll hides every non-Codex agent-session tab from a paired
// client that doesn't advertise the Claude capability (session-tab-agent-status-projection.ts). The
// plugin only creates Claude sessions, so without it the pane's 15 s liveness check saw an empty
// list and tore down every live chat as "session ended". Don't drop either entry.
test("the plugin advertises both the structured and the Claude-structured capability", () => {
	assert.ok(STRUCTURED_AGENT_SESSION_CAPABILITIES.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY));
	assert.ok(STRUCTURED_AGENT_SESSION_CAPABILITIES.includes(CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY));
});

test("listAllAgentSessionTabs sees its Claude session on a host that gates Claude tabs", async () => {
	const server = await FakeOrcaServer.start();
	try {
		server.setSessionTabs([agentSessionTab("sess-claude", "Claude Chat", "claude")]);
		const client = new OrcaRemoteClient();
		await client.connect(server.credential);
		const tabs = await client.listAllAgentSessionTabs();
		assert.deepEqual(tabs.map((t) => t.sessionId), ["sess-claude"]);
	} finally {
		await server.stop();
	}
});

// The agent-session calls the pane makes must each advertise both capabilities: Orca refuses
// agentSession.create without the structured one, and hides Claude tabs from listAll without the
// Claude one. (The transport adds its own baseline capabilities to every call; project calls such as
// repo.list and worktree.list aren't gated on these.)
test("createClaudeSession and listAllAgentSessionTabs send both structured capabilities", async () => {
	const server = await FakeOrcaServer.start();
	try {
		server.setRepos([{ id: "r1", path: "/v", kind: "folder" }]);
		server.setWorkspaces("r1", [{ id: "ws-1", path: "/v" }]);
		const client = new OrcaRemoteClient();
		await client.connect(server.credential);
		await client.listRepos();
		await client.listWorkspaces("r1");
		const { sessionId } = await client.createClaudeSession("ws-1");
		await client.listAllAgentSessionTabs();
		assert.ok(sessionId);
		for (const method of ["agentSession.create", "session.tabs.listAll"]) {
			const sent = server.receivedCapabilities(method);
			assert.equal(sent.length, 1, method);
			for (const capability of STRUCTURED_AGENT_SESSION_CAPABILITIES) {
				assert.ok(sent[0].includes(capability), `${method} lacks ${capability}`);
			}
		}
	} finally {
		await server.stop();
	}
});
