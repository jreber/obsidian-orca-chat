// [[wikilinks]] in the embedded chat: the fake Orca serves a page with wikilinks as plain text (as
// Orca's renderer leaves them); the pane's injected script links them, the host marks dead ones, and
// a click opens the note in the main area while the chat stays mounted.
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./helpers/obsidian-fixture";
import { activateChatLeaf, captureGuest, guestAnchors, inGuest, leaves } from "./helpers/guest";
import { chatWebview, screenshotWindow, startNewSession, statusLabel } from "./helpers/pane";

const EMBED_PAGE = {
	html: `<!doctype html><title>Orca Session</title>
<body style="background:#1e1e1e;color:#ddd;font:14px/1.5 sans-serif;padding:12px">
<p id="p1">See [[Welcome]] and [[Nope]].</p>
<p id="p2">Or read [[Welcome|alias text]].</p>
<p>In code: <code id="c">[[Welcome]]</code></p>
<div id="later"></div>
<script>
setTimeout(function () {
	var p = document.createElement("p");
	p.id = "p3";
	p.textContent = "Later: [[Welcome#Fixture vault]]";
	document.getElementById("later").appendChild(p);
}, 1000);
</script>
</body>`,
};

test("wikilinks in the chat are clickable, dead ones marked, and open notes in the main area", async ({
	server,
	obsidian,
	vaultDir,
	vaultPath,
}) => {
	server.setEmbedPage(EMBED_PAGE);
	await startNewSession(obsidian, server, vaultPath);
	await expect(statusLabel(obsidian)).toHaveText("● Live chat");
	const sessionId = await chatWebview(obsidian).getAttribute("data-orca-session-id");

	// Linked on load, the later paragraph once it appears, and Nope marked after the host's answer.
	await expect
		.poll(() => guestAnchors(obsidian), { timeout: 15_000 })
		.toEqual([
			{ parent: "p1", link: "Welcome", text: "Welcome", dead: false, title: null },
			{ parent: "p1", link: "Nope", text: "Nope", dead: true, title: "Note not found in this vault" },
			{ parent: "p2", link: "Welcome", text: "alias text", dead: false, title: null },
			{ parent: "p3", link: "Welcome#Fixture vault", text: "Welcome > Fixture vault", dead: false, title: null },
		]);
	expect(await inGuest(obsidian, `document.getElementById("c").textContent`)).toBe("[[Welcome]]");
	expect(await inGuest(obsidian, `document.getElementById("p1").textContent`)).toBe("See Welcome and Nope.");
	await captureGuest(obsidian, "plugin-e2e-wikilinks-guest");

	const welcomeEditors = async () => (await leaves(obsidian)).filter((l) => l.type === "markdown" && l.file === "Welcome.md");
	expect(await welcomeEditors()).toEqual([]);

	// ── Click [[Welcome]] while the chat's leaf is active.
	await activateChatLeaf(obsidian);
	await inGuest(obsidian, `document.querySelector("#p1 a.orca-wikilink").click()`);
	await expect.poll(welcomeEditors).toEqual([
		{ type: "markdown", file: "Welcome.md", inMain: true, active: true },
	]);
	// The chat is still there, still live, still the same session.
	const chatLeaves = (await leaves(obsidian)).filter((l) => l.type === "orca-chat-view");
	expect(chatLeaves).toEqual([{ type: "orca-chat-view", file: null, inMain: false, active: false }]);
	await expect(chatWebview(obsidian)).toHaveAttribute("data-orca-session-id", sessionId!);
	await expect(statusLabel(obsidian)).toHaveText("● Live chat");
	await expect(obsidian.locator(".orca-chat-view webview.orca-chat-webview")).toHaveCount(1);
	await screenshotWindow(obsidian, "wikilinks-opened-welcome");

	// ── Click [[Nope]]: a Notice, and no note is created.
	await activateChatLeaf(obsidian);
	await inGuest(obsidian, `document.querySelectorAll("#p1 a.orca-wikilink")[1].click()`);
	await expect(obsidian.locator(".notice", { hasText: 'no note named "Nope"' })).toBeVisible();
	await screenshotWindow(obsidian, "wikilinks-dead-notice");
	expect(existsSync(path.join(vaultDir, "Nope.md"))).toBe(false);
	expect(
		await obsidian.evaluate(
			() =>
				(window as unknown as { app: { vault: { getAbstractFileByPath: (p: string) => unknown } } }).app.vault.getAbstractFileByPath("Nope.md") !==
				null,
		),
	).toBe(false);
	expect((await leaves(obsidian)).filter((l) => l.type === "orca-chat-view")).toHaveLength(1);
	await expect(statusLabel(obsidian)).toHaveText("● Live chat");
});
