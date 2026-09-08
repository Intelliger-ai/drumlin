import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { DYNAMIC } from "../routes.js";

/**
 * A navigation intent found in source: a Link, an imperative push, or a redirect.
 */
export interface NavigationTarget {
  /** Href with runtime interpolations replaced by a placeholder segment. */
  href: string;
  /** Raw source text, kept for evidence. */
  raw: string;
  kind:
    | "link"
    | "push"
    | "replace"
    | "redirect"
    | "anchor"
    | "form-action"
    | "config";
  line: number;
  /** True when the target sits inside a layout or shared chrome component. */
  chrome: boolean;
  /**
   * Query keys the href carries forward, when it builds a query string.
   * An empty array means it navigates without any query.
   */
  query: string[];
  /** True when the href appears to forward existing search params wholesale. */
  forwardsSearchParams: boolean;
}

const PUSH_METHODS = new Set(["push", "replace"]);

/** Object keys that hold a route in a navigation config. */
const NAV_CONFIG_KEYS = new Set(["href", "to", "path", "route", "url", "link"]);

const SEARCH_PARAM_TOKENS = [
  "searchparams",
  "search_params",
  "queryparams",
  "query_params",
  "createquerystring",
  "tostring()",
  "filters",
  "currentparams",
  "params.tostring",
];

/**
 * Collapse a string-ish expression into a comparable href.
 *
 * Template interpolations become a placeholder rather than being dropped, so
 * `/invoices/${id}` keeps its shape and still matches `/invoices/[id]`.
 */
function readHref(node: Node): { href: string; raw: string } | undefined {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return { href: node.getLiteralValue(), raw: node.getText() };
  }

  if (Node.isTemplateExpression(node)) {
    let href = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      href += DYNAMIC + span.getLiteral().getLiteralText();
    }
    return { href, raw: node.getText() };
  }

  if (Node.isJsxExpression(node)) {
    const inner = node.getExpression();
    return inner ? readHref(inner) : undefined;
  }

  // Conditional hrefs contribute both branches; the caller sees two targets.
  return undefined;
}

function conditionalBranches(node: Node): Node[] {
  if (Node.isJsxExpression(node)) {
    const inner = node.getExpression();
    return inner ? conditionalBranches(inner) : [];
  }
  if (Node.isConditionalExpression(node)) {
    return [node.getWhenTrue(), node.getWhenFalse()];
  }
  return [];
}

function analyzeQuery(raw: string): {
  query: string[];
  forwardsSearchParams: boolean;
} {
  const lowered = raw.toLowerCase();
  const forwards = SEARCH_PARAM_TOKENS.some((token) => lowered.includes(token));

  const query: string[] = [];
  const queryIndex = raw.indexOf("?");
  if (queryIndex !== -1) {
    const queryText = raw.slice(queryIndex + 1);
    for (const match of queryText.matchAll(/([a-zA-Z_][\w-]*)=/g)) {
      if (match[1]) query.push(match[1]);
    }
  }

  return { query, forwardsSearchParams: forwards };
}

/**
 * Every navigation target in a source file.
 *
 * `chrome` marks targets that come from a layout or a shared navigation
 * component. Global nav makes almost nothing a true dead end, so rules need to
 * tell in-content links apart from chrome while still counting chrome for
 * reachability.
 */
export function findNavigationTargets(
  sourceFile: SourceFile,
  options: { chrome?: boolean } = {},
): NavigationTarget[] {
  const chrome = options.chrome ?? false;
  const targets: NavigationTarget[] = [];

  const add = (
    node: Node,
    kind: NavigationTarget["kind"],
    hrefNode: Node,
  ): void => {
    const branches = conditionalBranches(hrefNode);
    const nodes = branches.length > 0 ? branches : [hrefNode];
    for (const candidate of nodes) {
      const read = readHref(candidate);
      if (!read) continue;
      const { query, forwardsSearchParams } = analyzeQuery(read.raw);
      targets.push({
        href: read.href,
        raw: read.raw,
        kind,
        line: node.getStartLineNumber(),
        chrome,
        query,
        forwardsSearchParams,
      });
    }
  };

  for (const element of sourceFile.getDescendantsOfKind(
    SyntaxKind.JsxSelfClosingElement,
  )) {
    collectFromJsx(element.getTagNameNode().getText(), element, add);
  }
  for (const element of sourceFile.getDescendantsOfKind(
    SyntaxKind.JsxOpeningElement,
  )) {
    collectFromJsx(element.getTagNameNode().getText(), element, add);
  }

  // Navigation declared as data rather than markup. A sidebar built from a
  // `[{ label, href }]` array is the single most common way a real app defines
  // its main navigation, and missing it makes every screen the sidebar reaches
  // look unreachable.
  for (const property of sourceFile.getDescendantsOfKind(
    SyntaxKind.PropertyAssignment,
  )) {
    const name = property.getName().replace(/["']/g, "");
    if (!NAV_CONFIG_KEYS.has(name)) continue;
    const initializer = property.getInitializer();
    if (!initializer) continue;
    const read = readHref(initializer);
    if (!read || !read.href.startsWith("/")) continue;
    add(property, "config", initializer);
  }

  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const expression = call.getExpression();
    const argument = call.getArguments()[0];
    if (!argument) continue;

    if (Node.isPropertyAccessExpression(expression)) {
      const method = expression.getName();
      if (!PUSH_METHODS.has(method)) continue;
      const receiver = expression.getExpression().getText();
      if (!/router|navigation|history/i.test(receiver)) continue;
      add(call, method === "push" ? "push" : "replace", argument);
      continue;
    }

    if (Node.isIdentifier(expression) && expression.getText() === "redirect") {
      add(call, "redirect", argument);
    }
  }

  return targets;
}

function collectFromJsx(
  tagName: string,
  element: Node,
  add: (node: Node, kind: NavigationTarget["kind"], hrefNode: Node) => void,
): void {
  const isLink = tagName === "Link" || /(^|\.)Link$/.test(tagName);
  const isAnchor = tagName === "a";
  if (!isLink && !isAnchor) return;

  const attributes = element.getDescendantsOfKind(SyntaxKind.JsxAttribute);
  for (const attribute of attributes) {
    if (attribute.getNameNode().getText() !== "href") continue;
    const initializer = attribute.getInitializer();
    if (!initializer) continue;
    add(element, isLink ? "link" : "anchor", initializer);
  }
}

/** True when a file is shared chrome rather than a single screen. */
export function isChromeFile(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    /(^|\/)layout\.(tsx|jsx|ts|js)$/.test(lower) ||
    /(^|\/)template\.(tsx|jsx|ts|js)$/.test(lower) ||
    /(^|\/)(nav|navbar|navigation|sidebar|header|footer|app-shell|shell|menu|breadcrumbs?)[.-]/.test(
      lower,
    ) ||
    /(^|\/)_app\.(tsx|jsx|ts|js)$/.test(lower)
  );
}
