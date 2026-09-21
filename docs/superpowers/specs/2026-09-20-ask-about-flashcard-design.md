# Ask Orca about a flashcard — design

## Problem

The `knowledge` vault now has a spaced-repetition flashcard system (`kg-flashcards` generates
cards, `kg-review` launches Obsidian's `obsidian-spaced-repetition` review UI — see
`knowledge/docs/superpowers/specs/2026-09-20-kg-flashcard-review-design.md`). While reviewing a
card, there's no way to ask a follow-up question about it without leaving the review flow,
manually re-finding the source note, and typing the question fresh into Orca Chat.

`obsidian-orca-chat` already solves this exact problem for regular note text: the existing
"annotate" feature (command `annotate-selection-with-orca`, bound to Mod+Shift+H) lets you select
text anywhere in a note, hit the hotkey, type a question in a small modal, and have the selection
plus your question sent straight into the active Orca chat session. This design extends that same
mechanism to work on the card currently under review in the spaced-repetition modal, instead of
building a separate, parallel feature.

## Goals

- One command, one hotkey, one question-modal — not a second, independent feature. Pressing the
  existing Mod+Shift+H hotkey while a flashcard review modal is open asks about the card; pressing
  it anywhere else keeps doing exactly what it does today (asks about the text selection).
- Always available while a card is showing, including before you've flipped to reveal the answer
  — the answer is sent to chat regardless of whether you've revealed it in the UI yet.
- No changes to the `knowledge` vault or to `kg-flashcards`/`kg-review` — this is entirely a
  `obsidian-orca-chat` change.

## Non-goals

- **No visible button injected into the review modal.** `obsidian-spaced-repetition` exposes no
  extension API for third-party UI (confirmed by reading its source and the installed plugin's
  minified bundle — no `exposeApi`, `registerExtension`, or similar hook exists). Adding a real
  button would require monkey-patching its internal rendering classes, which are unversioned
  implementation details with no compatibility contract; a plugin update could silently break the
  patch or corrupt the review UI. Rejected in favor of a hotkey, which only needs to *read* a data
  value, not alter SR's rendering.
- **No fork or vendoring of `obsidian-spaced-repetition`.** Too high-maintenance for what this is
  (manually re-importing upstream fixes indefinitely) and would leave the user running a second,
  divergent copy of the real plugin.
- **No changes to `obsidian-spaced-repetition` itself.** It's a community plugin reinstalled from
  its GitHub releases (see the flashcard-review design doc); any local edit to it would be
  overwritten the next time it's updated.

## Design

### Command (single, context-branching)

Reuses the existing command ID `annotate-selection-with-orca` (registered in
`obsidian-orca-chat/src/main.ts`) so the current Mod+Shift+H binding keeps working without the
user re-binding anything. Its display name changes from "Annotate selection with Orca" to
something reflecting the broadened scope (e.g. "Ask Orca about this"). The callback branches:

1. **A flashcard review modal is currently open** → read the current card's question/answer text
   (see below), build a flashcard-flavored message.
2. **Otherwise** → unchanged existing behavior: resolve the current text selection via
   `resolveSelectionWithLocation()`, exactly as today.

Flashcard-context wins whenever a review modal is open, even if a text selection happens to linger
in a background editor — reviewing a card is treated as always-stronger intent than an incidental
leftover selection.

Both branches open the existing `AnnotateModal` for the question text, then send through the
existing `OrcaChatView.sendToSelected()` — same "pick a session in the Orca Chat pane first"
behavior as today if no session is selected. No changes needed to either of those.

### Reading the current card

`obsidian-spaced-repetition`'s `Card` objects carry `front`/`back` as plain string fields — not
hidden behind component state — so the value exists in memory as soon as a card is shown,
independent of whether the UI has rendered the back side yet. The new code needs a read path from
"a flashcard command was just invoked" to those two strings.

The exact object path (a stable field on the SR plugin singleton itself, e.g. something under a
review-sequencer object, versus a value only reachable through the currently-open modal instance,
requiring a narrow one-time patch on the modal's open lifecycle purely to capture a reference — no
rendering changes) is **not settled here** — it needs to be verified empirically against the
actually-installed plugin bundle (`knowledge/.obsidian/plugins/obsidian-spaced-repetition/main.js`,
pinned at v1.15.4) the same way `kg-review`'s exact command ID was pinned down by reading the real
installed code rather than assuming it from memory. That verification is implementation-plan work.

Either way, this is a **read of two string fields**, not a patch to SR's rendering or click
handling — the smallest possible surface touching SR's internals.

**Failure handling:** wrapped in try/catch. If the read fails for any reason (SR updated and
changed its internals, no card currently loaded, plugin not installed), show an Obsidian `Notice`
("Couldn't read the current flashcard — the Spaced Repetition plugin may have changed") and stop —
never throw an unhandled error, never send a malformed message to chat.

### Message format

A new pure helper, parallel to the existing `buildAnnotateMessage` in
`src/annotate-location.ts`, formats the flashcard case:

```
Flashcard from [[Term Name]]:
Q: <question text>
A: <answer text>

<the user's typed question>
```

`[[Term Name]]` comes from the card note's `source:` frontmatter field, which `kg-flashcards`
already writes on every generated card — giving the chat session (and the user, since Orca Chat
renders wikilinks) a jump-back path to the glossary term, mirroring how the existing selection-based
annotate message cites a file location today.

### How "is a flashcard review modal open" is detected

Needs to check whether `obsidian-spaced-repetition` is installed, enabled, and currently showing
its review modal (as opposed to installed-but-idle). Exact detection mechanism (a DOM check for
the modal's container class, versus a state check on the plugin instance) is also implementation-
plan work, verified against the real plugin rather than assumed.

## Open questions for the implementation plan

- The exact JS property path to the live current card (plugin-singleton field vs. modal-instance
  capture-patch) — verify against `obsidian-spaced-repetition` v1.15.4's actual installed
  `main.js`.
- The exact mechanism to detect "a review modal is currently open" at command-invocation time.
- Whether any existing test in `obsidian-orca-chat`'s harness (`test/fakes/obsidian.ts` and
  friends — see `NOTES.md`) needs a fake for the SR plugin's shape, or whether this is tested via
  a pure-function unit test on the new message-builder plus a manual/live check for the
  plugin-reflection part (similar to how `kg-review`'s `xdg-open` trigger was verified: an
  automated check for the well-formed command plus an explicit manual GUI confirmation step).
