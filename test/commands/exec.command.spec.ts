import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-exec-cmd-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

describe('commands/exec', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('joins the [command..] positional back into one command line and runs it in every package', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

    await runCli({ cwd: dir, argv: ['exec', '--no-progress', 'touch', 'marker.txt'] });

    expect(fs.existsSync(path.join(dir, 'packages/a/marker.txt'))).toBe(true);
  });

  it('--scope filters which packages the command runs in, through real CLI parsing', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });

    await runCli({ cwd: dir, argv: ['exec', '--no-progress', '--scope', 'pkg-a', 'touch', 'marker.txt'] });

    expect(fs.existsSync(path.join(dir, 'packages/a/marker.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'packages/b/marker.txt'))).toBe(false);
  });

  it('"--" escapes a flag that would otherwise be parsed as one of exec\'s own options', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

    // "--bail" is one of exec's own options too - without the leading "--" here, it would be
    // parsed as that instead of reaching "touch" as a (literal, touch's own "--"-escaped) filename.
    await runCli({ cwd: dir, argv: ['exec', '--no-progress', '--', 'touch', '--', '--bail'] });

    expect(fs.existsSync(path.join(dir, 'packages/a/--bail'))).toBe(true);
  });
});
