import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { GithubReleaseService } from '../../src/services/github-release.service.js';
import { service, useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-github-release-test-'));
}

describe('services/github-release', () => {
  useTestEcosystem();

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

  function releases(exists: boolean): GithubReleaseService.Deps {
    return { releaseExists: async () => exists };
  }

  /** A monorepo already tagged for its current version - the state `version` leaves behind and
   *  `github-release` expects. No opt-in of any kind: a release is always cut. */
  function fixture(
    options: { rootVersion?: string; rootRman?: unknown; remote?: string; tagged?: boolean } = {},
  ): string {
    const dir = tmp();
    const rootVersion = options.rootVersion ?? '1.2.0';
    writeJson(dir, 'package.json', {
      name: 'root',
      private: true,
      version: rootVersion,
      workspaces: ['packages/*'],
      rman: options.rootRman ?? {},
    });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.2.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.2.0' });
    initGit(dir, options.remote ?? 'git@github.com:panates/example.git');
    if (options.tagged !== false) {
      git(dir, 'tag', rootVersion.startsWith('20') ? `release-${rootVersion}` : `v${rootVersion}`);
    }
    return dir;
  }

  describe('getPlan()', () => {
    it('needs no opt-in at all - a release records that the repository shipped', async () => {
      // Every other "should this ship?" question in rman is opt-in; this one deliberately isn't.
      // A release isn't somewhere a package ships to, so there is nothing to opt a package into.
      const dir = fixture({ rootRman: {} });
      await Repository.create(dir);
      const plan = await service('githubRelease').getPlan({}, releases(false));
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({ status: 'publish', tag: 'v1.2.0' });
    });

    it('produces exactly one entry - a release belongs to the repository, not a package', async () => {
      const dir = fixture();
      await Repository.create(dir);
      const plan = await service('githubRelease').getPlan({}, releases(false));
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({
        status: 'publish',
        tag: 'v1.2.0',
        repository: 'panates/example',
        reason: 'never released',
      });
      expect(plan[0].package.name).toBe('root');
    });

    it('a release already exists for that tag -> "up-to-date"', async () => {
      const dir = fixture();
      await Repository.create(dir);
      const plan = await service('githubRelease').getPlan({}, releases(true));
      expect(plan[0]).toMatchObject({ status: 'up-to-date' });
    });

    it('names the release after the repository release tag once the root is on a calendar version', async () => {
      // Several version lines mean no shared number, so the release needs a name of its own - and
      // one that can't be mistaken for a package tag (see releaseTagPattern).
      const dir = fixture({ rootVersion: '2026.9.15-1430' });
      await Repository.create(dir);
      const plan = await service('githubRelease').getPlan({}, releases(false));
      expect(plan[0]).toMatchObject({ tag: 'release-2026.9.15-1430', version: '2026.9.15-1430' });
    });

    it('a "publish.skip" package changes nothing - the tag still covers its code', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, version: '1.2.0', workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.2.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.2.0',
        private: true,
        rman: { publish: { skip: true } },
      });
      initGit(dir);
      git(dir, 'tag', 'v1.2.0');

      await Repository.create(dir);
      const plan = await service('githubRelease').getPlan({}, releases(false));
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({ status: 'publish', tag: 'v1.2.0' });
    });

    it('root "githubRelease.repository" wins over whatever the origin remote says', async () => {
      const dir = fixture({
        rootRman: { githubRelease: { repository: 'panates/elsewhere' } },
      });
      await Repository.create(dir);
      const plan = await service('githubRelease').getPlan({}, releases(false));
      expect(plan[0]).toMatchObject({ repository: 'panates/elsewhere' });
    });

    it('an https remote resolves to the same "owner/repo" an ssh one does', async () => {
      const dir = fixture({ remote: 'https://github.com/panates/example.git' });
      await Repository.create(dir);
      const plan = await service('githubRelease').getPlan({}, releases(false));
      expect(plan[0]).toMatchObject({ repository: 'panates/example' });
    });

    it('no resolvable "owner/repo" at all is an error, not a silent skip', async () => {
      const dir = fixture({ remote: '' });
      await Repository.create(dir);
      const plan = await service('githubRelease').getPlan({}, releases(false));
      expect(plan[0]).toMatchObject({ status: 'error' });
      expect(plan[0].reason).toMatch(/owner\/repo/);
    });

    it('a failing release lookup (bad token, typo\'d repo) is an error, never "never released"', async () => {
      const dir = fixture();
      await Repository.create(dir);
      const plan = await service('githubRelease').getPlan(
        {},
        {
          releaseExists: async () => {
            throw new Error('401 Unauthorized');
          },
        },
      );
      expect(plan[0]).toMatchObject({ status: 'error', reason: '401 Unauthorized' });
    });

    it('a release tag that does not exist here is an error, not a release off the whole history', async () => {
      // Either `version` never ran, or this clone has no tags. Releasing anyway would look fine and
      // silently produce notes covering everything ever, since the *previous* release tag needed to
      // bound them can't be found either.
      const dir = fixture({ tagged: false });
      await Repository.create(dir);
      const plan = await service('githubRelease').getPlan({}, releases(false));
      expect(plan[0]).toMatchObject({ status: 'error' });
      expect(plan[0].reason).toMatch(/does not exist here/);
    });

    it('uncommitted changes abort the plan, unless ignoreDirty downgrades it to a skip', async () => {
      const dir = fixture();
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');
      await Repository.create(dir);

      expect((await service('githubRelease').getPlan({}, releases(false)))[0]).toMatchObject({
        status: 'error',
        reason: 'uncommitted local changes',
      });
      expect((await service('githubRelease').getPlan({ ignoreDirty: true }, releases(false)))[0]).toMatchObject({
        status: 'skip',
      });
    });
  });
});
