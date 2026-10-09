import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { CleanService } from '../../../../src/builtins/platforms/node/services/clean.service.js';
import { createRepository, useNodeEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-clean-test-'));
}

/** Runs `fn` with console.log swallowed instead of printed - `Clean.clean` logs a line per rm/clean
 *  step, which would otherwise spam test output for no benefit here. */
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

/** Runs `fn` with `process.stdout.isTTY` forced true and every `process.stdout.write()` call
 *  captured instead of hitting the real terminal - the only way to exercise the live
 *  ProgressPanel path (it's auto-disabled outside a TTY, which the test runner isn't). */
async function withLivePanel<T>(fn: () => Promise<T>): Promise<{ result: T; writes: string[] }> {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.write = ((chunk: string) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    const result = await fn();
    return { result, writes };
  } finally {
    process.stdout.write = originalWrite;
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  }
}

describe('services/clean', () => {
  useNodeEcosystem();

  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function writeJson(dir: string, rel: string, data: unknown) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  }

  function writeFile(dir: string, rel: string, content = '') {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }

  const exists = (dir: string, ...rel: string[]) => fs.existsSync(path.join(dir, ...rel));

  describe('TypeScript artifact cleanup (ts-cleanup replacement)', () => {
    it('removes compiled .js/.js.map/.d.ts sitting next to their .ts source, under src and test', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      for (const sub of ['src', 'test']) {
        writeFile(dir, `packages/a/${sub}/foo.ts`, 'export {}');
        writeFile(dir, `packages/a/${sub}/foo.js`);
        writeFile(dir, `packages/a/${sub}/foo.js.map`);
        writeFile(dir, `packages/a/${sub}/foo.d.ts`);
      }
      const repo = await createRepository(dir);

      await captureLogs(() => CleanService.clean(repo));

      for (const sub of ['src', 'test']) {
        expect(exists(dir, `packages/a/${sub}/foo.ts`)).toBe(true);
        expect(exists(dir, `packages/a/${sub}/foo.js`)).toBe(false);
        expect(exists(dir, `packages/a/${sub}/foo.js.map`)).toBe(false);
        expect(exists(dir, `packages/a/${sub}/foo.d.ts`)).toBe(false);
      }
    });

    it('leaves a .d.ts alone when it has no matching .ts/.tsx - presumably hand-written, not build output', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/globals.d.ts');
      const repo = await createRepository(dir);

      await captureLogs(() => CleanService.clean(repo));

      expect(exists(dir, 'packages/a/src/globals.d.ts')).toBe(true);
    });

    /**
     * **Compiled output outside `src`/`test` is swept too, which it was not.** The search was
     * `src`/`test` only, inherited from `ts-cleanup -s src` - and `tsc` writes beside the source
     * whenever a config does not send it elsewhere, which is the accident `clean` is reached for.
     * A package keeping `index.ts` at its own root was therefore never swept at all.
     *
     * Measured on `panates/opra`: ten emitted files under `examples/**` survived every `rman
     * clean`, and `rman lint` there died inside `eslint-plugin-import-x` on one of them - a crash
     * that reads as an eslint problem and is a stale artifact.
     */
    it('removes compiled output beside its source at the package root, not only under src/test', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/index.ts', 'export {}');
      writeFile(dir, 'packages/a/index.js');
      writeFile(dir, 'packages/a/index.js.map');
      writeFile(dir, 'packages/a/index.d.ts');
      const repo = await createRepository(dir);

      await captureLogs(() => CleanService.clean(repo));

      expect(exists(dir, 'packages/a/index.ts')).toBe(true);
      expect(exists(dir, 'packages/a/index.js')).toBe(false);
      expect(exists(dir, 'packages/a/index.js.map')).toBe(false);
      expect(exists(dir, 'packages/a/index.d.ts')).toBe(false);
    });

    /**
     * **The guard that makes the widening safe, and it only applies outside a source root.** Under
     * `src`/`test` everything is TypeScript and a bare `.js` goes; out here it could just as easily
     * be something somebody wrote, and the only evidence either way is whether a `.ts` sits beside
     * it. Without this, widening the search would delete `index.js`, `*.config.js` and
     * `scripts/*.js` from every package in the repository.
     */
    it('leaves a .js at the package root alone when no .ts sits beside it', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/index.js', 'hand written');
      writeFile(dir, 'packages/a/eslint.config.js', 'hand written');
      writeFile(dir, 'packages/a/scripts/release.js', 'hand written');
      /** The orphan rule still holds where it always did: under `src`, a `.js` with no source is
       *  output whose `.ts` was renamed or deleted, and goes. */
      writeFile(dir, 'packages/a/src/orphan.js');
      const repo = await createRepository(dir);

      await captureLogs(() => CleanService.clean(repo));

      expect(exists(dir, 'packages/a/index.js')).toBe(true);
      expect(exists(dir, 'packages/a/eslint.config.js')).toBe(true);
      expect(exists(dir, 'packages/a/scripts/release.js')).toBe(true);
      expect(exists(dir, 'packages/a/src/orphan.js')).toBe(false);
    });

    /**
     * **The build directory is named by the config, never assumed to be `build`.** A repository
     * that calls it `dist` would otherwise have every emitted file in it swept one at a time - each
     * sits beside nothing, so the guard above would not fire either. Its contents are the *point*
     * of a build; `clean.include` removes them when the repository asks.
     */
    it('leaves the configured build directory alone, whatever it is called', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { publish: { npm: { directory: 'dist' } } } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/dist/index.js');
      writeFile(dir, 'packages/a/dist/index.d.ts');
      /** A control: the default name is not special either - with `dist` configured, a stray
       *  `build/` is ordinary ground and its contents follow the usual rule. */
      writeFile(dir, 'packages/a/build/leftover.ts', 'export {}');
      writeFile(dir, 'packages/a/build/leftover.js');
      const repo = await createRepository(dir);

      await captureLogs(() => CleanService.clean(repo));

      expect(exists(dir, 'packages/a/dist/index.js')).toBe(true);
      expect(exists(dir, 'packages/a/dist/index.d.ts')).toBe(true);
      expect(exists(dir, 'packages/a/build/leftover.js')).toBe(false);
    });

    it('prunes a directory left empty by the cleanup, but leaves a directory with remaining files', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      // an orphaned .js with no .ts source at all (e.g. left behind by a renamed/removed
      // source file) - still removed in --all-equivalent mode, emptying its directory.
      writeFile(dir, 'packages/a/src/sub/orphan.js');
      writeFile(dir, 'packages/a/src/keep/thing.ts', 'export {}');
      writeFile(dir, 'packages/a/src/keep/thing.js');
      writeFile(dir, 'packages/a/src/keep/readme.md', 'not build output');
      const repo = await createRepository(dir);

      await captureLogs(() => CleanService.clean(repo));

      expect(exists(dir, 'packages/a/src/sub')).toBe(false);
      expect(exists(dir, 'packages/a/src/keep')).toBe(true);
      expect(exists(dir, 'packages/a/src/keep/readme.md')).toBe(true);
      expect(exists(dir, 'packages/a/src/keep/thing.js')).toBe(false);
    });
  });

  describe('.rmanrc "clean" include/exclude', () => {
    it('a root-level include/exclude reaches every package from the repository root, in one pass', async () => {
      // clean.include is evaluated relative to *root* for root's own config - "packages/*/build"
      // naturally spans every package without any of them needing to declare anything themselves.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ clean: { include: 'packages/*/build', exclude: 'packages/pkg1/*' } }),
      );
      writeJson(dir, 'packages/pkg1/package.json', { name: 'pkg1', version: '1.0.0' });
      writeJson(dir, 'packages/pkg2/package.json', { name: 'pkg2', version: '1.0.0' });
      writeFile(dir, 'packages/pkg1/build/out.js');
      writeFile(dir, 'packages/pkg2/build/out.js');
      const repo = await createRepository(dir);

      await captureLogs(() => CleanService.clean(repo));

      expect(exists(dir, 'packages/pkg1/build')).toBe(true); // excluded at the root
      expect(exists(dir, 'packages/pkg2/build')).toBe(false); // matched and removed
    });

    it("a package's own clean config replaces the root's for that package - it doesn't merge with it", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ clean: { include: 'packages/*/build', exclude: 'packages/pkg1/*' } }),
      );
      writeJson(dir, 'packages/pkg1/package.json', { name: 'pkg1', version: '1.0.0' });
      fs.writeFileSync(
        path.join(dir, 'packages/pkg1/.rmanrc'),
        JSON.stringify({ clean: { include: ['cache', 'build'], exclude: 'build/*.json' } }),
      );
      writeFile(dir, 'packages/pkg1/cache/entry.tmp');
      writeFile(dir, 'packages/pkg1/build/out.js');
      writeFile(dir, 'packages/pkg1/build/meta.json');
      const repo = await createRepository(dir);

      await captureLogs(() => CleanService.clean(repo));

      expect(exists(dir, 'packages/pkg1/cache')).toBe(false);
      expect(exists(dir, 'packages/pkg1/build/out.js')).toBe(false);
      // excluded by pkg1's own "build/*.json" - not touched despite "build" also being included.
      expect(exists(dir, 'packages/pkg1/build/meta.json')).toBe(true);
    });

    it('with no clean config anywhere, only the TypeScript artifact cleanup runs (no error)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await createRepository(dir);

      const lines = await captureLogs(() => CleanService.clean(repo, { progress: false }));
      expect(lines.some(l => l.includes('clean'))).toBe(true);
    });

    it('a package can opt itself out entirely via clean.skip: true', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/a/.rmanrc'), JSON.stringify({ clean: { skip: true } }));
      writeFile(dir, 'packages/a/src/foo.js'); // would otherwise be removed as a ts artifact
      const repo = await createRepository(dir);

      const lines = await captureLogs(() => CleanService.clean(repo));

      expect(exists(dir, 'packages/a/src/foo.js')).toBe(true);
      expect(lines.some(l => l.includes('pkg-a'))).toBe(false);
    });
  });

  /**
   * **A link is removed as a link, never followed.** A build directory can hold one into another
   * package's own build - measured on `panates/syncbridge`, where cleaning `syncbuild` went through
   * `build/node_modules/@syncbridge/common`, emptied `common/build`, and then failed `rmdir` on the
   * link with `ENOTDIR`, saying nothing but `0 succeeded, 1 failed`.
   */
  describe('symbolic links', () => {
    function linkedRepo(): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { clean: { include: 'build' } } }));
      writeJson(dir, 'packages/common/package.json', { name: 'common', version: '1.0.0' });
      writeJson(dir, 'packages/app/package.json', { name: 'app', version: '1.0.0' });
      writeFile(dir, 'packages/common/build/index.js', 'export {};');
      writeFile(dir, 'packages/app/build/main.js', 'export {};');
      fs.mkdirSync(path.join(dir, 'packages/app/build/node_modules'), { recursive: true });
      fs.symlinkSync('../../../common/build', path.join(dir, 'packages/app/build/node_modules/common'));
      return dir;
    }

    it('removes the link and leaves what it points at alone', async () => {
      const dir = linkedRepo();
      const repo = await createRepository(path.join(dir, 'packages/app'));

      await captureLogs(() => CleanService.clean(repo, { progress: false }));

      expect(exists(dir, 'packages/app/build')).toBe(false);
      expect(exists(dir, 'packages/common/build/index.js')).toBe(true);
    });

    it('says why a package failed when there is no panel to replay it', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'solo', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ clean: { include: 'build' } }));
      writeFile(dir, 'build/locked/out.js');
      fs.chmodSync(path.join(dir, 'build/locked'), 0o500);
      const repo = await createRepository(dir);

      /** `logger.error` writes to stdout, like the rest of clean's classic lines. */
      const original = console.log;
      const errors: string[] = [];
      console.log = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
      try {
        await CleanService.clean(repo, { progress: false }).catch(() => undefined);
      } finally {
        console.log = original;
        fs.chmodSync(path.join(dir, 'build/locked'), 0o700);
      }
      expect(errors.join('\n')).toMatch(/root[\s\S]*(EACCES|EPERM)/);
    });
  });

  describe('*.tsbuildinfo cleanup', () => {
    it('removes tsc incremental-build cache files anywhere in the package, but not in node_modules', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/tsconfig.tsbuildinfo');
      writeFile(dir, 'packages/a/dist/tsconfig.build.tsbuildinfo');
      writeFile(dir, 'packages/a/node_modules/dep/tsconfig.tsbuildinfo');
      const repo = await createRepository(dir);

      await captureLogs(() => CleanService.clean(repo));

      expect(exists(dir, 'packages/a/tsconfig.tsbuildinfo')).toBe(false);
      expect(exists(dir, 'packages/a/dist/tsconfig.build.tsbuildinfo')).toBe(false);
      expect(exists(dir, 'packages/a/node_modules/dep/tsconfig.tsbuildinfo')).toBe(true);
    });
  });

  describe('--dry-run', () => {
    it('reports what would be removed (ts artifacts, tsbuildinfo, and glob matches) without removing anything', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ clean: { include: 'build' } }));
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.ts', 'export {}');
      writeFile(dir, 'packages/a/src/foo.js');
      writeFile(dir, 'packages/a/tsconfig.tsbuildinfo');
      writeFile(dir, 'build/out.js');

      const repo = await createRepository(dir);
      const lines = await captureLogs(() => CleanService.clean(repo, { dryRun: true, progress: false }));

      expect(exists(dir, 'packages/a/src/foo.js')).toBe(true);
      expect(exists(dir, 'packages/a/tsconfig.tsbuildinfo')).toBe(true);
      expect(exists(dir, 'build/out.js')).toBe(true);
      expect(lines.some(l => l.includes('would rm'))).toBe(true);
    });
  });

  describe('progress panel', () => {
    it('defaults to the shared ProgressPanel on a TTY - the classic per-target log line is suppressed', async () => {
      // clean's own work is near-instant fs I/O, so the panel's 100ms redraw tick may never fire
      // before the command finishes - the reliable signal is which branch cleanPackage() took,
      // not whether a redraw frame happened to be captured in time.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await createRepository(dir);

      const { result: lines } = await withLivePanel(() => captureLogs(() => CleanService.clean(repo)));
      expect(lines.some(l => l.includes('clean') && l.includes('pkg-a'))).toBe(false);
      // printSummary()'s per-item recap (unconditional, not tied to the redraw timer) confirms
      // the panel really was active.
      expect(lines.some(l => l.includes('✓') && l.includes('pkg-a'))).toBe(true);
    });

    it('--no-progress stays on the classic per-target log even when stdout is a TTY', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await createRepository(dir);

      const { result: lines } = await withLivePanel(() =>
        captureLogs(() => CleanService.clean(repo, { progress: false })),
      );
      expect(lines.some(l => l.includes('clean') && l.includes('pkg-a'))).toBe(true);
    });

    it('reports a per-package success tally once done', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await createRepository(dir);

      const lines = await captureLogs(() => CleanService.clean(repo));
      expect(lines.some(l => /\d+ succeeded/.test(l))).toBe(true);
    });
  });

  describe('cwd scoping (Repository.currentPackage)', () => {
    it('running from inside a single package only cleans that package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.js');
      writeFile(dir, 'packages/b/src/bar.js');

      const repo = await createRepository(path.join(dir, 'packages/a'));
      const lines = await captureLogs(() => CleanService.clean(repo));

      expect(exists(dir, 'packages/a/src/foo.js')).toBe(false);
      expect(exists(dir, 'packages/b/src/bar.js')).toBe(true);
      expect(lines.some(l => l.includes('pkg-b'))).toBe(false);
    });

    it('--from-root (fromRoot: true) cleans the whole repository even from inside a single package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.js');
      writeFile(dir, 'packages/b/src/bar.js');

      const repo = await createRepository(path.join(dir, 'packages/a'));
      await captureLogs(() => CleanService.clean(repo, { fromRoot: true }));

      expect(exists(dir, 'packages/a/src/foo.js')).toBe(false);
      expect(exists(dir, 'packages/b/src/bar.js')).toBe(false);
    });
  });

  describe('--log-level (classic per-item log, panel off)', () => {
    // Note: the final "N succeeded, M failed" tally comes from the shared ProgressPanel and is
    // unaffected by --log-level (same as run/build) - only the ad-hoc classic clean/rm lines this
    // command prints itself are gated.
    it('logLevel: "silent" suppresses the classic clean/rm lines entirely', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.js');
      const repo = await createRepository(dir);

      const lines = await captureLogs(() => CleanService.clean(repo, { logLevel: 'silent', progress: false }));
      expect(lines.some(l => l.includes('pkg-a'))).toBe(false);
      // the level only affects logging - the actual cleanup still happened.
      expect(exists(dir, 'packages/a/src/foo.js')).toBe(false);
    });

    it('the default level still shows the classic clean/rm lines (unchanged from before --log-level support)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.js');
      const repo = await createRepository(dir);

      const lines = await captureLogs(() => CleanService.clean(repo, { progress: false }));
      expect(lines.some(l => l.includes('pkg-a'))).toBe(true);
    });

    it('.rmanrc "logLevel" sets the default when no explicit option is passed', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ logLevel: 'silent' }));
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.js');
      const repo = await createRepository(dir);

      const lines = await captureLogs(() => CleanService.clean(repo, { progress: false }));
      expect(lines.some(l => l.includes('pkg-a'))).toBe(false);
    });
  });
});
