import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli, useTestEcosystem } from '../_fixture.js';

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

  /** A module exporting a **plugin instance**, which is what a `plugins` glob must find. Written
   *  as a plain object, importing nothing: `definePlugin` is an identity helper, so a fixture that
   *  skips it tests the same thing while staying independent of how `'rman'` resolves from a temp
   *  directory. `manifestProvider` is the one required member - a plugin that cannot recognize a
   *  package has nothing to apply the rest of itself to. */
  function pluginModule(name: string): string {
    return `export default {
      name: ${JSON.stringify(name)},
      manifestProvider: { name: ${JSON.stringify(name)}, fileName: '${name}.json',
        read: () => undefined, write: () => {} },
    };`;
  }

  /** A module exporting a command, for a `commands` glob. */
  function commandModule(command: string, says: string): string {
    return `export default { command: ${JSON.stringify(command)}, describe: 'from a glob',
      handler: c => c.logger.info(${JSON.stringify(says)}) };`;
  }

  it('loads a plugin out of a module that exports one, named by a glob', async () => {
    const dir = fixture(
      { plugins: ['./p.mjs'], commands: ['./c.mjs'] },
      {
        'p.mjs': pluginModule('p'),
        'c.mjs': commandModule('hello', 'hello from p'),
      },
    );
    const lines = await captureLogs(() => runCli({ argv: ['hello'], cwd: dir }));
    expect(lines.join('\n')).toContain('hello from p');
  });

  /**
   * **The inverse of what this used to assert**, and the reason the key changed. `plugins` took a
   * package name whose module exported a *config*, and rman read only that config's own `plugins`
   * out of it. It takes an instance or a glob naming one now, so a config is the wrong shape -
   * a package's config reaches a repository through `extends`, which is the key that means "merge
   * this underneath mine".
   */
  it('refuses a module that exports a config instead of a plugin', async () => {
    const dir = fixture({ plugins: ['./p.mjs'] }, { 'p.mjs': `export default { plugins: [] };` });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('takes a plugin or a glob naming modules that export one');
  });

  it('accepts a plugin declared inline, which only a JS config can do', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true, version: '1.0.0' }));
    fs.writeFileSync(
      path.join(dir, '.rmanrc.mjs'),
      `export default {
         plugins: [{ name: 'inline', manifestProvider: { name: 'inline', fileName: 'i.json',
           read: () => undefined, write: () => {} } }],
         commands: [{ command: 'inline-cmd', describe: 'declared as an object',
           handler: c => c.logger.info('hello from inline') }],
       };`,
    );
    const lines = await captureLogs(() => runCli({ argv: ['inline-cmd'], cwd: dir }));
    expect(lines.join('\n')).toContain('hello from inline');
  });

  /**
   * **`init` is the escape hatch, and it still runs** - with the application and nothing else.
   * Everything a plugin used to register through it is a config key now, so a plugin contributing
   * only those needs none at all.
   */
  it('calls init with the application, for whatever the seams do not name', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true, version: '1.0.0' }));
    fs.writeFileSync(
      path.join(dir, '.rmanrc.mjs'),
      `export default { plugins: [{
         name: 'withinit',
         manifestProvider: { name: 'withinit', fileName: 'w.json', read: () => undefined, write: () => {} },
         init(ctx) { globalThis.__rmanInitSawApp = !!ctx.app; },
       }] };`,
    );
    await captureLogs(() => runCli({ argv: ['list'], cwd: dir }));
    expect((globalThis as Record<string, unknown>).__rmanInitSawApp).toBe(true);
    delete (globalThis as Record<string, unknown>).__rmanInitSawApp;
  });

  it("keeps an extended config's plugins when the repository names one of its own", async () => {
    /** No `+plugins` anywhere: `plugins` appends at every layer, because a repository adding one
     *  never means "and drop the ones my shared config brought". */
    const dir = fixture(
      { extends: './base.json', plugins: ['./mine.mjs'], commands: ['./mine-cmd.mjs'] },
      {
        'base.json': JSON.stringify({ plugins: ['./theirs.mjs'], commands: ['./theirs-cmd.mjs'] }),
        'theirs.mjs': pluginModule('theirs'),
        'mine.mjs': pluginModule('mine'),
        'theirs-cmd.mjs': commandModule('theirs-cmd', 'hello from theirs'),
        'mine-cmd.mjs': commandModule('mine-cmd', 'hello from mine'),
      },
    );

    expect((await captureLogs(() => runCli({ argv: ['theirs-cmd'], cwd: dir }))).join('\n')).toContain('from theirs');
    expect((await captureLogs(() => runCli({ argv: ['mine-cmd'], cwd: dir }))).join('\n')).toContain('from mine');
  });

  it('registers a plugin named by two layers only once', async () => {
    /** Registering twice would define its commands twice, which yargs does not survive - so this
     *  asserts the command still runs, not merely that loading returned. */
    const dir = fixture(
      { extends: './base.json', plugins: ['./p.mjs'], commands: ['./c.mjs'] },
      {
        'base.json': JSON.stringify({ plugins: ['./p.mjs'] }),
        'p.mjs': pluginModule('p'),
        'c.mjs': commandModule('hello', 'hello once'),
      },
    );
    const lines = await captureLogs(() => runCli({ argv: ['hello'], cwd: dir }));
    expect(lines.filter(l => l.includes('hello once'))).toHaveLength(1);
  });

  /**
   * **A glob matching nothing is an error for `plugins`**, unlike for `commands`, and this is the
   * measured reason: with it silently ignored, a repository naming a plugin it cannot find loaded
   * *successfully* with no commands - and the `--help`-on-a-broken-repository spec stopped
   * exercising the degraded path, taking the rest of the suite down with it when yargs then called
   * `process.exit`.
   */
  it('refuses a plugins glob that matches nothing, rather than loading without it', async () => {
    const dir = fixture({ plugins: ['./does-not-exist.mjs'] });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('matched no file');
  });

  /**
   * **A package name in `plugins` is the mistake the docs kept making**, so the message names the
   * fix rather than the symptom. `docs/rman.md` and both published READMEs all wrote
   * `plugins: ['rman-node']`; measured, every command exited 1 saying only
   * `glob ".../rman-node" matched no file`, which sends the reader to check their paths when what
   * they wrote is a package - whose config reaches a repository through `extends`.
   *
   * Reaching the loader intact is the other half: `mergeConfig` anchors a contribution glob to the
   * file that declared it, and anchoring `rman-node` into `<dir>/rman-node` erased the evidence.
   */
  it('tells a package name in "plugins" to be an "extends" instead, naming the package', async () => {
    const dir = fixture({ plugins: ['rman-node'] });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('looks like a package name');
    expect(error.message).toContain('extends: "rman-node"');
  });

  it('says the same for a scoped package name, scope included', async () => {
    const dir = fixture({ plugins: ['@panates/rman-node'] });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('extends: "@panates/rman-node"');
  });

  /**
   * The control for the two above: the predicate must not swallow a real glob, or a mistyped path
   * would be answered with advice about `extends`. `./does-not-exist.mjs` is covered by the case
   * further up; this is the bare-looking one, which is the shape that would over-fire.
   */
  it('still calls a bare glob a glob, rather than mistaking it for a package', async () => {
    const dir = fixture({ plugins: ['*.mjs'] });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('matched no file');
    expect(error.message).not.toContain('looks like a package name');
  });

  it('names the shape when a module exports something that is not an object at all', async () => {
    const dir = fixture({ plugins: ['./p.mjs'] }, { 'p.mjs': `export default 'oops';` });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('is a string');
  });

  it('refuses an entry that is neither a glob nor a plugin', async () => {
    const dir = fixture({ plugins: [42] });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('takes a plugin or a glob naming modules that export one');
  });

  it('refuses a plugin with no name, which everything downstream is keyed by', async () => {
    const dir = fixture({ plugins: [{ manifestProvider: {} }] });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('keyed by its `name`');
  });

  /**
   * **An rman 1.x plugin, which is the one wrong shape that used to get all the way in.**
   *
   * `{ name, init }` was the whole of a 1.x plugin - its `init` called `ctx.addTechStack()` and
   * `ctx.addCommand()` - and `name` was all this loader checked, so such an object registered
   * successfully and then died *inside its own `init`* with `ctx.addCommand is not a function`.
   * Measured on the real case while converting `@panates/rman-node`: fifteen failures naming
   * neither the plugin nor the version it was written against. `init` still exists in 2.0, so
   * nothing earlier gives the shape away - `manifestProvider` is the only member that does.
   *
   * Checked at runtime because the type cannot reach a JavaScript config, which is the form every
   * plugin outside this repository is written in.
   */
  it('refuses a 1.x plugin - a name and an init, with no technology behind them', async () => {
    const dir = fixture({ plugins: ['./old.mjs'] }, { 'old.mjs': `export default { name: 'legacy', init() {} };` });
    const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
    expect(error.message).toContain('has no "manifestProvider"');
    /** The message has to say where to go instead, or it only reports that something is wrong. */
    expect(error.message).toContain('rman 1.x plugin');
  });

  /** `publishTargets` is the third key of the same shape, and reaches `app.publishTargets` - which
   *  is what `publish` builds its `--target` choices from. */
  it('registers a publish target the config declares', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true, version: '1.0.0' }));
    fs.writeFileSync(
      path.join(dir, '.rmanrc.mjs'),
      `export default { publishTargets: [{ name: 'fake', describe: 'a fake target',
         getPlan: () => [], applyPlan: (ctx, plan) => plan }] };`,
    );
    /** Not `publish --help`: yargs' help calls `process.exit`, which kills the mocha process and
     *  takes the rest of the file with it (measured, twice now). `--target` validates against the
     *  registry instead, so naming one that is *not* there is the same question asked safely. */
    const error = await expectCliFailure(() =>
      runCli({ argv: ['publish', '--target', 'nope', '--dry-run'], cwd: dir }),
    );
    expect(error.message).toContain('fake');
  });

  /**
   * **A command declares itself the way a built-in does** - a function of the application, which
   * is `registerCommand` minus the push onto the module-level registry every `runCli` walks. The
   * fixture writes the bare function for the same reason the others write bare objects.
   */
  describe('a declarative command', () => {
    function declarativeModule(command: string, says: string): string {
      return `export default app => ({
        command: ${JSON.stringify(command)},
        describe: 'declared',
        configKeys: ['vars'],
        config: { loud: { target: 'cli', describe: 'say it louder', type: 'boolean' } },
        handler: args => console.log(${JSON.stringify(says)} + (args.loud ? '!' : '') + ' ' + app.repository.rootPackage.name),
      });`;
    }

    it('is registered, with its options, and runs once the repository exists', async () => {
      const dir = fixture({ commands: ['./c.mjs'] }, { 'c.mjs': declarativeModule('greet', 'hi') });
      const lines = await captureLogs(() => runCli({ argv: ['greet', '--loud'], cwd: dir }));
      /** `app.repository` in the handler is the point: the factory ran after `Repository.create`,
       *  not while the config was being read. */
      expect(lines.join('\n')).toContain('hi! root');
    });

    it('keeps its configKeys, so --config narrows to what it reads', async () => {
      const dir = fixture({ commands: ['./c.mjs'] }, { 'c.mjs': declarativeModule('greet', 'hi') });
      const out = (await captureLogs(() => runCli({ argv: ['greet', '--config'], cwd: dir }))).join('\n');
      expect(out).toContain('the keys greet reads: vars');
    });

    it('still cannot take a built-in name', async () => {
      const dir = fixture({ commands: ['./c.mjs'] }, { 'c.mjs': declarativeModule('publish', 'nope') });
      const error = await expectCliFailure(() => runCli({ argv: ['list'], cwd: dir }));
      expect(error.message).toContain('publish');
    });
  });
});
