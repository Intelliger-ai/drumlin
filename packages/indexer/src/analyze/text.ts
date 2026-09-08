import { Node, type SourceFile } from "ts-morph";

/**
 * Source text with comments blanked out.
 *
 * Several analyzers look for marker strings — `isPending`, `AlertDialog`,
 * `undo` — as evidence that a concern is handled. Comments must not count:
 * `// TODO: add a confirmation dialog` is the opposite of a confirmation
 * dialog, and reading it as one turns a real finding into silence.
 *
 * Comment ranges are replaced with spaces rather than removed so every offset
 * and line number in the result still matches the original file.
 *
 * The cache stores the text it was derived from, and that is not defensive
 * bookkeeping — it is the correctness condition. `refreshFromFileSystemSync`
 * re-reads a file by mutating the existing `SourceFile` in place rather than
 * constructing a new one, so an entry keyed on the object alone survives every
 * edit to that file and answers with the original text forever.
 *
 * In a cold process the cache starts empty and nothing goes wrong, which is
 * why this held for so long. In the warm daemon it meant every marker-based
 * analyzer — pending, error, confirmation, undo — kept reporting whatever was
 * on disk when the daemon started. Fixing a finding and re-running would say
 * the finding was still there, and reverting a fix would say it was still
 * fixed.
 */
const cache = new WeakMap<SourceFile, { text: string; stripped: string }>();

export function textWithoutComments(sourceFile: SourceFile): string {
  // Cheap: the compiler node already holds this string, so comparing it costs
  // a pointer check while the AST walk below is what the cache is protecting.
  const text = sourceFile.getFullText();
  const cached = cache.get(sourceFile);
  if (cached?.text === text) return cached.stripped;

  const ranges: Array<[number, number]> = [];

  const visit = (node: Node): void => {
    for (const range of node.getLeadingCommentRanges()) {
      ranges.push([range.getPos(), range.getEnd()]);
    }
    for (const range of node.getTrailingCommentRanges()) {
      ranges.push([range.getPos(), range.getEnd()]);
    }
    // `{/* ... */}` parses as a JSX expression with nothing in it.
    if (Node.isJsxExpression(node) && node.getExpression() === undefined) {
      ranges.push([node.getStart(), node.getEnd()]);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  const characters = [...text];
  for (const [start, end] of ranges) {
    for (
      let index = start;
      index < end && index < characters.length;
      index += 1
    ) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }

  const stripped = characters.join("");
  cache.set(sourceFile, { text, stripped });
  return stripped;
}

/** Lowercased source with comments removed, for case-insensitive markers. */
export function loweredCode(sourceFile: SourceFile): string {
  return textWithoutComments(sourceFile).toLowerCase();
}
