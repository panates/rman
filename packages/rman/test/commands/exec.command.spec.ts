import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli, useTestEcosystem } from '../_fixture.js';

/** A run refused by --allow-branch/--ignore-branch hits cli.ts's `.fail()` handler on an
 *  already-logged error, which calls the real `process.exit(1)` - fatal to the test runner itself,
 *  since it's the same process. */
/**
 * Runs a CLI call that is **expected to fail**, swallowing the rejection so the assertions below can
 * inspect what it printed - and failing the test if the command unexpectedly succeeds.
 *
 * This used to stub `process.exit`, because `runCli` called it from inside the library and would
 * otherwise have taken the whole test process down. The exit belongs to the bin entry alone now, so
 * a failed command is an ordinary rejected promise - and this helper can assert the failure instead
 * of merely surviving it, which the stub never did.
 */
async function expectCliFailure(fn: () => Promise<void>): Promise<void> {
  await fn().then(
    () => {
      throw new Error('expected the command to fail, but it resolved');
    },
    () => undefined,
  );
}

/** Suppresses `exec`'s own real "exec .../success ..." console output for the duration of `fn` -
 *  none of these tests assert on it (they check the filesystem side effect instead), so left
 *  uncaptured it's just noise on top of every other suite's own output. */
async function captureLogs(fn: () => Promise<void>): Promise<void> {
  const original = console.log;
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = original;
  }
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-exec-cmd-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

describe('commands/exec', () => {
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

  it('joins the [command..] positional back into one command line and runs it in every package', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

    await captureLogs(() => runCli({ cwd: dir, argv: ['exec', '--no-progress', 'touch', 'marker.txt'] }));

    expect(fs.existsSync(path.join(dir, 'packages/a/marker.txt'))).toBe(true);
  });

  it('--scope filters which packages the command runs in, through real CLI parsing', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });

    await captureLogs(() =>
      runCli({ cwd: dir, argv: ['exec', '--no-progress', '--scope', 'pkg-a', 'touch', 'marker.txt'] }),
    );

    expect(fs.existsSync(path.join(dir, 'packages/a/marker.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'packages/b/marker.txt'))).toBe(false);
  });

  it('"--" escapes a flag that would otherwise be parsed as one of exec\'s own options', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

    // "--bail" is one of exec's own options too - without the leading "--" here, it would be
    // parsed as that instead of reaching "touch" as a (literal, touch's own "--"-escaped) filename.
    await captureLogs(() => runCli({ cwd: dir, argv: ['exec', '--no-progress', '--', 'touch', '--', '--bail'] }));

    expect(fs.existsSync(path.join(dir, 'packages/a/--bail'))).toBe(true);
  });

  it("--allow-branch is recognized as exec's own option, not swallowed by [command..]", async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    execFileSync('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: dir });

    await captureLogs(() =>
      expectCliFailure(() =>
        runCli({ cwd: dir, argv: ['exec', '--no-progress', '--allow-branch', 'main', 'touch', 'marker.txt'] }),
      ),
    );

    // refused before running anything - "--allow-branch"/"main" never reached the [command..]
    // positional (which would otherwise have tried to "touch main marker.txt" instead).
    expect(fs.existsSync(path.join(dir, 'packages/a/marker.txt'))).toBe(false);
  });
});
