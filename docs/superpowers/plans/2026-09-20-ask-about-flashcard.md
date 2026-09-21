# Ask Orca About a Flashcard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing "annotate selection" hotkey so that, when a `obsidian-spaced-repetition` flashcard review modal is open, it asks about the current card instead of a text selection — one command, one hotkey, one question modal, branching on context.

**Architecture:** A new file `src/flashcard-context.ts` holds three pure, tested functions (DOM-open detection, card-shape extraction, message formatting) plus one untested reflection function that reaches into the live `obsidian-spaced-repetition` plugin instance and the vault's metadata cache to read the current card's `front`/`back` text and its source note's `source:` frontmatter. `AnnotateModal` gains an optional `title` parameter so it can say "flashcard" instead of "selection". `main.ts`'s existing `annotate-selection-with-orca` command branches on `isReviewModalOpen()` before falling back to its current selection-resolving behavior, and a small refactor (`ensureChatViewReady`) removes the chat-pane-resolution duplication between the two paths.

**Tech Stack:** TypeScript (strict), Obsidian plugin API, Node's built-in test runner (`node:test` + `node:assert/strict`) via the existing `test/run.mjs` esbuild-bundle-then-run harness, no test framework dependency.

## Global Constraints

- Everything in this plan lives in `/home/james/repos/obsidian-orca-chat` — no changes to the `knowledge` vault, `kg-flashcards`, or `kg-review`, and no changes to the installed `obsidian-spaced-repetition` plugin's own files (it's reinstalled from GitHub releases; any local edit would be overwritten on update).
- The command keeps its existing ID `annotate-selection-with-orca` and existing hotkey (Mod+Shift+H) — only its display `name` and `callback` change. No new hotkey is bound.
- Flashcard-context wins whenever a review modal is open, even if a text selection happens to linger in a background editor.
- The answer is always included in the message sent to chat, even if the card hasn't been flipped to reveal it yet in the SR UI — `front`/`back` are read directly from the live `Card` object in memory, not scraped from rendered DOM.
- Any failure reading the live SR plugin state (plugin not installed, internal shape changed, no card loaded) must show a `Notice` and stop — never throw an unhandled error.
- Verified against the actually-installed `obsidian-spaced-repetition` v1.15.4 bundle (`/home/james/repos/knowledge/.obsidian/plugins/obsidian-spaced-repetition/main.js`), not assumed from memory or from unminified GitHub source alone:
  - The plugin's main class is `SRPlugin`; `app.plugins.plugins["obsidian-spaced-repetition"]` is a live instance with a `uiManager` getter.
  - `uiManager.contentManager` is the live `ContentManager` for the open review session (set via `setContentManager` when a review modal opens; not reliably nulled back out on close, so its *presence* alone isn't a safe "is open" signal — that's why `isReviewModalOpen` uses a DOM check instead, see below).
  - `contentManager.reviewSequencer.currentCard` is a getter returning the live `Card` instance (or `null`), which is where `front: string` and `back: string` live directly as plain fields (`Card extends RepetitionItem`, constructed via `Object.assign(this, init)` — no getters/setters in the way).
  - `Card.storageInfo.notePath` is a plain string field holding the vault-relative path to the note the card's line came from (e.g. `papers/Infinite-Parameter-LLMs/Glossary-Cards/<Term Name>.md`) — used to look up that note's `source:` frontmatter via `app.vault.getAbstractFileByPath` + `app.metadataCache.getFileCache`, both real public Obsidian APIs (unlike the SR-internal reflection above).
  - `SRModalView.onOpen()` calls `this.contentEl.addClass("sr-modal-content")` — a stable-enough CSS hook (confirmed present in the installed bundle) used for `isReviewModalOpen`'s DOM check, since it reflects genuine UI visibility rather than an internal state flag that may or may not get reset.
- `App`'s public TypeScript declarations (`node_modules/obsidian/obsidian.d.ts`) do not include `.plugins` (Obsidian's plugin registry is real at runtime but undocumented/untyped) — reading it requires an explicit cast, confined to `resolveCurrentFlashcard`. `app.vault` and `app.metadataCache` (including `TFile`, `getAbstractFileByPath`, `getFileCache`) are properly typed public API — no cast needed for those.
- `test/fakes/obsidian.ts` (the module `test/run.mjs` aliases `"obsidian"` to during test bundling) does not currently export `TFile`. Any file that imports `TFile` from `"obsidian"` needs a fake added there first, or the whole test bundle fails to build (esbuild errors on a named import with no matching export in a local module) — even though no test actually exercises `TFile` behavior.
- Match existing repo conventions: pure, app-independent logic gets its own file with full unit tests (like `annotate-location.ts`); `App`-coupled orchestration glue (like `main.ts`'s existing `resolveSelectionWithLocation`) is not unit tested, verified live instead. Follow this same split rather than trying to force-test the SR reflection.

---

### Task 1: `flashcard-context.ts` — pure functions (DOM detection, card extraction, message format)

**Files:**
- Create: `src/flashcard-context.ts`
- Test: `test/flashcard-context.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `isReviewModalOpen(doc: Document): boolean`, `extractCardFrontBack(card: unknown): { front: string; back: string } | null`, `buildFlashcardAskMessage(front: string, back: string, sourceLink: string | null, question: string): string` — all three consumed by Task 2 (the same file) and Task 4 (`main.ts`'s wiring).

- [ ] **Step 1: Write the failing tests**

Create `test/flashcard-context.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { isReviewModalOpen, extractCardFrontBack, buildFlashcardAskMessage } from "../src/flashcard-context.ts";

test("isReviewModalOpen returns true when the SR modal's content element is present", () => {
	const dom = new JSDOM('<!doctype html><html><body><div class="sr-modal-content"></div></body></html>');
	assert.equal(isReviewModalOpen(dom.window.document), true);
});

test("isReviewModalOpen returns false when no SR modal element is present", () => {
	const dom = new JSDOM("<!doctype html><html><body></body></html>");
	assert.equal(isReviewModalOpen(dom.window.document), false);
});

test("extractCardFrontBack returns front/back when both are strings", () => {
	assert.deepEqual(extractCardFrontBack({ front: "Q", back: "A" }), { front: "Q", back: "A" });
});

test("extractCardFrontBack returns null when front is missing", () => {
	assert.equal(extractCardFrontBack({ back: "A" }), null);
});

test("extractCardFrontBack returns null when back is not a string", () => {
	assert.equal(extractCardFrontBack({ front: "Q", back: 5 }), null);
});

test("extractCardFrontBack returns null for null or undefined input", () => {
	assert.equal(extractCardFrontBack(null), null);
	assert.equal(extractCardFrontBack(undefined), null);
});

test("buildFlashcardAskMessage formats front/back with the source link when present", () => {
	assert.equal(
		buildFlashcardAskMessage("What is X?", "X is Y.", "[[X]]", "why does this matter?"),
		"Flashcard from [[X]]:\nQ: What is X?\nA: X is Y.\n\nwhy does this matter?",
	);
});

test("buildFlashcardAskMessage omits the source clause when there is no link", () => {
	assert.equal(
		buildFlashcardAskMessage("What is X?", "X is Y.", null, "why?"),
		"Flashcard:\nQ: What is X?\nA: X is Y.\n\nwhy?",
	);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/flashcard-context.ts` does not exist yet, so the import fails the build step.

- [ ] **Step 3: Write the implementation**

Create `src/flashcard-context.ts`:

```typescript
export function isReviewModalOpen(doc: Document): boolean {
	return doc.querySelector(".sr-modal-content") !== null;
}

export function extractCardFrontBack(card: unknown): { front: string; back: string } | null {
	if (card === null || typeof card !== "object") return null;
	const maybe = card as { front?: unknown; back?: unknown };
	if (typeof maybe.front !== "string" || typeof maybe.back !== "string") return null;
	return { front: maybe.front, back: maybe.back };
}

export function buildFlashcardAskMessage(
	front: string,
	back: string,
	sourceLink: string | null,
	question: string,
): string {
	const header = sourceLink ? `Flashcard from ${sourceLink}:` : "Flashcard:";
	return `${header}\nQ: ${front}\nA: ${back}\n\n${question}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all `flashcard-context.test.ts` tests green, alongside the existing suite.

- [ ] **Step 5: Commit**

```bash
git add src/flashcard-context.ts test/flashcard-context.test.ts
git commit -m "$(cat <<'EOF'
Add pure flashcard-context helpers (DOM detection, extraction, message format)

First piece of asking Orca about the current flashcard: detecting
whether a spaced-repetition review modal is open, extracting a card's
front/back text defensively, and formatting the chat message. No SR
plugin reflection yet — that's the next task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DegvUSu5uh9GoRVbB3kFvP
EOF
)"
```

---

### Task 2: `resolveCurrentFlashcard` — live SR plugin + note frontmatter reflection

**Files:**
- Modify: `src/flashcard-context.ts` (append)
- Modify: `test/fakes/obsidian.ts` (add a minimal `TFile` fake)

**Interfaces:**
- Consumes: `extractCardFrontBack` from Task 1 (same file).
- Produces: `FlashcardContext` interface (`{ front: string; back: string; sourceLink: string | null }`) and `resolveCurrentFlashcard(app: App): FlashcardContext | null` — consumed by Task 4's `main.ts` wiring.

This function is **not unit tested**, matching this codebase's existing convention for `App`-coupled orchestration glue (e.g. `main.ts`'s `resolveSelectionWithLocation` has no test file either) — it reaches into a live third-party plugin instance, which the test harness's fakes don't model. It's verified live in Task 4's manual end-to-end step instead.

- [ ] **Step 1: Add a minimal `TFile` fake**

`test/fakes/obsidian.ts` is what `test/run.mjs` aliases the `"obsidian"` import to during test bundling. Once this task's code does `import { App, TFile } from "obsidian"`, the test bundle needs a real `TFile` export to resolve against — otherwise esbuild fails the whole test build with an unresolved named import, even though no test exercises `TFile` directly. Add this class anywhere in the file (e.g. right after the existing `export class App` block, around line 93-96):

```typescript
export class TFile {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
}
```

- [ ] **Step 2: Run the existing test suite to confirm nothing broke**

Run: `npm test`
Expected: PASS — same test count as before (this step only adds an unused-so-far export, no behavior change).

- [ ] **Step 3: Append `resolveCurrentFlashcard` to `src/flashcard-context.ts`**

Add to the top of the file (new imports) and the end (new code):

```typescript
import { App, TFile } from "obsidian";
```

```typescript
export interface FlashcardContext {
	front: string;
	back: string;
	sourceLink: string | null;
}

interface SRPluginLike {
	uiManager?: {
		contentManager?: {
			reviewSequencer?: {
				currentCard?: unknown;
			};
		};
	};
}

// Reaches into obsidian-spaced-repetition's live plugin instance to read the card currently
// under review. app.plugins is real at runtime but absent from Obsidian's public type
// declarations (undocumented API), hence the cast. Every property access below is optional-
// chained and the whole thing is wrapped in try/catch: a plugin update that restructures these
// internals should make this return null, never throw.
export function resolveCurrentFlashcard(app: App): FlashcardContext | null {
	try {
		const pluginsHost = app as unknown as { plugins: { plugins: Record<string, unknown> } };
		const srPlugin = pluginsHost.plugins.plugins["obsidian-spaced-repetition"] as SRPluginLike | undefined;
		const rawCard = srPlugin?.uiManager?.contentManager?.reviewSequencer?.currentCard;
		const card = extractCardFrontBack(rawCard);
		if (!card) return null;

		const storageInfo = (rawCard as { storageInfo?: { notePath?: unknown } }).storageInfo;
		const notePath = storageInfo?.notePath;
		let sourceLink: string | null = null;
		if (typeof notePath === "string") {
			const file = app.vault.getAbstractFileByPath(notePath);
			if (file instanceof TFile) {
				const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
				if (typeof frontmatter?.source === "string") sourceLink = frontmatter.source;
			}
		}
		return { front: card.front, back: card.back, sourceLink };
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run the full test suite and typecheck**

Run: `npm test && npx tsc -noEmit -skipLibCheck`
Expected: `npm test` PASS with the same tests as Task 1 (this function has no dedicated test, by design — see above); `tsc` reports no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/flashcard-context.ts test/fakes/obsidian.ts
git commit -m "$(cat <<'EOF'
Add resolveCurrentFlashcard: read the live card from obsidian-spaced-repetition

Reflects into the installed SR plugin instance (app.plugins.plugins,
untyped/undocumented) to read the current card's front/back and, via
the real typed vault/metadataCache API, its source note's `source:`
frontmatter. Wrapped in try/catch — any failure returns null rather
than throwing, since these are unversioned third-party internals.
Not unit tested, matching main.ts's existing convention for
App-coupled glue; verified live in a later task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DegvUSu5uh9GoRVbB3kFvP
EOF
)"
```

---

### Task 3: `AnnotateModal` — parameterize the title

**Files:**
- Modify: `src/annotate-modal.ts`
- Modify: `test/annotate-modal.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `AnnotateModal`'s constructor gains a third, optional parameter `title: string = "Ask Orca about this selection"` — consumed by Task 4, which passes `"Ask Orca about this flashcard"` for the new flashcard path and omits it (keeping the default) for the existing selection path.

- [ ] **Step 1: Write the failing test**

Add to `test/annotate-modal.test.ts` (after the existing test, before the closing of the file):

```typescript
test("renders a custom title when one is provided", async () => {
	const modal = new AnnotateModal(new App(), async () => true, "Ask Orca about this flashcard");
	modal.open();
	const heading = modal.contentEl.querySelector("h3") as HTMLElement;
	assert.equal(heading.textContent, "Ask Orca about this flashcard");
});

test("falls back to the default title when none is provided", async () => {
	const modal = new AnnotateModal(new App(), async () => true);
	modal.open();
	const heading = modal.contentEl.querySelector("h3") as HTMLElement;
	assert.equal(heading.textContent, "Ask Orca about this selection");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `AnnotateModal`'s constructor doesn't accept a third argument yet, so the custom-title test renders the old hardcoded string instead of the expected one (TypeScript would also flag the extra constructor argument once Step 3 is skipped, but at this stage the test still runs against the old two-argument signature since JS ignores extra call arguments at runtime — the assertion is what fails).

- [ ] **Step 3: Implement the title parameter**

In `src/annotate-modal.ts`, change:

```typescript
export class AnnotateModal extends Modal {
	private onSubmit: (question: string) => Promise<boolean>;

	constructor(app: App, onSubmit: (question: string) => Promise<boolean>) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Ask Orca about this selection" });
```

to:

```typescript
export class AnnotateModal extends Modal {
	private onSubmit: (question: string) => Promise<boolean>;
	private title: string;

	constructor(
		app: App,
		onSubmit: (question: string) => Promise<boolean>,
		title = "Ask Orca about this selection",
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.title = title;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — both new tests green, plus the existing "closes immediately on submit" test unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/annotate-modal.ts test/annotate-modal.test.ts
git commit -m "$(cat <<'EOF'
Add optional title parameter to AnnotateModal

Defaults to the existing "Ask Orca about this selection" text, so the
current annotate-selection flow is unaffected. The flashcard-asking
path (next task) passes "Ask Orca about this flashcard" instead.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DegvUSu5uh9GoRVbB3kFvP
EOF
)"
```

---

### Task 4: Wire it into `main.ts`

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `isReviewModalOpen`, `resolveCurrentFlashcard`, `buildFlashcardAskMessage` (Tasks 1-2), `AnnotateModal`'s new `title` parameter (Task 3).
- Produces: nothing consumed by a later task — this is the final integration point.

No new automated test — `main.ts`'s command callbacks and private orchestration methods have no existing test file (`resolveSelectionWithLocation`, `runAnnotate`, etc. are all untested glue relying on a live `App`), and this task follows that same convention. Verified instead by `npm run build` (typecheck + bundle) plus an explicit manual end-to-end check for both branches.

- [ ] **Step 1: Add the new imports**

In `src/main.ts`, change the import block (currently lines 1-5):

```typescript
import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { AnnotateModal } from "./annotate-modal";
import { buildAnnotateMessage, buildObsidianOpenUri, formatLocation, lineRangeFromEditorCursors, readingModeLineRange, sectionInfoToLineTag } from "./annotate-location";
import { ORCA_CHAT_VIEW_TYPE, OrcaChatView } from "./chat-view";
import { PairingModal } from "./pairing-modal";
```

to:

```typescript
import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { AnnotateModal } from "./annotate-modal";
import { buildAnnotateMessage, buildObsidianOpenUri, formatLocation, lineRangeFromEditorCursors, readingModeLineRange, sectionInfoToLineTag } from "./annotate-location";
import { buildFlashcardAskMessage, FlashcardContext, isReviewModalOpen, resolveCurrentFlashcard } from "./flashcard-context";
import { ORCA_CHAT_VIEW_TYPE, OrcaChatView } from "./chat-view";
import { PairingModal } from "./pairing-modal";
```

- [ ] **Step 2: Extract the shared chat-view-readiness logic**

`runAnnotate` (currently lines 115-133) contains chat-pane resolution logic the new flashcard path also needs. Replace the whole method with a shared helper plus a slimmer `runAnnotate`:

```typescript
	private async ensureChatViewReady(): Promise<OrcaChatView | null> {
		let chatView = await this.getChatView();
		if (!chatView) {
			const leaf = await this.activateChatView();
			chatView = await this.resolveChatView(leaf);
			if (!chatView) {
				new Notice("Orca Chat: could not open the chat pane");
				return null;
			}
		}
		if (!chatView.getSelectedHandle()) {
			chatView.focusPicker();
		}
		return chatView;
	}

	private async runAnnotate(selection: string, location: string | null, filePath: string | null): Promise<void> {
		const view = await this.ensureChatViewReady();
		if (!view) return;
		const citationUri = filePath ? buildObsidianOpenUri(this.app.vault.getName(), filePath) : null;
		new AnnotateModal(this.app, async (question) => {
			return view.sendToSelected(buildAnnotateMessage(selection, question, location, citationUri));
		}).open();
	}

	private async runFlashcardAsk(card: FlashcardContext): Promise<void> {
		const view = await this.ensureChatViewReady();
		if (!view) return;
		new AnnotateModal(
			this.app,
			async (question) => view.sendToSelected(buildFlashcardAskMessage(card.front, card.back, card.sourceLink, question)),
			"Ask Orca about this flashcard",
		).open();
	}
```

- [ ] **Step 3: Branch the command's callback on flashcard-review context**

Change the `annotate-selection-with-orca` command registration (currently lines 19-35) from:

```typescript
		this.addCommand({
			id: "annotate-selection-with-orca",
			name: "Annotate selection with Orca",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "H" }],
			// Plain callback, not editorCallback: editorCallback only fires when
			// workspace.activeEditor is set, which Reading Mode never does (there is no CodeMirror
			// instance behind rendered markdown). Resolving the selection by hand lets one command
			// work in both Edit and Reading mode.
			callback: () => {
				const resolved = this.resolveSelectionWithLocation();
				if (!resolved) {
					new Notice("Select text first");
					return;
				}
				void this.runAnnotate(resolved.text, resolved.location, resolved.filePath);
			},
		});
```

to:

```typescript
		this.addCommand({
			id: "annotate-selection-with-orca",
			name: "Ask Orca about this",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "H" }],
			// Plain callback, not editorCallback: editorCallback only fires when
			// workspace.activeEditor is set, which Reading Mode never does (there is no CodeMirror
			// instance behind rendered markdown). Resolving the selection by hand lets one command
			// work in both Edit and Reading mode.
			//
			// Branches on flashcard-review context first: if a spaced-repetition review modal is
			// open, that's always stronger intent than a leftover text selection in a background
			// editor, so it wins unconditionally rather than checking selection first.
			callback: () => {
				if (isReviewModalOpen(document)) {
					const card = resolveCurrentFlashcard(this.app);
					if (!card) {
						new Notice("Couldn't read the current flashcard — the Spaced Repetition plugin may have changed");
						return;
					}
					void this.runFlashcardAsk(card);
					return;
				}
				const resolved = this.resolveSelectionWithLocation();
				if (!resolved) {
					new Notice("Select text first");
					return;
				}
				void this.runAnnotate(resolved.text, resolved.location, resolved.filePath);
			},
		});
```

- [ ] **Step 4: Typecheck and run the full test suite**

Run: `npx tsc -noEmit -skipLibCheck && npm test`
Expected: both PASS — no type errors, and the full suite (including the pre-existing `annotate-location.test.ts`, `annotate-modal.test.ts`, `chat-view.test.ts`, `embed-url.test.ts`, `fake-orca-server.protocol.test.ts`, plus this plan's new `flashcard-context.test.ts`) green.

- [ ] **Step 5: Build the plugin**

Run: `npm run build`
Expected: succeeds, producing an updated `main.js` bundle.

- [ ] **Step 6: Manual end-to-end verification (tell the user, don't attempt yourself)**

Report to the user that they should, in Obsidian on the `knowledge` vault:
1. Reload the plugin (or restart Obsidian) so the rebuilt `main.js` loads.
2. Confirm the command palette now shows "Ask Orca about this" (not "Annotate selection with Orca") for the same Mod+Shift+H binding.
3. Select some text in a note, press Mod+Shift+H, confirm the existing selection-annotate flow still works unchanged (modal titled "Ask Orca about this selection").
4. Run `kg-review` (or otherwise open a spaced-repetition review) so a flashcard is on screen, press Mod+Shift+H, confirm a modal titled "Ask Orca about this flashcard" appears, type a question, and confirm the message that arrives in the Orca Chat pane contains the card's question, answer, and a `[[Term Name]]` link back to its source note.
5. Try it again on a card *before* flipping to reveal the answer, and confirm the answer is still included in the sent message (per this feature's design — it's not gated on having revealed the answer in the UI).

This is the real acceptance test for the whole feature — nothing upstream of the GUI can substitute for it, the same way `kg-review`'s trigger required a manual confirmation.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "$(cat <<'EOF'
Wire flashcard-asking into the annotate-selection command

annotate-selection-with-orca (Mod+Shift+H) now branches: if a
spaced-repetition review modal is open, it asks about the current
card instead of a text selection. Same command ID and hotkey, same
question modal (now correctly titled per context), same send path —
extracted the shared chat-view-readiness logic into
ensureChatViewReady() to avoid duplicating it between the two paths.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DegvUSu5uh9GoRVbB3kFvP
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** the spec's three design sections (single context-branching command, reading the current card, message format) map directly to Tasks 4, 1+2, and 1 respectively. Both of the spec's explicit "open questions for the implementation plan" are resolved in the Global Constraints above by reading the real installed plugin bundle: the exact property path (`uiManager.contentManager.reviewSequencer.currentCard`, plus `storageInfo.notePath` for the source note) and the exact "is a review modal open" detection (`.sr-modal-content` DOM class, chosen over a state-flag check specifically because `contentManager` isn't reliably nulled out on close).
- **Placeholder scan:** no TBD/TODO; the one thing left for a human (Task 4 Step 6) is explicitly a manual GUI step, not a placeholder standing in for undone design work.
- **Type/naming consistency:** `FlashcardContext` (`front`/`back`/`sourceLink`) is defined once in Task 2 and used with the same field names in Task 4's `runFlashcardAsk`; `isReviewModalOpen`, `extractCardFrontBack`, `buildFlashcardAskMessage`, and `resolveCurrentFlashcard` are each defined exactly once and consumed with matching signatures everywhere they're called.
