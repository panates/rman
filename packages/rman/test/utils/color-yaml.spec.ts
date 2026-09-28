import { expect } from 'expect';
import { colorYaml } from '../../src/utils/color-yaml.js';

/** `\x1b` as an escape, never the literal byte - a `perl -pi` pass ate one in
 *  `config.command.spec.ts` once, leaving a regex that matched no colour and a test that passed
 *  only because the run had no TTY. */
// eslint-disable-next-line no-control-regex -- matching an escape sequence is the point here.
const ANSI = new RegExp('\\x1b\\[([0-9;]*)m', 'g');

const CYAN = 36;
const YELLOW = 33;
const GREY = 90;
const MAGENTA = 35;

/** Every code that opens a colour in `text`, in order - so a case names what it expects rather than
 *  matching a whole escaped string, which is unreadable the moment it fails. */
function opened(text: string): number[] {
  return [...text.matchAll(ANSI)].map(m => Number(m[1])).filter(code => code !== 39 && code !== 0);
}

function plain(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * **Self-contained: a string in, a string out.** The colouriser is a pure function of the document,
 * which is why it is a module and not part of either printer - both call it, and neither has to be
 * built to test it.
 */
describe('utils/colorYaml', () => {
  /** **The text is never changed, only wrapped**, which is the invariant the rest rests on: this
   *  runs over a document that has to stay the document. */
  it('leaves the document identical once the escapes are removed', () => {
    const doc = ['platform: node', 'clean:', '  include:', '    - build', "    - '*.tsbuildinfo'"].join('\n');
    expect(plain(colorYaml(doc))).toBe(doc);
  });

  it('colours a key, and only the key', () => {
    const line = colorYaml('directory: build');
    expect(opened(line)).toEqual([CYAN]);
    expect(line.startsWith(`\u001b[${CYAN}m`)).toBe(true);
    /** The value is the content and the longest thing on the line - colouring it competes with the
     *  key for attention, which is the failure mode of a highlighter that paints everything. */
    expect(line.endsWith('build')).toBe(true);
  });

  /** `skip: false` and `skip: "false"` mean different things and nothing else in the output tells
   *  them apart. */
  it('colours a literal, and leaves the string that looks like one alone', () => {
    expect(opened(colorYaml('skip: false'))).toEqual([CYAN, YELLOW]);
    expect(opened(colorYaml('concurrency: 4'))).toEqual([CYAN, YELLOW]);
    expect(opened(colorYaml('nothing: null'))).toEqual([CYAN, YELLOW]);
    expect(opened(colorYaml('skip: "false"'))).toEqual([CYAN]);
  });

  /**
   * The one place an unresolved expression in this output is **correct**: `version.before`/`.exec`/
   * `.after` are in `DEFERRED_PATHS` and are printed raw, so a reader sees a `${{ }}` among
   * resolved values. The colour is what stops that reading as interpolation being broken.
   */
  it('colours an expression wherever it sits in a value', () => {
    const line = colorYaml('exec: echo releasing ${{ pkg.targetVersion }}');
    expect(opened(line)).toEqual([CYAN, MAGENTA]);
    expect(plain(line)).toBe('exec: echo releasing ${{ pkg.targetVersion }}');
  });

  it('colours the list marker as structure, not the item', () => {
    expect(opened(colorYaml('  - build'))).toEqual([GREY]);
  });

  /** `printableConfig`'s placeholder, and the only value in the output that is not a value. */
  it('greys the function placeholder', () => {
    expect(opened(colorYaml('before: "[Function: copyDocs]"'))).toEqual([CYAN, GREY]);
    expect(opened(colorYaml('if: "[Function]"'))).toEqual([CYAN, GREY]);
  });

  it('colours a comment line whole', () => {
    expect(opened(colorYaml('# .rmanrc.yml'))).toEqual([GREY]);
  });

  /**
   * **A folded block scalar's continuation lines are prose, not YAML**, and js-yaml emits them
   * whenever `lineWidth` wraps a long string - which the publish targets' `describe` texts do
   * constantly. Without tracking the block, a line reading `(default: whatever .npmrc configures)`
   * has half a sentence coloured as a key, and a `#` in one reads as a comment.
   */
  it("leaves a block scalar's content alone but for expressions", () => {
    const doc = [
      'describe: >-',
      '  Registry to check against (default: whatever .npmrc already configures)',
      '  # not a comment, prose',
      '  and ${{ vars.x }} still counts',
      'skip: false',
    ].join('\n');
    const lines = colorYaml(doc).split('\n');

    expect(opened(lines[0]!)).toEqual([CYAN]);
    expect(opened(lines[1]!)).toEqual([]);
    expect(opened(lines[2]!)).toEqual([]);
    expect(opened(lines[3]!)).toEqual([MAGENTA]);
    /** And the block ends where the indent does - the key after it is coloured again. */
    expect(opened(lines[4]!)).toEqual([CYAN, YELLOW]);
  });

  /** js-yaml quotes any scalar holding a colon, so the key pattern stopping at the *first* one is
   *  the right rule rather than a lucky one. */
  it('takes the first colon as the key, not one inside the value', () => {
    const line = colorYaml("commitMessage: 'chore: release ${{ pkg.version }}'");
    expect(opened(line)).toEqual([CYAN, MAGENTA]);
    expect(plain(line)).toBe("commitMessage: 'chore: release ${{ pkg.version }}'");
  });
});
