import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import * as yaml from 'js-yaml';
import { runCli } from '../../src/cli.js';
import { useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-config-cmd-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

/** `\x1b` as an escape, never the literal byte: a `perl -pi` pass ate it once here, leaving a
 *  regex that matched no colour, and a test that passed only because the run had no TTY. */
// eslint-disable-next-line no-control-regex -- matching an escape sequence is the point here.
const ANSI = new RegExp('\\x1b\\[[0-9;]*m', 'g');

function stripColor(text: string): string {
  return text.replace(ANSI, '');
}

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

describe('commands/config', () => {
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

  /**
   * A repository whose config only makes sense *after* resolution - that is the whole point of this
   * command. `"[*]"` speaks for both packages, `pkg-a` overrides one key of it and appends to
   * another, and `vars` cascades to everything.
   */
  function fixture(): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    fs.writeFileSync(
      path.join(dir, '.rmanrc'),
      JSON.stringify({
        allowBranch: ['main'],
        vars: { registry: 'https://example.test' },
        '[*]': { run: { build: { exec: 'tsc -b', before: 'echo shared' } } },
        version: { exec: 'echo releasing ${{ pkg.targetVersion }}' },
      }),
    );
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
    fs.writeFileSync(
      path.join(dir, 'packages/a/.rmanrc'),
      JSON.stringify({
        group: 'a-line',
        run: { build: { exec: 'tsc -b tsconfig-build.json', '+before': 'echo mine' } },
      }),
    );
    return dir;
  }

  function parsed(lines: string[]): any {
    /** The `#` lines are comments, so the whole output is valid YAML - parsing it rather than the
     *  non-comment lines is also what proves that.
     *
     *  Colour is stripped rather than relied upon to be absent: the command only colours on a TTY,
     *  and mocha run from a terminal *has* one - so a run that passes in CI would otherwise fail on
     *  a developer's machine. The original failure is worth keeping in mind either way: an escape
     *  sequence inside a `#` comment makes js-yaml reject the whole document. */
    return yaml.load(stripColor(lines.join('\n')));
  }

  it("prints the config of the package the current directory is in, not the root's", async () => {
    const dir = fixture();
    const lines = await captureLogs(() => runCli({ argv: ['config'], cwd: path.join(dir, 'packages/a') }));

    expect(lines[0]).toContain('pkg-a');
    expect(lines[0]).toContain(path.join('packages', 'a'));

    const config = parsed(lines);
    /** The package's own statement wins over `"[*]"`, and `+before` *appends* to it rather than
     *  replacing - the two rules this command exists to make visible. */
    expect(config.run.build.exec).toBe('tsc -b tsconfig-build.json');
    expect(config.run.build.before).toEqual(['echo shared', 'echo mine']);
    expect(config.group).toBe('a-line');
    /** `vars` is the one unmarked key that reaches every package. */
    expect(config.vars).toEqual({ registry: 'https://example.test' });
    /** Root-only keys are not the package's. */
    expect(config.allowBranch).toBeUndefined();
  });

  it('a package with no .rmanrc of its own still shows what a selector said about it', async () => {
    const dir = fixture();
    const lines = await captureLogs(() => runCli({ argv: ['config'], cwd: path.join(dir, 'packages/b') }));

    expect(lines[0]).toContain('pkg-b');
    const config = parsed(lines);
    expect(config.run.build.exec).toBe('tsc -b');
    expect(config.run.build.before).toEqual('echo shared');
    expect(config.group).toBeUndefined();
  });

  it("--root prints the root package's config instead, from inside a package", async () => {
    const dir = fixture();
    const lines = await captureLogs(() => runCli({ argv: ['config', '--root'], cwd: path.join(dir, 'packages/a') }));

    expect(lines[0]).toContain('root');
    const config = parsed(lines);
    expect(config.allowBranch).toEqual(['main']);
    /** `"[*]"` includes the root, so its `run` block is here too - which is exactly the kind of
     *  thing this command exists to show. `"[ws:*]"` is the selector that leaves the root out. */
    expect(config.run.build.exec).toBe('tsc -b');
  });

  it('falls back to the root in a directory that holds no package', async () => {
    const dir = fixture();
    const lines = await captureLogs(() => runCli({ argv: ['config'], cwd: path.join(dir, 'packages') }));
    expect(lines[0]).toContain('root');
  });

  it('--json prints nothing but JSON, so it can be piped', async () => {
    const dir = fixture();
    const lines = await captureLogs(() => runCli({ argv: ['config', '--json'], cwd: path.join(dir, 'packages/a') }));

    const config = JSON.parse(lines.join('\n'));
    expect(config.run.build.before).toEqual(['echo shared', 'echo mine']);
    /** No header, no note - a `#` comment is fine in YAML and fatal in JSON. */
    expect(lines.join('\n')).not.toContain('#');
  });

  it('says so when a value is printed raw, instead of looking like broken interpolation', async () => {
    const dir = fixture();
    const atRoot = await captureLogs(() => runCli({ argv: ['config'], cwd: dir }));

    /** `version.exec` is in `DEFERRED_PATHS`: `${{ pkg.targetVersion }}` cannot be evaluated until
     *  `version` has a plan, so it is still an expression here. Printed without the note, it reads
     *  as interpolation having failed. */
    expect(parsed(atRoot).version.exec).toBe('echo releasing ${{ pkg.targetVersion }}');
    expect(atRoot.some(l => l.includes('version.exec') && l.includes('printed raw'))).toBe(true);

    /** And no note when nothing deferred is configured. */
    const inPkg = await captureLogs(() => runCli({ argv: ['config'], cwd: path.join(dir, 'packages/a') }));
    expect(inPkg.some(l => l.includes('printed raw'))).toBe(false);
  });
});
