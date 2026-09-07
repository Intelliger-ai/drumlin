import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { loweredCode, textWithoutComments } from "./text.js";

/**
 * Whether a screen actually reads data, and which states it already handles.
 *
 * This is the precision gate for the state-completeness rules. Every candidate
 * app measured so far has zero `loading.tsx` and zero `error.tsx`, so a rule
 * that fires on "no loading file" alone would report every route in the
 * product. Gating on real data access is what makes the finding mean something.
 */
export interface DataProfile {
  /** True when the screen reads data that can be slow or can fail. */
  fetchesData: boolean;
  /** Why we believe that, for use as finding evidence. */
  evidence: string[];
  /** True when the screen reads URL search params (filters, sort, page). */
  readsSearchParams: boolean;
  /** Search param keys the screen reads, when they are statically visible. */
  searchParamKeys: string[];
  /** States already handled inside the component itself. */
  handled: {
    loading: boolean;
    error: boolean;
    empty: boolean;
  };
  /** True when the file opts into being a client component. */
  clientComponent: boolean;
  /**
   * True when the screen is rendered at build time rather than per request.
   *
   * Decisive for the state-completeness rules. A statically generated MDX route
   * reads data, but it reads it during the build: there is no request to be slow
   * and no fetch to fail, so asking it for a loading state is asking for
   * something that can never appear. Four of the first four state findings on a
   * real app were exactly this.
   */
  prerendered: boolean;
}

const DATA_LIBRARY_IMPORTS = [
  "@prisma/client",
  "drizzle-orm",
  "@supabase/supabase-js",
  "@supabase/ssr",
  "mongoose",
  "@tanstack/react-query",
  "swr",
  "urql",
  "@apollo/client",
  "graphql-request",
  "axios",
  "ky",
];

const QUERY_HOOKS = [
  "useQuery",
  "useSuspenseQuery",
  "useInfiniteQuery",
  "useSWR",
  "useSWRInfinite",
  "useLazyQuery",
  "useFragment",
];

const PAGES_DATA_EXPORTS = [
  "getServerSideProps",
  "getStaticProps",
  "getInitialProps",
];

const LOADING_MARKERS = [
  "isloading",
  "ispending",
  "isfetching",
  "loading",
  "pending",
  "skeleton",
  "spinner",
  "suspense",
  "useformstatus",
  "useactionstate",
  "usetransition",
  "startTransition",
];

const ERROR_MARKERS = [
  "iserror",
  "onerror",
  "errorboundary",
  "error?",
  "error &&",
  "error ?",
  "haserror",
  "catch",
  "toast.error",
  "seterror",
];

const EMPTY_MARKERS = [
  "length === 0",
  "length == 0",
  "length ? ",
  "!data.length",
  "!items.length",
  "isempty",
  "emptystate",
  "no results",
  "nothing here",
  "no data",
];

function hasDirective(sourceFile: SourceFile, directive: string): boolean {
  for (const statement of sourceFile.getStatements().slice(0, 3)) {
    const text = statement.getText().trim().replace(/;$/, "");
    if (text === `"${directive}"` || text === `'${directive}'`) return true;
  }
  return false;
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/** Analyze one screen source file for data access and handled states. */
export function analyzeData(sourceFile: SourceFile): DataProfile {
  // Comments are stripped first: a screen that says `// TODO: loading state` has
  // no loading state, and must not be credited with one.
  const text = textWithoutComments(sourceFile);
  const lowered = loweredCode(sourceFile);
  const evidence: string[] = [];

  const clientComponent = hasDirective(sourceFile, "use client");

  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (
      DATA_LIBRARY_IMPORTS.some(
        (lib) => specifier === lib || specifier.startsWith(`${lib}/`),
      )
    ) {
      evidence.push(`imports data library ${specifier}`);
    }
  }

  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const expression = call.getExpression();
    const name = Node.isPropertyAccessExpression(expression)
      ? expression.getName()
      : expression.getText();

    if (name === "fetch") {
      evidence.push(`calls fetch() at line ${call.getStartLineNumber()}`);
      continue;
    }
    if (QUERY_HOOKS.includes(name)) {
      evidence.push(`uses ${name}() at line ${call.getStartLineNumber()}`);
      continue;
    }
    if (Node.isPropertyAccessExpression(expression)) {
      const receiver = expression.getExpression().getText();
      if (/^(prisma|db|database|supabase|client|sql)$/i.test(receiver)) {
        evidence.push(
          `queries ${receiver}.${name}() at line ${call.getStartLineNumber()}`,
        );
      }
    }
  }

  for (const name of PAGES_DATA_EXPORTS) {
    if (sourceFile.getFunction(name) ?? sourceFile.getVariableDeclaration(name)) {
      evidence.push(`exports ${name}`);
    }
  }

  // An async default export in a server component is itself a data signal, but
  // only when something is actually awaited — an async function that awaits
  // nothing but `params` is not fetching.
  const awaits = sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression);
  const meaningfulAwait = awaits.some((expression) => {
    const inner = expression.getExpression().getText();
    return !/^\s*(params|searchParams|props)\b/.test(inner);
  });
  if (meaningfulAwait && evidence.length === 0) {
    evidence.push("awaits a value during render");
  }

  const readsSearchParams =
    /\bsearchParams\b/.test(text) || /useSearchParams\s*\(/.test(text);

  return {
    fetchesData: evidence.length > 0,
    evidence,
    readsSearchParams,
    searchParamKeys: findSearchParamKeys(sourceFile),
    handled: {
      loading: containsAny(lowered, LOADING_MARKERS),
      error: containsAny(lowered, ERROR_MARKERS),
      empty: containsAny(lowered, EMPTY_MARKERS),
    },
    clientComponent,
    prerendered: isPrerendered(sourceFile),
  };
}

/**
 * Whether a route renders at build time.
 *
 * `generateStaticParams` is the declaration that the route's pages are known in
 * advance. An explicit `dynamic = 'force-dynamic'` overrides it, since that
 * moves rendering back to request time no matter what else the file says.
 */
function isPrerendered(sourceFile: SourceFile): boolean {
  const dynamicExport = sourceFile.getVariableDeclaration("dynamic");
  const dynamicValue = dynamicExport?.getInitializer()?.getText() ?? "";
  if (/force-dynamic/.test(dynamicValue)) return false;

  const staticParams =
    sourceFile.getFunction("generateStaticParams") ??
    sourceFile.getVariableDeclaration("generateStaticParams");
  if (staticParams) return true;

  // Pages Router: getStaticProps prerenders, getServerSideProps does not.
  if (
    (sourceFile.getFunction("getStaticProps") ??
      sourceFile.getVariableDeclaration("getStaticProps")) &&
    !(
      sourceFile.getFunction("getServerSideProps") ??
      sourceFile.getVariableDeclaration("getServerSideProps")
    )
  ) {
    return true;
  }

  return /force-static/.test(dynamicValue);
}

const NOT_A_PARAM_KEY = new Set([
  "then",
  "toString",
  "get",
  "getAll",
  "has",
  "entries",
  "keys",
  "values",
  "forEach",
  "set",
  "append",
  "delete",
  "size",
]);

/**
 * Search param keys a screen reads.
 *
 * Resolved through the AST rather than by scanning text, because `.get("…")` is
 * not distinctive on its own: `formData.get("password")` is the same shape as
 * `searchParams.get("status")`, and treating the two alike invents filter keys
 * that do not exist. Only receivers that actually hold search params count.
 */
function findSearchParamKeys(sourceFile: SourceFile): string[] {
  const keys = new Set<string>();
  const text = textWithoutComments(sourceFile);

  // Identifiers that hold search params: the conventional prop name, plus
  // anything bound to useSearchParams().
  // Descendants, not top-level declarations: `const params = useSearchParams()`
  // lives inside the component body, which `getVariableDeclarations` skips.
  const declarations = sourceFile.getDescendantsOfKind(
    SyntaxKind.VariableDeclaration,
  );

  const holders = new Set<string>(["searchParams"]);
  for (const declaration of declarations) {
    const initializer = declaration.getInitializer();
    if (!initializer) continue;
    if (/useSearchParams\s*\(/.test(initializer.getText())) {
      holders.add(declaration.getName());
    }
  }

  const isHolder = (expression: Node): boolean => {
    const receiver = expression.getText().replace(/^await\s+/, "");
    return holders.has(receiver) || holders.has(receiver.split(".").pop() ?? "");
  };

  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    const method = expression.getName();
    if (method !== "get" && method !== "getAll") continue;
    if (!isHolder(expression.getExpression())) continue;

    const argument = call.getArguments()[0];
    if (!argument) continue;
    const literal =
      argument.asKind(SyntaxKind.StringLiteral) ??
      argument.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
    if (literal) keys.add(literal.getLiteralValue());
  }

  // Direct property or index access on a searchParams object.
  for (const access of sourceFile.getDescendantsOfKind(
    SyntaxKind.PropertyAccessExpression,
  )) {
    if (!isHolder(access.getExpression())) continue;
    const name = access.getName();
    if (!NOT_A_PARAM_KEY.has(name)) keys.add(name);
  }
  for (const access of sourceFile.getDescendantsOfKind(
    SyntaxKind.ElementAccessExpression,
  )) {
    if (!isHolder(access.getExpression())) continue;
    const argument = access.getArgumentExpression();
    const literal = argument?.asKind(SyntaxKind.StringLiteral);
    if (literal) keys.add(literal.getLiteralValue());
  }

  // A destructuring or type annotation on the prop is the most reliable source.
  for (const match of text.matchAll(
    /searchParams\s*:\s*(?:Promise<)?\{([^}]*)\}/g,
  )) {
    const body = match[1];
    if (!body) continue;
    for (const field of body.matchAll(/([a-zA-Z_][\w-]*)\s*\??\s*:/g)) {
      if (field[1]) keys.add(field[1]);
    }
  }
  for (const declaration of declarations) {
    const nameNode = declaration.getNameNode();
    if (!Node.isObjectBindingPattern(nameNode)) continue;
    const initializer = declaration.getInitializer()?.getText() ?? "";
    if (!holders.has(initializer.replace(/^await\s+/, ""))) continue;
    for (const element of nameNode.getElements()) {
      keys.add(element.getPropertyNameNode()?.getText() ?? element.getName());
    }
  }

  return [...keys].sort();
}
