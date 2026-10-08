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

  constructor(
    readonly registry: Record<string, { latest?: string; releases: NpmRelease[]; time?: Record<string, string> }>,
  ) {
    super();
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

    it('never crosses a major by default, and says what it left behind', async () => {
      const dir = single({ dependencies: { a: '^1.0.0', b: '^1.0.0' } });
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
      const { entries } = await plan(dir, updater);
      expect(entry(entries, 'zero')).toMatchObject({ status: 'update', target: '^0.1.4', available: '0.2.0' });
      const major = await plan(dir, updater, { target: 'major' });
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

    it('leaves an exact version, a compound range, a tag and a URL out of the plan', async () => {
      const dir = single({
        dependencies: { pinned: '1.0.0', compound: '>=1 <2', tagged: 'latest', remote: 'github:x/y' },
      });
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
    const dir = single({ dependencies: { common: '^0.13.7', builtins: '^0.14.12' } });
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

    it('holds a version whose engines.node does not cover every Node the package supports', async () => {
      const dir = single({ engines: { node: '>=20' }, dependencies: { a: '^1.0.0' } });
      const updater = new FakeRegistryUpdater({
        a: { releases: releases('1.0.0', { version: '1.1.0', engines: { node: '>=22' } }) },
      });
      const { entries } = await plan(dir, updater, { target: 'major' });
      const a = entry(entries, 'a');
      expect(a).toMatchObject({ status: 'held', latest: '1.1.0' });
      expect(a.reason).toContain('a@1.1.0 needs node >=22, app supports >=20');
    });

    it('does not hold a version to a Node the current version already leaves out', async () => {
      const dir = single({ engines: { node: '>=18' }, devDependencies: { a: '^1.0.0' } });
      const updater = new FakeRegistryUpdater({
        a: {
          releases: releases(
            { version: '1.0.0', engines: { node: '^18.18.0 || >=20' } },
            { version: '1.1.0', engines: { node: '^18.18.0 || >=20' } },
            { version: '1.2.0', engines: { node: '>=20' } },
          ),
        },
      });
      const { entries } = await plan(dir, updater, { target: 'major' });
      const a = entry(entries, 'a');
      expect(a).toMatchObject({ status: 'update', target: '^1.1.0', latest: '1.2.0' });
      expect(a.reason).toContain('a@1.2.0 needs node >=20, app supports >=18');
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
