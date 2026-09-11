import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../src/cli.js';

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
