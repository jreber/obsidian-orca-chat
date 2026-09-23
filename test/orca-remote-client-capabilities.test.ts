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
