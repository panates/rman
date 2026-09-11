import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-info-cmd-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Runs `fn` with `console.log` captured (plain, ANSI stripped) instead of printed. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('commands/info', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  describe('plain (table-ish) output', () => {
    it('prints a "Repository" section with type, name, version and root for a single package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'my-pkg', version: '3.2.1' });

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['info'] }));
      const joined = lines.join('\n');

      expect(joined).toContain('Repository:');
      expect(joined).toContain('Single package');
      expect(joined).toContain('my-pkg');
      expect(joined).toContain('3.2.1');
      expect(joined).toContain(dir);
    });

    it('for a monorepo, also prints the package count and a hint to run "list"', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['info'] }));
      const joined = lines.join('\n');

      expect(joined).toContain('Monorepo');
      expect(joined).toContain('Packages');
      expect(joined).toContain('2');
      expect(joined).toContain('list');
    });

    it('shows "(none)" for a package with no name/version instead of printing nothing', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', {});

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['info'] }));
      const joined = lines.join('\n');
      expect(joined).toContain('(none)');
    });
  });

  describe('--json', () => {
    it('prints one JSON object combining system info and a nested "repository" key', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'my-pkg', version: '3.2.1' });

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['info', '--json'] }));
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);

      expect(parsed.repository).toEqual({
        type: 'package',
        name: 'my-pkg',
        version: '3.2.1',
        root: dir,
        packageCount: 1,
      });
      // whatever envinfo reports lives alongside "repository", not nested under it.
      expect(typeof parsed).toBe('object');
      expect(Object.keys(parsed)).toContain('repository');
    });

    it('reports "monorepo" and the right package count in JSON too', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['info', '--json'] }));
      const parsed = JSON.parse(lines[0]);
      expect(parsed.repository.type).toBe('monorepo');
      expect(parsed.repository.packageCount).toBe(1);
    });
  });
});
