import { expect } from 'expect';
import type { Package } from '../../src/core/package.js';
import { filterPackages } from '../../src/utils/package-filter.js';

/**
 * A minimal fake `Package` - only `name` and `dependencies` matter to `filterPackages`.
 *
 * `dependencies` holds **packages, not names**: a name identifies a package only where the
 * ecosystem guarantees uniqueness, so the graph is built out of references and `filterPackages`
 * compares by identity. Passing strings here silently matched nothing.
 */
function pkg(name: string, dependencies: Package[] = []): Package {
  return { name, dependencies } as Package;
}

/**
 * Builds a set of fake packages from `name -> dependency names`, wiring `dependencies` to the
 * **objects**. Declaration order is preserved, which several specs below assert.
 *
 * Each entry is expected to list its own *transitive* closure, the way `Repository` computes it.
 */
function graph(spec: Record<string, string[]>): Package[] {
  const packages = Object.keys(spec).map(name => pkg(name));
  const byName = new Map(packages.map(p => [p.name, p]));
  for (const p of packages) {
    p.dependencies = (spec[p.name] ?? []).map(n => byName.get(n)!);
  }
  return packages;
}

describe('utils/package-filter', () => {
  describe('filterPackages()', () => {
    it('with no options at all, returns every package unchanged (same order)', () => {
      const packages = [pkg('a'), pkg('b'), pkg('c')];
      expect(filterPackages(packages, {})).toEqual(packages);
    });

    describe('scope', () => {
      it('keeps only packages matching at least one glob', () => {
        const packages = [pkg('@scope/a'), pkg('@scope/b'), pkg('plain')];
        const result = filterPackages(packages, { scope: '@scope/*' });
        expect(result.map(p => p.name)).toEqual(['@scope/a', '@scope/b']);
      });

      it('accepts an array of globs, matching any of them', () => {
        const packages = [pkg('a'), pkg('b'), pkg('c')];
        const result = filterPackages(packages, { scope: ['a', 'c'] });
        expect(result.map(p => p.name)).toEqual(['a', 'c']);
      });
    });

    describe('ignore', () => {
      it('excludes packages matching the glob, applied after scope', () => {
        const packages = [pkg('@scope/a'), pkg('@scope/b'), pkg('plain')];
        const result = filterPackages(packages, { scope: '@scope/*', ignore: '*/b' });
        expect(result.map(p => p.name)).toEqual(['@scope/a']);
      });

      it('with no scope, just excludes the matched packages from the full set', () => {
        const packages = [pkg('a'), pkg('b'), pkg('c')];
        const result = filterPackages(packages, { ignore: 'b' });
        expect(result.map(p => p.name)).toEqual(['a', 'c']);
      });
    });

    describe('deps', () => {
      it('also includes every package the matched set (transitively) depends on', () => {
        // c depends on b, b depends on a - c's own `dependencies` is already the transitive closure.
        const packages = graph({ a: [], b: ['a'], c: ['a', 'b'] });
        const result = filterPackages(packages, { scope: 'c', deps: true });
        expect(result.map(p => p.name).sort()).toEqual(['a', 'b', 'c']);
      });

      it('preserves the original array order, not the scanning order', () => {
        const packages = graph({ a: [], b: ['a'], c: ['a', 'b'] });
        const result = filterPackages(packages, { scope: 'c', deps: true });
        expect(result.map(p => p.name)).toEqual(['a', 'b', 'c']);
      });
    });

    describe('dependents', () => {
      it('also includes every package that (transitively) depends on the matched set', () => {
        const packages = graph({ a: [], b: ['a'], c: ['a', 'b'] });
        const result = filterPackages(packages, { scope: 'a', dependents: true });
        expect(result.map(p => p.name).sort()).toEqual(['a', 'b', 'c']);
      });
    });

    describe('deps + dependents together', () => {
      it("each expands independently from the original scoped set, not from the other's additions", () => {
        // chain: base <- lib <- app ; and a totally separate pair: leaf <- tool (depends on leaf).
        // Scoping to "lib" with both flags should pull in "base" (its own dependency) and "app"
        // (depends on lib) - but never "leaf"/"tool", which have no relation to "lib" at all. If
        // --dependents were (incorrectly) computed against the deps-expanded set instead of the
        // original scope, this would still hold here since deps-expansion of "lib" only adds
        // "base", which nothing outside this chain depends on - so this also guards against a
        // regression that would blow up unrelated parts of a more connected graph.
        const packages = graph({
          base: [],
          lib: ['base'],
          app: ['base', 'lib'],
          leaf: [],
          tool: ['leaf'],
        });
        const result = filterPackages(packages, { scope: 'lib', deps: true, dependents: true });
        expect(result.map(p => p.name).sort()).toEqual(['app', 'base', 'lib']);
      });
    });

    it('scope + ignore + deps + dependents all compose together', () => {
      // "dependencies" is already the transitive closure (as the real Repository computes it) -
      // c depends on b, which depends on a, so c's own array lists both.
      const packages = graph({ a: [], b: ['a'], c: ['a', 'b'], d: [] });
      // scope to "c" -> ignore removes nothing (ignore glob doesn't match "c") -> deps adds a,b ->
      // dependents of {c} adds nothing further (nothing depends on c) - "d" never enters at all.
      const result = filterPackages(packages, { scope: 'c', ignore: 'zzz', deps: true, dependents: true });
      expect(result.map(p => p.name).sort()).toEqual(['a', 'b', 'c']);
    });
  });
});
