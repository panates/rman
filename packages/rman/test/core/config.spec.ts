import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { createFileScope, defineConfig, readDirConfig, resolveConfig } from '../../src/core/config.js';
import type { RmanConfig } from '../../src/interfaces/rman-config.interface.js';

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
    it('returns {} for an empty directory', async () => {
      expect(await readDirConfig(tmp())).toEqual({});
    });

    it('reads package.json#rman', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', rman: { foo: 1 } }));
      expect(await readDirConfig(dir)).toEqual({ foo: 1 });
    });

    it('reads .rmanrc.yml', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), 'foo: 1\nbar:\n  baz: 2\n');
      expect(await readDirConfig(dir)).toEqual({ foo: 1, bar: { baz: 2 } });
    });

    it('reads .rmanrc as JSON', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ foo: 1 }));
      expect(await readDirConfig(dir)).toEqual({ foo: 1 });
    });

    it('deep-merges all three sources, .rmanrc winning over .rmanrc.yml winning over package.json#rman', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', rman: { a: 1, b: 1, c: 1 } }));
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), 'b: 2\nc: 2\n');
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ c: 3 }));
      expect(await readDirConfig(dir)).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('ignores a non-object package.json#rman value', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', rman: 'nonsense' }));
      expect(await readDirConfig(dir)).toEqual({});
    });

    describe('.rmanrc.cjs / .rmanrc.mjs / .rmanrc.js (JS config)', () => {
      it('reads .rmanrc.cjs (CommonJS, regardless of the nearest package.json "type")', async () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, '.rmanrc.cjs'), 'module.exports = { foo: 1, bar: { baz: 2 } };\n');
        expect(await readDirConfig(dir)).toEqual({ foo: 1, bar: { baz: 2 } });
      });

      it('reads .rmanrc.mjs (native ESM, a default export)', async () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, '.rmanrc.mjs'), 'export default { foo: 1, bar: { baz: 2 } };\n');
        expect(await readDirConfig(dir)).toEqual({ foo: 1, bar: { baz: 2 } });
      });

      it('reads .rmanrc.js as ESM when the nearest package.json says "type": "module"', async () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
        fs.writeFileSync(path.join(dir, '.rmanrc.js'), 'export default { foo: 1 };\n');
        expect(await readDirConfig(dir)).toEqual({ foo: 1 });
      });

      it('reads .rmanrc.js as CommonJS when the nearest package.json has no "type" (or "commonjs")', async () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
        fs.writeFileSync(path.join(dir, '.rmanrc.js'), 'module.exports = { foo: 1 };\n');
        expect(await readDirConfig(dir)).toEqual({ foo: 1 });
      });

      it('a JS config wins over .rmanrc/.rmanrc.yml/package.json#rman, the highest-precedence source', async () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', rman: { a: 1, b: 1, c: 1 } }));
        fs.writeFileSync(path.join(dir, '.rmanrc.yml'), 'b: 2\nc: 2\n');
        fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ c: 3 }));
        fs.writeFileSync(path.join(dir, '.rmanrc.cjs'), 'module.exports = { c: 4 };\n');
        expect(await readDirConfig(dir)).toEqual({ a: 1, b: 2, c: 4 });
      });

      it('merges .rmanrc.cjs/.mjs/.js together (in that order) when more than one exists', async () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
        fs.writeFileSync(path.join(dir, '.rmanrc.cjs'), 'module.exports = { a: 1, b: 1 };\n');
        fs.writeFileSync(path.join(dir, '.rmanrc.mjs'), 'export default { b: 2, c: 2 };\n');
        fs.writeFileSync(path.join(dir, '.rmanrc.js'), 'module.exports = { c: 3 };\n');
        expect(await readDirConfig(dir)).toEqual({ a: 1, b: 2, c: 3 });
      });
    });
  });

  describe('resolveConfig()', () => {
    it('cascades root -> intermediate -> leaf, each level overriding the ones above', async () => {
      const root = tmp();
      const mid = path.join(root, 'packages', 'group-a');
      const leaf = path.join(mid, 'pkg');
      fs.mkdirSync(leaf, { recursive: true });

      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ a: 'root', b: 'root', c: 'root' }));
      fs.writeFileSync(path.join(mid, '.rmanrc'), JSON.stringify({ b: 'mid' }));
      fs.writeFileSync(path.join(leaf, '.rmanrc'), JSON.stringify({ c: 'leaf' }));

      expect(await resolveConfig(root, leaf)).toEqual({ a: 'root', b: 'mid', c: 'leaf' });
    });

    it('resolves to just the root config when targetDir === rootDir', async () => {
      const root = tmp();
      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ a: 1 }));
      expect(await resolveConfig(root, root)).toEqual({ a: 1 });
    });

    it('falls back to only the root config for a target outside the root', async () => {
      const root = tmp();
      const outside = tmp();
      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ a: 1 }));
      expect(await resolveConfig(root, outside)).toEqual({ a: 1 });
    });

    it("a package directory's unmarked config speaks for that package only, never the ones below it", async () => {
      // The whole point of the split: the root has a package.json, so its unmarked config is the
      // ROOT package's - not a silent default for every package under it.
      const root = tmp();
      const pkg = path.join(root, 'packages', 'a');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }));
      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ a: 'root-only' }));
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'pkg-a' }));

      expect(await resolveConfig(root, pkg, undefined, 'pkg-a')).toEqual({});
      expect(await resolveConfig(root, root, undefined, 'root')).toEqual({ a: 'root-only' });
    });

    it('a directory holding no package still cascades - it has no package to speak for', async () => {
      const root = tmp();
      const mid = path.join(root, 'packages');
      const pkg = path.join(mid, 'a');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }));
      fs.writeFileSync(path.join(mid, '.rmanrc'), JSON.stringify({ a: 'from-mid' }));
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'pkg-a' }));

      expect(await resolveConfig(root, pkg, undefined, 'pkg-a')).toEqual({ a: 'from-mid' });
    });

    it('a "[selector]" block reaches the packages it names', async () => {
      const root = tmp();
      const a = path.join(root, 'packages', 'a');
      const dialect = path.join(root, 'packages', 'mysql-dialect');
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(dialect, { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }));
      fs.writeFileSync(
        path.join(root, '.rmanrc'),
        JSON.stringify({ '[*]': { a: 'all' }, '[*-dialect]': { a: 'dialects', b: 'only-dialects' } }),
      );

      expect(await resolveConfig(root, a, undefined, 'pkg-a')).toEqual({ a: 'all' });
      expect(await resolveConfig(root, dialect, undefined, 'mysql-dialect')).toEqual({
        a: 'dialects',
        b: 'only-dialects',
      });
    });

    it('a selector glob is anchored at both ends', async () => {
      const root = tmp();
      const pkg = path.join(root, 'packages', 'a');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }));
      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ '[*-dialect]': { a: 1 } }));

      expect(await resolveConfig(root, pkg, undefined, 'my-dialect-helper')).toEqual({});
      expect(await resolveConfig(root, pkg, undefined, 'mysql-dialect')).toEqual({ a: 1 });
    });

    it('precedence: "[*]" < a more specific selector < the package\'s own config', async () => {
      const root = tmp();
      const pkg = path.join(root, 'packages', 'mysql-dialect');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }));
      fs.writeFileSync(
        path.join(root, '.rmanrc'),
        // "[*]" written last on purpose - it always loses regardless of declaration order.
        JSON.stringify({ '[*-dialect]': { a: 'specific', b: 'specific' }, '[*]': { a: 'all', c: 'all' } }),
      );
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'mysql-dialect' }));
      fs.writeFileSync(path.join(pkg, '.rmanrc'), JSON.stringify({ a: 'own' }));

      expect(await resolveConfig(root, pkg, undefined, 'mysql-dialect')).toEqual({
        a: 'own',
        b: 'specific',
        c: 'all',
      });
    });

    it('without a package name, selector blocks contribute nothing at all', async () => {
      const root = tmp();
      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ a: 1, '[*]': { b: 2 } }));
      expect(await resolveConfig(root, root)).toEqual({ a: 1 });
    });

    it('reuses a shared cache across calls instead of re-reading a common ancestor', async () => {
      const root = tmp();
      const pkgA = path.join(root, 'packages', 'a');
      const pkgB = path.join(root, 'packages', 'b');
      fs.mkdirSync(pkgA, { recursive: true });
      fs.mkdirSync(pkgB, { recursive: true });
      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ shared: 1 }));
      fs.writeFileSync(path.join(pkgA, '.rmanrc'), JSON.stringify({ own: 'a' }));
      fs.writeFileSync(path.join(pkgB, '.rmanrc'), JSON.stringify({ own: 'b' }));

      const cache = new Map<string, RmanConfig>();
      expect(await resolveConfig(root, pkgA, cache)).toEqual({ shared: 1, own: 'a' });
      expect(await resolveConfig(root, pkgB, cache)).toEqual({ shared: 1, own: 'b' });
      // the root entry must have been cached once and reused for both calls.
      expect(cache.get(root)).toEqual({ shared: 1 });
    });
  });

  describe('defineConfig()', () => {
    it('returns the given config object completely unchanged - a typing aid, not a transform', () => {
      /** Core keys only - `packageManager` left with `rman-node`, and a core spec must not need a
       *  plugin loaded to type its own fixture. */
      const config: RmanConfig = { logLevel: 'silent', group: false };
      expect(defineConfig(config)).toBe(config);
    });
  });

  /**
   * **A type-level check, run by `tsc` over the test tree rather than by mocha.** The runtime rule
   * is general - any object node may carry `vars` and scopes its subtree - while a type can only
   * say it one interface at a time, so the two can drift apart in exactly one direction: a nested
   * options interface that forgot to extend `ScopedVars`. It did drift, and the assertion below is
   * what would have caught it - `vars` worked at every level and type-checked at none.
   *
   * `tsc --noEmit -p packages/rman/test/tsconfig.json` is what enforces this; `npm test` does not
   * type-check.
   */
  describe('ScopedVars', () => {
    it('is accepted wherever the runtime scopes it', () => {
      const config: RmanConfig = {
        vars: { x: 1 },
        run: {
          build: { vars: { x: 3 }, exec: 'tsc -b' },
        },
        version: { vars: { x: 4 }, commitMessage: 'release' },
        changelog: { vars: { x: 5 } },
        publish: { vars: { x: 6 } },
        githubRelease: { vars: { x: 7 } },
      };
      /** Nothing to assert at runtime: the declaration above either compiles or it does not. */
      expect(config.run?.build).toEqual({ vars: { x: 3 }, exec: 'tsc -b' });

      /** `run.vars` is the one place the runtime scopes and the type does not - see `RunConfig`
       *  for the measurement behind that. It needs a cast, and the cast is what this pins. */
      const withRunVars: RmanConfig = {
        run: { vars: { x: 2 }, build: { exec: 'tsc' } } as RmanConfig['run'],
      };
      expect((withRunVars.run as Record<string, unknown>).vars).toEqual({ x: 2 });
    });
  });

  describe('createFileScope()', () => {
    /**
     * **Pinned, not merely documented.** `file` is evaluated while the config *resolves*, which
     * every command does - so a member that changed anything would change it on `rman list`,
     * `rman info` and `rman config`, once per package, with nothing having asked. A comment saying
     * so can be contradicted by the next person adding a plausible-sounding `copy`; this fails.
     *
     * Work belongs in a step, which is the one thing rman runs on purpose - and a step can be a
     * function too, so refusing this costs nothing.
     */
    it('exposes exactly three members, all of them questions', () => {
      const scope = createFileScope(tmp());
      expect(Object.keys(scope).sort()).toEqual(['exists', 'resolve', 'resolveFirst']);
    });

    it('leaves the directory untouched - nothing here creates, copies or writes', () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'present.txt'), 'x');
      const before = fs.readdirSync(dir).sort();

      const scope = createFileScope(dir);
      expect(scope.exists('present.txt')).toBe(path.join(dir, 'present.txt'));
      /** A miss is `''` rather than `undefined`, so `a || b` picks the first that exists and a miss
       *  stays clear of the nullish-inside-a-string guard. */
      expect(scope.exists('missing.txt')).toBe('');
      expect(scope.resolve('present.txt')).toBe(path.join(dir, 'present.txt'));
      expect(() => scope.resolve('missing.txt')).toThrow(/found nothing/);
      expect(scope.resolveFirst('missing.txt', 'present.txt')).toBe(path.join(dir, 'present.txt'));
      expect(() => scope.resolveFirst('missing.txt', 'gone.txt')).toThrow(/found none of/);

      expect(fs.readdirSync(dir).sort()).toEqual(before);
    });
  });
});
