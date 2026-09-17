import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { readDirConfig } from '../../src/core/config.js';

describe('core/extends-config', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A repository holding a `@test/base` package in its own `node_modules`, the way a shared config
   *  actually arrives - so resolution is exercised through the repository's dependencies rather
   *  than a path. */
  function fixture(files: Record<string, string>, pkgExports: Record<string, string> = { '.': './index.mjs' }): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-extends-test-'));
    dirs.push(dir);
    const base = path.join(dir, 'node_modules', '@test', 'base');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(
      path.join(base, 'package.json'),
      JSON.stringify({ name: '@test/base', version: '1.0.0', exports: pkgExports }),
    );
    for (const [name, body] of Object.entries(files)) {
      const file = name.startsWith('.') ? path.join(dir, name) : path.join(base, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    return dir;
  }

  it('merges a shared package underneath the config that names it', async () => {
    const dir = fixture({
      'index.mjs': "export default { group: true, changelog: { tagPattern: 'v*' } };\n",
      '.rmanrc.yml': "extends: '@test/base'\nchangelog:\n  tagPattern: '{name}@*'\n",
    });
    // The base provides, the declaring file overrides - and "extends" itself is gone.
    expect(await readDirConfig(dir)).toEqual({ group: true, changelog: { tagPattern: '{name}@*' } });
  });

  it('applies an array in declaration order, later entries winning', async () => {
    const dir = fixture(
      {
        'a.mjs': "export default { group: 'from-a', logLevel: 'info' };\n",
        'b.mjs': "export default { group: 'from-b' };\n",
        '.rmanrc.yml': "extends: ['@test/base/a', '@test/base/b']\n",
      },
      { './a': './a.mjs', './b': './b.mjs' },
    );
    expect(await readDirConfig(dir)).toEqual({ group: 'from-b', logLevel: 'info' });
  });

  it('resolves a base that is itself built on another, and lets `+key` accumulate down the chain', async () => {
    // The pairing that makes a shared config liveable: each layer adds a step instead of restating
    // the list, which would freeze a copy of the base at the version it was copied from.
    const dir = fixture(
      {
        'index.mjs': 'export default { "[*]": { run: { build: { before: "base" } } } };\n',
        'strict.mjs': 'export default { extends: "@test/base", "[*]": { run: { build: { "+before": "strict" } } } };\n',
        '.rmanrc.yml': "extends: '@test/base/strict'\n\"[*]\":\n  run:\n    build:\n      +before: 'repo'\n",
      },
      { '.': './index.mjs', './strict': './strict.mjs' },
    );
    const config: any = await readDirConfig(dir);
    // Each layer's append lands as soon as there is something to land on, and the base is merged
    // first - so they resolve here rather than staying outstanding, in chain order.
    expect(config['[*]'].run.build.before).toEqual(['base', 'strict', 'repo']);
    expect(config['[*]'].run.build['+before']).toBeUndefined();
  });

  it('reads a YAML or JSON base as well as a module', async () => {
    const dir = fixture({
      'base.yml': "logLevel: 'verbose'\n",
      '.rmanrc.yml': "extends: './node_modules/@test/base/base.yml'\n",
    });
    expect(await readDirConfig(dir)).toEqual({ logLevel: 'verbose' });
  });

  it('drops a base\'s "$schema", which is editor tooling and nothing else', async () => {
    const dir = fixture({
      'base.json': JSON.stringify({ $schema: './x.json', group: true }),
      '.rmanrc.yml': "extends: './node_modules/@test/base/base.json'\n",
    });
    expect(await readDirConfig(dir)).toEqual({ group: true });
  });

  it('reports a cycle instead of recursing into it', async () => {
    const dir = fixture(
      {
        'a.mjs': "export default { extends: '@test/base/b' };\n",
        'b.mjs': "export default { extends: '@test/base/a' };\n",
        '.rmanrc.yml': "extends: '@test/base/a'\n",
      },
      { './a': './a.mjs', './b': './b.mjs' },
    );
    await expect(readDirConfig(dir)).rejects.toThrow(/forms a cycle/);
  });

  it('names the file and asks the useful question when a target is missing', async () => {
    const dir = fixture({ '.rmanrc.yml': "extends: '@test/not-installed'\n" });
    await expect(readDirConfig(dir)).rejects.toThrow(/could not be resolved.*is it installed in this repository/s);
  });

  it('refuses "extends" inside a selector block, naming the file that holds it', async () => {
    // Typed as a whole RmanConfig, a selector block makes this look valid - and it would simply
    // never be resolved. A config that quietly does nothing is worse than one that won't load.
    const dir = fixture({ '.rmanrc.yml': '"[*]":\n  extends: \'@test/base\'\n' });
    await expect(readDirConfig(dir)).rejects.toThrow(/"\[\*\]" in ".*\.rmanrc\.yml" cannot use "extends"/s);
  });

  it('rejects an "extends" that is not a name or a list of them', async () => {
    const dir = fixture({ '.rmanrc.yml': 'extends: 42\n' });
    await expect(readDirConfig(dir)).rejects.toThrow(/must be a config name or path/);
  });
});
