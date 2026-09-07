import { z } from "zod";

/**
 * Node identity. Semantic and stable by construction — `screen.invoices` rather
 * than a hash or a line number. Source locations are evidence, not identity, so
 * a node survives a file move or a reformat.
 *
 * See vault/Graph/Graph Identity.md and vault/Architecture/Stable IDs.md
 */
export const NodeIdSchema = z.string().min(1);
export type NodeId = string;

/** Prefix namespaces, keeping IDs readable and greppable. */
export const ID_KINDS = [
  "product",
  "feature",
  "persona",
  "role",
  "story",
  "task",
  "flow",
  "screen",
  "state",
  "component",
  "action",
  "decision",
  "event",
  "permission",
  "rule",
  "object",
] as const;
export type IdKind = (typeof ID_KINDS)[number];

/**
 * Lowercase, hyphenated, dot-free. Dots are the segment separator in an ID, so
 * they must not survive inside a single segment.
 */
export function slugify(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** Build a namespaced ID from already-meaningful parts. */
export function nodeId(kind: IdKind, ...parts: string[]): NodeId {
  const tail = parts
    .map((part) => slugify(part))
    .filter((part) => part.length > 0);
  return tail.length > 0 ? `${kind}.${tail.join(".")}` : kind;
}

/** The `kind` prefix of an ID, or undefined if it has none. */
export function idKind(id: NodeId): IdKind | undefined {
  const head = id.split(".")[0];
  return ID_KINDS.find((kind) => kind === head);
}

/**
 * Screen ID for a route. Dynamic segments collapse to their parameter name so
 * `/invoices/[id]` and `/invoices/[invoiceId]` stay distinguishable while
 * neither depends on a concrete value.
 *
 *   /                      -> screen.root
 *   /invoices              -> screen.invoices
 *   /invoices/[id]         -> screen.invoices.id
 *   /(dashboard)/settings  -> screen.settings
 */
export function routeToScreenId(route: string): NodeId {
  const segments = routeSegments(route);
  if (segments.length === 0) return nodeId("screen", "root");
  return nodeId("screen", ...segments);
}

/**
 * Dynamic segments that select a language rather than a record.
 *
 * Shared by the indexer and the rules because both get it wrong in the same
 * way otherwise. An i18n prefix is not a parameter in any sense a rule cares
 * about: every route has one, it always resolves, and it names nothing that
 * could be missing. Left alone it made `/[locale]` an orphan — the home page —
 * and claimed a missing not-found case on all twelve pages beneath it.
 */
const LOCALE_SEGMENT =
  /^\[{1,2}(\.\.\.)?(locale|locales|lang|langs|language|lng|loc|country|region|i18n)]{1,2}$/i;

/** True when a path segment selects a language rather than a record. */
export function isLocaleSegment(segment: string): boolean {
  return LOCALE_SEGMENT.test(segment);
}

/** The route with locale segments removed, e.g. `/[locale]/login` to `/login`. */
export function withoutLocaleSegments(route: string): string {
  const segments = route
    .split("/")
    .filter((segment) => segment.length > 0 && !isLocaleSegment(segment));
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * Meaningful segments of a route path. Drops Next.js route groups — `(marketing)`
 * organises files without affecting the URL, so it must not affect identity.
 */
export function routeSegments(route: string): string[] {
  return route
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .map((segment) =>
      segment
        .replace(/^\[\[\.\.\.(.+)\]\]$/, "$1-optional-catchall")
        .replace(/^\[\.\.\.(.+)\]$/, "$1-catchall")
        .replace(/^\[(.+)\]$/, "$1"),
    )
    .map((segment) => slugify(segment))
    .filter((segment) => segment.length > 0);
}

/**
 * State ID beneath a screen: `state.invoices.loading`.
 *
 * The screen path is split before rebuilding, because `nodeId` slugifies each
 * part it is given and would otherwise flatten `invoices.id` into `invoices-id`.
 */
export function stateId(screen: NodeId, name: string): NodeId {
  const withoutPrefix = screen.replace(/^screen\./, "");
  return nodeId("state", ...withoutPrefix.split("."), name);
}

/** Issue IDs are sequential and padded so they sort lexically: `UX-0184`. */
export function issueId(sequence: number): string {
  return `UX-${String(sequence).padStart(4, "0")}`;
}

export function parseIssueId(id: string): number | undefined {
  const match = /^UX-(\d+)$/.exec(id);
  if (!match?.[1]) return undefined;
  return Number.parseInt(match[1], 10);
}
