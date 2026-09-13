import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { RunService } from '../../src/services/run.service.js';

function atom(name: string, value?: string): RunService.IfNode {
  return { kind: 'atom', name, value };
}

/** Runs `fn` with console.log silenced - for tests that deliberately trigger one of
 *  evaluateIfAtom's own warning lines and don't need to inspect it. */
async function withSilencedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

describe('run: "if" expression', () => {
  describe('Run.parseIfExpr()', () => {
    it('returns undefined for empty, whitespace, or non-string input', () => {
      expect(RunService.parseIfExpr(undefined)).toBeUndefined();
      expect(RunService.parseIfExpr('')).toBeUndefined();
      expect(RunService.parseIfExpr('   ')).toBeUndefined();
      expect(RunService.parseIfExpr(42)).toBeUndefined();
    });

    it('parses a bare atom', () => {
      expect(RunService.parseIfExpr('changed')).toEqual(atom('changed'));
    });

    it('parses an atom with a value', () => {
      expect(RunService.parseIfExpr('changed = abc123')).toEqual(atom('changed', 'abc123'));
    });

    it('resolves a {ENV_VAR} placeholder in the value', () => {
      process.env.RMAN_TEST_HASH = 'deadbeef';
      try {
        expect(RunService.parseIfExpr('changed = {RMAN_TEST_HASH}')).toEqual(atom('changed', 'deadbeef'));
      } finally {
        delete process.env.RMAN_TEST_HASH;
      }
    });

    it('resolves an unset {ENV_VAR} placeholder to an empty string', () => {
      delete process.env.RMAN_TEST_MISSING;
      expect(RunService.parseIfExpr('changed = {RMAN_TEST_MISSING}')).toEqual(atom('changed', ''));
    });

    it('leaves a plain (non-placeholder) value untouched', () => {
      expect(RunService.parseIfExpr('changed = a1b2c3')).toEqual(atom('changed', 'a1b2c3'));
    });

    it('parses "not"', () => {
      expect(RunService.parseIfExpr('not changed')).toEqual({ kind: 'not', node: atom('changed') });
    });

    it('gives "and" higher precedence than "or" (a or b and c => a or (b and c))', () => {
      expect(RunService.parseIfExpr('a or b and c')).toEqual({
        kind: 'or',
        left: atom('a'),
        right: { kind: 'and', left: atom('b'), right: atom('c') },
      });
    });

    it('is case-insensitive for and/or/not keywords', () => {
      expect(RunService.parseIfExpr('a AND b')).toEqual({ kind: 'and', left: atom('a'), right: atom('b') });
      expect(RunService.parseIfExpr('a Or b')).toEqual({ kind: 'or', left: atom('a'), right: atom('b') });
      expect(RunService.parseIfExpr('NOT a')).toEqual({ kind: 'not', node: atom('a') });
    });

    it('lets parentheses override precedence ((a or b) and c)', () => {
      expect(RunService.parseIfExpr('(a or b) and c')).toEqual({
        kind: 'and',
        left: { kind: 'or', left: atom('a'), right: atom('b') },
        right: atom('c'),
      });
    });

    it('parses deeply nested parentheses', () => {
      expect(RunService.parseIfExpr('((a or b) and not c) or (d and not e)')).toEqual({
        kind: 'or',
        left: {
          kind: 'and',
          left: { kind: 'or', left: atom('a'), right: atom('b') },
          right: { kind: 'not', node: atom('c') },
        },
        right: { kind: 'and', left: atom('d'), right: { kind: 'not', node: atom('e') } },
      });
    });
  });

  describe('Run.evaluateIf()', () => {
    let dir: string;
    let originDir: string;
    let repository: Repository;
    let baseHash: string;

    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
    const writeJson = (rel: string, data: unknown) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));

    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-if-test-'));
      /** "committed" (committed locally but not in upstream) only means anything once a branch has
       *  an upstream - `git cherry` errors out without one - so set up a real bare origin to push to. */
      originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-if-origin-'));
      execFileSync('git', ['init', '-q', '--bare', originDir]);

      for (const pkg of ['pkg-untouched', 'pkg-committed', 'pkg-dirty']) {
        fs.mkdirSync(path.join(dir, 'packages', pkg), { recursive: true });
        writeJson(`packages/${pkg}/package.json`, { name: pkg, version: '1.0.0' });
      }
      writeJson('package.json', { name: 'root', version: '1.0.0', private: true, workspaces: ['packages/*'] });

      git('init', '-q');
      git('config', 'user.email', 't@t.com');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      baseHash = git('rev-parse', 'HEAD');

      git('remote', 'add', 'origin', originDir);
      git('branch', '-M', 'main');
      git('push', '-u', 'origin', 'main', '-q');

      // committed on the current branch, but never pushed to origin -> "committed" status.
      fs.writeFileSync(path.join(dir, 'packages/pkg-committed/file.txt'), 'v2');
      git('add', '-A');
      git('commit', '-q', '-m', 'change pkg-committed');

      // uncommitted local edit -> "dirty" status (takes priority over "committed").
      fs.writeFileSync(path.join(dir, 'packages/pkg-dirty/file.txt'), 'uncommitted');

      repository = await Repository.create(dir);
    });

    after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(originDir, { recursive: true, force: true });
    });

    const evalFor = async (expr: string, pkgName: string): Promise<boolean> => {
      const node = RunService.parseIfExpr(expr);
      if (!node) throw new Error(`"${expr}" failed to parse`);
      const pkg = repository.getPackage(pkgName);
      if (!pkg) throw new Error(`no such package "${pkgName}"`);
      return RunService.evaluateIf(repository, pkg, node, new Map());
    };

    it('"changed" matches dirty and committed-but-unpushed packages, not an untouched one', async () => {
      expect(await evalFor('changed', 'pkg-dirty')).toBe(true);
      expect(await evalFor('changed', 'pkg-committed')).toBe(true);
      expect(await evalFor('changed', 'pkg-untouched')).toBe(false);
    });

    it('"dirty" matches only the package with uncommitted local edits', async () => {
      expect(await evalFor('dirty', 'pkg-dirty')).toBe(true);
      expect(await evalFor('dirty', 'pkg-committed')).toBe(false);
      expect(await evalFor('dirty', 'pkg-untouched')).toBe(false);
    });

    it('"not dirty" is the inverse of "dirty"', async () => {
      expect(await evalFor('not dirty', 'pkg-dirty')).toBe(false);
      expect(await evalFor('not dirty', 'pkg-untouched')).toBe(true);
    });

    it('"dirty or committed" is equivalent to "changed" here', async () => {
      expect(await evalFor('dirty or committed', 'pkg-dirty')).toBe(true);
      expect(await evalFor('dirty or committed', 'pkg-untouched')).toBe(false);
    });

    it('"changed = <hash>" scopes the diff to a specific commit, but dirty still wins', async () => {
      // relative to baseHash, only pkg-committed has a *committed* diff; pkg-dirty's edit is
      // uncommitted, so "dirty" still takes priority over the hash comparison for it.
      expect(await evalFor(`changed = ${baseHash}`, 'pkg-committed')).toBe(true);
      expect(await evalFor(`changed = ${baseHash}`, 'pkg-dirty')).toBe(true);
      expect(await evalFor(`changed = ${baseHash}`, 'pkg-untouched')).toBe(false);
    });

    it('"changed = {ENV_VAR}" reads the hash from the environment', async () => {
      process.env.RMAN_TEST_BASE = baseHash;
      try {
        expect(await evalFor('changed = {RMAN_TEST_BASE}', 'pkg-committed')).toBe(true);
        expect(await evalFor('changed = {RMAN_TEST_BASE}', 'pkg-untouched')).toBe(false);
      } finally {
        delete process.env.RMAN_TEST_BASE;
      }
    });

    it('an unresolved (empty) value evaluates to false rather than throwing', async () => {
      delete process.env.RMAN_TEST_MISSING_2;
      // these two conditions are deliberately mis-specified, so evaluateIf's own warning
      // (meant for a real user's terminal) is expected here - silence it, not the assertion.
      await withSilencedConsole(async () => {
        expect(await evalFor('changed = {RMAN_TEST_MISSING_2}', 'pkg-dirty')).toBe(false);
      });
    });

    it('an unknown condition name evaluates to true (fails open, does not silently skip packages)', async () => {
      await withSilencedConsole(async () => {
        expect(await evalFor('some-future-rule', 'pkg-untouched')).toBe(true);
      });
    });

    it('combines with and/or/not/parens against real git state', async () => {
      expect(await evalFor('(dirty or committed) and not committed', 'pkg-dirty')).toBe(true);
      expect(await evalFor('(dirty or committed) and not committed', 'pkg-committed')).toBe(false);
      expect(await evalFor('(dirty or committed) and not committed', 'pkg-untouched')).toBe(false);
    });
  });
});
