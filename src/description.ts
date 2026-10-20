import type { ConnectorSyncedDescription } from "./contract.js";

/** The most of a description Ajour stores (Ajour's ADR 0009). */
export const MAX_DESCRIPTION_LENGTH = 64_000;

/**
 * The longest body GitHub takes. GitHub does not document it; it refuses a
 * longer one with "Body is too long (maximum is 65536 characters)", counting
 * characters, not UTF-16 code units.
 */
export const GITHUB_BODY_MAX_LENGTH = 65_536;

/** What `lost` names for a body whose lines end in more than one way. */
export const MIXED_LINE_ENDINGS = "line endings Ajour cannot keep";

/**
 * An issue body as Ajour syncs it. A body is Markdown already, so the text is
 * the body as written, `@login` mentions and GitHub-only syntax included. As
 * Ajour stores a description, its lines end in Unix line endings, without the
 * blank lines before it or the spaces after it; `bodyFor` puts them back.
 */
export function describeIssueBody(body: string | null | undefined): ConnectorSyncedDescription {
  const source = body ?? "";
  let text = source
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
  // A write gives every line the body's one line ending, so a mix, or old
  // Mac endings, would change.
  const mixed = /\r(?!\n)/.test(source) || (source.includes("\r\n") && /(?:^|[^\r])\n/.test(source));
  const cut = text.length > MAX_DESCRIPTION_LENGTH;
  if (cut) {
    text = text.slice(0, MAX_DESCRIPTION_LENGTH);
    // Never leave half of a character made of two code units.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  return {
    text,
    ...(mixed ? { lost: [MIXED_LINE_ENDINGS] } : {}),
    ...(cut ? { cut: true } : {}),
  };
}

/**
 * Where the source's last line is among the edited lines, if the user left it
 * as it was: after the lines they kept before it, or else its last place
 * among the lines after those. Undefined when they edited or deleted it.
 */
function lastLineAt(original: string[], edited: string[]) {
  let kept = 0;
  while (kept < original.length && kept < edited.length && original[kept] === edited[kept]) kept += 1;
  if (kept === original.length) return kept - 1;
  const at = edited.lastIndexOf(original[original.length - 1]!);
  return at >= kept ? at : undefined;
}

/**
 * The body to write for Ajour's text: the text as it is, with the source
 * body's line endings, and the whitespace the read trimmed put back where it
 * was. The blank lines before and after the text stay at the body's start and
 * end. The last line's trailing spaces, tabs or non-breaking spaces stay on
 * that line wherever the edit moved it, and go with it when the user edited
 * or deleted it. An emptied description empties the body, and a blank body,
 * with nothing to keep in place, takes the text as it is.
 */
export function bodyFor(source: string | null | undefined, text: string) {
  const lines = (source ?? "").replace(/\r\n?/g, "\n");
  const start = /^(?:[ \t]*\n)*/.exec(lines)![0];
  const read = lines.slice(start.length).trimEnd();
  if (!text || !read) return text;
  const end = lines.slice(start.length + read.length);
  const lineEnd = end.indexOf("\n");
  const trailing = lineEnd === -1 ? end : end.slice(0, lineEnd);
  const blankLines = lineEnd === -1 ? "" : end.slice(lineEnd);
  const edited = text.split("\n");
  const at = lastLineAt(read.split("\n"), edited);
  if (at !== undefined) edited[at] += trailing;
  const whole = `${start}${edited.join("\n")}${blankLines}`;
  return source!.includes("\r\n") ? whole.replace(/\n/g, "\r\n") : whole;
}

/** A body's length as GitHub counts it: a character made of two code units counts once. */
export function bodyLength(body: string) {
  return [...body].length;
}
