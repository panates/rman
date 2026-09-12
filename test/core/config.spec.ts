import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import expect from 'expect';
import { readDirConfig, resolveConfig } from '../../src/core/config.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-config-test-'));
}

describe('core/config', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }

  describe('readDirConfig()', () => {
    it('returns {} for an empty directory', () => {
      expect(readDirConfig(tmp())).toEqual({});
    });

    it('reads package.json#rman', () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', rman: { foo: 1 } }));
      expect(readDirConfig(dir)).toEqual({ foo: 1 });
    });

    it('reads .rman.yml', () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rman.yml'), 'foo: 1\nbar:\n  baz: 2\n');
      expect(readDirConfig(dir)).toEqual({ foo: 1, bar: { baz: 2 } });
    });

    it('reads .rmanrc as JSON', () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ foo: 1 }));
      expect(readDirConfig(dir)).toEqual({ foo: 1 });
    });

    it('deep-merges all three sources, .rmanrc winning over .rman.yml winning over package.json#rman', () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', rman: { a: 1, b: 1, c: 1 } }));
      fs.writeFileSync(path.join(dir, '.rman.yml'), 'b: 2\nc: 2\n');
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ c: 3 }));
      expect(readDirConfig(dir)).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('ignores a non-object package.json#rman value', () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', rman: 'nonsense' }));
      expect(readDirConfig(dir)).toEqual({});
    });
  });

  describe('resolveConfig()', () => {
    it('cascades root -> intermediate -> leaf, each level overriding the ones above', () => {
      const root = tmp();
      const mid = path.join(root, 'packages', 'group-a');
      const leaf = path.join(mid, 'pkg');
      fs.mkdirSync(leaf, { recursive: true });

      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ a: 'root', b: 'root', c: 'root' }));
      fs.writeFileSync(path.join(mid, '.rmanrc'), JSON.stringify({ b: 'mid' }));
      fs.writeFileSync(path.join(leaf, '.rmanrc'), JSON.stringify({ c: 'leaf' }));

      expect(resolveConfig(root, leaf)).toEqual({ a: 'root', b: 'mid', c: 'leaf' });
    });

    it('resolves to just the root config when targetDir === rootDir', () => {
      const root = tmp();
      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ a: 1 }));
      expect(resolveConfig(root, root)).toEqual({ a: 1 });
    });

    it('falls back to only the root config for a target outside the root', () => {
      const root = tmp();
      const outside = tmp();
      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ a: 1 }));
      expect(resolveConfig(root, outside)).toEqual({ a: 1 });
    });

    it('reuses a shared cache across calls instead of re-reading a common ancestor', () => {
      const root = tmp();
      const pkgA = path.join(root, 'packages', 'a');
      const pkgB = path.join(root, 'packages', 'b');
      fs.mkdirSync(pkgA, { recursive: true });
      fs.mkdirSync(pkgB, { recursive: true });
      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ shared: 1 }));
      fs.writeFileSync(path.join(pkgA, '.rmanrc'), JSON.stringify({ own: 'a' }));
      fs.writeFileSync(path.join(pkgB, '.rmanrc'), JSON.stringify({ own: 'b' }));

      const cache = new Map<string, unknown>();
      expect(resolveConfig(root, pkgA, cache)).toEqual({ shared: 1, own: 'a' });
      expect(resolveConfig(root, pkgB, cache)).toEqual({ shared: 1, own: 'b' });
      // the root entry must have been cached once and reused for both calls.
      expect(cache.get(root)).toEqual({ shared: 1 });
    });
  });
});
