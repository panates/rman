import colors from 'ansi-colors';
import EasyTable from 'easy-table';
import { expect } from 'expect';
import { fitTable } from '../../src/utils/fit-table.js';

/** A table of the shape `rman version` prints - short fixed columns, then free text. */
function table(reason: string): string {
  const t = new EasyTable();
  t.cell('Status', 'bump');
  t.cell('Package', 'pkg-a');
  t.cell('Reason', reason);
  t.newRow();
  t.cell('Status', 'bump');
  t.cell('Package', 'pkg-b');
  t.cell('Reason', 'short');
  t.newRow();
  return t.toString().trim();
}

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('utils/fitTable', () => {
  const long = 'repository release identity - several version lines, so no shared number to report';

  it('continues a long last column under itself, and keeps every line inside the terminal', () => {
    const lines = fitTable(table(long), 60).split('\n');
    const start = lines[0]!.indexOf('Reason');
    for (const line of lines) expect(plain(line).length).toBeLessThanOrEqual(60);
    const reasonLines = lines.filter(l => /identity|lines|number|report/.test(l));
    expect(reasonLines.length).toBeGreaterThan(1);
    for (const l of reasonLines.slice(1)) expect(l.search(/\S/)).toBe(start);
    expect(lines.map(l => l.trim()).join(' ')).toContain('no shared number to report');
  });

  it('cuts the delimiter line at the edge rather than letting it wrap', () => {
    const delimiter = fitTable(table(long), 60)
      .split('\n')
      .find(l => /^[\s-]+$/.test(l))!;
    expect(delimiter.length).toBeLessThanOrEqual(60);
  });

  it('keeps a painted cell painted on each of its lines', () => {
    const wasEnabled = colors.enabled;
    colors.enabled = true;
    try {
      const out = fitTable(table(colors.gray(long)), 60);
      const continuation = out.split('\n').filter(l => /lines|number/.test(plain(l)) && !/pkg-a/.test(l));
      for (const l of continuation) expect(l).toContain('\x1b[90m');
    } finally {
      colors.enabled = wasEnabled;
    }
  });

  it('leaves the table alone with no terminal, and only trims the padding when it fits', () => {
    const text = table(long);
    expect(fitTable(text, undefined)).toBe(text);
    expect(fitTable(text, 400)).toBe(
      text
        .split('\n')
        .map(l => l.trimEnd())
        .join('\n'),
    );
  });

  /** Too narrow to wrap the last column into: no row is split, but none is left padded past the
   *  edge either - that padding is what drew a blank line under every row. */
  it('trims the padding and cuts the delimiter where the last column is too narrow to wrap', () => {
    const lines = fitTable(table(long), 30).split('\n');
    expect(lines.find(l => /pkg-b/.test(l))).toMatch(/short$/);
    expect(lines.find(l => /^[\s-]+$/.test(l))!.length).toBeLessThanOrEqual(30);
    expect(lines.filter(l => /pkg-a/.test(l))).toHaveLength(1);
  });
});
