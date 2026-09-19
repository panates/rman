import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';
import { useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-plugin-test-'));
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

/**
 * A CLI call expected to fail, with **both** output streams silenced while it runs.
 *
 * `console.error` and not just `console.log`, which is what the other specs' `captureLogs` patches:
 * these failures are thrown while `Repository.create` loads the plugins, so they never reach the
 * `logged` convention and `runCli`'s own catch prints them with `console.error`. Left through, they
 * do worse than clutter - the reporter and the stray write race for the same stream, and a line
 * comes out spliced: `Plugin "./p.mjs" must export an rman conf      ✔ throws a clear error...`.
 *
 * Every assertion here reads `error.message`, so nothing is lost by dropping the printed copy.
 */
async function expectCliFailure(fn: () => Promise<void>): Promise<Error> {
  const log = console.log;
  const error = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await fn().then(
      () => {
        throw new Error('expected the command to fail, but it resolved');
      },
      (e: Error) => e,
    );
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe('core/plugin', () => {
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
   * A repository, plus however many plugin modules the case needs.
   *
   * The modules are written as **plain objects**, importing nothing: `definePlugin`/`defineConfig`
   * are identity helpers, so a fixture that skips them is testing the same thing while staying
   * independent of how `'rman'` happens to resolve from a temp directory.
   */
  function fixture(config: unknown, modules: Record<string, string> = {}): string {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true, version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(config));
    for (const [name, source] of Object.entries(modules)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), source);
    }
    return dir;
  }

  /** A module exporting a *config* whose `plugins` hold the plugin - the shape `rman-node` uses. */
  function configModule(name: string, command: string, says: string): string {
    return `export default { plugins: [{ name: ${JSON.stringify(name)}, init(ctx) {
      ctx.addCommand({ command: ${JSON.stringify(command)}, describe: 'from ${name}',
        handler: c => c.logger.info(${JSON.stringify(says)}) });
    } }] };`;
  }

  it('loads a plugin out of a config-exporting module, which is what a plugin package is now', async () => {
    const dir = fixture({ plugins: ['./p.mjs'] }, { 'p.mjs': configModule('p', 'hello', 'hello from p') });
    const lines = await captureLogs(() => runCli({ argv: ['hello'], cwd: dir }));
    expect(lines.join('\n')).toContain('hello from p');
  });

  it('refuses a module that exports the plugin itself, and says what to do about it', async () => {
    /** Accepting both shapes would mean telling them apart at runtime, and `name` is a key either
     *  may have - so the test would be a guess, and guessing "plugin" registers nothing while the
     *  command reports success. Refusing is the point; the message carries the fix. */
    const bare = `export default { name: 'bare', init(ctx) {
      ctx.addCommand({ command: 'bare-cmd', describe: 'from bare', handler: c => c.logger.info('hello from bare') });
    } };`;
    const dir = fixture({ plugins: ['./p.mjs'] }, { 'p.mjs': bare });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('must export an rman config');
    expect(error.message).toContain('looks like the plugin itself');
  });

  it('accepts a plugin object declared inline, which only a JS config can do', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true, version: '1.0.0' }));
    fs.writeFileSync(
      path.join(dir, '.rmanrc.mjs'),
      `export default { plugins: [{ name: 'inline', init(ctx) {
         ctx.addCommand({ command: 'inline-cmd', describe: 'declared as an object',
           handler: c => c.logger.info('hello from inline') });
       } }] };`,
    );
    const lines = await captureLogs(() => runCli({ argv: ['inline-cmd'], cwd: dir }));
    expect(lines.join('\n')).toContain('hello from inline');
  });

  it("keeps an extended config's plugins when the repository names one of its own", async () => {
    /** No `+plugins` anywhere: `plugins` appends at every layer, because a repository adding a
     *  plugin never means "and drop the ones my shared config brought". */
    const dir = fixture(
      { extends: './base.json', plugins: ['./mine.mjs'] },
      {
        'base.json': JSON.stringify({ plugins: ['./theirs.mjs'] }),
        'theirs.mjs': configModule('theirs', 'theirs-cmd', 'hello from theirs'),
        'mine.mjs': configModule('mine', 'mine-cmd', 'hello from mine'),
      },
    );

    expect((await captureLogs(() => runCli({ argv: ['theirs-cmd'], cwd: dir }))).join('\n')).toContain('from theirs');
    expect((await captureLogs(() => runCli({ argv: ['mine-cmd'], cwd: dir }))).join('\n')).toContain('from mine');
  });

  it('registers a plugin named by two layers only once', async () => {
    /** Registering twice would define its commands twice, which yargs does not survive - so this
     *  asserts the command still runs, not merely that loading returned. */
    const dir = fixture(
      { extends: './base.json', plugins: ['./p.mjs'] },
      {
        'base.json': JSON.stringify({ plugins: ['./p.mjs'] }),
        'p.mjs': configModule('p', 'hello', 'hello once'),
      },
    );
    const lines = await captureLogs(() => runCli({ argv: ['hello'], cwd: dir }));
    expect(lines.filter(l => l.includes('hello once'))).toHaveLength(1);
  });

  it('says what is missing when a module exports a config with no plugins', async () => {
    const dir = fixture({ plugins: ['./p.mjs'] }, { 'p.mjs': `export default { group: 'x' };` });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('must export an rman config');
    expect(error.message).toContain('has no "plugins"');
  });

  it('names the shape when a module exports something that is not an object at all', async () => {
    const dir = fixture({ plugins: ['./p.mjs'] }, { 'p.mjs': `export default 'oops';` });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('default export is a string');
  });

  it('refuses an entry that is neither a name nor a plugin object', async () => {
    const dir = fixture({ plugins: [42] });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('takes a package name, a path, or a plugin object');
  });

  it('refuses a plugin object with no name, which everything downstream is keyed by', async () => {
    const dir = fixture({ plugins: [{ init() {} }] });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('has no "name"');
  });
});
