import { test, expect } from "./helpers/obsidian-fixture";
import { chatWebview, startNewSession } from "./helpers/pane";

test("a new session mounts a webview pointed at Orca's single-session UI", async ({ server, obsidian, vaultPath }) => {
	await startNewSession(obsidian, server, vaultPath);
	const [create] = server.received("agentSession.create") as { envelope: { sessionId: string } }[];
	const sessionId = create.envelope.sessionId;

	const webview = chatWebview(obsidian);
	const src = await webview.getAttribute("src");
	const expectedOrigin = server.credential.endpoint.replace(/^ws/, "http");
	expect(src).toMatch(new RegExp(`^${expectedOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/single-session-index\\.html\\?`));
	// "session", not "sessionId": Orca's parseSingleSessionLocation() contract (see embed-url.ts).
	expect(src).toContain(`session=${sessionId}`);
	expect(src).toMatch(/[?&]pairing=/);

	const partition = await webview.getAttribute("partition");
	expect(partition).toBeTruthy();
	expect(partition).not.toMatch(/^persist:/);
});
