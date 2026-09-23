// The script the pane injects into the embedded Orca chat to make [[wikilinks]] clickable, run
// against a jsdom document. Orca's markdown renderer leaves [[Note]] as literal text, so the script
// finds it in text nodes and wraps it in an anchor; clicks and dead-link checks go to the host as
// console.log markers.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { wikilinkGuestScript, wikilinkMarkScript, WIKILINK_OPEN_MARKER, WIKILINK_CHECK_MARKER } = await import(
	"../src/wikilinks.ts"
);

type Guest = { window: JSDOM["window"]; document: Document; logs: string[]; inject: () => void };

function guest(bodyHtml: string): Guest {
	const dom = new JSDOM(`<!doctype html><html><head></head><body>${bodyHtml}</body></html>`, { runScripts: "outside-only" });
	const logs: string[] = [];
	dom.window.console.log = (message: unknown) => void logs.push(String(message));
	const inject = () => void dom.window.eval(wikilinkGuestScript());
	inject();
	return { window: dom.window, document: dom.window.document, logs, inject };
}

// MutationObserver callbacks run as microtasks.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const anchors = (g: Guest) => Array.from(g.document.querySelectorAll("a.orca-wikilink")) as HTMLAnchorElement[];
const linkOf = (a: Element) => a.getAttribute("data-orca-link");
const checks = (g: Guest) =>
	g.logs.filter((l) => l.startsWith(WIKILINK_CHECK_MARKER)).map((l) => JSON.parse(l.slice(WIKILINK_CHECK_MARKER.length)) as string[]);

test("[[target]] becomes an anchor showing the target, with the surrounding text kept", () => {
	const g = guest("<p id=p>See [[Welcome]] for more.</p>");
	const [a] = anchors(g);
	assert.equal(a.textContent, "Welcome");
	assert.equal(linkOf(a), "Welcome");
	assert.equal(a.getAttribute("href"), "#");
	assert.equal(g.document.getElementById("p")!.textContent, "See Welcome for more.");
});

test("[[target#heading]] links to the heading and shows it as Obsidian does", () => {
	const g = guest("<p>[[Welcome#Getting started]]</p>");
	const [a] = anchors(g);
	assert.equal(linkOf(a), "Welcome#Getting started");
	assert.equal(a.textContent, "Welcome > Getting started");
});

test("[[target|alias]] shows the alias", () => {
	const g = guest("<p>Read [[Welcome|the welcome note]] now</p>");
	const [a] = anchors(g);
	assert.equal(linkOf(a), "Welcome");
	assert.equal(a.textContent, "the welcome note");
	assert.equal(g.document.body.textContent, "Read the welcome note now");
});

test("[[target#heading|alias]] links to the heading and shows the alias", () => {
	const g = guest("<p>[[Welcome#Setup|setup steps]]</p>");
	const [a] = anchors(g);
	assert.equal(linkOf(a), "Welcome#Setup");
	assert.equal(a.textContent, "setup steps");
});

test("several links in one text node are all linked, in order", () => {
	const g = guest("<p id=p>[[a]] and [[b]], then [[c|see c]].</p>");
	assert.deepEqual(anchors(g).map(linkOf), ["a", "b", "c"]);
	assert.equal(g.document.getElementById("p")!.textContent, "a and b, then see c.");
});

test("text inside code, pre, existing links, textareas and editable areas is left alone", () => {
	const g = guest(
		"<code>[[InCode]]</code><pre>[[InPre]]</pre><a href='https://x'>[[InLink]]</a>" +
			"<textarea>[[InTextarea]]</textarea><div contenteditable='true'>[[InEditor]]</div><p>[[Outside]]</p>",
	);
	assert.deepEqual(anchors(g).map(linkOf), ["Outside"]);
	assert.equal(g.document.querySelector("code")!.textContent, "[[InCode]]");
	assert.equal(g.document.querySelector("pre")!.textContent, "[[InPre]]");
	assert.equal(g.document.querySelector("div")!.textContent, "[[InEditor]]");
});

test("an unclosed [[Note is not linked until its ]] arrives", async () => {
	const g = guest("<p id=p>See [[Welc</p>");
	assert.equal(anchors(g).length, 0);
	assert.equal(g.document.getElementById("p")!.textContent, "See [[Welc");
	// Streaming output grows the same text node.
	(g.document.getElementById("p")!.firstChild as Text).nodeValue = "See [[Welcome]] now";
	await settle();
	assert.deepEqual(anchors(g).map(linkOf), ["Welcome"]);
	assert.equal(g.document.getElementById("p")!.textContent, "See Welcome now");
});

test("odd and nested brackets don't break anything", () => {
	const g = guest("<p id=a>[[[Note]]]</p><p id=b>[[a[b]] ]]x[[ [[]] [[|alias]]</p>");
	assert.deepEqual(anchors(g).map(linkOf), ["Note"]);
	assert.equal(g.document.getElementById("a")!.textContent, "[Note]");
	assert.equal(g.document.getElementById("b")!.textContent, "[[a[b]] ]]x[[ [[]] [[|alias]]");
});

test("HTML-like agent text stays text inside the anchor", () => {
	const g = guest("<p id=p></p>");
	g.document.getElementById("p")!.textContent = "x [[<img src=x onerror=alert(1)>]] y";
	g.inject();
	// The first injection already ran; a mutation made after it is picked up by the observer.
	return settle().then(() => {
		const [a] = anchors(g);
		assert.equal(a.textContent, "<img src=x onerror=alert(1)>");
		assert.equal(a.children.length, 0);
		assert.equal(g.document.querySelector("img"), null);
	});
});

test("running the script twice links each wikilink once", async () => {
	const g = guest("<p>[[Welcome]] and [[Other]]</p>");
	g.inject();
	g.document.body.appendChild(g.document.createElement("div"));
	await settle();
	assert.deepEqual(anchors(g).map(linkOf), ["Welcome", "Other"]);
});

test("text added later is linked by the mutation observer", async () => {
	const g = guest("<main id=m></main>");
	const p = g.document.createElement("p");
	p.textContent = "Later: [[Welcome]]";
	g.document.getElementById("m")!.appendChild(p);
	await settle();
	assert.deepEqual(anchors(g).map(linkOf), ["Welcome"]);
	const text = g.document.createTextNode(" and [[Other]]");
	p.appendChild(text);
	await settle();
	assert.deepEqual(anchors(g).map(linkOf), ["Welcome", "Other"]);
});

// React updates a text node it owns by assigning nodeValue; the anchors made from the old text must
// go, and the new text is linked instead.
test("a re-rendered text node replaces the links made from its old text", async () => {
	const g = guest("<p id=p>[[Old]] tail</p>");
	const original = g.document.getElementById("p")!.firstChild as Text;
	assert.deepEqual(anchors(g).map(linkOf), ["Old"]);
	original.nodeValue = "Now [[New]]!";
	await settle();
	assert.deepEqual(anchors(g).map(linkOf), ["New"]);
	assert.equal(g.document.getElementById("p")!.textContent, "Now New!");
	// React removing its node takes our anchors with it.
	g.document.getElementById("p")!.removeChild(original);
	await settle();
	assert.equal(anchors(g).length, 0);
	assert.equal(g.document.getElementById("p")!.textContent, "");
});

test("clicking a wikilink reports it to the host and does not navigate", () => {
	const g = guest("<p>[[Welcome#Setup|go]]</p>");
	const [a] = anchors(g);
	const event = new g.window.MouseEvent("click", { bubbles: true, cancelable: true });
	a.dispatchEvent(event);
	assert.equal(event.defaultPrevented, true);
	const opens = g.logs.filter((l) => l.startsWith(WIKILINK_OPEN_MARKER));
	assert.deepEqual(opens.map((l) => JSON.parse(l.slice(WIKILINK_OPEN_MARKER.length))), [{ link: "Welcome#Setup" }]);
});

test("each distinct target is sent for checking once; dead ones are marked, now and later", async () => {
	const g = guest("<p>[[Welcome]] [[Nope]] [[Welcome|again]]</p>");
	assert.deepEqual(checks(g), [["Welcome", "Nope"]]);
	g.window.eval(wikilinkMarkScript(["Nope"]));
	const dead = anchors(g).filter((a) => a.classList.contains("is-unresolved"));
	assert.deepEqual(dead.map(linkOf), ["Nope"]);
	assert.equal(dead[0].getAttribute("title"), "Note not found in this vault");

	const p = g.document.createElement("p");
	p.textContent = "[[Nope|later]] [[Third]]";
	g.document.body.appendChild(p);
	await settle();
	assert.deepEqual(checks(g), [["Welcome", "Nope"], ["Third"]]);
	const later = anchors(g).find((a) => a.textContent === "later")!;
	assert.ok(later.classList.contains("is-unresolved"), "a dead target seen again is marked at once");
});

test("a large batch of targets is sent in chunks of at most 200", () => {
	const text = Array.from({ length: 450 }, (_, i) => `[[n${i}]]`).join(" ");
	const g = guest(`<p>${text}</p>`);
	assert.deepEqual(checks(g).map((c) => c.length), [200, 200, 50]);
});
