import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { copyAssets, DEFAULT_ASSET_PATTERNS } from '../../../../src/builtins/platforms/node/utils/copy-assets.js';
import { runBin } from '../../../../src/utils/run-bin.js';

/**
 * `tsc` itself, from this repository's own install - `copyAssets` asks it for the resolved
 * `rootDir`/`outDir`, and a stand-in answering with JSON would test the parsing and not the question.
 */
const TSC = path.resolve(import.meta.dirname, '../../../../../../node_modules/.bin/tsc');
const realTsc: Parameters<typeof copyAssets>[0]['runBin'] = (bin, argv, options) =>
  runBin(bin === 'tsc' ? TSC : bin, argv, { ...options, logLevel: 'silent' });

describe('plugins/node/copyAssets', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function pkg(files: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-assets-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    }
    return dir;
  }

  const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));

  it('copies json, xml and yaml from rootDir into outDir, keeping the tree, and nothing else', async () => {
    const dir = pkg({
      'tsconfig.json': { compilerOptions: { rootDir: 'src', outDir: 'build' } },
      'src/index.ts': 'export const x = 1;',
      'src/i18n/tr.json': '{"hello":"merhaba"}',
      'src/templates/report.xml': '<report/>',
      'src/data/table.yml': 'a: 1',
      'src/notes.md': '# notes',
    });

    const written = await copyAssets({ tsconfig: path.join(dir, 'tsconfig.json'), runBin: realTsc });

    expect(written.map(f => path.relative(dir, f)).sort()).toEqual([
      path.join('build', 'data', 'table.yml'),
      path.join('build', 'i18n', 'tr.json'),
      path.join('build', 'templates', 'report.xml'),
    ]);
    expect(fs.readFileSync(path.join(dir, 'build/i18n/tr.json'), 'utf-8')).toBe('{"hello":"merhaba"}');
    expect(exists(dir, 'build/notes.md')).toBe(false);
  });

  /** The case `--showConfig` exists here for: the directories come from a base the tsconfig extends,
   *  and are relative to *that* file. */
  it('takes rootDir and outDir through extends, relative to the file that declares them', async () => {
    const dir = pkg({
      'config/base.json': { compilerOptions: { rootDir: '../src', outDir: '../dist' } },
      'tsconfig-build.json': { extends: './config/base.json' },
      'src/index.ts': 'export const x = 1;',
      'src/i18n/en.json': '{}',
    });

    await copyAssets({ tsconfig: path.join(dir, 'tsconfig-build.json'), runBin: realTsc });

    expect(exists(dir, 'dist/i18n/en.json')).toBe(true);
  });

  it("uses the inputs' common directory when no rootDir is declared, as tsc does", async () => {
    const dir = pkg({
      'tsconfig.json': { compilerOptions: { outDir: 'build' }, include: ['src'] },
      'src/index.ts': 'export const x = 1;',
      'src/i18n/en.json': '{}',
    });

    await copyAssets({ tsconfig: path.join(dir, 'tsconfig.json'), runBin: realTsc });

    expect(exists(dir, 'build/i18n/en.json')).toBe(true);
  });

  it('copies nothing when the tsconfig has no outDir - tsc then compiles beside the sources', async () => {
    const dir = pkg({
      'tsconfig.json': { compilerOptions: {} },
      'src/index.ts': 'export const x = 1;',
      'src/i18n/en.json': '{}',
    });

    expect(await copyAssets({ tsconfig: path.join(dir, 'tsconfig.json'), runBin: realTsc })).toEqual([]);
  });

  it('never copies the manifest, the lockfile, a tsconfig or the output directory itself', async () => {
    const dir = pkg({
      'tsconfig.json': { compilerOptions: { rootDir: '.', outDir: 'build' }, include: ['*.ts', 'lib'] },
      'package.json': { name: 'x' },
      'package-lock.json': {},
      'index.ts': 'export const x = 1;',
      'lib/data.json': '{}',
      'build/stale.json': '{}',
    });

    const written = await copyAssets({ tsconfig: path.join(dir, 'tsconfig.json'), runBin: realTsc });

    expect(written.map(f => path.relative(dir, f))).toEqual([path.join('build', 'lib', 'data.json')]);
  });

  it('copies what the patterns name instead of the default', async () => {
    const dir = pkg({
      'tsconfig.json': { compilerOptions: { rootDir: 'src', outDir: 'build' } },
      'src/index.ts': 'export const x = 1;',
      'src/i18n/en.json': '{}',
      'src/sql/schema.sql': 'select 1;',
    });

    await copyAssets({ tsconfig: path.join(dir, 'tsconfig.json'), patterns: ['**/*.sql'], runBin: realTsc });

    expect(exists(dir, 'build/sql/schema.sql')).toBe(true);
    expect(exists(dir, 'build/i18n/en.json')).toBe(false);
  });

  it('names what tsc said when it cannot read the tsconfig', async () => {
    const dir = pkg({ 'tsconfig.json': '{ "extends": "./missing.json" }' });
    await expect(copyAssets({ tsconfig: path.join(dir, 'tsconfig.json'), runBin: realTsc })).rejects.toThrow(
      /missing\.json/,
    );
  });

  it('defaults to the data formats a package keeps beside its sources', () => {
    expect(DEFAULT_ASSET_PATTERNS).toEqual(['**/*.json', '**/*.xml', '**/*.yaml', '**/*.yml']);
  });
});
