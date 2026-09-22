import { expect } from 'expect';
import { mergeConfig } from '../../src/core/merge-config.js';

describe('core/merge-config', () => {
  describe('mergeConfig()', () => {
    it('replaces a plain key and merges a nested object, as a deep merge always has', () => {
      const target = { group: true, publish: { target: ['npm'], skip: false } };
      mergeConfig(target, { group: false, publish: { skip: true } });
      expect(target).toEqual({ group: false, publish: { target: ['npm'], skip: true } });
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

    it('takes a bare `plugins` from a scalar too', () => {
      const target: Record<string, any> = { plugins: 'a' };
      mergeConfig(target, { plugins: 'b' });
      mergeConfig(target, { plugins: 'c' });
      expect(target).toEqual({ plugins: ['a', 'b', 'c'] });
    });

    /** A contribution key accumulates across layers, in the order they were merged - which is the
     *  whole of what `ALWAYS_APPEND` buys. Every *other* key replaces; a closer layer deriving from
     *  what it inherited asks for `value` instead. */
    it('accumulates a contribution key across layers, in the order they were merged', () => {
      const target: Record<string, any> = {};
      mergeConfig(target, { commands: ['a'] });
      mergeConfig(target, { commands: 'b' });
      mergeConfig(target, { commands: ['c', 'd'] });
      expect(target.commands).toEqual(['a', 'b', 'c', 'd']);
    });

    /**
     * **A retired `+key` is refused, not ignored**, and that is the whole difference between a
     * breaking change a repository can diagnose and one that changes its behaviour in silence.
     *
     * rman validates no config keys - there is no schema behind `.rmanrc` any more - so an unknown
     * key is simply dropped. Measured before the check: a consumer's `+include: ['extra']` resolved
     * to the inherited list unchanged, exactly as if the line were not there.
     */
    it('refuses a retired `+key`, naming what to write instead', () => {
      expect(() => mergeConfig({}, { '+before': ['x'] }, '/repo/.rmanrc.yml')).toThrow(
        /"\+before" is no longer a config key \(\/repo\/\.rmanrc\.yml\)/,
      );
      /** The message has to carry the replacement, or it only reports that something is wrong. */
      expect(() => mergeConfig({}, { '+before': ['x'] })).toThrow(/\[\.\.\.value, 'x'\]/);
    });

    /** A bare `+` names no key, so it is an ordinary key that happens to be punctuation - not an
     *  append anyone wrote, and not worth refusing. */
    it('leaves a bare `+` alone', () => {
      const target: Record<string, any> = {};
      mergeConfig(target, { '+': 'odd but harmless' });
      expect(target).toEqual({ '+': 'odd but harmless' });
    });

    /** And every other key replaces, which is the rule `+key` used to carve an exception out of. */
    it('replaces an ordinary list key rather than appending to it', () => {
      const target: Record<string, any> = { before: ['a'] };
      mergeConfig(target, { before: ['b'] });
      expect(target.before).toEqual(['b']);
    });
  });

  describe('immutability', () => {
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
