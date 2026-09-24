import { expect } from 'expect';
import type { Package } from '../../src/core/package.js';
import { filterPackages, ROOT_SELECTOR } from '../../src/utils/package-filter.js';

/**
 * A minimal fake `Package` - only `selector`, `dependencies` and `isRoot` matter to
 * `filterPackages`.
 *
 * **`selector`, which is what `--scope` matches, and `name` beside it because they are not the same
 * question.** A package having a name at all is an ecosystem's promise; the selector is what
 * addresses it inside this repository, and a repository can assign one where its technology offers
 * none. They coincide here, as they do in every Node repository.
 *
 * `dependencies` holds **packages, not names**: a name identifies a package only where the
 * ecosystem guarantees uniqueness, so the graph is built out of references and `filterPackages`
 * compares by identity. Passing strings here silently matched nothing.
 */
function pkg(name: string, dependencies: Package[] = []): Package {
  return { name, selector: name, dependencies, isRoot: false } as unknown as Package;
}

/** The repository's own root package - what `--scope /` selects. Given a selector like any other
 *  package on purpose: the point of `ROOT_SELECTOR` is that it is *not* how the root is found. */
function rootPkg(name: string): Package {
  return { name, selector: name, dependencies: [], isRoot: true } as unknown as Package;
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

    /**
     * `--scope /` - the same `/` `.rmanrc`'s `"[/]"` uses, and structural for the same reason: the
     * root is never selected by name.
     */
    describe(`scope ${ROOT_SELECTOR} (the root package)`, () => {
      it('selects the root package, and nothing else', () => {
        const packages = [rootPkg('the-repo'), pkg('a'), pkg('b')];
        const result = filterPackages(packages, { scope: ROOT_SELECTOR });
        expect(result.map(p => p.name)).toEqual(['the-repo']);
      });

      it('is not a glob - it matches the root whatever the root is called, and matches no member', () => {
        // The trap it removed: `--scope the-repo` used to work, which is exactly the name-based
        // addressing the config selectors dropped. A member named "/" cannot exist, so there is
        // nothing for the structural reading to shadow.
        const packages = [rootPkg('anything-at-all'), pkg('/')];
        const result = filterPackages(packages, { scope: ROOT_SELECTOR });
        expect(result.map(p => p.name)).toEqual(['anything-at-all']);
        expect(result[0]!.isRoot).toBe(true);
      });

      it('combines with globs rather than replacing them', () => {
        const packages = [rootPkg('the-repo'), pkg('a'), pkg('b')];
        const result = filterPackages(packages, { scope: [ROOT_SELECTOR, 'a'] });
        expect(result.map(p => p.name)).toEqual(['the-repo', 'a']);
      });

      it('selects nothing when the candidate list holds no root - which is most commands', () => {
        // `repository.packages` is the workspace members only, so `list`/`run` never see the root.
        // The honest answer there is an empty set, not a special case that invents one.
        const packages = [pkg('a'), pkg('b')];
        expect(filterPackages(packages, { scope: ROOT_SELECTOR })).toEqual([]);
      });

      it('works through ignore too: everything but the root', () => {
        const packages = [rootPkg('the-repo'), pkg('a'), pkg('b')];
        const result = filterPackages(packages, { ignore: ROOT_SELECTOR });
        expect(result.map(p => p.name)).toEqual(['a', 'b']);
      });

      /**
       * The other half of the rule, and the reason `/` is not merely a second spelling: a glob is
       * never offered the root. `.rmanrc` already says this (`"[my-*]"` cannot pick up a root called
       * `my-repo`; `"[*]"` means the members) and the CLI disagreed - measured, `clean --scope
       * 'rman*'` selected this repository's own root, whose sweep recurses through `packages/*`.
       */
      it("a glob never matches the root, however well the root's name fits it", () => {
        const packages = [rootPkg('the-repo'), pkg('the-lib')];
        expect(filterPackages(packages, { scope: 'the-*' }).map(p => p.name)).toEqual(['the-lib']);
        expect(filterPackages(packages, { scope: 'the-repo' }).map(p => p.name)).toEqual([]);
        expect(filterPackages(packages, { scope: '*' }).map(p => p.name)).toEqual(['the-lib']);
      });

      it('and so a glob never ignores it either - the rule is the same in both directions', () => {
        const packages = [rootPkg('the-repo'), pkg('the-lib')];
        const result = filterPackages(packages, { ignore: '*' });
        expect(result.map(p => p.name)).toEqual(['the-repo']);
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
