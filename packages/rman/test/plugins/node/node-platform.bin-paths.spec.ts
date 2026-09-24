import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { NodePlatform } from '../../../src/plugins/node/node.platform.js';

/** The method under test, as a free function - it reads nothing off `this`, and naming it here
 *  keeps the assertions below reading the way they did when it was one. */
const npmBinPaths = (cwd: string): string[] => new NodePlatform().getBinPaths(cwd);

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-runpath-test-'));
}

/**
 * The npm half of what used to be one `npmRunPath` in rman's core: *which* directories hold a
 * repository's locally installed binaries. Composing them into a PATH is the core's, and is
 * covered by `packages/rman/test/utils/bin-path.spec.ts`.
 */
describe('utils/npm-run-path', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmpNested(): { root: string; nested: string } {
    const root = mkTmp();
    dirs.push(root);
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    return { root, nested };
  }

  it('returns node_modules/.bin for cwd and every ancestor up to the filesystem root', () => {
    const { root, nested } = tmpNested();
    const entries = npmBinPaths(nested);
    expect(entries).toContain(path.join(nested, 'node_modules/.bin'));
    expect(entries).toContain(path.join(root, 'a', 'node_modules/.bin'));
    expect(entries).toContain(path.join(root, 'node_modules/.bin'));
  });

  it('lists the nearer directories before farther ones', () => {
    const { root, nested } = tmpNested();
    const entries = npmBinPaths(nested);
    const nestedIdx = entries.indexOf(path.join(nested, 'node_modules/.bin'));
    const rootIdx = entries.indexOf(path.join(root, 'node_modules/.bin'));
    expect(nestedIdx).toBeGreaterThanOrEqual(0);
    expect(rootIdx).toBeGreaterThan(nestedIdx);
  });

  it('includes the directory of the current Node executable, last', () => {
    const { nested } = tmpNested();
    const entries = npmBinPaths(nested);
    expect(entries).toContain(path.dirname(process.execPath));
    expect(entries.at(-1)).toBe(path.dirname(process.execPath));
  });
});
