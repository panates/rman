import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { ConfigInterpolator } from '../../src/core/config/config-interpolator.js';
import { ORIGINS, PREVIOUS_VALUES } from '../../src/core/config/merge-config.js';
import type { ConfigScope } from '../../src/interfaces/config-scope.interface.js';

/**
 * **Self-contained: no repository, no application, no fixture ecosystem.** `ConfigInterpolator`
 * takes a structural `ConfigScope`, so a spec builds one out of plain objects - which is also the
 * proof that the class depends on no `Package`.
 */
describe('core/ConfigInterpolator', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-interp-'));
    dirs.push(d);
    return d;
  }

  /** The smallest scope an expression can be evaluated against. Anything a case needs beyond this
   *  it adds itself, which keeps each case's dependencies visible in the case. */
  function scope(extra?: Record<string, unknown>): ConfigScope {
    return { pkg: { name: 'mypackage', version: '1.2.3' }, env: {}, path, ...extra } as unknown as ConfigScope;
  }

  function interp(): ConfigInterpolator {
    return new ConfigInterpolator();
  }

  describe('expressions', () => {
    it('resolves an expression embedded in text', () => {
      const out = interp().interpolate({ config: { tag: 'app:${{ pkg.version }}' }, scope: scope() });
      expect(out.tag).toBe('app:1.2.3');
    });

    it('keeps the value type when the string is nothing but one expression', () => {
      const out = interp().interpolate({
        config: { flag: '${{ pkg.flag }}', count: '${{ pkg.count }}' },
        scope: scope({ pkg: { flag: false, count: 7 } }),
      });
      expect(out.flag).toBe(false);
      expect(out.count).toBe(7);
    });

    /** Counted rather than matched with an anchored regex: a lazy quantifier backtracks to reach an
     *  end anchor, so this looked like one expression running from `a` to `b`. */
    it('does not read two expressions in one string as a single one', () => {
      const out = interp().interpolate({
        config: { s: '${{ pkg.name }} and ${{ pkg.version }}' },
        scope: scope(),
      });
      expect(out.s).toBe('mypackage and 1.2.3');
    });

    it('leaves a bare {{ }} alone - it belongs to something else', () => {
      const cfg = { s: 'helm template --set tag={{.Values.tag}}' };
      expect(interp().interpolate({ config: cfg, scope: scope() }).s).toBe(cfg.s);
    });

    it('lets an expression emit a literal ${{', () => {
      const out = interp().interpolate({ config: { s: "${{ '${{' }}.Values.tag}}" }, scope: scope() });
      expect(out.s).toBe('${{.Values.tag}}');
    });

    /** Alone it is "unset", which is a legitimate answer; spliced into text it produces an
     *  `app:undefined` that looks plausible and is wrong. */
    it('allows a nullish result alone and refuses one inside a string', () => {
      expect(interp().interpolate({ config: { a: '${{ pkg.missing }}' }, scope: scope() }).a).toBeUndefined();
      expect(() => interp().interpolate({ config: { a: 'x:${{ pkg.missing }}' }, scope: scope() })).toThrow(
        /is undefined inside a string/,
      );
    });

    it('names the config path and the file in a failing expression', () => {
      const config: Record<string, any> = { version: { commitMessage: '${{ nope( }}' } };
      Object.defineProperty(config.version, ORIGINS, { value: { commitMessage: '/repo/.rmanrc.yml' } });
      expect(() => interp().interpolate({ config, scope: scope() })).toThrow(
        /Invalid expression in "version\.commitMessage" \(.*\.rmanrc\.yml\)/,
      );
    });

    it('stops an expression that never returns', () => {
      expect(() => interp().interpolate({ config: { a: '${{ while(true){} }}' }, scope: scope() })).toThrow();
    });
  });

  describe("the config's own keys are in scope", () => {
    it('reads another top-level key bare', () => {
      const out = interp().interpolate({
        config: { changelog: { filePath: 'CHANGELOG.md' }, after: 'cp x ${{ changelog.filePath }}' },
        scope: scope(),
      });
      expect(out.after).toBe('cp x CHANGELOG.md');
    });

    /** Resolved on demand, so a key declared *below* the one reading it works exactly as one
     *  declared above - the order in the file means nothing. */
    it('does not depend on key order in the file', () => {
      const out = interp().interpolate({ config: { a: '${{ b }}-x', b: 'B' }, scope: scope() });
      expect(out.a).toBe('B-x');
    });

    /** The cycle is *recorded* by the guard and *surfaces* on the error the resulting `undefined`
     *  causes - here, a nullish expression spliced into text. Reported as a loop rather than as
     *  `b is not defined`, which would send the reader after a missing key. */
    it('reports a cycle rather than a missing key', () => {
      expect(() => interp().interpolate({ config: { a: 'x-${{ b }}', b: 'y-${{ a }}' }, scope: scope() })).toThrow(
        /forms a cycle: a -> b -> a/,
      );
    });

    /**
     * **The documented limit of that, pinned so a change to it is deliberate.** Two keys that are
     * *nothing but* each other's expression resolve to `undefined` and nothing throws - alone, a
     * nullish result is a legitimate "unset". Measured identical against `interpolateConfig`.
     */
    it('control: a cycle of sole expressions resolves to undefined instead', () => {
      const out = interp().interpolate({ config: { a: '${{ b }}', b: '${{ a }}' }, scope: scope() });
      expect(out).toEqual({ a: undefined, b: undefined });
    });

    it('lets a scope binding win over a config key of the same name', () => {
      const out = interp().interpolate({ config: { pkg: 'not-this', s: '${{ pkg.name }}' }, scope: scope() });
      expect(out.s).toBe('mypackage');
    });
  });

  describe('value functions', () => {
    it('calls a function where a value is expected', () => {
      const out = interp().interpolate({
        config: { name: ({ pkg }: any) => `${pkg.name}-suffix` },
        scope: scope(),
      });
      expect(out.name).toBe('mypackage-suffix');
    });

    /** A step is code for `run`/`version` to call in its own time. Calling it here would run
     *  build-time work while merely loading the repository. */
    it('leaves a function at a step path alone', () => {
      const step = () => 'never called';
      const out = interp().interpolate({ config: { run: { build: { exec: step } } }, scope: scope() });
      expect((out as any).run.build.exec).toBe(step);
    });

    it('leaves a function under a code subtree alone', () => {
      const fn = () => 'never called';
      const out = interp().interpolate({ config: { plugins: [{ name: 'x', init: fn }] }, scope: scope() });
      expect((out as any).plugins[0].init).toBe(fn);
    });

    it('names the config path when a value function throws', () => {
      expect(() =>
        interp().interpolate({
          config: {
            changelog: {
              filePath: () => {
                throw new Error('boom');
              },
            },
          },
          scope: scope(),
        }),
      ).toThrow(/Config function in "changelog\.filePath" failed: boom/);
    });
  });

  describe('value: what the layers below resolved to', () => {
    /** The chain is recorded by `mergeConfig`; a spec builds one by hand so the interpolator can be
     *  exercised without a merge. */
    function withChain(config: Record<string, any>, key: string, previous: unknown): Record<string, any> {
      Object.defineProperty(config, PREVIOUS_VALUES, { value: { [key]: { value: previous } } });
      return config;
    }

    it('spreads the layer below', () => {
      const config = withChain({ include: "${{ [...value, 'dist'] }}" }, 'include', ['build']);
      expect(interp().interpolate({ config, scope: scope() }).include).toEqual(['build', 'dist']);
    });

    /** Not exotic: a value written to extend an inherited list is also the first layer in a
     *  repository that inherits nothing. */
    it('spreads as empty when nothing below set the key', () => {
      const out = interp().interpolate({ config: { include: "${{ [...value, 'dist'] }}" }, scope: scope() });
      expect(out.include).toEqual(['dist']);
    });

    /** `undefined + 1` is `NaN`, which serializes to `null` and reads like a configured value. */
    it('refuses to be a string or a number rather than becoming one', () => {
      expect(() => interp().interpolate({ config: { s: '${{ `${value}-x` }}' }, scope: scope() })).toThrow(
        /`value` cannot be used as a string or a number/,
      );
    });

    it('is available to a value function through the prototype', () => {
      const config = withChain({ include: ({ value }: any) => [...value, 'dist'] }, 'include', ['build']);
      expect(interp().interpolate({ config, scope: scope() }).include).toEqual(['build', 'dist']);
    });

    /** The hint explains an empty `value`; attaching it to an unrelated failure sends the reader to
     *  the wrong place. */
    it('adds the empty-value note only when the value actually read it', () => {
      const read = () => interp().interpolate({ config: { a: '${{ value.nope.deep }}' }, scope: scope() });
      expect(read).toThrow(/so `value` is empty/);

      const unrelated = () => interp().interpolate({ config: { a: '${{ pkg.nope.deep }}' }, scope: scope() });
      expect(unrelated).toThrow();
      expect(unrelated).not.toThrow(/so `value` is empty/);
    });
  });

  describe('vars scopes its own subtree', () => {
    it('merges a level over the one above it, per key', () => {
      const out = interp().interpolate({
        config: {
          vars: { x: 1, keep: 'me' },
          run: { vars: { x: 2 }, build: { name: '${{ vars.x }}-${{ vars.keep }}' } },
        },
        scope: scope(),
      });
      expect((out as any).run.build.name).toBe('2-me');
    });

    /** The values stay numbers: each `name` is nothing but one expression, and a sole expression
     *  keeps the value's own type. */
    it('does not leak a deeper level back out to a sibling', () => {
      const out = interp().interpolate({
        config: {
          vars: { x: 1 },
          run: { build: { vars: { x: 3 }, name: '${{ vars.x }}' }, clean: { name: '${{ vars.x }}' } },
        },
        scope: scope(),
      });
      expect((out as any).run.build.name).toBe(3);
      expect((out as any).run.clean.name).toBe(1);
    });

    it("resolves a level's own block against the scope above it", () => {
      const out = interp().interpolate({
        config: { vars: { x: 'a' }, run: { vars: { out: '${{ vars.x }}/dist' }, build: { p: '${{ vars.out }}' } } },
        scope: scope(),
      });
      expect((out as any).run.build.p).toBe('a/dist');
    });
  });

  describe('at and skip', () => {
    /** Without `at`, a fragment starts at the root and matches no step path, so a function in a
     *  version hook is called while the hook is being prepared. */
    it('treats a fragment as a step when told where it sits', () => {
      const step = () => 'never called';
      expect(interp().interpolate({ config: step, scope: scope(), at: ['version', 'after'] })).toBe(step);
    });

    it('control: the same fragment with no "at" is called as a value', () => {
      expect(interp().interpolate({ config: () => 'called', scope: scope() })).toBe('called');
    });

    it('hands a skipped path on untouched, subtree and all', () => {
      const config = { version: { after: 'x ${{ nope( }}' }, other: '${{ pkg.name }}' };
      const out = interp().interpolate({ config, scope: scope(), skip: ['version.after'] });
      expect((out as any).version.after).toBe('x ${{ nope( }}');
      expect(out.other).toBe('mypackage');
    });
  });

  describe('defer: two passes', () => {
    it('rewrites the deferred part and resolves the rest', () => {
      const out = interp().interpolate({
        config: { after: "docker build -t myapp:${{ '_' + defer(pkg.targetVersion) + '-' + pkg.name }} ." },
        scope: scope(),
      });
      expect(out.after).toBe('docker build -t myapp:_${{ pkg.targetVersion }}-mypackage .');
    });

    it('resolves it on the second pass, with what the caller can now bind', () => {
      const it1 = interp();
      const pass1 = it1.interpolate({
        config: { after: "docker build -t myapp:${{ '_' + defer(pkg.targetVersion) + '-' + pkg.name }} ." },
        scope: scope(),
      });
      const pass2 = it1.resolveDeferred({
        config: pass1,
        scope: scope({ pkg: { name: 'mypackage', targetVersion: '1.3.0' } }),
      });
      expect((pass2 as any).after).toBe('docker build -t myapp:_1.3.0-mypackage .');
    });

    /**
     * **The reason pass two walks marks rather than scanning for `${{`.** This string holds a
     * literal `${{` that pass one was asked to produce; nothing deferred it, so pass two must not
     * evaluate it.
     */
    it('leaves a literal ${{ that nothing deferred', () => {
      const c = interp();
      const pass1 = c.interpolate({ config: { after: "${{ '${{' }}.Values.tag}}" }, scope: scope() });
      expect((pass1 as any).after).toBe('${{.Values.tag}}');
      const pass2 = c.resolveDeferred({ config: pass1, scope: scope() });
      expect((pass2 as any).after).toBe('${{.Values.tag}}');
    });

    it('says whether a second pass is needed at all', () => {
      const c = interp();
      expect(c.hasDeferred(c.interpolate({ config: { a: '${{ pkg.name }}' }, scope: scope() }))).toBe(false);
      expect(c.hasDeferred(c.interpolate({ config: { a: '${{ defer(pkg.x) }}' }, scope: scope() }))).toBe(true);
    });

    it('marks a nested key, and pass two reaches it', () => {
      const c = interp();
      const pass1 = c.interpolate({
        config: { version: { after: 'tag ${{ defer(pkg.targetVersion) }}' }, other: '${{ pkg.name }}' },
        scope: scope(),
      });
      const pass2: any = c.resolveDeferred({ config: pass1, scope: scope({ pkg: { targetVersion: '2.0.0' } }) });
      expect(pass2.version.after).toBe('tag 2.0.0');
      expect(pass2.other).toBe('mypackage');
    });

    /** The parser decides where the argument ends, not a counter - this `)` closes nothing. */
    it('finds the closing parenthesis past a ) inside a string', () => {
      const out = interp().interpolate({
        config: { a: "${{ defer(x ? ')' : y) }}" },
        scope: scope(),
      });
      expect(out.a).toBe("${{ x ? ')' : y }}");
    });

    it('does not treat a property or a longer name as defer()', () => {
      const out = interp().interpolate({
        config: { a: '${{ helper.defer(1) + mydefer(2) }}' },
        scope: scope({ helper: { defer: (n: number) => n }, mydefer: (n: number) => n }),
      });
      expect(out.a).toBe(3);
    });

    it('refuses a nested defer()', () => {
      expect(() => interp().interpolate({ config: { a: '${{ defer(defer(x)) }}' }, scope: scope() })).toThrow(
        /Nested defer\(\)/,
      );
    });

    /**
     * **`}}` inside an expression is a limitation of the `${{ }}` delimiter, not of `defer`.**
     * `EXPRESSION` is non-greedy, so the expression is already cut at the first `}}` before `defer`
     * sees any of it - which is why there is no `}}` check inside `_findDeferArgument`. It fails
     * loudly, which is the part that matters.
     */
    it('fails on }} inside an expression, defer or not', () => {
      expect(() => interp().interpolate({ config: { a: '${{ defer(x["}}"]) }}' }, scope: scope() })).toThrow();
      expect(() => interp().interpolate({ config: { a: '${{ pkg.x["}}"] }}' }, scope: scope() })).toThrow();
    });

    /** The control for the shared-regex bug: a refusal must not leave a cursor behind for the next
     *  expression. Measured before the fix - this second call reached V8 as `defer is not defined`. */
    it('a refusal does not break the next expression', () => {
      expect(() => interp().interpolate({ config: { a: '${{ defer(defer(x)) }}' }, scope: scope() })).toThrow();
      const out = interp().interpolate({ config: { a: '${{ defer(pkg.x) }}' }, scope: scope() });
      expect(out.a).toBe('${{ pkg.x }}');
    });

    it('does not carry the mark into JSON or a toEqual diff', () => {
      const out = interp().interpolate({ config: { a: '${{ defer(pkg.x) }}' }, scope: scope() });
      expect(JSON.parse(JSON.stringify(out))).toEqual({ a: '${{ pkg.x }}' });
      expect(out).toEqual({ a: '${{ pkg.x }}' });
    });
  });

  describe('the file scope, when a scope provides one', () => {
    it('reads what a scope member answers', () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
      const out = interp().interpolate({
        config: { exec: "tsc -b ${{ file.exists('tsconfig.json') || 'none' }}" },
        scope: scope({
          file: { exists: (p: string) => (fs.existsSync(path.join(dir, p)) ? path.join(dir, p) : '') },
        }),
      });
      expect(out.exec).toBe(`tsc -b ${path.join(dir, 'tsconfig.json')}`);
    });
  });

  describe('the origin cursor is per instance', () => {
    /** It was a module variable, shared by every interpolation in the process. Per instance, a
     *  failed walk cannot leave its cursor behind for the next one. */
    it('does not leak an origin from one interpolation into another', () => {
      const first: Record<string, any> = { a: '${{ nope( }}' };
      Object.defineProperty(first, ORIGINS, { value: { a: '/repo/first.yml' } });
      expect(() => interp().interpolate({ config: first, scope: scope() })).toThrow(/first\.yml/);

      const second = interp();
      expect(() => second.interpolate({ config: { b: '${{ nope( }}' }, scope: scope() })).toThrow(
        /Invalid expression in "b": /,
      );
    });
  });
});
