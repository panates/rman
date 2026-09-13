import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import * as api from '../src/index.js';

/**
 * A smoke test for the public programmatic API (`src/index.ts`) - it locks in the exported
 * surface itself (so an internal refactor can't silently drop something consumers rely on) and
 * confirms a couple of entry points actually work end-to-end when imported this way, not just
 * when called from within the CLI commands that normally use them.
 */
describe('public API (src/index.ts)', () => {
  it("exports Repository, Package, and each domain's namespace (Changelog, Ci, Clean, SystemInfo, List, Run)", () => {
    expect(typeof api.Repository).toBe('function');
    expect(typeof api.Package).toBe('function');
    expect(typeof api.ChangelogService.getEntries).toBe('function');
    expect(typeof api.ChangelogService.getEntries).toBe('function');
    expect(typeof api.ChangelogService.generateToFile).toBe('function');
    expect(typeof api.detectChangeHash).toBe('function');
    expect(typeof api.CiService.reinstall).toBe('function');
    expect(typeof api.CiService.wipe).toBe('function');
    expect(typeof api.CiService.resolvePackageManager).toBe('function');
    expect(typeof api.CleanService.clean).toBe('function');
    expect(typeof api.SystemInfo.getSystemInfo).toBe('function');
    expect(typeof api.SystemInfo.getRepositoryInfo).toBe('function');
    expect(typeof api.ListService.getPackages).toBe('function');
    expect(typeof api.RunService.runScript).toBe('function');
    expect(api.LOG_LEVELS).toEqual(['silent', 'error', 'info', 'verbose']);
    expect(typeof api.defineConfig).toBe('function');
  });

  it('Repository.create() + List.getPackages() work when imported from the public entry point, returning data with no console output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-api-test-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      );
      fs.mkdirSync(path.join(dir, 'packages/a'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'packages/a/package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }));
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], {
        cwd: dir,
      });

      const repo = await api.Repository.create(dir);
      const originalLog = console.log;
      const logged: unknown[] = [];
      console.log = (...args: unknown[]) => logged.push(args);
      let packages: api.ListService.Item[];
      try {
        packages = await api.ListService.getPackages(repo);
      } finally {
        console.log = originalLog;
      }
      expect(logged).toEqual([]); // a service returns data - it never prints anything itself.
      expect(packages.some(p => p.name === 'pkg-a')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
