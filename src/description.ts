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
 * The body to write for Ajour's text: the text as it is, with the source
 * body's line endings, and the blank lines and spaces the read trimmed from
 * its start and end, as they were. An emptied description empties the body.
 */
export function bodyFor(source: string | null | undefined, text: string) {
  const lines = (source ?? "").replace(/\r\n?/g, "\n");
  if (!text || !lines.trim()) return text;
  const start = /^(?:[ \t]*\n)*/.exec(lines)![0];
  const end = lines.slice(lines.trimEnd().length);
  const whole = `${start}${text}${end}`;
  return source!.includes("\r\n") ? whole.replace(/\n/g, "\r\n") : whole;
}

/** A body's length as GitHub counts it: a character made of two code units counts once. */
export function bodyLength(body: string) {
  return [...body].length;
}
