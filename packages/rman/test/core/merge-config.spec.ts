import { expect } from 'expect';
import { appendTarget, finalizeConfig, mergeConfig } from '../../src/core/merge-config.js';

describe('core/merge-config', () => {
  describe('appendTarget()', () => {
    it('names the key an append is aimed at', () => {
      expect(appendTarget('+before')).toBe('before');
      expect(appendTarget('before')).toBeUndefined();
      // Nothing to append to - a bare prefix names no key at all.
      expect(appendTarget('+')).toBeUndefined();
    });
  });

  describe('mergeConfig()', () => {
    it('replaces a plain key and merges a nested object, as a deep merge always has', () => {
      const target = { group: true, publish: { target: ['npm'], skip: false } };
      mergeConfig(target, { group: false, publish: { skip: true } });
      expect(target).toEqual({ group: false, publish: { target: ['npm'], skip: true } });
    });

    it('appends with `+key`, promoting either side from a scalar', () => {
      // The case a shared config can't live without: add a step without restating the base's list.
      const target = { before: 'rm ./build' };
      mergeConfig(target, { '+before': 'rm ./cache' });
      expect(target).toEqual({ before: ['rm ./build', 'rm ./cache'] });
    });

    it('appends `plugins` without being asked, since replacing is never what it would mean', () => {
      /** The silent failure this closes: a repository that `extends` a toolchain config and then
       *  names a plugin of its own used to *drop* the toolchain's, and what it noticed was
       *  `Unknown argument: publish`. */
      const target = { plugins: ['rman-node'] };
      mergeConfig(target, { plugins: ['./local-plugin.mjs'] });
      expect(target).toEqual({ plugins: ['rman-node', './local-plugin.mjs'] });
    });

    it('drops a `plugins` entry already there - two layers naming one plugin is the ordinary case', () => {
      const target = { plugins: ['rman-node'] };
      mergeConfig(target, { plugins: ['rman-node', 'other'] });
      expect(target).toEqual({ plugins: ['rman-node', 'other'] });
    });

    it('does not de-duplicate an explicit `+key`, which was written rather than inferred', () => {
      /** Asymmetric on purpose: `plugins` appends by itself, so a repeat is a consequence of the
       *  rule; a repeated `+before` is what the author actually typed. */
      const target = { before: ['echo x'] };
      mergeConfig(target, { '+before': 'echo x' });
      expect(target).toEqual({ before: ['echo x', 'echo x'] });
    });

    it('takes a bare `plugins` from a scalar too, and `+plugins` means nothing extra', () => {
      const target: Record<string, any> = { plugins: 'a' };
      mergeConfig(target, { plugins: 'b' });
      mergeConfig(target, { '+plugins': 'c' });
      expect(target).toEqual({ plugins: ['a', 'b', 'c'] });
    });

    it('accumulates across layers, in the order they were merged', () => {
      const target: Record<string, any> = {};
      mergeConfig(target, { before: ['a'] });
      mergeConfig(target, { '+before': 'b' });
      mergeConfig(target, { '+before': ['c', 'd'] });
      expect(target.before).toEqual(['a', 'b', 'c', 'd']);
    });

    it('keeps an append outstanding until something to append to turns up', () => {
      // The layer providing it may still be coming: a directory's own file forms are merged into
      // an empty object long before the selector blocks and parent directories they append to are.
      // Collapsing it here lost both of those.
      const target: Record<string, any> = {};
      mergeConfig(target, { '+before': 'mine' });
      expect(target).toEqual({ '+before': ['mine'] });

      // Two layers with nothing but appends accumulate, still outstanding.
      mergeConfig(target, { '+before': 'and mine' });
      expect(target).toEqual({ '+before': ['mine', 'and mine'] });

      // And the moment a plain value arrives, they land on it.
      const withBase: Record<string, any> = { before: 'inherited' };
      mergeConfig(withBase, target);
      expect(withBase).toEqual({ before: ['inherited', 'mine', 'and mine'] });
    });

    it('honors `key` and `+key` in the same object - replace first, then append', () => {
      const target = { before: ['inherited'] };
      mergeConfig(target, { before: 'mine', '+before': 'and also' });
      // The replacement wins over what was inherited; the append lands on top of *it*.
      expect(target).toEqual({ before: ['mine', 'and also'] });
    });

    it('ignores the prefix on an object, where merging is what it already does', () => {
      const target = { docker: { buildArgs: { A: '1' } } };
      mergeConfig(target, { '+docker': { buildArgs: { B: '2' } } });
      expect(target).toEqual({ docker: { buildArgs: { A: '1', B: '2' } } });
    });

    it('ignores the prefix on a scalar, which behaves as the plain key would', () => {
      const target = { group: 'dialects' };
      mergeConfig(target, { '+group': 'other' });
      expect(target).toEqual({ group: ['dialects', 'other'] });
    });
  });

  describe('finalizeConfig()', () => {
    it('turns an outstanding append into the value itself - nothing was inherited', () => {
      expect(finalizeConfig({ '+before': ['only'] })).toEqual({ before: ['only'] });
      expect(finalizeConfig({ run: { build: { '+before': 'only' } } })).toEqual({
        run: { build: { before: ['only'] } },
      });
    });

    it('leaves a config with no appends exactly as it is', () => {
      const config = { group: true, run: { build: { before: ['a'], exec: 'tsc' } } };
      expect(finalizeConfig(config)).toEqual(config);
    });

    it('folds an outstanding append onto a plain key declared alongside it', () => {
      expect(finalizeConfig({ before: 'a', '+before': ['b'] })).toEqual({ before: ['a', 'b'] });
    });

    it('leaves the source untouched - a base config is merged into many packages', () => {
      const source = { publish: { target: ['npm'] }, before: ['a'] };
      const a: Record<string, any> = {};
      const b: Record<string, any> = {};
      mergeConfig(a, source);
      mergeConfig(b, source);
      a.publish.target.push('docker');
      a.before.push('z');
      expect(source).toEqual({ publish: { target: ['npm'] }, before: ['a'] });
      expect(b).toEqual({ publish: { target: ['npm'] }, before: ['a'] });
    });
  });
});
