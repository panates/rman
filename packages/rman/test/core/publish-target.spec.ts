import { expect } from 'expect';
import type { Package } from '../../src/core/classes/package.js';
import { declaredTargets, type PublishTarget, shipsTo } from '../../src/core/interfaces/publish-target.js';

/** **Self-contained: `shipsTo` is a function of a package and a target**, so a spec builds the two
 *  smallest objects that answer its questions and needs no repository. */
describe('core/shipsTo()', () => {
  /** Only `provider` (the platform's name) and `config.publish.target` are read. */
  function pkg(provider: string, target?: string | string[]): Package {
    return { provider, config: target === undefined ? {} : { publish: { target } } } as unknown as Package;
  }

  function publishTarget(name: string, extra: Partial<PublishTarget> = {}): PublishTarget {
    return {
      name,
      getPlan: async () => [],
      applyPlan: async () => [],
      ...extra,
    } as PublishTarget;
  }

  describe('a target that declares neither', () => {
    /** Opt-in, which is what `docker` is: most packages in a repository are not images. */
    it('claims nothing', () => {
      expect(shipsTo(pkg('node'), publishTarget('docker'))).toBe(false);
      expect(shipsTo(pkg('cargo'), publishTarget('docker'))).toBe(false);
    });
  });

  describe('platforms alone', () => {
    const npm = publishTarget('npm', { platforms: ['node'] });

    /** Belonging to one of them *is* the claim - the declarative form of what `claims` used to
     *  spell out as `pkg.provider === 'node'`. */
    it('claims a package of that technology', () => {
      expect(shipsTo(pkg('node'), npm)).toBe(true);
    });

    /**
     * **The bug this replaced.** The default used to be a hardcoded `['npm']` in the core, so
     * `rman list --json` reported `publishTargets: ["npm"]` for a Cargo package and `publish`
     * treated it as an npm candidate.
     */
    it('leaves a package of another technology alone', () => {
      expect(shipsTo(pkg('cargo'), npm)).toBe(false);
      expect(shipsTo(pkg(''), npm)).toBe(false);
    });

    it('takes several', () => {
      const both = publishTarget('t', { platforms: ['node', 'cargo'] });
      expect(shipsTo(pkg('node'), both)).toBe(true);
      expect(shipsTo(pkg('cargo'), both)).toBe(true);
      expect(shipsTo(pkg('maven'), both)).toBe(false);
    });
  });

  describe('platforms beside claims', () => {
    /** `platforms` narrows first, `claims` decides within what it let through. */
    const nodeImages = publishTarget('t', { platforms: ['node'], claims: (p: any) => p.hasDockerfile === true });

    it('asks claims only for a package the platforms let through', () => {
      const withFile = Object.assign(pkg('node'), { hasDockerfile: true });
      const without = Object.assign(pkg('node'), { hasDockerfile: false });
      const otherPlatform = Object.assign(pkg('cargo'), { hasDockerfile: true });

      expect(shipsTo(withFile, nodeImages)).toBe(true);
      expect(shipsTo(without, nodeImages)).toBe(false);
      expect(shipsTo(otherPlatform, nodeImages)).toBe(false);
    });

    /** The control: without the platform narrowing, `claims` alone would have taken the Cargo one. */
    it('control: claims alone would have claimed it', () => {
      const anyImage = publishTarget('t', { claims: (p: any) => p.hasDockerfile === true });
      expect(shipsTo(Object.assign(pkg('cargo'), { hasDockerfile: true }), anyImage)).toBe(true);
    });
  });

  describe('a package that declares its own target', () => {
    /**
     * **A declared `publish.target` is the last word**, and neither `platforms` nor `claims` is
     * asked after it - a package naming a target has said where it goes, whatever ecosystem it is.
     * This is the one place it parts from `CommandMetadata.platforms`, which is a hard limit.
     */
    it('ships there even against the target platforms', () => {
      const npm = publishTarget('npm', { platforms: ['node'] });
      expect(shipsTo(pkg('cargo', 'npm'), npm)).toBe(true);
    });

    it('does not ship anywhere it did not name', () => {
      const npm = publishTarget('npm', { platforms: ['node'] });
      expect(shipsTo(pkg('node', 'docker'), npm)).toBe(false);
    });

    it('takes a list', () => {
      const npm = publishTarget('npm', { platforms: ['node'] });
      expect(shipsTo(pkg('cargo', ['docker', 'npm']), npm)).toBe(true);
    });

    /** Declaring none is not the same as declaring an empty list - the second says "nowhere". */
    it('ships nowhere on an empty list', () => {
      const npm = publishTarget('npm', { platforms: ['node'] });
      expect(declaredTargets(pkg('node', []))).toEqual([]);
      expect(shipsTo(pkg('node', []), npm)).toBe(false);
    });
  });
});
