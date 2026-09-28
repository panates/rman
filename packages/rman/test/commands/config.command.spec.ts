import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import * as yaml from 'js-yaml';
import { runCli, useTestEcosystem } from '../_fixture.js';

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

/** The `# <name> (<dir>)` line, found rather than indexed: the header grew a config-file line above
 *  it, and three cases asserting `lines[0]` all broke on a change that was about something else. */
function headerOf(lines: string[]): string {
  const header = lines.map(stripColor).find(line => /^# \S+ \(/.test(line));
  if (!header) throw new Error(`no package header in:\n${lines.join('\n')}`);
  return header;
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
   * another, `vars` cascades like any other unmarked key, and `"[/]"` keeps the two repo-wide
   * statements at the root - which is where a repository migrating off the old cascade puts them.
   */
  function fixture(): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    fs.writeFileSync(
      path.join(dir, '.rmanrc'),
      JSON.stringify({
        vars: { registry: 'https://example.test' },
        '[/]': { allowBranch: ['main'], version: { exec: 'echo releasing ${{ pkg.targetVersion }}' } },
        '[*]': { run: { build: { exec: 'tsc -b', before: 'echo shared' } } },
      }),
    );
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
    fs.writeFileSync(
      path.join(dir, 'packages/a/.rmanrc'),
      JSON.stringify({
        group: 'a-line',
        run: { build: { exec: 'tsc -b tsconfig-build.json', before: "${{ [...value, 'echo mine'] }}" } },
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

    expect(headerOf(lines)).toContain('pkg-a');
    expect(headerOf(lines)).toContain(path.join('packages', 'a'));

    const config = parsed(lines);
    /** The package's own statement wins over `"[*]"`, and `[...value]` *adds* to it rather than
     *  replacing - the two rules this command exists to make visible. */
    expect(config.run.build.exec).toBe('tsc -b tsconfig-build.json');
    expect(config.run.build.before).toEqual(['echo shared', 'echo mine']);
    expect(config.group).toBe('a-line');
    /** An unmarked key reaches every package below - `vars` is no longer the exception it was. */
    expect(config.vars).toEqual({ registry: 'https://example.test' });
    /** And a `"[/]"` key stays at the root, which is the only way one does now. */
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

  it("--from-root prints the root package's config instead, from inside a package", async () => {
    const dir = fixture();
    const lines = await captureLogs(() =>
      runCli({ argv: ['config', '--from-root'], cwd: path.join(dir, 'packages/a') }),
    );

    expect(headerOf(lines)).toContain('root');
    const config = parsed(lines);
    expect(config.allowBranch).toEqual(['main']);
    /** `"[*]"` names the packages *below*, so the root does not carry their build block - which is
     *  exactly the kind of thing this command exists to make visible. */
    expect(config.run).toBeUndefined();
  });

  it('falls back to the root in a directory that holds no package', async () => {
    const dir = fixture();
    const lines = await captureLogs(() => runCli({ argv: ['config'], cwd: path.join(dir, 'packages') }));
    expect(headerOf(lines)).toContain('root');
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

  /**
   * A config may legitimately hold a function - a `run.<script>` step or an `if` written as
   * JavaScript - and a `plugins` entry given in its object form holds several.
   *
   * This died rather than printed: js-yaml refuses one with `unacceptable kind of an object to
   * dump [object Function]`, so `rman config` failed on a repository whose shared config did
   * nothing more unusual than `extends` a plugin package. Printing the name is what makes the
   * output answer the question being asked of it - *which* function is configured here.
   */
  it('prints a function rather than failing to serialize it', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    fs.writeFileSync(
      path.join(dir, '.rmanrc.cjs'),
      `module.exports = { '[*]': { run: { build: {
         exec: function copyDocs() {},
         if: () => true,
       } } } };\n`,
    );

    const lines = await captureLogs(() => runCli({ argv: ['config'], cwd: path.join(dir, 'packages/a') }));
    const text = stripColor(lines.join('\n'));
    expect(text).toContain('[Function: copyDocs]');
    /** An anonymous one still prints, as `[Function]` - which is itself worth seeing, since it is
     *  also what the progress panel has to label. */
    expect(text).toMatch(/if: '?\[Function\]?/);

    /** And the document stays loadable, which is the reason the command emits YAML at all. */
    expect(() => yaml.load(text.replace(/^#.*$/gm, ''))).not.toThrow();
  });

  it('prints a function in --json too, where JSON.stringify would have dropped the key', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    fs.writeFileSync(
      path.join(dir, '.rmanrc.cjs'),
      `module.exports = { '[*]': { run: { build: { exec: function copyDocs() {} } } } };\n`,
    );

    const lines = await captureLogs(() => runCli({ argv: ['config', '--json'], cwd: path.join(dir, 'packages/a') }));
    // JSON.stringify omits a function-valued key entirely, so `exec` would simply have vanished -
    // a quieter wrong answer than the YAML crash, and a worse one.
    expect(JSON.parse(lines.join('\n')).run.build.exec).toBe('[Function: copyDocs]');
  });
  /**
   * **The output is a repository's settings, not a record of how they were assembled.**
   *
   * `plugins`, `platforms`, `commands` and `publishTargets` are `CODE_SUBTREES` - code - and every
   * repository now carries them, because rman's own presets go under every root. Printed, they bury
   * the answer: measured on this repository, `rman config` emitted the whole npm publish target's
   * option table and `commands: ['[Function]', '[Function]']` above the two keys the `.rmanrc`
   * actually set.
   *
   * The fixture declares one of each **by hand**, so the case does not depend on the preset default
   * (this suite passes `presets: []`) and still proves the key is dropped wherever it came from.
   */
  it('leaves out the contribution keys - they are code, not settings', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    fs.writeFileSync(
      path.join(dir, '.rmanrc.cjs'),
      `module.exports = {
         commands: [{ command: 'x', describe: 'a command', builder: c => c, handler() {} }],
         '[*]': { run: { build: { exec: 'tsc -b' } } },
       };\n`,
    );

    const lines = await captureLogs(() => runCli({ argv: ['config'], cwd: path.join(dir, 'packages/a') }));
    const text = stripColor(lines.join('\n'));
    const body = text.replace(/^#.*$/gm, '');
    expect(body).not.toContain('commands');
    /** The setting it was burying is still there - this drops four names, not the config. */
    expect(body).toContain('tsc -b');

    /** **And no note about it.** That was tried: the announcement read as the sibling of the
     *  deferred-paths one, and it is not - that explains a visible oddity, this announced an
     *  absence. Presets go under every root, so every config carries all four and the line was
     *  printed every time; at this repository's root it was one of three. */
    expect(text).not.toContain('omitted');
  });

  /** `--json` is what a pipeline reads, so it drops them too - the two spellings cannot disagree
   *  about what the config is. */
  it('leaves them out of --json as well', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    fs.writeFileSync(
      path.join(dir, '.rmanrc.cjs'),
      `module.exports = {
         commands: [{ command: 'x', describe: 'a command', builder: c => c, handler() {} }],
         '[*]': { group: true },
       };\n`,
    );

    const lines = await captureLogs(() => runCli({ argv: ['config', '--json'], cwd: path.join(dir, 'packages/a') }));
    const printed = JSON.parse(lines.join('\n'));
    expect(printed.commands).toBeUndefined();
    expect(printed.group).toBe(true);
  });
  /**
   * **The file you would open to change this**, headed first because that is a reader's next
   * question. The package's *own* file - the printed config is more than it (the directory chain
   * above, every `extends` base, each `"[selector]"` block), and the per-key answer is `ORIGINS`;
   * this line is the starting point rather than the whole provenance.
   */
  it('heads the output with the config file the directory declares', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { group: true } }));
    fs.writeFileSync(path.join(dir, 'packages/a/.rmanrc.yml'), 'skip: true\n');

    const lines = await captureLogs(() => runCli({ argv: ['config'], cwd: path.join(dir, 'packages/a') }));
    expect(stripColor(lines[0]!)).toBe('# .rmanrc.yml');
  });

  /** **Nothing where the directory declares none**, rather than a name that is not there: a package
   *  configured entirely from above would otherwise send the reader to create a file when the
   *  answer is a level up. */
  it('says nothing about a file for a package that declares none', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { group: true } }));

    const lines = await captureLogs(() => runCli({ argv: ['config'], cwd: path.join(dir, 'packages/a') }));
    expect(stripColor(lines[0]!)).toBe(`# pkg-a (${path.join('packages', 'a')})`);
  });
});
