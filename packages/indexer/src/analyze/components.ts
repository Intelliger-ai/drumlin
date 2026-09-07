import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { loweredCode } from "./text.js";

/**
 * Component-level facts the rules need.
 *
 * Everything a rule reads has to be pre-computed here and carried on the IR,
 * because `core` may not touch source. That constraint keeps the rule engine
 * portable and keeps source access in exactly one package.
 */
export interface ComponentInfo {
  name: string;
  file: string;
  line: number;
  /** True when the file lives in the design-system directory. */
  designSystem: boolean;
  /** Lowercase tag of the outermost element rendered, when it is intrinsic. */
  rootElement?: string;
  propNames: string[];
  /** String union members of a `variant` prop, sorted. */
  variantValues: string[];
  /** Design-system component names this file imports. */
  importsDesignSystem: string[];
}

/** A select-like control bound to a collection of unknown size. */
export interface UnboundedSelect {
  line: number;
  /** The expression being mapped over, e.g. `invoices`. */
  collection: string;
  /** The select-ish component or element name. */
  control: string;
}

const DESIGN_SYSTEM_DIRECTORY = /(^|\/)components\/ui\//;

const SELECT_CONTROLS = /^(Select|SelectContent|NativeSelect|select|Listbox|RadioGroup)$/;

/** Controls that already solve the scale problem, so their presence excuses it. */
const SEARCHABLE_MARKERS = [
  "command",
  "combobox",
  "autocomplete",
  "typeahead",
  "searchable",
  "cmdk",
  "virtuoso",
  "react-window",
  "react-virtual",
  // A text filter over the same data is the fix, however it is spelled.
  "setquery",
  "setsearch",
  "onsearch",
  'type="search"',
  "placeholder=\"search",
];

/** Signals that a value was read from somewhere whose size is not knowable. */
const DATA_SOURCE = /\b(fetch|useQuery|useSuspenseQuery|useInfiniteQuery|useSWR|getAll|findMany|select|list|query)\s*[(<]/;

/** Above this, an inline literal list stops being obviously bounded. */
const BOUNDED_LITERAL_LIMIT = 15;

export function isDesignSystemFile(relPath: string): boolean {
  return DESIGN_SYSTEM_DIRECTORY.test(relPath);
}

function rootElementOf(node: Node): string | undefined {
  const returns = node.getDescendantsOfKind(SyntaxKind.ReturnStatement);
  for (const statement of returns) {
    const expression = statement.getExpression();
    if (!expression) continue;
    const element =
      expression.asKind(SyntaxKind.JsxElement) ??
      expression.asKind(SyntaxKind.JsxSelfClosingElement) ??
      expression.getFirstDescendantByKind(SyntaxKind.JsxElement) ??
      expression.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement);
    if (!element) continue;
    const tag = Node.isJsxElement(element)
      ? element.getOpeningElement().getTagNameNode().getText()
      : element.getTagNameNode().getText();
    // Only intrinsic elements are comparable across components; a wrapper that
    // renders another component is composition, not duplication.
    return /^[a-z]/.test(tag) ? tag : undefined;
  }
  return undefined;
}

function propsOf(sourceFile: SourceFile, componentName: string): {
  propNames: string[];
  variantValues: string[];
} {
  const propNames = new Set<string>();
  const variantValues = new Set<string>();

  const interfaces = [
    ...sourceFile.getInterfaces(),
    ...sourceFile.getTypeAliases(),
  ].filter((declaration) => {
    const name = declaration.getName();
    return (
      name === `${componentName}Props` ||
      name === "Props" ||
      name.endsWith("Props")
    );
  });

  for (const declaration of interfaces) {
    for (const property of declaration.getDescendantsOfKind(
      SyntaxKind.PropertySignature,
    )) {
      const name = property.getName();
      propNames.add(name);
      if (name !== "variant" && name !== "size") continue;
      const typeNode = property.getTypeNode();
      if (!typeNode) continue;
      for (const literal of typeNode.getDescendantsOfKind(
        SyntaxKind.StringLiteral,
      )) {
        if (name === "variant") variantValues.add(literal.getLiteralValue());
      }
    }
  }

  return {
    propNames: [...propNames].sort(),
    variantValues: [...variantValues].sort(),
  };
}

/** Exported components declared in a file. */
export function findComponents(
  sourceFile: SourceFile,
  relPath: string,
): ComponentInfo[] {
  const designSystem = isDesignSystemFile(relPath);
  const importsDesignSystem: string[] = [];

  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!/components\/ui\/|@\/components\/ui/.test(specifier)) continue;
    for (const named of declaration.getNamedImports()) {
      importsDesignSystem.push(named.getName());
    }
  }

  const components: ComponentInfo[] = [];

  const consider = (name: string, node: Node): void => {
    // React components are PascalCase by convention; anything else is a helper.
    if (!/^[A-Z]/.test(name)) return;
    const hasJsx =
      node.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined ||
      node.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !==
        undefined ||
      node.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined;
    if (!hasJsx) return;

    const { propNames, variantValues } = propsOf(sourceFile, name);
    const rootElement = rootElementOf(node);

    const info: ComponentInfo = {
      name,
      file: relPath,
      line: node.getStartLineNumber(),
      designSystem,
      propNames,
      variantValues,
      importsDesignSystem: [...new Set(importsDesignSystem)].sort(),
    };
    if (rootElement) info.rootElement = rootElement;
    components.push(info);
  };

  for (const declaration of sourceFile.getFunctions()) {
    if (!declaration.isExported()) continue;
    consider(declaration.getName() ?? "", declaration);
  }

  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) continue;
    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer();
      if (!initializer) continue;
      if (
        Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer) ||
        Node.isCallExpression(initializer)
      ) {
        consider(declaration.getName(), declaration);
      }
    }
  }

  return components;
}

/**
 * Select-like controls bound to a collection whose size is not knowable.
 *
 * A select over a fetched list is fine at ten rows and unusable at ten
 * thousand. Two gates keep this honest, both learned from false positives on a
 * real app: the collection has to be read from a data source *in this file*,
 * and the file must offer no search or virtualisation.
 *
 * The first gate is the important one. A collection arriving as a prop, or
 * derived from one, says nothing about its size — a tab strip of code languages
 * and a list of blog categories both looked identical to a ten-thousand-row
 * select without it, and both were reported wrongly.
 */
export function findUnboundedSelects(
  sourceFile: SourceFile,
): UnboundedSelect[] {
  const lowered = loweredCode(sourceFile);
  if (SEARCHABLE_MARKERS.some((marker) => lowered.includes(marker))) return [];

  const fetched = fetchedCollections(sourceFile);
  if (fetched.size === 0) return [];

  const found: UnboundedSelect[] = [];

  for (const element of sourceFile.getDescendantsOfKind(
    SyntaxKind.JsxElement,
  )) {
    const tag = element.getOpeningElement().getTagNameNode().getText();
    if (!SELECT_CONTROLS.test(tag)) continue;

    for (const call of element.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) continue;
      if (expression.getName() !== "map") continue;

      const source = expression.getExpression();
      const sourceText = source.getText();

      // An inline literal list is bounded by inspection.
      const literal = source.asKind(SyntaxKind.ArrayLiteralExpression);
      if (literal && literal.getElements().length <= BOUNDED_LITERAL_LIMIT) {
        continue;
      }

      const rootName = sourceText.split(/[.[(]/)[0]!.trim();
      if (!fetched.has(rootName)) continue;

      found.push({
        line: call.getStartLineNumber(),
        collection: sourceText,
        control: tag,
      });
    }
  }

  return found;
}

/** Variables in this file that hold data read from a source of unknown size. */
function fetchedCollections(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();

  // Descendants, not top-level declarations: the interesting bindings are
  // inside the component body.
  for (const declaration of sourceFile.getDescendantsOfKind(
    SyntaxKind.VariableDeclaration,
  )) {
    const initializer = declaration.getInitializer();
    if (!initializer) continue;

    // An await anywhere in the initializer counts: the value usually arrives as
    // `(await res.json()) as Invoice[]`, where the await is nested two nodes in.
    const awaited =
      Node.isAwaitExpression(initializer) ||
      initializer.getFirstDescendantByKind(SyntaxKind.AwaitExpression) !==
        undefined;
    if (!awaited && !DATA_SOURCE.test(initializer.getText())) continue;

    const nameNode = declaration.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) names.add(element.getName());
      continue;
    }
    names.add(declaration.getName());
  }

  return names;
}

/**
 * Local components that reimplement a design-system primitive.
 *
 * Requires an exact match on the rendered element and on the full `variant`
 * union, and requires that the component not already import the primitive.
 * Narrow on purpose: a near-miss here is a false accusation about someone's
 * code, which costs more trust than the finding is worth.
 */
export function findDuplicatePrimitives(
  components: readonly ComponentInfo[],
): Array<{ duplicate: ComponentInfo; primitive: ComponentInfo }> {
  const primitives = components.filter(
    (component) =>
      component.designSystem &&
      component.rootElement !== undefined &&
      component.variantValues.length > 0,
  );
  const pairs: Array<{ duplicate: ComponentInfo; primitive: ComponentInfo }> =
    [];

  for (const candidate of components) {
    if (candidate.designSystem) continue;
    if (candidate.rootElement === undefined) continue;
    if (candidate.variantValues.length === 0) continue;

    for (const primitive of primitives) {
      if (primitive.rootElement !== candidate.rootElement) continue;
      if (
        primitive.variantValues.join("|") !== candidate.variantValues.join("|")
      ) {
        continue;
      }
      if (candidate.importsDesignSystem.includes(primitive.name)) continue;
      pairs.push({ duplicate: candidate, primitive });
      break;
    }
  }

  return pairs;
}
