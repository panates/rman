import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { NodePlatform } from '../../../src/builtins/platforms/node/node.platform.js';

/** The method under test, as a free function - it reads nothing off `this`, and naming it here
 *  keeps the assertions below reading the way they did when it was one. */
const npmBinPaths = (cwd: string, inherited = ''): string[] => new InheritingPlatform(inherited).getBinPaths(cwd);

/** The platform with the PATH it inherits stated by the case, rather than whatever the machine
 *  running the suite has. */
class InheritingPlatform extends NodePlatform {
  constructor(readonly inherited: string) {
    super();
  }
  protected override inheritedPath(): string {
    return this.inherited;
  }
}

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

  it('includes the directory of the current Node executable, last, when the PATH finds another node', () => {
    const { root, nested } = tmpNested();
    const other = path.join(root, 'other-bin');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, process.platform === 'win32' ? 'node.exe' : 'node'), '');
    for (const inherited of ['', other]) {
      const entries = npmBinPaths(nested, inherited);
      expect(entries.at(-1)).toBe(path.dirname(process.execPath));
    }
  });

  /** Measured: the interpreter's directory is where `npm install -g` writes, so putting it first put
   *  a global pnpm 9.9.0 ahead of the shell's 12.10.1 - for nothing, since the shell's `node` was the
   *  same interpreter. */
  it("leaves it out when the inherited PATH's first node is this interpreter", () => {
    const { root, nested } = tmpNested();
    const linked = path.join(root, 'linked-bin');
    fs.mkdirSync(linked);
    fs.symlinkSync(process.execPath, path.join(linked, 'node'));
    const nowhere = path.join(root, 'empty');
    for (const inherited of [path.dirname(process.execPath), [nowhere, linked].join(path.delimiter)]) {
      expect(npmBinPaths(nested, inherited)).not.toContain(path.dirname(process.execPath));
    }
  });
});
