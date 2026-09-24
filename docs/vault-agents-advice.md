# Advice for the chat's agent: AGENTS.md in the vault

The Orca Chat pane runs an agent whose working folder is the vault root, so standing guidance for it
belongs in the vault's own `AGENTS.md`. Files in the Orca or plugin repos are never read by it.

Whether the agent reads `AGENTS.md` is up to Claude Code. Current Claude Code reads it only when the
vault has no `CLAUDE.md` of its own; older versions may not read it at all. When the vault root has a
`CLAUDE.md` (or `.claude/CLAUDE.md`), the button's Notice says so: "This vault has a CLAUDE.md, and
current Claude Code may read that instead of AGENTS.md."

The pane's **Append AGENTS.md advice** button (a plain button next to **New session**; hover it for a
tooltip) writes the block below into
the vault root's `AGENTS.md`. It creates the file if it is missing and appends the block at the end,
after a blank line. If the block is already there, it replaces the block in place with the current
text rather than adding a second copy. Nothing outside the markers is ever changed, and the file's
line endings are kept. An existing file is changed through Obsidian's `Vault#process`, so an open
editor's unsaved typing isn't lost. The Notice says "Added Orca Chat advice to AGENTS.md" or "Updated Orca Chat
advice in AGENTS.md".

```markdown
<!-- orca-chat:advice:start -->
## Orca Chat (Obsidian)

This folder is an Obsidian vault, and you may be talking to its owner through the Orca Chat pane in Obsidian.

- Be brief and conversational.
- Where it helps, mention notes with inline Obsidian wikilinks — [[Note Title]] or [[Note Title|shown text]]. The chat pane makes them clickable.
- Only link notes that exist in this vault: check with a file search first, and use the note's exact name without ".md".
- Don't put wikilinks inside code spans or code blocks; they won't be clickable there.
<!-- orca-chat:advice:end -->
```

To keep your own wording, write it outside the markers; the button owns what is between them.

## Why wikilinks

Orca's chat renderer drops links with schemes it doesn't know (an `obsidian://` link renders with an
empty href) and doesn't parse `[[wikilinks]]`. The pane turns `[[Note]]`, `[[Note#Heading]]`,
`[[Note|text]]` and `[[Note#Heading|text]]` in the chat into links. Clicking one opens the note in the
main editor area next to the chat. A link to a note that doesn't exist is shown faded with a dotted
underline, and clicking it only shows a Notice; no note is created. Wikilinks inside code are left as
text.
