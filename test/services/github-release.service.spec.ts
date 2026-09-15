import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { GithubReleaseService } from '../../src/services/github-release.service.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-github-release-test-'));
}

describe('services/github-release', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function writeJson(dir: string, rel: string, data: unknown) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  }

  function git(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  }

  function initGit(dir: string, remote = 'git@github.com:panates/example.git') {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
    if (remote) git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
  }

  function entryFor(plan: GithubReleaseService.Entry[], name: string): GithubReleaseService.Entry {
    const e = plan.find(p => p.package.name === name);
    if (!e) throw new Error(`no plan entry for "${name}"`);
    return e;
  }

  function releases(exists: boolean): GithubReleaseService.Deps {
    return { releaseExists: async () => exists };
  }

  describe('getPlan()', () => {
    it('a package not targeting "github" at all is left out of the plan entirely', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);

      const repo = await Repository.create(dir);
      const plan = await GithubReleaseService.getPlan(repo, {}, releases(false));
      expect(plan).toEqual([]);
    });

    it('no release for the version\'s tag yet -> "publish", against the origin remote\'s repo', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.0',
        rman: { publish: { target: ['github'] } },
      });
      initGit(dir);

      const repo = await Repository.create(dir);
      const plan = await GithubReleaseService.getPlan(repo, {}, releases(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({
        status: 'publish',
        tag: 'v1.2.0',
        repository: 'panates/example',
        reason: 'never released',
      });
    });

    it('a release already exists for that tag -> "up-to-date", nothing to do', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.0',
        rman: { publish: { target: ['github'] } },
      });
      initGit(dir);

      const repo = await Repository.create(dir);
      const plan = await GithubReleaseService.getPlan(repo, {}, releases(true));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'up-to-date' });
    });

    it('a package private to npm is still a perfectly normal github-target candidate', async () => {
      // The whole point of this target: an app that ships as release assets (or deploys elsewhere)
      // is never an npm package, so "private" must not exclude it the way it does on the npm side.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.0',
        private: true,
        rman: { publish: { target: ['github'] } },
      });
      initGit(dir);

      const repo = await Repository.create(dir);
      const plan = await GithubReleaseService.getPlan(repo, {}, releases(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish' });
    });

    it('.rmanrc "publish.skip" leaves a github-targeted package out entirely', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.0',
        rman: { publish: { target: ['github'], skip: true } },
      });
      initGit(dir);

      const repo = await Repository.create(dir);
      const plan = await GithubReleaseService.getPlan(repo, {}, releases(false));
      expect(plan).toEqual([]);
    });

    it('"publish.github.repository" wins over whatever the origin remote says', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.0',
        rman: { publish: { target: ['github'], github: { repository: 'panates/elsewhere' } } },
      });
      initGit(dir);

      const repo = await Repository.create(dir);
      const plan = await GithubReleaseService.getPlan(repo, {}, releases(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ repository: 'panates/elsewhere' });
    });

    it('an https remote resolves to the same "owner/repo" an ssh one does', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.0',
        rman: { publish: { target: ['github'] } },
      });
      initGit(dir, 'https://github.com/panates/example.git');

      const repo = await Repository.create(dir);
      const plan = await GithubReleaseService.getPlan(repo, {}, releases(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ repository: 'panates/example' });
    });

    it('no resolvable "owner/repo" at all is an error, not a silent skip', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.0',
        rman: { publish: { target: ['github'] } },
      });
      initGit(dir, '');

      const repo = await Repository.create(dir);
      const plan = await GithubReleaseService.getPlan(repo, {}, releases(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'error' });
      expect(entryFor(plan, 'pkg-a').reason).toMatch(/owner\/repo/);
    });

    it('a failing release lookup (bad token, typo\'d repo) is an error, never "never released"', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.0',
        rman: { publish: { target: ['github'] } },
      });
      initGit(dir);

      const repo = await Repository.create(dir);
      const plan = await GithubReleaseService.getPlan(
        repo,
        {},
        {
          releaseExists: async () => {
            throw new Error('401 Unauthorized');
          },
        },
      );
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'error', reason: '401 Unauthorized' });
    });

    it("uses the package's own tag pattern, so independent versioning gets its own release", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.0',
        rman: { changelog: { tagPattern: '{name}@*' }, publish: { target: ['github'] } },
      });
      initGit(dir);

      const repo = await Repository.create(dir);
      const plan = await GithubReleaseService.getPlan(repo, {}, releases(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ tag: 'pkg-a@1.2.0' });
    });

    it('a dirty package aborts the plan, unless ignoreDirty downgrades it to a skip', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.0',
        rman: { publish: { target: ['github'] } },
      });
      initGit(dir);
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      const repo = await Repository.create(dir);
      expect(entryFor(await GithubReleaseService.getPlan(repo, {}, releases(false)), 'pkg-a')).toMatchObject({
        status: 'error',
        reason: 'uncommitted local changes',
      });
      expect(
        entryFor(await GithubReleaseService.getPlan(repo, { ignoreDirty: true }, releases(false)), 'pkg-a'),
      ).toMatchObject({ status: 'skip' });
    });
  });
});
