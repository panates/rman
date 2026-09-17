import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../src/cli.js';
import { useTestEcosystem } from './_fixture.js';

/** Runs `fn` with console.log captured (plain, unmodified) instead of printed - proves what the
 *  CLI actually logged without spamming test output. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('cli: global --log-level', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('the global --log-level flag overrides the root .rmanrc "logLevel" through real CLI parsing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-cli-test-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', version: '1.0.0', scripts: { build: 'echo hi > /dev/null 2>&1' } }),
    );
    // root config says "silent" (no per-step lines at all) - the CLI flag below must win over it.
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ logLevel: 'silent' }));

    const lines = await captureLogs(() =>
      runCli({ cwd: dir, argv: ['run', 'build', '--no-progress', '--log-level', 'verbose'] }),
    );
    expect(lines.some(l => l.includes('executing'))).toBe(true);
  });

  it('without a CLI override, the root .rmanrc "logLevel" is what actually takes effect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-cli-test-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', version: '1.0.0', scripts: { build: 'echo hi > /dev/null 2>&1' } }),
    );
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ logLevel: 'silent' }));

    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['run', 'build', '--no-progress'] }));
    expect(lines.some(l => l.includes('┆'))).toBe(false);
  });
});

describe('cli: global --config', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A monorepo whose `build` step would leave a file behind - so "nothing was run" is provable
   *  rather than merely printed. `pkg-b` is skipped, which the target list has to reflect. */
  function fixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-config-flag-test-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    );
    fs.writeFileSync(
      path.join(dir, '.rmanrc'),
      JSON.stringify({
        packageManager: 'pnpm',
        '[ws:*]': { run: { build: { exec: 'echo ran > ran.txt' } } },
        '[pkg-b]': { skip: true },
      }),
    );
    for (const name of ['a', 'b']) {
      fs.mkdirSync(path.join(dir, 'packages', name), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'packages', name, 'package.json'),
        JSON.stringify({ name: `pkg-${name}`, version: '1.0.0' }),
      );
    }
    return dir;
  }

  it('prints what the command would run with, and runs nothing at all', async () => {
    const dir = fixture();
    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['build', '--config', '--parallel', '2'] }));
    const out = lines.join('\n');

    expect(out).toContain('command: build');
    /** The parsed argv - what this invocation asked for. */
    expect(out).toContain('parallel: 2');
    /** And the step never ran: no file, which is the claim the header makes. */
    expect(fs.existsSync(path.join(dir, 'packages/a/ran.txt'))).toBe(false);
    expect(out).toContain('nothing was run');
  });

  it('narrows the config to the keys the command declares it reads', async () => {
    const dir = fixture();
    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['build', '--config'] }))).join('\n');
    expect(out).toContain('the keys build reads: run.build');
    expect(out).toContain('run.build:');
    expect(out).toContain('echo ran > ran.txt');
  });

  it('works out the key from argv when the command needs it to (run <script>)', async () => {
    const dir = fixture();
    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['run', 'lint', '--config'] }))).join('\n');
    /** Nothing configures `lint`, and saying so is the point - "why did my lint step do nothing". */
    expect(out).toContain('the keys run reads: run.lint');
    expect(out).toContain('pkg-a: {}');
  });

  it('lists the packages the command would act on, after --scope and skip', async () => {
    const dir = fixture();
    const all = (await captureLogs(() => runCli({ cwd: dir, argv: ['build', '--config'] }))).join('\n');
    /** `pkg-b` carries `skip: true`, so it is not a target - the same set the command computes. */
    expect(all).toContain('packages: [pkg-a]');

    const scoped = (
      await captureLogs(() => runCli({ cwd: dir, argv: ['build', '--config', '--scope', 'pkg-nope'] }))
    ).join('\n');
    expect(scoped).toContain('packages: []');
  });

  it('lists the root package as well, since repo-wide keys are read there', async () => {
    const dir = fixture();
    /** `ci` is a plugin command here, so use a core one that reads a root key: `github-release`
     *  reads `githubRelease`, and the root is where that lives. Without the root in the output, a
     *  command reading only root keys answered with `pkg-a: {}` - "nothing is configured". */
    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['build', '--config'] }))).join('\n');
    expect(out).toContain('root:');
    expect(out).toContain('is the root - listed because repo-wide keys are read there');
  });

  it("reaches a repository's own .rman/*.mjs command too, and forwards its configKeys", async () => {
    const dir = fixture();
    fs.mkdirSync(path.join(dir, '.rman'));
    fs.writeFileSync(
      path.join(dir, '.rman', 'deploy.mjs'),
      `export default {
         describe: 'would deploy',
         configKeys: ['vars'],
         handler: ctx => { throw new Error('the handler must not run under --config'); },
       };`,
    );
    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['deploy', '--config'] }))).join('\n');
    expect(out).toContain('command: deploy');
    expect(out).toContain('the keys deploy reads: vars');
  });
});
