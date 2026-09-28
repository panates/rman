import colors from 'ansi-colors';

/**
 * A YAML document with syntax colour, for the two commands that print one to be **looked at** -
 * `rman config` and `--config`.
 *
 * **Only call this when `process.stdout.isTTY`.** Colouring a document that is being redirected
 * makes it unloadable, which is the whole reason the callers gate on a terminal.
 */
/* **Line-based and deliberately shallow.** This is a highlighter, not a parser: it colours what a
 * reader's eye uses to navigate - the key, the list marker, a literal - and leaves anything it is
 * not sure about alone. A real parse would have to round-trip js-yaml's own output to gain nothing
 * a reader would notice, and every extra rule is a new way to mangle a value.
 *
 * **What it colours and why that set**:
 *
 * - the **key**, in cyan, because that is what you scan a config for;
 * - **`${{ ... }}`**, in magenta, because rman's configs are full of them and because a `version`
 *   hook is printed *raw* (`DEFERRED_PATHS`) - the one place an unresolved expression is correct
 *   rather than a bug, and the colour is what stops it reading as a mistake;
 * - **numbers, booleans and `null`**, in yellow, since `skip: false` and `skip: "false"` mean
 *   different things and nothing else in the output tells them apart;
 * - **`[Function: name]`**, in grey, because it is this printer's placeholder rather than anything
 *   the config says - the one value in the output that is not a value;
 * - the **`-`** of a list item and a `#` comment, in grey, as structure rather than content.
 *
 * A plain string value is left uncoloured on purpose. It is the *content*, usually the longest
 * thing on the line, and colouring it competes with the key for attention - which is the failure
 * mode of a highlighter that paints everything.
 *
 * **The two places a shallow pass has to be careful, and neither is hypothetical:**
 *
 * - **A `:` inside a value.** js-yaml quotes any scalar holding one, so the line is
 *   `key: 'a: b'` - and the key pattern stops at the *first* colon, which is the right one. Nothing
 *   to do, but it is why the pattern is written `[^:]*` rather than anything greedier.
 * - **A folded block scalar.** `lineWidth: 100` makes js-yaml emit `describe: >-` and continue on
 *   deeper-indented lines, and a continuation line is prose: one holding `(default: ...)` would
 *   otherwise have half a sentence coloured as a key. So the block's indent is tracked and its
 *   content is left alone but for expressions. A `#` there is prose too, not a comment. */
export function colorYaml(text: string): string {
  /** The indent of the key that opened a block scalar, while one is open. Anything indented past it
   *  is that block's content; the first line that is not ends it. */
  let blockIndent: number | undefined;

  return text
    .split('\n')
    .map(line => {
      const indent = line.length - line.trimStart().length;
      if (blockIndent !== undefined) {
        if (line.trim() === '' || indent > blockIndent) return colorExpressions(line);
        blockIndent = undefined;
      }
      if (BLOCK_SCALAR.test(line)) blockIndent = indent;
      return colorLine(line);
    })
    .join('\n');
}

/** `key: >-`, `key: |`, `key: >2-`, and the bare `- >-` of a list item. */
const BLOCK_SCALAR = /:\s*[|>][0-9]*[-+]?\s*$/;

const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;
const LITERAL = /^(true|false|null|~|-?\d+(?:\.\d+)?)$/;
const FUNCTION = /^"?\[Function(?::[^\]]*)?\]"?$/;

function colorLine(line: string): string {
  const comment = /^(\s*)#(.*)$/.exec(line);
  if (comment) return comment[1] + colors.gray(`#${comment[2]}`);

  /** `indent`, an optional `- ` for a list item, then either `key:` plus a value or a bare item. */
  const parsed = /^(\s*)(- )?(?:([^\s:][^:]*):(\s|$))?([\s\S]*)$/.exec(line);
  if (!parsed) return line;
  const [, indent = '', dash, key, gap = '', rest = ''] = parsed;

  return indent + (dash ? colors.gray(dash) : '') + (key ? `${colors.cyan(key)}:${gap}` : '') + colorValue(rest);
}

function colorValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (LITERAL.test(trimmed)) return value.replace(trimmed, colors.yellow(trimmed));
  if (FUNCTION.test(trimmed)) return value.replace(trimmed, colors.gray(trimmed));
  return colorExpressions(value);
}

function colorExpressions(value: string): string {
  return value.replace(EXPRESSION, match => colors.magenta(match));
}
