import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'expect';
import { assertNoBuiltinShadowing, defaultCommandGlobs, loadCustomCommands } from '../../src/core/custom-command.js';

const srcIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/index.ts');

describe('core/custom-command', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A repository with a `.rman` directory holding the given modules, keyed by file name. Returns
   *  the default globs for it, which is what a repository declaring no `commands` is loaded from. */
  function fixture(files: Record<string, string>, subdir = '.rman'): string[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-command-test-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, subdir), { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, subdir, name), body);
    return subdir === '.rman' ? defaultCommandGlobs(dir) : [path.join(dir, subdir, '*.mjs')];
  }

  /** `defineCommand` is only an identity function, so a fixture can declare the object directly
   *  rather than importing from a build that may not exist while these tests run. */
  const command = (body: string) => `export default ${body};\n`;

  describe('loadCustomCommands()', () => {
    it('names a command after its file, and keeps the module order stable', async () => {
      const dir = fixture({
        'deploy.mjs': command("{ describe: 'ships it', handler() {} }"),
        'audit.mjs': command("{ describe: 'checks it', handler() {} }"),
      });
      const { commands, errors } = await loadCustomCommands(dir);
      expect(errors).toEqual([]);
      expect(commands.map(c => c.name)).toEqual(['audit', 'deploy']);
      expect(commands.map(c => c.custom?.command)).toEqual(['audit', 'deploy']);
    });

    it('lets an explicit `command` declare positionals, the name coming from its first word', async () => {
      const dir = fixture({ 'deploy.mjs': command("{ command: 'deploy <stage>', describe: 'x', handler() {} }") });
      const { commands } = await loadCustomCommands(dir);
      expect(commands[0]).toMatchObject({ name: 'deploy', custom: { command: 'deploy <stage>' } });
    });

    it('a repository with no .rman directory loads nothing, without touching the disk further', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-command-test-'));
      dirs.push(dir);
      expect(await loadCustomCommands(defaultCommandGlobs(dir))).toEqual({ commands: [], errors: [] });
    });

    /**
     * `.rman/` is the *default value* of `commands`, not a directory the loader knows about - so a
     * repository keeping its commands anywhere else is the same code path, not a second one.
     */
    it('loads from any directory a glob names, not just .rman', async () => {
      const globs = fixture({ 'deploy.mjs': command("{ describe: 'ships it', handler() {} }") }, 'tools');
      const { commands, errors } = await loadCustomCommands(globs);
      expect(errors).toEqual([]);
      expect(commands.map(c => c.name)).toEqual(['deploy']);
    });

    /**
     * **Both forms**, as `PluginContext.addCommand` accepts both. The declarative one is stored
     * unrun: its factory wants `app.repository`, which does not exist while modules are loading.
     */
    it('accepts the declarative form, leaving its factory for the caller to run', async () => {
      const globs = fixture({ 'ship.mjs': 'export default app => ({ describe: "x", handler() {} });\n' });
      const { commands, errors } = await loadCustomCommands(globs);
      expect(errors).toEqual([]);
      expect(commands[0]).toMatchObject({ name: 'ship' });
      expect(typeof commands[0]!.register).toBe('function');
      expect(commands[0]!.custom).toBeUndefined();
    });

    /** `commands` appends and cascades, so one file arrives under several globs as a matter of
     *  course. Registering it twice is what yargs does not survive. */
    it('loads a file named by two globs only once', async () => {
      const globs = fixture({ 'deploy.mjs': command("{ describe: 'x', handler() {} }") }, 'tools');
      const both = [...globs, ...globs.map(g => g.replace('*.mjs', 'deploy.mjs'))];
      const { commands } = await loadCustomCommands(both);
      expect(commands.map(c => c.name)).toEqual(['deploy']);
    });

    it('ignores files that are not loadable modules', async () => {
      const dir = fixture({
        'notes.md': '# not a command',
        'deploy.mjs': command("{ describe: 'x', handler() {} }"),
      });
      const { commands, errors } = await loadCustomCommands(dir);
      expect(commands.map(c => c.name)).toEqual(['deploy']);
      expect(errors).toEqual([]);
    });

    it('reports a broken module instead of throwing, so the rest still load', async () => {
      // One unparseable file must not take `rman publish` down with it.
      const dir = fixture({
        'broken.mjs': 'export default { this is not valid js\n',
        'deploy.mjs': command("{ describe: 'x', handler() {} }"),
      });
      const { commands, errors } = await loadCustomCommands(dir);
      expect(commands.map(c => c.name)).toEqual(['deploy']);
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toContain('broken.mjs');
    });

    it('reports what a module is missing, rather than registering something half-formed', async () => {
      const dir = fixture({
        'nodefault.mjs': 'export const x = 1;\n',
        'nohandler.mjs': command("{ describe: 'x' }"),
        'nodescribe.mjs': command('{ handler() {} }'),
      });
      const { commands, errors } = await loadCustomCommands(dir);
      expect(commands).toEqual([]);
      expect(errors.map(e => path.basename(e.file)).sort()).toEqual([
        'nodefault.mjs',
        'nodescribe.mjs',
        'nohandler.mjs',
      ]);
      // Each reason names the actual omission - "it didn't work" sends nobody anywhere.
      expect(errors.find(e => e.file.includes('nodescribe'))?.reason).toMatch(/describe/);
      expect(errors.find(e => e.file.includes('nohandler'))?.reason).toMatch(/handler/);
      /** **"no command exported", not "no default export"** - the file may well have one, of the
       *  wrong shape, and saying otherwise sends the reader to look at the wrong line. Measured on
       *  a real package: a module exporting the declarative form was refused as having no default
       *  export, which it plainly had. */
      expect(errors.find(e => e.file.includes('nodefault'))?.reason).toMatch(/no command exported/);
    });
  });

  describe('assertNoBuiltinShadowing()', () => {
    it("refuses a command that would take a built-in's name", () => {
      // Thrown, unlike a module that merely fails to load: the file is fine, the *name* is the
      // mistake, and there is no reading of `rman publish` that is safe to guess at.
      const commands = [{ name: 'publish', file: '/x/.rman/publish.mjs', describe: 'x', handler() {} }];
      expect(() => assertNoBuiltinShadowing(commands, ['publish', 'run'])).toThrow(/shadow.*built-in "publish"/s);
    });

    it('allows every other name', () => {
      const commands = [{ name: 'deploy', file: '/x/.rman/deploy.mjs', describe: 'x', handler() {} }];
      expect(() => assertNoBuiltinShadowing(commands, ['publish', 'run'])).not.toThrow();
    });
  });

  /**
   * **The list of built-ins is derived now, so what needs pinning moved.**
   *
   * It used to be a hand-maintained array in `cli.ts`, and this spec compared it against the
   * command sources so that adding a command could not quietly leave a repository's own able to
   * shadow it. `builtInNames` reads `commandRegistry` instead, so the guard and the registrations
   * are the same walk and cannot disagree.
   *
   * What *can* still go wrong is one step earlier: a command registers itself as a side effect of
   * its module being imported, so a new file in `src/commands/` that nothing imports is simply not a
   * command - no error, no entry in `--help`, and a repository's own command free to take its name.
   * That is the drift this pins, now against `commands.ts` rather than `cli.ts`.
   */
  it('commands.ts imports every command module, so each one actually registers', () => {
    const srcDir = path.dirname(srcIndex);
    const barrel = fs.readFileSync(path.resolve(srcDir, 'commands.ts'), 'utf-8');

    const files = fs
      .readdirSync(path.resolve(srcDir, 'commands'))
      .filter(f => f.endsWith('.command.ts'))
      .map(f => f.replace(/\.ts$/, '.js'));
    expect(files.length).toBeGreaterThan(0);

    const missing = files.filter(f => !barrel.includes(`import './commands/${f}'`));
    expect(missing).toEqual([]);
  });

  /**
   * **And both entry points have to reach that barrel**, for two different reasons.
   *
   * `cli.ts` needs the registrations - without them `commandRegistry` is empty and rman has no
   * commands at all. `index.ts` needs the **type** augmentations: each command contributes its own
   * `.rmanrc` keys with a `declare module` block, and a type augmentation applies only where the
   * module declaring it is in the program. Reached from `cli.ts` alone, those keys existed for rman
   * and for nobody else - measured the moment the keys stopped being hand-written in
   * `rman-config.interface.ts`: `rman-node` reading `pkg.config.publish` got
   * `Property 'publish' does not exist on type 'RmanConfig'`.
   */
  it('both cli.ts and index.ts reach the barrel - one for the registrations, one for the types', () => {
    const srcDir = path.dirname(srcIndex);
    for (const entry of ['cli.ts', 'index.ts']) {
      const source = fs.readFileSync(path.resolve(srcDir, entry), 'utf-8');
      expect(source).toMatch(/(import|export \*) .*'\.\/commands\.js'/);
    }
  });
});
