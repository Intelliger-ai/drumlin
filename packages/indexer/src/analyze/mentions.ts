import { SyntaxKind, type SourceFile } from "ts-morph";

/**
 * Every place a route is named, whether or not it became a link.
 *
 * Orphan detection asks "does anything link here", and an edge is a stronger
 * claim than that question needs. A route named in a markdown article, in a
 * content module a page renders, or behind a helper that builds the href is
 * linked in fact even when the link cannot be resolved statically.
 *
 * Treating a mention as sufficient trades recall for precision: a page reached
 * only from another orphan stops being reported. That is the right way round
 * for Milestone A, where one wrong finding costs more than one missed.
 */

const ROUTE_LIKE = /^\/(?!\/)[a-zA-Z0-9\-_/[\]().]*$/;

/** File extensions that hold prose rather than code. */
export const CONTENT_EXTENSIONS = [".md", ".mdx", ".markdown"] as const;

export interface RouteMention {
  value: string;
  /**
   * True when the string is the start of a route rather than a whole one.
   *
   * The distinction is load-bearing. `/users/` as the head of a template
   * literal is a mention of `/users/[id]`, but as a complete href it means
   * `/users`, and those are different screens.
   */
  partial: boolean;
}

/** Route-shaped strings appearing anywhere in a source file. */
export function findRouteMentions(sourceFile: SourceFile): RouteMention[] {
  const mentions = new Map<string, RouteMention>();

  const consider = (value: string, partial: boolean): void => {
    const trimmed = value.trim();
    if (trimmed.length < 2 || !ROUTE_LIKE.test(trimmed)) return;
    const existing = mentions.get(trimmed);
    // A partial claim covers the complete one, so keep the broader reading.
    if (existing?.partial) return;
    mentions.set(trimmed, { value: trimmed, partial });
  };

  for (const literal of sourceFile.getDescendantsOfKind(
    SyntaxKind.StringLiteral,
  )) {
    const value = literal.getLiteralValue();
    consider(value, value.endsWith("/"));
  }
  for (const literal of sourceFile.getDescendantsOfKind(
    SyntaxKind.NoSubstitutionTemplateLiteral,
  )) {
    const value = literal.getLiteralValue();
    consider(value, value.endsWith("/"));
  }

  // `/authors/${slug}` mentions `/authors/` even though the whole href is not
  // knowable, and that is enough to answer the reachability question.
  for (const template of sourceFile.getDescendantsOfKind(
    SyntaxKind.TemplateExpression,
  )) {
    const head = template.getHead().getLiteralText();
    if (head.startsWith("/")) consider(head, true);
  }

  return [...mentions.values()];
}

/** Link targets in a markdown or MDX document. */
export function findMarkdownLinks(text: string): string[] {
  const links = new Set<string>();

  for (const match of text.matchAll(/]\(\s*(\/[^)\s"']*)/g)) {
    if (match[1]) links.add(normalise(match[1]));
  }
  for (const match of text.matchAll(/href\s*=\s*["'](\/[^"']*)["']/g)) {
    if (match[1]) links.add(normalise(match[1]));
  }
  // Reference-style definitions: `[label]: /route`
  for (const match of text.matchAll(/^\s*\[[^\]]+]:\s*(\/\S+)/gm)) {
    if (match[1]) links.add(normalise(match[1]));
  }

  return [...links];
}

function normalise(href: string): string {
  const withoutFragment = href.split(/[?#]/)[0] ?? href;
  if (withoutFragment.length > 1 && withoutFragment.endsWith("/")) {
    return withoutFragment.slice(0, -1);
  }
  return withoutFragment;
}
