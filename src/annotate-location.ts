export interface LineRange {
	start: number;
	end: number;
}

export function formatLocation(filePath: string | null, lineRange: LineRange | null): string | null {
	if (!filePath) return null;
	if (!lineRange) return filePath;
	const lines = lineRange.start === lineRange.end ? `${lineRange.start}` : `${lineRange.start}-${lineRange.end}`;
	return `${filePath}:${lines}`;
}

// The citation is an obsidian://open link rather than a bare bracketed path, so the agent sees
// exactly which vault file is meant. It is not clickable in the embedded chat: Orca's renderer strips
// the obsidian:// href. Links the agent writes back are clickable as [[wikilinks]] (wikilinks.ts).
export function buildAnnotateMessage(
	selection: string,
	question: string,
	location: string | null,
	citationUri?: string | null,
): string {
	const lines = selection.split("\n");
	const citation = location ? (citationUri ? ` [${location}](${citationUri})` : ` [${location}]`) : "";
	const quoted = lines.map((line, i) => `> ${line}${i === lines.length - 1 ? citation : ""}`).join("\n");
	return `${quoted}\n\n${question}`;
}

// Obsidian's own deep-link scheme for opening a file in a named vault. Built with
// URLSearchParams (not encodeURIComponent) specifically because it also escapes `(` and `)` —
// encodeURIComponent leaves those unescaped, and an unescaped `)` in the URL would prematurely
// close the enclosing markdown link syntax `[text](url)`.
export function buildObsidianOpenUri(vaultName: string, filePath: string): string {
	const params = new URLSearchParams({ vault: vaultName, file: filePath });
	return `obsidian://open?${params.toString()}`;
}

export function lineRangeFromEditorCursors(fromLine: number, toLine: number): LineRange {
	return { start: fromLine + 1, end: toLine + 1 };
}

export function sectionInfoToLineTag(lineStart: number, lineEnd: number): string {
	return `${lineStart + 1}-${lineEnd + 1}`;
}

export function parseLineTag(tag: string | null | undefined): LineRange | null {
	if (!tag) return null;
	const match = /^(\d+)-(\d+)$/.exec(tag);
	if (!match) return null;
	return { start: Number(match[1]), end: Number(match[2]) };
}

export function readingModeLineRange(startTag: string | null | undefined, endTag: string | null | undefined): LineRange | null {
	const start = parseLineTag(startTag);
	const end = parseLineTag(endTag);
	if (!start || !end) return null;
	return { start: start.start, end: end.end };
}
