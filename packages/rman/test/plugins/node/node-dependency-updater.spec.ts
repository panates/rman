import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { NodeDependencyUpdater } from '../../../src/builtins/platforms/node/node-dependency-updater.js';
import type { NpmRelease, NpmReleases } from '../../../src/builtins/publish-targets/npm/npm-view.js';
import type { Repository } from '../../../src/core/classes/repository.js';
import { DependencyUpdater } from '../../../src/core/interfaces/dependency-updater.js';
import { createRepository, useNodeEcosystem } from './_fixture.js';

/**
 * A registry answered from a table rather than from `npm view` - the seam is `fetchReleases`,
 * so everything above it (the floors, the filters, the solving) is the real code.
 */
class FakeRegistryUpdater extends NodeDependencyUpdater {
  readonly calls: string[] = [];
  inFlight = 0;
  peak = 0;
  /** The Node a release is checked against, fixed - the suite runs on several, and an answer that
   *  moved with the machine would be a different test on each. */
  node = '24.15.0';

  constructor(
    readonly registry: Record<string, { latest?: string; releases: NpmRelease[]; time?: Record<string, string> }>,
  ) {
    super();
  }

  protected override runningNode(): string {
    return this.node;
  }

  protected override async fetchReleases(name: string, range: string): Promise<NpmReleases | undefined> {
    this.calls.push(`${name}@${range}`);
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    this.inFlight--;
    const known = this.registry[name];
    if (!known) return undefined;
    const latest = known.latest ?? known.releases[known.releases.length - 1]!.version;
    return { latest, releases: known.releases, time: known.time };
  }
}

function releases(...versions: (string | NpmRelease)[]): NpmRelease[] {
  return versions.map(v => (typeof v === 'string' ? { version: v } : v));
}

describe('plugins/node/NodeDependencyUpdater', () => {
  useNodeEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function writeJson(dir: string, rel: string, value: unknown): void {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, undefined, 2) + '\n');
  }

  /** A single-package repository whose one manifest is `manifest`. */
  function single(manifest: object, rmanrc: object = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-deps-'));
    dirs.push(dir);
    writeJson(dir, 'package.json', { name: 'app', version: '1.0.0', ...manifest });
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(rmanrc));
    return dir;
  }

  async function plan(
    dir: string,
    updater: NodeDependencyUpdater,
    options: Partial<DependencyUpdater.Options> = {},
  ): Promise<{ repository: Repository; entries: DependencyUpdater.Entry[] }> {
    const repository = await createRepository(dir);
    const ctx: DependencyUpdater.Context = {
      app: repository.app,
      repository,
      options: { concurrency: 4, ...options },
    };
    const packages = repository.monorepo ? [repository.rootPackage, ...repository.packages] : repository.packages;
    return { repository, entries: await updater.getPlan(ctx, packages) };
  }

  function entry(entries: DependencyUpdater.Entry[], name: string, pkg?: string): DependencyUpdater.Entry {
    const found = entries.find(e => e.name === name && (!pkg || e.package.name === pkg));
    if (!found) throw new Error(`no entry for ${name}`);
    return found;
  }

  describe('which ranges move', () => {
    it('moves a caret or tilde range to the newest version, keeping its prefix', async () => {
      const dir = single({ dependencies: { a: '^1.0.0' }, devDependencies: { b: '~2.1.0' } });
      const updater = new FakeRegistryUpdater({
        a: { releases: releases('1.0.0', '1.4.0', '2.0.0') },
        b: { releases: releases('2.1.0', '2.1.5', '2.2.0') },
      });
      const { entries } = await plan(dir, updater, { target: 'major' });
      expect(entry(entries, 'a')).toMatchObject({ status: 'update', target: '^2.0.0', bump: 'major' });
      expect(entry(entries, 'b')).toMatchObject({ status: 'update', target: '~2.2.0', bump: 'minor' });
    });

    /** The default is the largest move the scheme has - the rules below still decide what is taken. */
    it('crosses a major by default', async () => {
      const dir = single({ dependencies: { a: '^1.0.0' } });
      const updater = new FakeRegistryUpdater({ a: { releases: releases('1.0.0', '1.4.0', '2.0.0') } });
      const { entries } = await plan(dir, updater);
      expect(entry(entries, 'a')).toMatchObject({ status: 'update', target: '^2.0.0', bump: 'major' });
      expect(entry(entries, 'a').reason).toBeUndefined();
    });

    it('never crosses a major under deps.target: minor, and says what it left behind', async () => {
      const dir = single({ dependencies: { a: '^1.0.0', b: '^1.0.0' } }, { deps: { target: 'minor' } });
      const updater = new FakeRegistryUpdater({
        a: { releases: releases('1.0.0', '1.4.0', '2.0.0') },
        b: { releases: releases('1.0.0', '2.0.0') },
      });
      const { entries } = await plan(dir, updater);
      expect(entry(entries, 'a')).toMatchObject({
        status: 'update',
        target: '^1.4.0',
        bump: 'minor',
        available: '2.0.0',
        reason: 'major - deps.target is "minor"',
      });
      expect(entry(entries, 'b')).toMatchObject({
        status: 'skipped',
        available: '2.0.0',
        reason: 'major - deps.target is "minor"',
      });
    });

    it('counts a 0.x minor as a major, as a caret range does', async () => {
      const dir = single({ dependencies: { zero: '^0.1.0' } });
      const updater = new FakeRegistryUpdater({ zero: { releases: releases('0.1.0', '0.1.4', '0.2.0') } });
      const { entries } = await plan(dir, updater, { target: 'minor' });
      expect(entry(entries, 'zero')).toMatchObject({ status: 'update', target: '^0.1.4', available: '0.2.0' });
      const major = await plan(dir, updater);
      expect(entry(major.entries, 'zero')).toMatchObject({ status: 'update', target: '^0.2.0', bump: 'major' });
    });

    it('lets deps.targets give one dependency a target of its own, the last matching glob winning', async () => {
      const dir = single(
        { dependencies: { '@types/node': '^22.0.0', '@types/react': '^18.0.0', zero: '^0.1.0' } },
        { deps: { targets: { '@types/*': 'major', '@types/react': 'patch', zero: 'major' } } },
      );
      const updater = new FakeRegistryUpdater({
        '@types/node': { releases: releases('22.0.0', '24.1.0') },
        '@types/react': { releases: releases('18.0.0', '18.0.5', '18.3.0', '19.0.0') },
        zero: { releases: releases('0.1.0', '0.3.0') },
      });
      const { entries } = await plan(dir, updater);
      expect(entry(entries, '@types/node')).toMatchObject({ status: 'update', target: '^24.1.0' });
      expect(entry(entries, '@types/react')).toMatchObject({
        status: 'update',
        target: '^18.0.5',
        available: '19.0.0',
        reason: 'major - deps.targets["@types/react"] is "patch"',
      });
      expect(entry(entries, 'zero')).toMatchObject({ status: 'update', target: '^0.3.0' });

      const cli = await plan(dir, updater, { target: 'minor' });
      expect(entry(cli.entries, '@types/node')).toMatchObject({ status: 'skipped' });
    });

    it('refuses a deps.targets size the version scheme does not have', async () => {
      const dir = single({ dependencies: { a: '^1.0.0' } }, { deps: { targets: { a: 'latest' } } });
      await expect(plan(dir, new FakeRegistryUpdater({}))).rejects.toThrow(/deps\.targets.*"latest"/);
    });

    /**
     * **Never moved, but listed when something newer is out**, as a `skipped` row. Left out of the
     * table entirely, `"mocha": "11.7.5"` on `panates/hl7v2` read as up to date with 12.x out. A tag
     * and a URL are not version ranges, so there is nothing to compare and no row.
     */
    it('lists an exact version and a compound range a newer release falls outside, without moving them', async () => {
      const dir = single({
        dependencies: { pinned: '1.0.0', compound: '>=1 <2', tagged: 'latest', remote: 'github:x/y' },
      });
      const updater = new FakeRegistryUpdater({
        pinned: { releases: releases('1.0.0', '2.0.0') },
        compound: { releases: releases('1.0.0', '2.0.0') },
      });
      const { entries } = await plan(dir, updater);
      expect(entries.map(e => e.name).sort()).toEqual(['compound', 'pinned']);
      expect(entry(entries, 'pinned')).toMatchObject({
        status: 'skipped',
        current: '1.0.0',
        latest: '2.0.0',
        reason: expect.stringMatching(/not a \^ or ~ range/),
      });
      expect(entry(entries, 'compound')).toMatchObject({ status: 'skipped', current: '>=1 <2' });
    });

    /** Node's own lookup: the first `node_modules/<name>` walking up, so a hoisted copy counts. */
    it('reports the version installed now, and none for one that is not', async () => {
      const dir = single({ dependencies: { a: '^1.0.0', b: '^1.0.0' } });
      writeJson(dir, 'node_modules/a/package.json', { name: 'a', version: '1.0.4' });
      const updater = new FakeRegistryUpdater({
        a: { releases: releases('1.0.0', '1.1.0') },
        b: { releases: releases('1.0.0', '1.1.0') },
      });
      const { entries } = await plan(dir, updater);
      expect(entry(entries, 'a').installed).toBe('1.0.4');
      /** And what an install would put there - the newest release the declared range takes. */
      expect(entry(entries, 'a').resolved).toBe('1.1.0');
      expect(entry(entries, 'a').installedInRange).toBe(true);
      expect(entry(entries, 'b').installedInRange).toBeUndefined();
      expect(entry(entries, 'b').installed).toBeUndefined();
    });

    it('leaves out a fixed range that still takes the newest release', async () => {
      const dir = single({ dependencies: { pinned: '2.0.0', compound: '>=1 <3' } });
      const updater = new FakeRegistryUpdater({
        pinned: { releases: releases('1.0.0', '2.0.0') },
        compound: { releases: releases('1.0.0', '2.0.0') },
      });
      const { entries } = await plan(dir, updater);
      expect(entries).toEqual([]);
    });

    it('never offers a deprecated version, a prerelease, or one above the latest tag', async () => {
      const dir = single({ dependencies: { a: '^1.0.0' } });
      const updater = new FakeRegistryUpdater({
        a: {
          latest: '1.2.0',
          releases: releases('1.0.0', '1.2.0', { version: '1.3.0', deprecated: 'broken' }, '1.4.0-beta.1', '1.5.0'),
        },
      });
      const { entries } = await plan(dir, updater);
      expect(entry(entries, 'a')).toMatchObject({ status: 'update', target: '^1.2.0' });
    });

    it('stays inside the major under target "minor", and inside the minor under "patch"', async () => {
      const dir = single({ dependencies: { a: '^1.2.0', b: '^1.2.0' } }, { '[*]': { deps: { target: 'patch' } } });
      const updater = new FakeRegistryUpdater({
        a: { releases: releases('1.2.0', '1.2.9', '1.3.0', '2.0.0') },
        b: { releases: releases('1.2.0', '1.2.9', '1.3.0', '2.0.0') },
      });
      const config = await plan(dir, updater);
      expect(entry(config.entries, 'a')).toMatchObject({ target: '^1.2.9' });
      const cli = await plan(dir, updater, { target: 'minor' });
      expect(entry(cli.entries, 'a')).toMatchObject({ target: '^1.3.0' });
    });

    it('only offers a version older than deps.minAge', async () => {
      const dir = single({ dependencies: { a: '^1.0.0' } }, { deps: { minAge: 3 } });
      const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      const updater = new FakeRegistryUpdater({
        a: {
          releases: releases('1.0.0', '1.1.0', '1.2.0'),
          time: { '1.0.0': ago(30), '1.1.0': ago(5), '1.2.0': ago(1) },
        },
      });
      const { entries } = await plan(dir, updater);
      expect(entry(entries, 'a')).toMatchObject({ status: 'update', target: '^1.1.0', latest: '1.1.0' });
    });

    it('skips a rejected name and plans only the names asked for', async () => {
      const dir = single({ dependencies: { a: '^1.0.0', b: '^1.0.0', c: '^1.0.0' } }, { deps: { reject: ['c'] } });
      const registry = {
        a: { releases: releases('1.0.0', '1.1.0') },
        b: { releases: releases('1.0.0', '1.1.0') },
        c: { releases: releases('1.0.0', '1.1.0') },
      };
      const all = await plan(dir, new FakeRegistryUpdater(registry));
      expect(all.entries.map(e => e.name).sort()).toEqual(['a', 'b']);
      const named = await plan(dir, new FakeRegistryUpdater(registry), { names: ['b'] });
      expect(named.entries.map(e => e.name)).toEqual(['b']);
    });

    it('reports a name the registry does not answer for as an error', async () => {
      const dir = single({ dependencies: { gone: '^1.0.0' } });
      const { entries } = await plan(dir, new FakeRegistryUpdater({}));
      expect(entry(entries, 'gone')).toMatchObject({ status: 'error' });
    });
  });

  /**
   * **A rule the other side cannot meet holds back the side stating it, and only that side.**
   * Measured on `abisena/syncbridge-iomt`: `builtins@0.14.13` needs `common ^0.14.0`, which
   * `target: minor` leaves out (a 0.x minor is a major). `common`'s own `0.13.9` was dropped for it,
   * then `builtins` stepped back as well, and both read "not updated" - with `common` blamed on a
   * move that never happened.
   */
  it('moves the side a rule is about as far as it may, and holds back the side whose rule it cannot meet', async () => {
    const dir = single({ dependencies: { common: '^0.13.7', builtins: '^0.14.12' } }, { deps: { target: 'minor' } });
    const updater = new FakeRegistryUpdater({
      common: { releases: releases('0.13.7', '0.13.9', '0.14.0') },
      builtins: {
        releases: releases(
          { version: '0.14.12', peerDependencies: { common: '^0.13.0' } },
          { version: '0.14.13', peerDependencies: { common: '^0.14.0' } },
        ),
      },
    });
    const { entries } = await plan(dir, updater);

    expect(entry(entries, 'common')).toMatchObject({ status: 'update', target: '^0.13.9', available: '0.14.0' });
    const builtins = entry(entries, 'builtins');
    expect(builtins).toMatchObject({ status: 'held', latest: '0.14.13' });
    expect(builtins.reason).toBe(
      '0.14.13 refused: builtins@0.14.13 needs common ^0.14.0 (common@0.14.0: major - deps.target is "minor")',
    );
  });

  /** Under `target: major`, so a rule is what holds a version back and not the size of the move. */
  describe('rules another declaration states', () => {
    it("holds a version back that another dependency's peer range refuses, and names the rule", async () => {
      const dir = single({ devDependencies: { typescript: '^5.3.0', parser: '^8.40.0' } });
      const updater = new FakeRegistryUpdater({
        typescript: { releases: releases('5.3.0', '5.9.3', '6.0.0') },
        parser: { releases: releases({ version: '8.40.0', peerDependencies: { typescript: '>=4.8.4 <6.0.0' } }) },
      });
      const { entries } = await plan(dir, updater, { target: 'major' });
      const ts = entry(entries, 'typescript');
      expect(ts).toMatchObject({ status: 'update', target: '^5.9.3', latest: '6.0.0' });
      expect(ts.reason).toContain('parser@8.40.0 needs typescript >=4.8.4 <6.0.0');
    });

    it('takes both sides when the newer peer range allows the newer version', async () => {
      const dir = single({ devDependencies: { typescript: '^5.3.0', parser: '^8.40.0' } });
      const updater = new FakeRegistryUpdater({
        typescript: { releases: releases('5.3.0', '6.0.0') },
        parser: {
          releases: releases(
            { version: '8.40.0', peerDependencies: { typescript: '>=4.8.4 <6.0.0' } },
            { version: '8.50.0', peerDependencies: { typescript: '>=4.8.4 <6.1.0' } },
          ),
        },
      });
      const { entries } = await plan(dir, updater, { target: 'major' });
      expect(entry(entries, 'typescript')).toMatchObject({ status: 'update', target: '^6.0.0' });
      expect(entry(entries, 'parser')).toMatchObject({ status: 'update', target: '^8.50.0' });
    });

    it('steps the side stating the range down when the side it is about cannot move', async () => {
      const dir = single({ devDependencies: { typescript: '5.9.3', parser: '^8.40.0' } });
      const updater = new FakeRegistryUpdater({
        typescript: { releases: releases('5.9.3', '6.0.0') },
        parser: {
          releases: releases(
            { version: '8.40.0', peerDependencies: { typescript: '<6' } },
            { version: '8.45.0', peerDependencies: { typescript: '<6' } },
            { version: '8.50.0', peerDependencies: { typescript: '>=6' } },
          ),
        },
      });
      const { entries } = await plan(dir, updater, { target: 'major' });
      const parser = entry(entries, 'parser');
      expect(parser).toMatchObject({ status: 'update', target: '^8.45.0', latest: '8.50.0' });
      expect(parser.reason).toContain('8.50.0 refused: parser@8.50.0 needs typescript >=6');
    });

    it("holds a dependency where the package's own peer range for it does not move", async () => {
      const dir = single({ devDependencies: { react: '^18.2.0' }, peerDependencies: { react: '>=18 <19' } });
      const updater = new FakeRegistryUpdater({ react: { releases: releases('18.2.0', '18.3.1', '19.0.0') } });
      const { entries } = await plan(dir, updater, { target: 'major' });
      const react = entry(entries, 'react');
      expect(react).toMatchObject({ status: 'update', target: '^18.3.1' });
      expect(react.reason).toContain('app declares react >=18 <19 in peerDependencies');
    });

    it('moves every field declaring a name together', async () => {
      const dir = single({ devDependencies: { react: '^18.2.0' }, peerDependencies: { react: '^18.0.0' } });
      const updater = new FakeRegistryUpdater({ react: { releases: releases('18.0.0', '18.2.0', '19.0.0') } });
      const { repository, entries } = await plan(dir, updater, { target: 'major' });
      expect(entry(entries, 'react')).toMatchObject({ status: 'update', target: '^19.0.0' });

      const ctx = { app: repository.app, repository, options: { concurrency: 1 } };
      await updater.applyPlan(ctx, entries);
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      expect(written.devDependencies.react).toBe('^19.0.0');
      expect(written.peerDependencies.react).toBe('^19.0.0');
    });

    it('holds a version whose engines.node leaves out the Node rman runs on', async () => {
      const dir = single({ dependencies: { a: '^1.0.0' } });
      const updater = new FakeRegistryUpdater({
        a: { releases: releases('1.0.0', { version: '1.1.0', engines: { node: '>=22' } }) },
      });
      updater.node = '20.19.0';
      const { entries } = await plan(dir, updater, { target: 'major' });
      const a = entry(entries, 'a');
      expect(a).toMatchObject({ status: 'held', latest: '1.1.0' });
      expect(a.reason).toContain('a@1.1.0 needs node >=22, this is node 20.19.0');
    });

    /** Reported on `panates/peacox-ui`: jsdom 30 leaves Node 25 out, the package's `engines` takes
     *  it in, and the old rule - every Node the package supports - held the upgrade on a machine
     *  running 24.15.0, where it installs. A gap in the range is not this Node's problem. */
    it("takes a version whose engines.node has a gap the running Node is not in, whatever the package's engines say", async () => {
      const dir = single({ engines: { node: '>=22' }, devDependencies: { jsdom: '^29.1.1' } });
      const updater = new FakeRegistryUpdater({
        jsdom: {
          releases: releases(
            { version: '29.1.1', engines: { node: '^20.19.0 || ^22.13.0 || >=24.0.0' } },
            { version: '30.1.3', engines: { node: '^22.22.2 || ^24.15.0 || >=26.0.0' } },
          ),
        },
      });
      const { entries } = await plan(dir, updater, { target: 'major' });
      expect(entry(entries, 'jsdom')).toMatchObject({ status: 'update', target: '^30.1.3' });

      /** The same release, on the Node it leaves out. */
      updater.node = '25.2.0';
      const held = entry((await plan(dir, updater, { target: 'major' })).entries, 'jsdom');
      expect(held).toMatchObject({ status: 'held' });
      expect(held.reason).toContain('jsdom@30.1.3 needs node ^22.22.2 || ^24.15.0 || >=26.0.0, this is node 25.2.0');
    });

    /** The second question: a range with *nothing* in common with the package's own `engines` is
     *  refused even where the running Node takes it - a gap would not be, which the case above pins. */
    it("holds a version whose engines.node shares no Node with the package's engines", async () => {
      const dir = single({ engines: { node: '^20' }, dependencies: { a: '^1.0.0' } });
      const updater = new FakeRegistryUpdater({
        a: {
          releases: releases(
            { version: '1.0.0', engines: { node: '>=20' } },
            { version: '1.1.0', engines: { node: '>=22' } },
          ),
        },
      });
      const { entries } = await plan(dir, updater, { target: 'major' });
      const a = entry(entries, 'a');
      expect(a).toMatchObject({ status: 'held', latest: '1.1.0' });
      expect(a.reason).toContain('a@1.1.0 needs node >=22, none of which app supports (^20)');

      /** One Node in common is enough. */
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          engines: { node: '^20 || ^22' },
          dependencies: { a: '^1.0.0' },
        }),
      );
      expect(entry((await plan(dir, updater, { target: 'major' })).entries, 'a')).toMatchObject({ status: 'update' });
    });

    /** `eslint ^9` needs `^18.18.0`: on an older 18 the 9.x installed today does not run either, so
     *  a newer 9.x is no worse - only a release that stops working where the current one works is
     *  refused. */
    it('does not hold a version to a Node the current version already leaves out', async () => {
      const dir = single({ devDependencies: { a: '^1.0.0' } });
      const updater = new FakeRegistryUpdater({
        a: {
          releases: releases(
            { version: '1.0.0', engines: { node: '^18.18.0 || >=20' } },
            { version: '1.1.0', engines: { node: '^18.18.0 || >=20' } },
            { version: '1.2.0', engines: { node: '>=20' } },
          ),
        },
      });
      updater.node = '18.12.0';
      const { entries } = await plan(dir, updater, { target: 'major' });
      expect(entry(entries, 'a')).toMatchObject({ status: 'update', target: '^1.2.0' });

      /** On 18.18, where 1.0.0 runs, 1.2.0 would stop it: held, and 1.1.0 taken instead. */
      updater.node = '18.18.0';
      const a = entry((await plan(dir, updater, { target: 'major' })).entries, 'a');
      expect(a).toMatchObject({ status: 'update', target: '^1.1.0', latest: '1.2.0' });
      expect(a.reason).toContain('a@1.2.0 needs node >=20, this is node 18.18.0');
    });

    it("holds a version a sibling package's peer range refuses", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-deps-mono-'));
      dirs.push(dir);
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/lib/package.json', {
        name: 'lib',
        version: '1.0.0',
        peerDependencies: { q: '>=2 <3' },
      });
      writeJson(dir, 'packages/app/package.json', {
        name: 'app',
        version: '1.0.0',
        dependencies: { lib: '^1.0.0' },
        devDependencies: { q: '^2.1.0' },
      });
      const updater = new FakeRegistryUpdater({ q: { releases: releases('2.1.0', '2.4.0', '3.0.0') } });
      const { entries } = await plan(dir, updater, { target: 'major' });
      const q = entry(entries, 'q', 'app');
      expect(q).toMatchObject({ status: 'update', target: '^2.4.0' });
      expect(q.reason).toContain('lib needs q >=2 <3');
    });
  });

  describe('asking the registry', () => {
    it('asks once per name however many packages declare it, from the lowest floor', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-deps-mono-'));
      dirs.push(dir);
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      for (const [name, range] of [
        ['p1', '^1.2.0'],
        ['p2', '^1.0.0'],
        ['p3', '^1.5.0'],
      ]) {
        writeJson(dir, `packages/${name}/package.json`, { name, version: '1.0.0', dependencies: { a: range } });
      }
      const updater = new FakeRegistryUpdater({ a: { releases: releases('1.0.0', '1.2.0', '1.5.0', '1.6.0') } });
      const { entries } = await plan(dir, updater);
      expect(updater.calls).toEqual(['a@>=1.0.0']);
      expect(entries.filter(e => e.status === 'update').map(e => e.target)).toEqual(['^1.6.0', '^1.6.0', '^1.6.0']);
    });

    it('runs the lookups in parallel, never more than the concurrency at once', async () => {
      const names = Array.from({ length: 12 }, (_, i) => `n${i}`);
      const dir = single({ dependencies: Object.fromEntries(names.map(n => [n, '^1.0.0'])) });
      const updater = new FakeRegistryUpdater(Object.fromEntries(names.map(n => [n, { releases: releases('1.0.0') }])));
      await plan(dir, updater, { concurrency: 4 });
      expect(updater.calls.length).toBe(12);
      expect(updater.peak).toBe(4);
    });
  });

  /**
   * What `deps -u` holds back when npm refuses the written manifests. The refusal is the one measured
   * on `panates/syncbridge-cloud`: `@hookform/resolvers@6.0.0` cannot be installed by npm anywhere,
   * since its own optional peers ask for `effect ^4` and, through `@typeschema/main`, `effect ^3`.
   */
  describe('blame', () => {
    const ERESOLVE = [
      '  code ERESOLVE',
      '  ERESOLVE unable to resolve dependency tree',
      '  While resolving: app@1.0.0',
      '  Found: effect@3.22.3',
      '  node_modules/effect',
      '    peerOptional effect@"^3.6.5" from @typeschema/effect@0.14.0',
      '      peerOptional @typeschema/main@">=0.13.7" from @hookform/resolvers@6.0.0',
      '        node_modules/@hookform/resolvers',
      '          @hookform/resolvers@"^6.0.0" from app@1.0.0',
      '    peer a@"^1.0.0" from b@2.0.0',
      '  Could not resolve dependency:',
      '  peerOptional effect@"^4.0.0" from @hookform/resolvers@6.0.0',
      '  node_modules/@hookform/resolvers',
    ].join('\n');

    async function planned() {
      const dir = single({ dependencies: { '@hookform/resolvers': '^5.9.2', a: '^1.0.0', b: '^1.0.0' } });
      const updater = new FakeRegistryUpdater({
        '@hookform/resolvers': { releases: releases('5.9.2', '6.0.0') },
        a: { releases: releases('1.0.0', '1.1.0') },
        b: { releases: releases('1.0.0', '2.0.0') },
      });
      const { entries } = await plan(dir, updater, { target: 'major' });
      return { updater, entries };
    }

    it('holds the move npm names under "Could not resolve dependency:" and no other', async () => {
      const { updater, entries } = await planned();
      const blamed = updater.blame(ERESOLVE, entries);
      expect(blamed.map(b => b.entry.name)).toEqual(['@hookform/resolvers']);
      expect(blamed[0]!.reason).toBe(
        'npm cannot install it: peerOptional effect@"^4.0.0" from @hookform/resolvers@6.0.0',
      );
    });

    /** `b@2.0.0` is mentioned only on the way, and a name at a version nothing moved to is no
     *  evidence at all - `effect@3.22.3` is what is installed. */
    it('falls back to every move the output names at its new version', async () => {
      const { updater, entries } = await planned();
      const withoutVerdict = ERESOLVE.split('\n').slice(0, -3).join('\n');
      const blamed = updater.blame(withoutVerdict, entries);
      expect(blamed.map(b => b.entry.name).sort()).toEqual(['@hookform/resolvers', 'b']);
    });

    /** npm's verdict names a manifest's own dependency by its declared range, not a version -
     *  measured on `abisena/syncbridge-iomt`. Only that move is held, with what it conflicts with. */
    it('reads the verdict\'s `name@"range"` form, and holds only the move it names', async () => {
      const dir = single({ devDependencies: { tool: '^1.0.4', helper: '^1.1.1' } });
      const updater = new FakeRegistryUpdater({
        tool: { releases: releases('1.0.4', '2.2.0') },
        helper: { releases: releases('1.1.1', '2.0.0') },
      });
      const { entries } = await plan(dir, updater, { target: 'major' });
      const refusal = [
        '  While resolving: app@1.0.0',
        '  Found: tool@1.0.4',
        '    dev tool@"^2.2.0" from the root project',
        '  Could not resolve dependency:',
        '  dev tool@"^2.2.0" from the root project',
        '  Conflicting peer dependency: common@2.0.1',
        '    peer common@"^2.0.1" from tool@2.2.0',
      ].join('\n');
      const blamed = updater.blame(refusal, entries);
      expect(blamed.map(b => b.entry.name)).toEqual(['tool']);
      expect(blamed[0]!.reason).toBe(
        'npm cannot install it: dev tool@"^2.2.0" from the root project - Conflicting peer dependency: common@2.0.1',
      );
    });

    it('blames nothing when no move appears at its new version', async () => {
      const { updater, entries } = await planned();
      expect(updater.blame('  ERESOLVE unable to resolve dependency tree\n  from b@2.0.01', entries)).toEqual([]);
    });
  });

  /**
   * **pnpm is asked too**, through `pnpm install --dry-run --strict-peer-dependencies`. The report
   * below is the one pnpm 12.10.1 printed for `typescript@^7` beside `@typescript-eslint/parser@8.40.0`,
   * whose peer range stops below 6 - trimmed of the dry run's package list, workspace-indented as it
   * comes from a member.
   */
  describe('verify with pnpm', () => {
    const PEER_ISSUES = [
      'Dry run complete. A real install would make the following changes (nothing was written to disk):',
      '[ERR_PNPM_PEER_DEP_ISSUES] Unmet peer dependencies',
      '',
      'packages/a',
      '  ✕ unmet peer typescript',
      '    Installed: 7.0.2',
      '    Wanted:',
      '      ">=4.8.4 <6.0.0":',
      '        @typescript-eslint/parser@8.40.0',
      '        @typescript-eslint/typescript-estree@8.40.0',
      'hint: To disable failing on peer dependency issues, add the following to pnpm-workspace.yaml in your project root:',
    ].join('\n');

    /** pnpm answered from a script, and every call it was asked recorded. */
    class FakePnpmUpdater extends FakeRegistryUpdater {
      readonly asked: string[] = [];
      constructor(
        registry: ConstructorParameters<typeof FakeRegistryUpdater>[0],
        readonly answers: {
          version?: string;
          install?: { code: number; stdout: string };
          /** What `pnpm config get <key> --json` prints - a release age of 0 unless a case says. */
          config?: Record<string, unknown>;
        },
      ) {
        super(registry);
      }
      protected override async pnpm(_ctx: DependencyUpdater.Context, args: string) {
        this.asked.push(args);
        if (args === '--version') return { code: 0, stdout: `${this.answers.version ?? '12.10.1'}\n` };
        const key = /^config get (\S+) --json$/.exec(args)?.[1];
        if (key) {
          const config = this.answers.config ?? { minimumReleaseAge: 0 };
          return { code: 0, stdout: JSON.stringify(config[key] ?? null) + '\n' };
        }
        return this.answers.install ?? { code: 0, stdout: '' };
      }
    }

    /** A pnpm-locked repository whose plan moves the parser to 8.40.0 and, unless `typescript` says
     *  it is already there, typescript to 7.0.2 - written, so `verify` sees what `deps -u` would leave
     *  on disk. */
    async function written(answers: FakePnpmUpdater['answers'], typescript = '^5.9.0') {
      const dir = single({ devDependencies: { typescript, '@typescript-eslint/parser': '^8.0.0' } });
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
      const updater = new FakePnpmUpdater(
        {
          typescript: { releases: releases('5.9.0', '7.0.2') },
          '@typescript-eslint/parser': { releases: releases('8.0.0', '8.40.0') },
        },
        answers,
      );
      const { repository, entries } = await plan(dir, updater, { target: 'major' });
      const ctx: DependencyUpdater.Context = { app: repository.app, repository, options: { concurrency: 4 } };
      await updater.applyPlan(ctx, entries);
      /** The plan asked pnpm for its release age; `verify`'s own questions are what a case reads. */
      updater.asked.length = 0;
      return { updater, entries, ctx };
    }

    /** `console.error` collected rather than printed, for the "Not verified" note. */
    async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; notes: string[] }> {
      const original = console.error;
      const notes: string[] = [];
      console.error = (...args: unknown[]) => void notes.push(args.join(' '));
      try {
        return { result: await fn(), notes };
      } finally {
        console.error = original;
      }
    }

    it('asks pnpm with strict peers, and passes when it installs', async () => {
      const { updater, ctx } = await written({});
      expect(await updater.verify(ctx)).toBeUndefined();
      expect(updater.asked).toEqual(['--version', 'install --dry-run --strict-peer-dependencies --ignore-scripts']);
    });

    /** Below 11.8 `install` has no `--dry-run`, and nothing about an older pnpm was measured. */
    it('does not ask a pnpm older than 11.8, and says so', async () => {
      const { updater, ctx } = await written({ version: '11.7.2' });
      const { result, notes } = await quietly(() => updater.verify(ctx));
      expect(result).toBeUndefined();
      expect(updater.asked).toEqual(['--version']);
      expect(notes.join('\n')).toContain('pnpm 11.7.2 has no dry-run install - it needs pnpm 11.8.0');
    });

    it('refuses on a peer issue one of the moves is part of, and holds the peer', async () => {
      const { updater, entries, ctx } = await written({ install: { code: 1, stdout: PEER_ISSUES } });
      const refusal = await updater.verify(ctx);
      expect(refusal).toContain('✕ unmet peer typescript');
      expect(refusal).not.toContain('Dry run complete');
      /** Both moved: the peer outgrowing its requirer is the one to hold. */
      const blamed = updater.blame(refusal!, entries);
      expect(blamed.map(b => b.entry.name)).toEqual(['typescript']);
      expect(blamed[0]!.reason).toBe(
        'pnpm cannot install it: unmet peer typescript (found 7.0.2), wanted ">=4.8.4 <6.0.0" by @typescript-eslint/parser@8.40.0',
      );
    });

    /** typescript was already on 7, so the parser moving to 8.40.0 is what changed. */
    it('holds the requirer when the peer did not move', async () => {
      const { updater, entries } = await written({}, '^7.0.2');
      expect(entries.filter(e => e.status === 'update').map(e => e.name)).toEqual(['@typescript-eslint/parser']);
      expect(updater.blame(PEER_ISSUES, entries).map(b => b.entry.name)).toEqual(['@typescript-eslint/parser']);
    });

    /** Strict is stricter than the repository, which has lived with its peer warnings. Counted, a
     *  repository carrying one could never upgrade anything. */
    it("lets through a peer issue none of the moves is part of - the repository's own", async () => {
      const unrelated = PEER_ISSUES.replace('typescript\n', 'react\n')
        .replace('Installed: 7.0.2', 'Installed: 19.0.0')
        .replace(/@typescript-eslint\/[a-z-]+@8\.40\.0/g, 'old-widget@1.0.0');
      const { updater, ctx } = await written({ install: { code: 1, stdout: unrelated } });
      expect(await updater.verify(ctx)).toBeUndefined();
    });

    it("refuses on any other failure, with pnpm's own error lines", async () => {
      const stdout = '+ typescript@7.0.2\n[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for typescript@^9\n';
      const { updater, entries, ctx } = await written({ install: { code: 1, stdout } });
      const refusal = await updater.verify(ctx);
      expect(refusal).toBe('  [ERR_PNPM_NO_MATCHING_VERSION] No matching version found for typescript@^9');
      /** Nothing to pin it on, so the command puts every write back. */
      expect(updater.blame(refusal!, entries)).toEqual([]);
    });

    /** opra's shape: an unquoted range, which pnpm writes for one with no space in it. Read as
     *  anything else it ended the issue before the requirer, and nothing could be held for it. */
    it('reads a range pnpm leaves unquoted', async () => {
      const unquoted = PEER_ISSUES.replace('">=4.8.4 <6.0.0":', '^5.112.0:');
      const { updater, entries } = await written({}, '^7.0.2');
      const blamed = updater.blame(unquoted, entries);
      expect(blamed.map(b => b.entry.name)).toEqual(['@typescript-eslint/parser']);
      expect(blamed[0]!.reason).toContain('wanted ^5.112.0 by @typescript-eslint/parser@8.40.0');
    });

    /**
     * **pnpm's release age is the default, so `deps -u` writes nothing pnpm would exempt.** Measured
     * on `panates/opra`: with `deps.minAge` at 0, `deps -u` wrote `@nestjs/common@12.3.2` (21 hours
     * old) and a plain `pnpm install` added it to `minimumReleaseAgeExclude` without asking.
     */
    describe("pnpm's minimumReleaseAge", () => {
      const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
      const registry = {
        a: {
          releases: releases('1.0.0', '1.1.0', '1.2.0'),
          time: { '1.0.0': ago(24 * 30), '1.1.0': ago(30), '1.2.0': ago(21) },
        },
      };

      async function pnpmPlan(
        answers: FakePnpmUpdater['answers'],
        rmanrc: object = {},
        options: Partial<DependencyUpdater.Options> = {},
      ) {
        const dir = single({ dependencies: { a: '^1.0.0' } }, rmanrc);
        fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
        const updater = new FakePnpmUpdater(registry, answers);
        const { entries } = await plan(dir, updater, options);
        return { updater, a: entry(entries, 'a') };
      }

      it("holds a release younger than pnpm's default, and says why", async () => {
        /** `pnpm config get` answers null for the default - it is the one value that cannot be asked. */
        const { a } = await pnpmPlan({ config: {} });
        expect(a).toMatchObject({ status: 'update', target: '^1.1.0', latest: '1.1.0', available: '1.2.0' });
        expect(a.reason).toBe("published 21 hour(s) ago - pnpm's minimumReleaseAge is 1440 minutes");
      });

      it('reads the age pnpm is configured with, in minutes', async () => {
        const { a } = await pnpmPlan({ config: { minimumReleaseAge: 60 * 40 } });
        expect(a).toMatchObject({ status: 'skipped', available: '1.2.0' });
        expect(a.reason).toBe("published 21 hour(s) ago - pnpm's minimumReleaseAge is 2400 minutes");
      });

      it('lets in what minimumReleaseAgeExclude names, by name or by version', async () => {
        const byVersion = await pnpmPlan({ config: { minimumReleaseAgeExclude: ['a@1.2.0'] } });
        expect(byVersion.a).toMatchObject({ target: '^1.2.0' });
        const byGlob = await pnpmPlan({ config: { minimumReleaseAgeExclude: ['@other/*', 'a'] } });
        expect(byGlob.a).toMatchObject({ target: '^1.2.0' });
        const other = await pnpmPlan({ config: { minimumReleaseAgeExclude: ['a@1.1.5 || 1.1.9'] } });
        expect(other.a).toMatchObject({ target: '^1.1.0' });
      });

      it('gives way to deps.minAge and --min-age, which someone decided', async () => {
        const configured = await pnpmPlan({ config: {} }, { deps: { minAge: 0.5 } });
        expect(configured.a).toMatchObject({ target: '^1.2.0' });
        expect(configured.updater.asked).toEqual([]);
        const flag = await pnpmPlan({ config: {} }, {}, { minAge: 0 });
        expect(flag.a).toMatchObject({ target: '^1.2.0' });
      });

      it('has no age before pnpm 11, whose default was none', async () => {
        const { a } = await pnpmPlan({ version: '10.20.0', config: {} });
        expect(a).toMatchObject({ target: '^1.2.0' });
      });
    });

    /** opra installs with pnpm and sets `packageManager.node: npm` so `rman publish` keeps npm's
     *  provenance; `verify` asked npm, which cannot read `workspace:^`, and every upgrade went back. */
    it('asks the package manager the lockfile belongs to, whatever packageManager.node says', async () => {
      const dir = single({ devDependencies: { typescript: '^5.9.0' } }, { packageManager: { node: 'npm' } });
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
      const updater = new FakePnpmUpdater({ typescript: { releases: releases('5.9.0', '5.9.3') } }, {});
      const { repository } = await plan(dir, updater);
      updater.asked.length = 0;
      const ctx: DependencyUpdater.Context = { app: repository.app, repository, options: { concurrency: 4 } };
      expect(await updater.verify(ctx)).toBeUndefined();
      expect(updater.asked).toEqual(['--version', 'install --dry-run --strict-peer-dependencies --ignore-scripts']);
    });
  });

  /**
   * **An npm alias moves, under the package it names** - measured missing on
   * `abisena/syncbridge-iomt`: a dev `npm:@sbext/syncbridge__hl7@^2.0.0` beside a peer `^2.0.0` was
   * never listed, and the peer was asked of `@syncbridge/hl7` on npmjs.org, which stops at 1.x.
   */
  describe('an npm alias', () => {
    const aliased = () =>
      single({
        peerDependencies: { '@sb/hl7': '^2.0.0' },
        devDependencies: { '@sb/hl7': 'npm:@mirror/sb__hl7@^2.0.0' },
      });
    const mirror = () =>
      new FakeRegistryUpdater({
        '@mirror/sb__hl7': { releases: releases('2.0.0', '2.1.0') },
        /** What npmjs.org has under the plain name - must not be what decides. */
        '@sb/hl7': { releases: releases('1.2.1') },
      });

    it('asks the registry under the aliased name, and moves the alias and the peer beside it together', async () => {
      const updater = mirror();
      const { entries } = await plan(aliased(), updater);
      expect(updater.calls.map(c => c.split('@>=')[0])).toEqual(['@mirror/sb__hl7']);
      expect(entry(entries, '@sb/hl7')).toMatchObject({
        status: 'update',
        current: 'npm:@mirror/sb__hl7@^2.0.0',
        target: 'npm:@mirror/sb__hl7@^2.1.0',
        bump: 'minor',
      });
    });

    it('writes the alias back with its prefix, and the peer as a plain range', async () => {
      const dir = aliased();
      const updater = mirror();
      const { repository, entries } = await plan(dir, updater);
      await updater.applyPlan({ app: repository.app, repository, options: { concurrency: 1 } }, entries);
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      expect(written.devDependencies).toEqual({ '@sb/hl7': 'npm:@mirror/sb__hl7@^2.1.0' });
      expect(written.peerDependencies).toEqual({ '@sb/hl7': '^2.1.0' });
    });

    it('is up to date when the aliased package has nothing newer', async () => {
      const updater = new FakeRegistryUpdater({ '@mirror/sb__hl7': { releases: releases('2.0.0') } });
      const { entries } = await plan(aliased(), updater);
      expect(entry(entries, '@sb/hl7').status).toBe('up-to-date');
    });
  });

  describe('applyPlan', () => {
    it('writes only the update entries, and restore puts the file back byte for byte', async () => {
      const dir = single({ dependencies: { a: '^1.0.0', b: '^1.0.0' } }, { deps: { reject: ['b'] } });
      const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8');
      const updater = new FakeRegistryUpdater({
        a: { releases: releases('1.0.0', '1.1.0') },
        b: { releases: releases('1.0.0', '1.1.0') },
      });
      const { repository, entries } = await plan(dir, updater);
      const applied = await updater.applyPlan(
        { app: repository.app, repository, options: { concurrency: 1 } },
        entries,
      );

      expect(applied.files).toEqual([path.join(dir, 'package.json')]);
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      expect(written.dependencies).toEqual({ a: '^1.1.0', b: '^1.0.0' });

      applied.restore();
      expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).toBe(before);
    });
  });
});
