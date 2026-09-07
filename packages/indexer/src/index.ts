import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { FileSystemRefreshResult, type Project, type SourceFile } from "ts-morph";
import {
  fromRepository,
  nodeId,
  routeToScreenId,
  withoutLocaleSegments,
  type GraphDocument,
  type GraphNode,
  type JsonValue,
  type NodeId,
  type SourceLocation,
} from "@drumlin/model";
import {
  analyzeCallSites,
  findActions,
  type ActionInfo,
} from "./analyze/actions.js";
export type { ActionInfo } from "./analyze/actions.js";
import {
  findComponents,
  findDuplicatePrimitives,
  findUnboundedSelects,
  type ComponentInfo,
} from "./analyze/components.js";
import { analyzeData, type DataProfile } from "./analyze/data.js";
import { findRouteMentions } from "./analyze/mentions.js";
import { collectContentLinks } from "./content.js";
import {
  findNavigationTargets,
  isChromeFile,
  type NavigationTarget,
} from "./analyze/navigation.js";
import {
  collectAppSegments,
  nearestConventionFile,
  screenSegments,
  STATE_CONVENTION_NAMES,
  stateKindFor,
  stateNodeId,
  type AppSegment,
} from "./app-router.js";
import { GraphBuilder } from "./builder.js";
import { describeApp, findApps, relativePath, type NextApp } from "./discover.js";
import { collectPagesRoutes } from "./pages-router.js";
import {
  addSourceDirectory,
  createProject,
  isAnalyzableSource,
} from "./project.js";
import { createImportResolver, type ImportResolver } from "./resolve.js";
import {
  isExternalHref,
  isNonNavigationalHref,
  matchRoute,
  splitRoute,
  toRoutePattern,
  type RoutePattern,
} from "./routes.js";

export * from "./discover.js";
export * from "./permissions.js";
export { GraphBuilder } from "./builder.js";
export { compareToGolden, type GoldenMismatch } from "./golden.js";
export type { ComponentInfo } from "./analyze/components.js";
export type { DataProfile } from "./analyze/data.js";
export * from "./resolve.js";
export { isAnalyzableSource } from "./project.js";

/**
 * How far to follow a layout's imports when looking for chrome navigation.
 *
 * Three covers layout to nav component to menu data, which is where real nav
 * definitions sit. Deeper would start treating an ordinary link inside a
 * feature component as if it appeared on every screen in the section.
 */
const CHROME_IMPORT_DEPTH = 3;

/**
 * How far to follow a screen's imports when looking for its navigation.
 *
 * Two reaches the components a page renders and the pieces they are built from,
 * which covers the table-column and card patterns where links actually live.
 */
const SCREEN_IMPORT_DEPTH = 2;

export interface IndexOptions {
  /** Directory to index. May be a monorepo root or a single app. */
  root: string;
  /** Pre-resolved app, when the caller already chose one. */
  app?: NextApp;
}

export interface BrokenLink {
  fromRoute: string;
  href: string;
  file: string;
  line: number;
}

export interface IndexStats {
  filesParsed: number;
  screens: number;
  states: number;
  actions: number;
  components: number;
  edges: number;
  durationMs: number;
}

export interface IndexResult {
  graph: GraphDocument;
  app: NextApp;
  stats: IndexStats;
  /** Hrefs that matched no known route. Reported, not turned into edges. */
  brokenLinks: BrokenLink[];
}

/** Resolve which app to index, preferring an explicit choice. */
export function resolveApp(options: IndexOptions): NextApp {
  if (options.app) return options.app;

  const direct = describeApp(options.root);
  if (direct) return direct;

  const found = findApps(options.root);
  if (found.length === 0) {
    throw new Error(
      `No Next.js app found at or beneath ${options.root}. ` +
        `Expected a next.config.* alongside an app/ or pages/ directory.`,
    );
  }
  if (found.length > 1) {
    const list = found.map((app) => `  ${app.root} (${app.router})`).join("\n");
    throw new Error(
      `Found ${found.length} Next.js apps. Choose one with --app:\n${list}`,
    );
  }
  return found[0]!;
}

/**
 * Build the `actual` UX Graph IR for one Next.js application.
 *
 * Parses from cold. Prefer `IndexSession` when indexing the same app more than
 * once in a process: parsing dominates the cost, and the session keeps it.
 */
export function indexApp(options: IndexOptions): IndexResult {
  return new IndexSession(resolveApp(options)).index();
}

/**
 * A parsed app, kept alive across re-indexes.
 *
 * The daemon exists for this: on a large app the cold index spends most of its
 * time in `ts-morph` turning files into ASTs, and almost none of that work is
 * invalidated when one file changes. Holding the `Project` and refreshing
 * individual files turns a multi-second index into a sub-second one, which is
 * the difference between a hook that can fire on every edit and one that
 * cannot.
 *
 * Deliberately rebuilds the whole graph from the warm ASTs rather than patching
 * a subgraph. Reachability is global, so a partial rebuild would need the
 * dependency-tracking machinery that Graph Identity warns against attempting
 * before Milestone C.
 */
export class IndexSession {
  private readonly project: Project;
  private parsed: string[];
  private resolveImport: ImportResolver;

  constructor(readonly app: NextApp) {
    this.project = createProject();
    this.parsed = addSourceDirectory(this.project, app.root);
    this.resolveImport = createImportResolver(app.root, this.parsed);
  }

  /** Files currently held in the project. */
  get files(): readonly string[] {
    return this.parsed;
  }

  /**
   * Re-read the given paths from disk.
   *
   * Returns what actually happened rather than a boolean, because a caller
   * that reports "re-indexed" after being handed only image paths is lying.
   */
  refresh(files: readonly string[]): RefreshOutcome {
    const outcome: RefreshOutcome = { updated: 0, added: 0, removed: 0, ignored: 0 };
    let structureChanged = false;

    for (const file of files) {
      if (!isAnalyzableSource(file)) {
        outcome.ignored += 1;
        continue;
      }

      const existing = this.project.getSourceFile(file);
      if (existing) {
        const result = existing.refreshFromFileSystemSync();
        if (result === FileSystemRefreshResult.Deleted) {
          outcome.removed += 1;
          structureChanged = true;
        } else if (result === FileSystemRefreshResult.Updated) {
          outcome.updated += 1;
        }
        continue;
      }

      if (!existsSync(file)) {
        outcome.ignored += 1;
        continue;
      }

      try {
        this.project.addSourceFileAtPath(file);
        outcome.added += 1;
        structureChanged = true;
      } catch {
        outcome.ignored += 1;
      }
    }

    // The resolver closes over the known file set, so a new or deleted file
    // changes what an import specifier points at.
    if (structureChanged) {
      this.parsed = this.project
        .getSourceFiles()
        .map((file) => file.getFilePath() as string)
        .sort();
      this.resolveImport = createImportResolver(this.app.root, this.parsed);
    }

    return outcome;
  }

  index(): IndexResult {
    return buildGraph(this.app, this.project, this.parsed, this.resolveImport);
  }
}

export interface RefreshOutcome {
  updated: number;
  added: number;
  removed: number;
  /** Paths that were never analyzable, or vanished before we looked. */
  ignored: number;
}

/**
 * Turn a parsed app into the graph.
 *
 * Structured as filesystem conventions first, then AST analysis, then edge
 * resolution. That order exists because a transition can only be resolved once
 * every route is known.
 */
function buildGraph(
  app: NextApp,
  project: Project,
  parsed: readonly string[],
  resolveImport: ImportResolver,
): IndexResult {
  const started = Date.now();
  const builder = new GraphBuilder();

  const sourceOf = (file: string): SourceFile | undefined =>
    project.getSourceFile(file);
  const rel = (file: string): string => relativePath(app.root, file);

  // ---- Routes on disk -------------------------------------------------------

  const appSegments = app.appDir ? collectAppSegments(app.appDir) : [];
  const appScreens = screenSegments(appSegments);
  const pagesTree = app.pagesDir
    ? collectPagesRoutes(app.pagesDir)
    : { routes: [], states: [] };

  const declaredRoutes = [
    ...appScreens.map(({ segment }) => segment.route),
    ...pagesTree.routes.map((route) => route.route),
  ];

  // Locale-prefixed routes get a second pattern with the prefix dropped.
  //
  // With next-intl the routes on disk are `/[locale]/terms` while every link is
  // written `/terms`, because middleware adds the prefix. Without the alias none
  // of those links resolve, and an entire localised site reads as unreachable.
  const patterns: RoutePattern[] = [
    ...declaredRoutes.map((route) => toRoutePattern(route)),
    ...declaredRoutes
      .filter((route) => withoutLocaleSegments(route) !== route)
      .map((route) => ({
        route,
        segments: splitRoute(withoutLocaleSegments(route)),
      })),
  ];

  // A screen per route. Two routers can legitimately produce the same URL, in
  // which case the node merges and carries both source locations.
  const screensByRoute = new Map<string, { id: NodeId; file: string }>();

  const addScreen = (
    route: string,
    file: string,
    router: "app" | "pages",
  ): NodeId => {
    const id = routeToScreenId(route);
    const source = sourceOf(file);
    const profile = source ? analyzeData(source) : undefined;

    const node: GraphNode = {
      id,
      type: "Screen",
      label: route,
      route,
      router,
      sources: [{ file: rel(file) }],
      provenance: fromRepository([rel(file)]),
    };

    if (profile) {
      node.context = { async: profile.fetchesData };
      node.properties = dataProperties(profile);
    }

    builder.addNode(node);
    screensByRoute.set(route, { id, file });
    return id;
  };

  for (const { segment } of appScreens) {
    addScreen(segment.route, segment.files.get("page")!, "app");
  }
  for (const route of pagesTree.routes) {
    addScreen(route.route, route.file, "pages");
  }

  // ---- States from file conventions ----------------------------------------

  let stateCount = 0;

  for (const { segment, index } of appScreens) {
    const screenId = routeToScreenId(segment.route);

    for (const conventionName of STATE_CONVENTION_NAMES) {
      const nearest = nearestConventionFile(appSegments, index, conventionName);
      if (!nearest) continue;

      const kind = stateKindFor(conventionName);
      if (!kind) continue;

      const id = stateNodeId(nearest.segment, conventionName);
      const file = nearest.segment.files.get(conventionName)!;

      builder.addNode({
        id,
        type: "State",
        label: `${nearest.segment.route} ${kind}`,
        stateKind: kind,
        sources: [{ file: rel(file) }],
        provenance: fromRepository([rel(file)]),
        properties: {
          // Whether the boundary is declared here or inherited from an ancestor
          // changes nothing for correctness, but it changes the fix.
          inherited: nearest.index !== index,
          declaredAt: nearest.segment.route,
        },
      });
      stateCount += 1;

      builder.addEdge({
        from: screenId,
        to: id,
        type: "contains",
        provenance: fromRepository([rel(file)]),
        properties: { inherited: nearest.index !== index },
      });
    }
  }

  // Pages Router fallbacks are app-wide, so they attach to every Pages screen.
  for (const state of pagesTree.states) {
    const id = nodeId("state", "pages", state.kind);
    builder.addNode({
      id,
      type: "State",
      label: `pages ${state.kind}`,
      stateKind: state.kind,
      sources: [{ file: rel(state.file) }],
      provenance: fromRepository([rel(state.file)]),
      properties: { inherited: true, declaredAt: "/" },
    });
    stateCount += 1;

    for (const route of pagesTree.routes) {
      builder.addEdge({
        from: routeToScreenId(route.route),
        to: id,
        type: "contains",
        provenance: fromRepository([rel(state.file)]),
        properties: { inherited: true },
      });
    }
  }

  // ---- Components and design-system drift ----------------------------------

  const components: ComponentInfo[] = [];
  for (const file of parsed) {
    const source = sourceOf(file);
    if (!source) continue;
    components.push(...findComponents(source, rel(file)));
  }

  const duplicates = findDuplicatePrimitives(components);
  const duplicateByKey = new Map(
    duplicates.map(({ duplicate, primitive }) => [
      `${duplicate.file}#${duplicate.name}`,
      primitive,
    ]),
  );

  for (const component of components) {
    const id = nodeId("component", component.file, component.name);
    const primitive = duplicateByKey.get(
      `${component.file}#${component.name}`,
    );

    const properties: Record<string, JsonValue> = {
      designSystem: component.designSystem,
      props: component.propNames,
      variants: component.variantValues,
      importsDesignSystem: component.importsDesignSystem,
    };
    if (component.rootElement) properties["rootElement"] = component.rootElement;
    if (primitive) {
      properties["duplicatesPrimitive"] = primitive.name;
      properties["duplicatesPrimitiveFile"] = primitive.file;
    }

    builder.addNode({
      id,
      type: "Component",
      label: component.name,
      sources: [
        {
          file: component.file,
          line: component.line,
          symbol: component.name,
        },
      ],
      provenance: fromRepository([component.file]),
      properties,
    });
  }

  // Select controls bound to collections of unknown size, recorded on whichever
  // screen or component renders them.
  for (const file of parsed) {
    const source = sourceOf(file);
    if (!source) continue;
    const overloads = findUnboundedSelects(source);
    if (overloads.length === 0) continue;

    const owner = ownerNodeFor(rel(file), screensByRoute, rel, components);
    if (!owner) continue;

    const node = builder.getNode(owner);
    if (!node) continue;
    builder.addNode({
      ...node,
      properties: {
        ...node.properties,
        unboundedSelects: overloads.map((overload) => ({
          line: overload.line,
          collection: overload.collection,
          control: overload.control,
        })),
      },
    });
  }

  // ---- Actions -------------------------------------------------------------

  const actions: ActionInfo[] = [];
  for (const file of parsed) {
    const source = sourceOf(file);
    if (!source) continue;
    actions.push(...findActions(source, rel(file)));
  }

  const actionsByName = new Map<string, ActionInfo[]>();
  for (const action of actions) {
    const bucket = actionsByName.get(action.name) ?? [];
    bucket.push(action);
    actionsByName.set(action.name, bucket);
  }

  /** Screens and components that import a given action. */
  const callSites = new Map<string, Set<string>>();

  for (const file of parsed) {
    const source = sourceOf(file);
    if (!source) continue;

    for (const declaration of source.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      for (const named of declaration.getNamedImports()) {
        const name = named.getName();
        const candidates = actionsByName.get(name);
        if (!candidates) continue;

        const match = candidates.find((candidate) =>
          importPointsAt(app.root, file, specifier, candidate.file),
        );
        const action = match ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (!action) continue;

        const key = `${action.file}#${action.name}`;
        const bucket = callSites.get(key) ?? new Set<string>();
        bucket.add(file);
        callSites.set(key, bucket);
      }
    }
  }

  // A bare `action.<name>` ID reads well and stays stable, but local handlers
  // called `handleDelete` repeat across files. Only the colliding names get
  // qualified, so the common case keeps the short ID.
  const nameCounts = new Map<string, number>();
  for (const action of actions) {
    nameCounts.set(action.name, (nameCounts.get(action.name) ?? 0) + 1);
  }
  const actionIdFor = (action: ActionInfo): NodeId =>
    (nameCounts.get(action.name) ?? 0) > 1
      ? nodeId("action", action.file, action.name)
      : nodeId("action", action.name);

  for (const action of actions) {
    const key = `${action.file}#${action.name}`;
    const declaringFile = resolvePath(app.root, action.file);
    const importers = [...(callSites.get(key) ?? [])].sort();

    // A server action's feedback lives wherever it is called. A client mutation
    // declares its own, in the file that holds it.
    const ownerFiles =
      action.style === "server-action" ? importers : [declaringFile];
    const evidenceFiles = [declaringFile, ...importers];

    const affordances = analyzeCallSites(
      evidenceFiles
        .map((file) => sourceOf(file))
        .filter((source): source is SourceFile => source !== undefined),
    );

    const id = actionIdFor(action);
    const location: SourceLocation = {
      file: action.file,
      line: action.line,
      symbol: action.name,
    };

    builder.addNode({
      id,
      type: "Action",
      label: action.name,
      sources: [location],
      provenance: fromRepository(evidenceFiles.map(rel)),
      context: {
        async: true,
        destructive: action.destructive,
        reversible: action.destructive ? affordances.undo : true,
        risk: action.destructive ? "high" : "low",
      },
      properties: {
        serverAction: action.serverAction,
        style: action.style,
        methods: action.methods,
        returnsValue: action.returnsValue,
        redirects: action.redirects,
        surfacesPending: affordances.pending,
        surfacesError: affordances.error,
        hasConfirmation: affordances.confirmation,
        hasUndo: affordances.undo,
        callSites: importers.map(rel),
      },
    });

    // A screen that invokes an action offers it, so the graph should say so.
    for (const file of ownerFiles) {
      const owner = ownerNodeFor(rel(file), screensByRoute, rel, components);
      if (!owner) continue;
      builder.addEdge({
        from: owner,
        to: id,
        type: "contains",
        provenance: fromRepository([rel(file)]),
      });
    }
  }

  // ---- Transitions ---------------------------------------------------------

  const brokenLinks: BrokenLink[] = [];

  const addTransitions = (
    fromId: NodeId,
    fromRoute: string,
    file: string,
    targets: readonly NavigationTarget[],
  ): void => {
    for (const target of targets) {
      if (isExternalHref(target.href)) continue;
      if (isNonNavigationalHref(target.href)) continue;
      if (!target.href.startsWith("/")) continue;

      const pattern = matchRoute(target.href, patterns);
      if (!pattern) {
        brokenLinks.push({
          fromRoute,
          href: target.raw,
          file: rel(file),
          line: target.line,
        });
        continue;
      }

      const toId = routeToScreenId(pattern.route);
      if (toId === fromId) continue;

      builder.addEdge({
        from: fromId,
        to: toId,
        type: "transitions_to",
        label: target.kind,
        preserve: target.query,
        sources: [{ file: rel(file), line: target.line }],
        provenance: fromRepository([rel(file)]),
        properties: {
          chrome: target.chrome,
          kind: target.kind,
          forwardsSearchParams: target.forwardsSearchParams,
        },
      });
    }
  };

  // A screen's navigation includes whatever its components render.
  //
  // A table's row-link lives in `users-columns.tsx`, not in `page.tsx`, so
  // reading only the page file misses the single most common link in an admin
  // app — and then reports the detail route it points at as unreachable.
  const collectScreenTargets = (
    file: string,
    depth: number,
    seen: Set<string>,
  ): Array<{ target: NavigationTarget; file: string }> => {
    if (depth < 0 || seen.has(file)) return [];
    seen.add(file);

    const source = sourceOf(file);
    if (!source) return [];

    const relative = rel(file);
    // Chrome is attributed through layouts instead, to every screen in the
    // subtree rather than only the ones that happen to import it.
    if (seen.size > 1 && isChromeFile(relative)) return [];

    const collected = findNavigationTargets(source, { chrome: false }).map(
      (target) => ({ target, file }),
    );

    for (const declaration of source.getImportDeclarations()) {
      const resolved = resolveImport(
        file,
        declaration.getModuleSpecifierValue(),
      );
      if (!resolved) continue;
      collected.push(...collectScreenTargets(resolved, depth - 1, seen));
    }

    return collected;
  };

  for (const [route, screen] of screensByRoute) {
    for (const { target, file } of collectScreenTargets(
      screen.file,
      SCREEN_IMPORT_DEPTH,
      new Set(),
    )) {
      addTransitions(screen.id, route, file, [target]);
    }
  }

  // Where a layout's navigation actually lives.
  //
  // A layout rarely writes its own nav links; it renders a <Navbar>, which in
  // turn imports the menu data. Since anything a layout renders appears on
  // every screen beneath it, the imports of a layout are chrome by definition
  // and have to be followed transitively. On the first real app, not following
  // them made 26 of 30 findings false: every page reached only from the site
  // header looked unreachable.
  const collectChromeTargets = (
    file: string,
    depth: number,
    seen: Set<string>,
  ): Array<{ target: NavigationTarget; file: string }> => {
    if (depth < 0 || seen.has(file)) return [];
    seen.add(file);

    const source = sourceOf(file);
    if (!source) return [];

    const collected = findNavigationTargets(source, { chrome: true }).map(
      (target) => ({ target, file }),
    );

    // Resolved by path, not by exported name: the import that matters is
    // usually a default export behind a path alias, which has no name to match.
    for (const declaration of source.getImportDeclarations()) {
      const resolved = resolveImport(
        file,
        declaration.getModuleSpecifierValue(),
      );
      if (!resolved) continue;
      collected.push(...collectChromeTargets(resolved, depth - 1, seen));
    }

    return collected;
  };

  const attributeChrome = (
    sourceFile: string,
    screens: Array<{ id: NodeId; route: string }>,
  ): void => {
    const collected = collectChromeTargets(sourceFile, CHROME_IMPORT_DEPTH, new Set());
    if (collected.length === 0) return;
    for (const screen of screens) {
      for (const { target, file } of collected) {
        addTransitions(screen.id, screen.route, file, [target]);
      }
    }
  };

  if (app.appDir) {
    for (const [index, segment] of appSegments.entries()) {
      const layoutFile =
        segment.files.get("layout") ?? segment.files.get("template");
      if (!layoutFile) continue;
      attributeChrome(
        layoutFile,
        screensInSubtree(appSegments, appScreens, index),
      );
    }
  }

  if (pagesTree.appFile) {
    attributeChrome(
      pagesTree.appFile,
      pagesTree.routes.map((route) => ({
        id: routeToScreenId(route.route),
        route: route.route,
      })),
    );
  }

  // A shared nav component that no layout imports still describes navigation,
  // so its links are recorded on the component itself rather than discarded.
  for (const file of parsed) {
    const relative = rel(file);
    if (!isChromeFile(relative)) continue;
    const source = sourceOf(file);
    if (!source) continue;
    const componentId = componentIdFor(relative, components);
    if (!componentId) continue;
    addTransitions(
      componentId,
      relative,
      file,
      findNavigationTargets(source, { chrome: true }),
    );
  }

  // ---- Route mentions ------------------------------------------------------
  //
  // Recorded so orphan detection can distinguish "nothing links here" from
  // "the link exists but is built at runtime, or written in prose". Without
  // this, a page linked from a markdown article or through a helper that
  // assembles the href looks unreachable.
  const mentionedRoutes = new Map<string, Set<string>>();

  const credit = (route: string, fromFile: string): void => {
    const bucket = mentionedRoutes.get(route) ?? new Set<string>();
    bucket.add(fromFile);
    mentionedRoutes.set(route, bucket);
  };

  const noteMention = (
    href: string,
    fromFile: string,
    partial = false,
  ): void => {
    const pattern = matchRoute(href, patterns);
    if (pattern) credit(pattern.route, fromFile);

    // A partial mention still answers the question. `/authors/${slug}` is only
    // ever visible as the literal `/authors/`, and that is a link to
    // `/authors/[slug]` however the rest of it is assembled. Both readings are
    // credited, since `/users/` matches the list route as well as the detail.
    if (pattern && !partial) return;
    for (const route of dynamicRoutesUnder(href, patterns)) {
      credit(route, fromFile);
    }
  };

  for (const file of parsed) {
    const source = sourceOf(file);
    if (!source) continue;
    const relative = rel(file);
    for (const mention of findRouteMentions(source)) {
      noteMention(mention.value, relative, mention.partial);
    }
  }

  for (const { file, links } of collectContentLinks(app.root)) {
    for (const href of links) noteMention(href, rel(file));
  }

  for (const [route, screen] of screensByRoute) {
    const screenDirectory = dirname(rel(screen.file));
    // A route naming itself, in its own metadata or canonical URL, is not a
    // link to it. Only mentions from elsewhere count.
    const elsewhere = [...(mentionedRoutes.get(route) ?? [])]
      .filter((file) => !file.startsWith(screenDirectory))
      .sort();

    if (elsewhere.length === 0) continue;
    const node = builder.getNode(screen.id);
    if (!node) continue;
    node.properties = { ...node.properties, mentionedIn: elsewhere.slice(0, 5) };
  }

  // ---- Module graph --------------------------------------------------------
  //
  // Recorded so `check --changed` can answer "what else does this file affect"
  // without a parsed project to walk. Only local files are kept: a package
  // import has no dependents inside the repository.
  const imports: Record<string, string[]> = {};

  for (const file of parsed) {
    const source = sourceOf(file);
    if (!source) continue;

    const targets = new Set<string>();
    for (const declaration of source.getImportDeclarations()) {
      const resolved = resolveImport(
        file,
        declaration.getModuleSpecifierValue(),
      );
      if (resolved) targets.add(rel(resolved));
    }
    for (const declaration of source.getExportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (!specifier) continue;
      const resolved = resolveImport(file, specifier);
      if (resolved) targets.add(rel(resolved));
    }

    if (targets.size > 0) imports[rel(file)] = [...targets].sort();
  }

  const dropped = builder.pruneDanglingEdges();
  for (const edge of dropped) {
    const location = edge.sources?.[0];
    brokenLinks.push({
      fromRoute: edge.from,
      href: edge.to,
      file: location?.file ?? "unknown",
      line: location?.line ?? 0,
    });
  }

  const graph = builder.build("actual", {
    id: app.root,
    root: app.root,
  });
  graph.imports = imports;

  return {
    graph,
    app,
    stats: {
      filesParsed: parsed.length,
      screens: screensByRoute.size,
      states: stateCount,
      actions: actions.length,
      components: components.length,
      edges: graph.edges.length,
      durationMs: Date.now() - started,
    },
    brokenLinks,
  };
}

/**
 * Dynamic routes whose static prefix is exactly this href.
 *
 * The one case that matters: a helper returns `/authors/${slug}`, so the only
 * literal anywhere is `/authors/`. Requiring the prefix to be complete keeps
 * this from crediting `/blog` for a mention of `/b`.
 */
function dynamicRoutesUnder(
  href: string,
  patterns: readonly RoutePattern[],
): string[] {
  const segments = href.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return [];

  return patterns
    .filter((pattern) => {
      const staticPrefix: string[] = [];
      for (const segment of pattern.segments) {
        if (segment.startsWith("[")) break;
        staticPrefix.push(segment);
      }
      return (
        staticPrefix.length < pattern.segments.length &&
        staticPrefix.length === segments.length &&
        staticPrefix.every((value, index) => value === segments[index])
      );
    })
    .map((pattern) => pattern.route);
}

function dataProperties(profile: DataProfile): Record<string, JsonValue> {
  return {
    fetchesData: profile.fetchesData,
    dataEvidence: profile.evidence,
    readsSearchParams: profile.readsSearchParams,
    searchParamKeys: profile.searchParamKeys,
    handledStates: {
      loading: profile.handled.loading,
      error: profile.handled.error,
      empty: profile.handled.empty,
    },
    clientComponent: profile.clientComponent,
    prerendered: profile.prerendered,
  };
}

/** Screens rendered inside the layout at `segmentIndex`. */
function screensInSubtree(
  segments: readonly AppSegment[],
  screens: ReadonlyArray<{ segment: AppSegment; index: number }>,
  segmentIndex: number,
): Array<{ id: NodeId; route: string }> {
  const result: Array<{ id: NodeId; route: string }> = [];

  for (const { segment, index } of screens) {
    let current: number = index;
    while (current >= 0) {
      if (current === segmentIndex) {
        result.push({ id: routeToScreenId(segment.route), route: segment.route });
        break;
      }
      const parent: number | undefined = segments[current]?.parent;
      if (parent === undefined) break;
      current = parent;
    }
  }

  return result;
}

/** The graph node a source file belongs to: its screen, else its component. */
function ownerNodeFor(
  relFile: string,
  screensByRoute: ReadonlyMap<string, { id: NodeId; file: string }>,
  rel: (file: string) => string,
  components: readonly ComponentInfo[],
): NodeId | undefined {
  for (const screen of screensByRoute.values()) {
    if (rel(screen.file) === relFile) return screen.id;
  }
  return componentIdFor(relFile, components);
}

function componentIdFor(
  relFile: string,
  components: readonly ComponentInfo[],
): NodeId | undefined {
  const component = components.find((candidate) => candidate.file === relFile);
  return component
    ? nodeId("component", component.file, component.name)
    : undefined;
}

/**
 * Whether an import specifier refers to a specific file.
 *
 * Relative specifiers resolve exactly. Alias specifiers such as `@/lib/actions`
 * cannot be resolved without reading tsconfig paths, so they fall back to a
 * suffix comparison, which is accurate enough to disambiguate same-named
 * exports in different directories.
 */
function importPointsAt(
  root: string,
  fromFile: string,
  specifier: string,
  targetRelFile: string,
): boolean {
  const targetWithoutExtension = targetRelFile.replace(
    /\.(tsx|ts|jsx|js)$/,
    "",
  );

  if (specifier.startsWith(".")) {
    const resolved = resolvePath(dirname(fromFile), specifier);
    const relResolved = relativePath(root, resolved).replace(/\/index$/, "");
    return (
      relResolved === targetWithoutExtension ||
      relResolved === targetWithoutExtension.replace(/\/index$/, "")
    );
  }

  const tail = specifier.replace(/^(@|~|#)\//, "").replace(/^src\//, "");
  if (tail.length === 0) return false;
  return (
    targetWithoutExtension === tail || targetWithoutExtension.endsWith(`/${tail}`)
  );
}
