import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { loweredCode } from "./text.js";

/**
 * Mutations the product can perform, and how safely they are presented.
 *
 * Drumlin cares less about the mutation than about what surrounds it: whether
 * the user learns it is running, whether they learn it failed, and whether an
 * irreversible one asks first.
 */
export interface ActionInfo {
  name: string;
  /** Repository-relative file the action is declared in. */
  file: string;
  line: number;
  /** True for `"use server"` server actions. */
  serverAction: boolean;
  /**
   * How the mutation is written. A server action is called from elsewhere, so
   * its feedback lives at the call site; a `useMutation` declares its feedback
   * in the same file. The two need different evidence, so they are recorded
   * separately rather than flattened into "an action".
   */
  style: "server-action" | "client-mutation" | "handler";
  destructive: boolean;
  /** HTTP methods the action performs, when visible. */
  methods: string[];
  /** True when the action returns something a caller could render. */
  returnsValue: boolean;
  /** True when the action itself navigates on success. */
  redirects: boolean;
}

const DESTRUCTIVE_NAME = /(^|[_-]|\b)(delete|destroy|remove|revoke|purge|wipe|drop|terminate|deactivate|disable|cancel|reset|erase|unpublish|archive)/i;

const DESTRUCTIVE_METHODS = new Set(["DELETE"]);

function hasUseServerDirective(node: SourceFile | Node): boolean {
  const statements = Node.isSourceFile(node)
    ? node.getStatements()
    : Node.isBlock(node)
      ? node.getStatements()
      : [];
  for (const statement of statements.slice(0, 3)) {
    const text = statement.getText().trim().replace(/;$/, "");
    if (text === '"use server"' || text === "'use server'") return true;
  }
  return false;
}

/** HTTP methods mentioned in fetch options inside a function body. */
function findMethods(node: Node): string[] {
  const methods = new Set<string>();
  for (const property of node.getDescendantsOfKind(
    SyntaxKind.PropertyAssignment,
  )) {
    if (property.getName().replace(/["']/g, "") !== "method") continue;
    const initializer = property.getInitializer();
    if (!initializer) continue;
    const value = initializer.getText().replace(/["'`]/g, "").toUpperCase();
    if (value) methods.add(value);
  }
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    const name = expression.getName();
    if (/^(delete|destroy|deleteMany|remove)$/i.test(name)) {
      methods.add("DELETE");
    }
  }
  return [...methods];
}

/** Mutation hooks whose call site declares the mutation. */
const MUTATION_HOOKS = new Set([
  "useMutation",
  "useSWRMutation",
  "useActionState",
  "useFormState",
]);

/**
 * Mutations declared in a file.
 *
 * Covers server actions, client mutation hooks, and local async handlers that
 * perform a mutating request. All three had to be supported because real apps
 * pick one and stick with it: the first target uses `useMutation` fifteen times
 * and `"use server"` once, so a server-action-only detector would have found
 * almost nothing and two rules would have quietly never fired.
 */
export function findActions(
  sourceFile: SourceFile,
  relPath: string,
): ActionInfo[] {
  const fileIsServerAction = hasUseServerDirective(sourceFile);
  const actions: ActionInfo[] = [];
  const claimed = new Set<string>();

  const consider = (
    name: string,
    node: Node,
    isAsync: boolean,
    body: Node | undefined,
    exported: boolean,
  ): void => {
    if (!name) return;
    const inlineServer = body ? hasUseServerDirective(body) : false;
    const serverAction = fileIsServerAction || inlineServer;
    if (!serverAction && !isAsync) return;

    const scope = body ?? node;
    const methods = findMethods(scope);
    const mutatingMethod = methods.some(
      (method) => method !== "GET" && method !== "HEAD",
    );

    // An exported server action is a mutation by declaration. Anything else has
    // to prove it mutates, or every async data loader would be reported.
    if (!serverAction && !mutatingMethod) return;
    if (!serverAction && !exported && !mutatingMethod) return;

    const returnsValue = scope
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .some((statement) => statement.getExpression() !== undefined);

    const redirects = scope
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .some((call) => /^redirect$/.test(call.getExpression().getText()));

    claimed.add(name);
    actions.push({
      name,
      file: relPath,
      line: node.getStartLineNumber(),
      serverAction,
      style: serverAction ? "server-action" : "handler",
      destructive: isDestructive(name, methods, scope),
      methods,
      returnsValue,
      redirects,
    });
  };

  // Descendants, not top-level declarations. A form's submit handler is
  // declared inside the component that renders the form, which is where most
  // client-side mutations in a real app live — restricting this to the top
  // level found none of the five on the first app measured.
  for (const declaration of sourceFile.getDescendantsOfKind(
    SyntaxKind.FunctionDeclaration,
  )) {
    consider(
      declaration.getName() ?? "",
      declaration,
      declaration.isAsync(),
      declaration.getBody(),
      declaration.isExported(),
    );
  }

  for (const statement of sourceFile.getDescendantsOfKind(
    SyntaxKind.VariableStatement,
  )) {
    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer();
      if (!initializer) continue;
      if (
        Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer)
      ) {
        consider(
          declaration.getName(),
          declaration,
          initializer.isAsync(),
          initializer.getBody(),
          statement.isExported(),
        );
      }
    }
  }

  // Client mutation hooks. The declaring variable names the mutation, which is
  // how a developer refers to it too.
  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const callee = call.getExpression();
    const calleeName = Node.isPropertyAccessExpression(callee)
      ? callee.getName()
      : callee.getText();
    if (!MUTATION_HOOKS.has(calleeName)) continue;

    const declaration = call.getFirstAncestorByKind(
      SyntaxKind.VariableDeclaration,
    );
    const nameNode = declaration?.getNameNode();
    const name =
      nameNode && Node.isIdentifier(nameNode)
        ? nameNode.getText()
        : `${calleeName}@${call.getStartLineNumber()}`;

    if (claimed.has(name)) continue;
    claimed.add(name);

    const methods = findMethods(call);
    actions.push({
      name,
      file: relPath,
      line: call.getStartLineNumber(),
      serverAction: false,
      style: "client-mutation",
      destructive: isDestructive(name, methods, call),
      methods,
      returnsValue: false,
      redirects: call
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .some((inner) => /^(redirect|router\.push)$/.test(inner.getExpression().getText())),
    });
  }

  return actions;
}

/**
 * Whether a mutation destroys something.
 *
 * Checked three ways because any one alone misses common cases: the name, the
 * HTTP method, and the endpoint path — `fetch("/api/x/revoke", {method:"POST"})`
 * is destructive despite a name and method that say otherwise.
 */
function isDestructive(name: string, methods: string[], scope: Node): boolean {
  if (DESTRUCTIVE_NAME.test(name)) return true;
  if (methods.some((method) => DESTRUCTIVE_METHODS.has(method))) return true;

  for (const literal of scope.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    const value = literal.getLiteralValue();
    if (!value.startsWith("/")) continue;
    if (
      /\/(delete|remove|revoke|purge|terminate|deactivate|archive|cancel)(\/|$|\?)/i.test(
        value,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** How a mutation is presented at a call site. */
export interface CallSiteAffordances {
  /** The caller surfaces pending state while the mutation runs. */
  pending: boolean;
  /** The caller surfaces failure. */
  error: boolean;
  /** The caller asks before running an irreversible mutation. */
  confirmation: boolean;
  /** The caller offers an undo window instead of a prompt. */
  undo: boolean;
}

const PENDING_MARKERS = [
  "useformstatus",
  "useactionstate",
  "usetransition",
  "ispending",
  "issubmitting",
  "isloading",
  "pending",
  "disabled={",
];

const ERROR_MARKERS = [
  "toast.error",
  "onerror",
  "iserror",
  "seterror",
  "error &&",
  "error ?",
  "errorboundary",
  "catch",
  "formstate?.error",
  "state?.error",
];

const CONFIRM_MARKERS = [
  "alertdialog",
  "confirmdialog",
  "useconfirm",
  "window.confirm",
  "confirm(",
  "areyousure",
  "are you sure",
  "type the name",
  "cannot be undone",
  "dialogtrigger",
  "<dialog",
];

const UNDO_MARKERS = ["undo", "restore", "revert", "trash", "soft delete"];

/**
 * Inspect the files that reference an action to see how it is presented.
 *
 * Deliberately generous about what counts as feedback: a false negative here is
 * a missed finding, while a false positive is a developer losing trust in the
 * whole tool.
 */
export function analyzeCallSites(
  files: readonly SourceFile[],
): CallSiteAffordances {
  let pending = false;
  let error = false;
  let confirmation = false;
  let undo = false;

  for (const file of files) {
    // A comment promising a confirmation dialog is not a confirmation dialog.
    const lowered = loweredCode(file);
    pending ||= PENDING_MARKERS.some((marker) => lowered.includes(marker));
    error ||= ERROR_MARKERS.some((marker) => lowered.includes(marker));
    confirmation ||= CONFIRM_MARKERS.some((marker) => lowered.includes(marker));
    undo ||= UNDO_MARKERS.some((marker) => lowered.includes(marker));
  }

  return { pending, error, confirmation, undo };
}
