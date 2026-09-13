import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { ExecService } from '../../src/services/exec.service.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-exec-test-'));
}

/** A `node -e '...'` command that appends `line` to `file` - single-quoted for the shell,
 *  double-quoted (via JSON.stringify) inside, so the two quoting styles never collide. */
function appendCommand(file: string, line: string): string {
  return `node -e 'require("fs").appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(line + '\n')})'`;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

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

describe('services/exec', () => {
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

  it('runs the given command directly in every package - no package.json script needed at all', async () => {
    const dir = tmp();
    const marker = path.join(dir, 'calls.log');
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
    const repo = await Repository.create(dir);

    await captureLogs(() => ExecService.exec(repo, appendCommand(marker, 'ran'), { progress: false }));

    const calls = fs.readFileSync(marker, 'utf-8').trim().split('\n');
    expect(calls.length).toBe(2);
  });

  it("runs in each package's own directory (cwd), not the repository root", async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    const repo = await Repository.create(dir);

    const marker = path.join(dir, 'cwd.log');
    await captureLogs(() =>
      ExecService.exec(repo, `node -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, process.cwd())'`, {
        progress: false,
      }),
    );
    expect(fs.realpathSync(fs.readFileSync(marker, 'utf-8'))).toBe(fs.realpathSync(path.join(dir, 'packages/a')));
  });

  it('respects topological order by default - a dependency runs before its dependent', async () => {
    const dir = tmp();
    const marker = path.join(dir, 'order.log');
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', {
      name: 'pkg-b',
      version: '1.0.0',
      dependencies: { 'pkg-a': '1.0.0' },
    });
    const repo = await Repository.create(dir);

    await captureLogs(() =>
      ExecService.exec(repo, `node -e 'require("fs").appendFileSync(${JSON.stringify(marker)}, process.cwd()+"\\n")'`, {
        progress: false,
        parallel: false,
      }),
    );
    const lines = fs.readFileSync(marker, 'utf-8').trim().split('\n');
    expect(lines[0]).toContain('packages/a');
    expect(lines[1]).toContain('packages/b');
  });

  it('a failing package aborts (bail default true) - its dependent never runs', async () => {
    const dir = tmp();
    const marker = path.join(dir, 'ran.log');
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', {
      name: 'pkg-b',
      version: '1.0.0',
      dependencies: { 'pkg-a': '1.0.0' },
    });
    const repo = await Repository.create(dir);

    await captureLogs(async () => {
      await expect(
        ExecService.exec(repo, `bash -c "[ $(basename $(pwd)) = a ] && exit 1 || echo ran >> ${marker}"`, {
          progress: false,
          parallel: false,
        }),
      ).rejects.toThrow();
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('--scope narrows which packages the command runs in', async () => {
    const dir = tmp();
    const marker = path.join(dir, 'calls.log');
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
    const repo = await Repository.create(dir);

    await captureLogs(() => ExecService.exec(repo, appendCommand(marker, 'ran'), { progress: false, scope: 'pkg-a' }));
    expect(fs.readFileSync(marker, 'utf-8').trim().split('\n').length).toBe(1);
  });

  it('reports "No package matched." and runs nothing when the filter matches nobody', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    const repo = await Repository.create(dir);

    const lines = await captureLogs(() =>
      ExecService.exec(repo, 'echo should-not-run', { progress: false, scope: 'nothing-matches-this' }),
    );
    expect(lines.some(l => l.includes('No package matched.'))).toBe(true);
  });
});
