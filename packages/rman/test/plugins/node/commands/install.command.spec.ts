import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { CiService } from '../../../../src/builtins/platforms/node/services/ci.service.js';
import { appWithStubBin, runCli, useNodeEcosystem } from '../_fixture.js';

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

/** `console` silenced for the run - the stubs print nothing, rman's status line does. */
async function quietly(fn: () => Promise<void>): Promise<void> {
  const original = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
}

/**
 * **What each package manager is handed, flag by flag.** The spellings are the ones each tool's own
 * `install --help` gives - npm 11.12.1, pnpm 12.10.1, bun 1.4.2, yarn 3.4.1 - and the table is the
 * claim, so it is pinned whole rather than one flag at a time.
 */
describe('CiService.installArgv', () => {
  const all = {
    prod: true,
    ignoreScripts: true,
    offline: true,
    dryRun: true,
    registry: 'https://registry.example',
    extra: ['--own-flag'],
  };

  it('spells every option the way that package manager does', () => {
    expect(CiService.installArgv('npm', all)).toEqual([
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--offline',
      '--dry-run',
      '--registry=https://registry.example',
      '--own-flag',
    ]);
    expect(CiService.installArgv('pnpm', all)).toEqual([
      'install',
      '--prod',
      '--ignore-scripts',
      '--offline',
      '--dry-run',
      '--registry=https://registry.example',
      '--own-flag',
    ]);
    expect(CiService.installArgv('bun', all)).toEqual([
      'install',
      '--production',
      '--ignore-scripts',
      '--offline',
      '--dry-run',
      '--registry=https://registry.example',
      '--own-flag',
    ]);
    expect(CiService.installArgv('pnpm', { lockfileOnly: true, preferOffline: true })).toEqual([
      'install',
      '--lockfile-only',
      '--prefer-offline',
    ]);
    expect(CiService.installArgv('npm', { lockfileOnly: true })).toEqual(['install', '--package-lock-only']);
  });

  /** npm has no frozen install that keeps `node_modules`; `npm ci` is its answer to "exactly the
   *  lockfile", and it is the one way this command deletes anything. */
  it('is npm ci under npm for --frozen-lockfile, and the flag everywhere else', () => {
    expect(CiService.installArgv('npm', { frozenLockfile: true, ignoreScripts: true })).toEqual([
      'ci',
      '--ignore-scripts',
    ]);
    for (const manager of ['pnpm', 'bun', 'yarn'] as const) {
      expect(CiService.installArgv(manager, { frozenLockfile: true })).toEqual(['install', '--frozen-lockfile']);
    }
  });

  it('refuses an option the package manager has no spelling of, naming the way round it', () => {
    expect(() => CiService.installArgv('yarn', { prod: true })).toThrow(
      "yarn install has no equivalent of --prod. Pass yarn's own flag after --",
    );
    /** ...and nothing is refused when nothing was asked: a bare install works with all four. */
    for (const manager of CiService.PACKAGE_MANAGERS) {
      expect(CiService.installArgv(manager, {})).toEqual(['install']);
    }
  });

  it('refuses --frozen-lockfile with --lockfile-only', () => {
    expect(() => CiService.installArgv('pnpm', { frozenLockfile: true, lockfileOnly: true })).toThrow(
      'contradict each other',
    );
  });
});

describe('commands/install', () => {
  useNodeEcosystem();

  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-install-cmd-'));
    dirs.push(d);
    return d;
  };
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** `npm` and `pnpm` stand-ins in one directory, each writing its cwd and then its argv, one per
   *  line - contributed through `appWithStubBin`, for the reason `ci.command.spec.ts` gives. */
  function stubs(): { binDir: string; logOf: (name: string) => string[] | undefined } {
    const binDir = tmp();
    const logDir = tmp();
    for (const name of ['npm', 'pnpm']) {
      const log = JSON.stringify(path.join(logDir, `${name}.log`));
      fs.writeFileSync(
        path.join(binDir, name),
        `#!/bin/sh\npwd >> ${log}\nfor a in "$@"; do echo "$a" >> ${log}; done\n`,
        { mode: 0o755 },
      );
    }
    return {
      binDir,
      logOf: name => {
        const file = path.join(logDir, `${name}.log`);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim().split('\n') : undefined;
      },
    };
  }

  /** A pnpm-locked workspace with an installed `node_modules` - which `install`, unlike `ci`, leaves
   *  where it is. */
  function fixture(): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    fs.mkdirSync(path.join(dir, 'node_modules', 'kept'), { recursive: true });
    return dir;
  }

  it("installs once at the root with the lockfile's package manager, deleting nothing", async () => {
    const dir = fixture();
    const { binDir, logOf } = stubs();
    /** From inside a package, under the short name: still the root, still one install. */
    await quietly(() =>
      runCli({
        cwd: path.join(dir, 'packages/a'),
        argv: ['i', '--prod', '--', '--reporter=silent'],
        app: appWithStubBin(binDir),
      }),
    );

    const [cwd, ...argv] = logOf('pnpm')!;
    expect(fs.realpathSync(cwd!)).toBe(fs.realpathSync(dir));
    expect(argv).toEqual(['install', '--prod', '--reporter=silent']);
    expect(logOf('npm')).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'node_modules', 'kept'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))).toBe(true);
  });

  it('takes --package-manager over the lockfile, and refuses a flag that tool cannot spell before running it', async () => {
    const dir = fixture();
    const { binDir, logOf } = stubs();
    await quietly(() =>
      runCli({
        cwd: dir,
        argv: ['install', '--package-manager', 'npm', '--frozen-lockfile'],
        app: appWithStubBin(binDir),
      }),
    );
    expect(logOf('npm')!.slice(1)).toEqual(['ci']);
    expect(logOf('pnpm')).toBeUndefined();

    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ packageManager: { node: 'yarn' } }));
    let failure: unknown;
    await quietly(() =>
      runCli({ cwd: dir, argv: ['install', '--prod'], app: appWithStubBin(binDir) }).catch(e => void (failure = e)),
    );
    expect(String(failure)).toContain('yarn install has no equivalent of --prod');
  });
});
