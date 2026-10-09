/**
 * A rendered `easy-table` fitted to a terminal `columns` wide: a row wider than that has its **last
 * column** continued on further lines, each starting at that column, and a delimiter line is cut at
 * the edge. Anything that already fits is left exactly as it was.
 *
 * `columns` is `undefined` when the output is not a terminal, and then nothing changes - a file or a
 * pipe has no edge to wrap at, and a reader of one wants each row on one line.
 */
/* **The terminal wrapping it is what this replaces**, and what that did to a table: measured on
 * `panates/syncbridge`, `rman version`'s root row carries a 70-character reason, so the row and the
 * delimiter under the header - as wide as the widest cell - both ran past the edge and continued at
 * column 0, breaking the table into lines the eye could not follow.
 *
 * **Only the last column moves**, because it is the free-text one in every table rman prints
 * (`Reason`, `Path`) - the columns before it are short, fixed values whose alignment is the point.
 * Where it starts is read off the first delimiter line easy-table draws, the one place the column
 * boundaries are spelled out without colour codes in the way.
 *
 * A row whose last column would get fewer than `MIN_WIDTH` characters is left alone: wrapping into a
 * sliver is worse than the terminal's own wrap. */
export function fitTable(text: string, columns: number | undefined): string {
  if (!columns) return text;
  const lines = text.split('\n');
  const delimiter = lines.find(line => /^[\s-]*-[\s-]*$/.test(line));
  if (!delimiter) return text;
  const start = delimiter.search(/-+\s*$/);
  const width = columns - start;
  /** Every cell is padded to its column, the last one included, so a row of short text is still as
   *  wide as the widest - past the edge, those spaces wrapped into a blank line under each row.
   *  Trimmed and cut even where the last column is too narrow to wrap into. */
  const trimmed = lines.map(line => (/^[\s-]+$/.test(line) ? line.slice(0, columns) : line.trimEnd()));
  if (start <= 0 || width < MIN_WIDTH) return trimmed.join('\n');

  return trimmed
    .flatMap(line => {
      if (visibleLength(line) <= columns) return [line];
      const at = rawIndexOf(line, start);
      const head = line.slice(0, at);
      const tail = line.slice(at);
      /** A cell painted as a whole (`colors.gray(reason)`) keeps its colour on every line. */
      // eslint-disable-next-line no-control-regex
      const paint = /^(?:\x1b\[[0-9;]*m)+/.exec(tail)?.[0] ?? '';
      const chunks = wrapWords(stripAnsi(tail), width);
      const pad = ' '.repeat(start);
      return chunks.map((chunk, i) => (i ? pad : head) + (paint ? `${paint}${chunk}\x1b[0m` : chunk));
    })
    .join('\n');
}

const MIN_WIDTH = 20;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

/** The index in `line` of its `visible`-th visible character, colour codes skipped. */
function rawIndexOf(line: string, visible: number): number {
  let seen = 0;
  let i = 0;
  while (i < line.length && seen < visible) {
    if (line[i] === '\x1b') {
      const end = line.indexOf('m', i);
      i = end < 0 ? line.length : end + 1;
      continue;
    }
    seen++;
    i++;
  }
  /** Colour codes sitting right at the boundary belong to the cell after it. */
  return i;
}

/** `text` cut at spaces into lines of at most `width` - a word longer than that on a line of its own. */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.trim().split(/\s+/)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines;
}
