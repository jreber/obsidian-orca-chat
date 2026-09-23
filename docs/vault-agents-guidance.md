# Guidance for the chat's agent: AGENTS.md in the vault

The Orca Chat pane runs a Claude session whose working folder is the **vault root**. The agent reads
standing instructions from files in that folder, so that is where chat guidance has to go. Files in the
Orca repo or in this plugin's repo are never read by the agent.

Claude Code reads `CLAUDE.md`, not `AGENTS.md`. To have it read `AGENTS.md` too, put a line
`@AGENTS.md` in the vault root's `CLAUDE.md` (create it if there isn't one).

## The command

Run **Orca Chat: Add chat guidelines to AGENTS.md** from the command palette. It:

- creates `AGENTS.md` at the vault root with the block below if there is no such file;
- appends the block, after a blank line, if the file exists without it;
- does nothing ("already there") if the block's start marker is already in the file.

It never changes text outside the markers, never overwrites the file, and keeps the file's line
endings (CRLF stays CRLF). It never creates or edits `CLAUDE.md`; if `CLAUDE.md` is missing or has no
`@AGENTS.md` line, the Notice says to add one. Edit the text between the markers however you like;
running the command again won't touch it.

## The block

```markdown
<!-- orca-chat:guidelines:start -->
## Orca Chat (Obsidian)

This folder is an Obsidian vault, and you may be talking to its owner through the Orca Chat pane in Obsidian.

- Be conversational and brief.
- Mention notes with inline Obsidian wikilinks — [[Note Title]] or [[Note Title|shown text]] — as often as is natural. The chat pane makes them clickable.
- Only link notes that exist in this vault: check with a file search first, and use the note's exact name without ".md".
- Don't put wikilinks inside code spans or code blocks; they won't be clickable there.
<!-- orca-chat:guidelines:end -->
```

## Why wikilinks

Orca's chat renderer drops links with schemes it doesn't know (an `obsidian://` link renders with an
empty href) and doesn't parse `[[wikilinks]]`. The pane turns `[[Note]]`, `[[Note#Heading]]`,
`[[Note|text]]` and `[[Note#Heading|text]]` in the chat into links. Clicking one opens the note in the
main editor area next to the chat. A link to a note that doesn't exist is shown faded with a dotted
underline, and clicking it only shows a Notice; no note is created. Wikilinks inside code are left as
text.
