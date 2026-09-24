import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { assertAllowedBranch } from '../../src/utils/branch-guard.js';
import { createRepository, useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-branch-guard-test-'));
}

describe('utils/branch-guard', () => {
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

  /** A rejected `assertAllowedBranch` call has already printed its own red message via
   *  `console.log` before throwing (see the "logging convention" tests below) - suppressed here
   *  since most tests only care about the thrown error, not that printed line. */
  async function captureLogs<T>(fn: () => Promise<T>): Promise<T> {
    const original = console.log;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = original;
    }
  }

  function repoOnBranch(branch: string, rmanrc?: unknown): Promise<Repository> {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
    if (rmanrc) writeJson(dir, '.rmanrc', rmanrc);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'checkout', '-q', '-b', branch);
    return createRepository(dir);
  }

  describe('with neither allowBranch nor ignoreBranch set anywhere', () => {
    it('never blocks - purely opt-in', async () => {
      const repo = await repoOnBranch('whatever-branch-i-want');
      await expect(assertAllowedBranch(repo)).resolves.toBeUndefined();
    });
  });

  describe('allowBranch', () => {
    it('passes when the current branch matches the glob', async () => {
      const repo = await repoOnBranch('main');
      await expect(assertAllowedBranch(repo, { allowBranch: 'main' })).resolves.toBeUndefined();
    });

    it('rejects when the current branch does not match', async () => {
      const repo = await repoOnBranch('feature/foo');
      await captureLogs(() =>
        expect(assertAllowedBranch(repo, { allowBranch: 'main' })).rejects.toThrow(/feature\/foo/),
      );
    });

    it('supports a glob (e.g. "release/*") and an array of alternatives', async () => {
      const repo = await repoOnBranch('release/1.0');
      await expect(assertAllowedBranch(repo, { allowBranch: ['main', 'release/*'] })).resolves.toBeUndefined();
    });

    it('reads .rmanrc "allowBranch" when no CLI option is given', async () => {
      const allowed = await repoOnBranch('main', { allowBranch: 'main' });
      await expect(assertAllowedBranch(allowed)).resolves.toBeUndefined();

      const blocked = await repoOnBranch('side-branch', { allowBranch: 'main' });
      await captureLogs(() => expect(assertAllowedBranch(blocked)).rejects.toThrow(/side-branch/));
    });

    it('an explicit CLI option replaces .rmanrc entirely, rather than merging with it', async () => {
      // .rmanrc only allows "main", but the CLI value below should be the only thing that matters.
      const repo = await repoOnBranch('feature/foo', { allowBranch: 'main' });
      await expect(assertAllowedBranch(repo, { allowBranch: 'feature/*' })).resolves.toBeUndefined();
    });
  });

  describe('ignoreBranch', () => {
    it('rejects when the current branch matches the glob', async () => {
      const repo = await repoOnBranch('wip/experiment');
      await captureLogs(() =>
        expect(assertAllowedBranch(repo, { ignoreBranch: 'wip/*' })).rejects.toThrow(/wip\/experiment/),
      );
    });

    it('passes when the current branch does not match', async () => {
      const repo = await repoOnBranch('main');
      await expect(assertAllowedBranch(repo, { ignoreBranch: 'wip/*' })).resolves.toBeUndefined();
    });
  });

  describe('logging convention', () => {
    it('prints the message and marks the thrown error "logged", matching every other guard check', async () => {
      const repo = await repoOnBranch('feature/foo');
      const original = console.log;
      const logged: string[] = [];
      console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));
      try {
        await assertAllowedBranch(repo, { allowBranch: 'main' });
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e.logged).toBe(true);
        expect(logged.some(l => l.includes('feature/foo'))).toBe(true);
      } finally {
        console.log = original;
      }
    });
  });
});
