import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import publishCommand from '../../src/cmd/publish.command.js';
import { type PublishTarget, shipsTo } from '../../src/core/publish-target.js';
import { filterPackages } from '../../src/utils/package-filter.js';
import { createRepository, runCli, service, useTarget, useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-publish-cmd-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
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

async function expectCliFailure(fn: () => Promise<void>): Promise<void> {
  await fn().then(
    () => {
      throw new Error('expected the command to fail, but it resolved');
    },
    () => undefined,
  );
}

/**
 * What the fake target was asked, so a spec can assert on the seam rather than on a registry.
 *
 * Module-scope and cleared per case, which is the same shape `registryCalls` has: the target object
 * itself is stateless (one instance is shared by every application the fixture builds), so the
 * recording has to live beside it.
 */
const calls: {
  target: string;
  method: 'getPlan' | 'applyPlan';
  packages: string[];
  options: PublishTarget.Options;
  args: Record<string, any>;
}[] = [];

/** What either fake target did, in order - the seam, rather than a registry, is what these assert. */
function callsTo(name: string) {
  return calls.filter(c => c.target === name);
}

/**
 * A publish target the core could never ship, contributed the way a plugin's is.
 *
 * `claims` is the field worth demonstrating: only the technology that read a manifest can say
 * whether a package with no explicit `publish.target` belongs to a given registry, so this one
 * answers for the fixture's own ecosystem (`'test'`).
 */
function fakeTarget(name: string, options: { claims: boolean }): PublishTarget {
  const target: PublishTarget = {
    name,
    describe: `The core specs' own "${name}" registry`,
    claims: options.claims ? pkg => pkg.provider === 'test' : undefined,
    options: {
      [`${name}Tag`]: {
        target: 'cli',
        cliName: `${name}-tag`,
        describe: `A flag only the "${name}" target knows about`,
        type: 'string',
      },
    },
    async getPlan(ctx) {
      /** Through `shipsTo`, exactly as `DockerPublishService` does: which packages are a target's
       *  own is one question with one implementation, or `publish` and `list --json` drift apart. */
      const packages = filterPackages(ctx.repository.getPackages(), ctx.options).filter(pkg => shipsTo(pkg, target));
      calls.push({
        target: name,
        method: 'getPlan',
        packages: packages.map(p => p.name),
        options: ctx.options,
        args: ctx.args,
      });
      return packages.map(pkg => ({
        package: pkg,
        version: pkg.version,
        status: 'publish' as const,
        detail: `${name}:${pkg.name}`,
        reason: 'never published',
      }));
    },
    async applyPlan(ctx, plan) {
      calls.push({
        target: name,
        method: 'applyPlan',
        packages: plan.map(e => e.package.name),
        options: ctx.options,
        args: ctx.args,
      });
      return plan;
    },
  };
  return target;
}

/** Claims the fixture's packages, so a package that declares nothing lands here. */
const fixtureTarget = fakeTarget('fixture', { claims: true });
/** Claims nothing, so a package reaches it only by naming it - which is what `docker` is, and what
 *  makes "declared beats claimed" testable without a real registry on either side. */
const optInTarget = fakeTarget('optin', { claims: false });

/**
 * `publish` is the **core's** command, and every case here is about the seam that made that
 * possible rather than about any one registry.
 *
 * It was `rman-node`'s until publish targets became contributions, which had the ownership
 * backwards: the plan/confirm/apply shape, the dependency order, `--dry-run` and the JSON a CI gate
 * reads are all facts about a repository, while "is this version on the registry, and how do I push
 * it" is the only part an ecosystem owns. The measured consequence was that `publish --target
 * docker` - implemented in the core all along - could only be reached by installing a Node plugin.
 *
 * So these specs never load `rman-node`. The npm half is exercised where it lives, in that
 * package's own tests.
 */
describe('commands/publish', () => {
  useTestEcosystem();
  useTarget(fixtureTarget);
  useTarget(optInTarget);
  beforeEach(() => {
    calls.length = 0;
  });

  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A repository the fixture's technology claims, with one package below the root. */
  function fixtureRepo(publish?: unknown): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(publish ? { '[*]': { publish } } : {}));
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    return dir;
  }

  it('is a built-in now, so it exists in a repository that names no plugin at all', async () => {
    const dir = fixtureRepo();
    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--dry-run'] }));
    expect(lines.some(l => l.includes('[fixture]') && l.includes('pkg-a'))).toBe(true);
  });

  /**
   * Asserted on the declaration rather than by driving `--help`: yargs' own help handler calls
   * `process.exit`, which in mocha's parallel mode takes the whole worker down with it (measured -
   * "Workerpool Worker terminated Unexpectedly", with the suite still reporting the old count).
   * `toYargsCommand` turns this block into the options, and the argv cases below prove that half.
   */
  it("offers every registered target's flags, the core's docker one included", async () => {
    const dir = fixtureRepo();
    const repository = await createRepository(dir);
    const meta = publishCommand(repository.app);
    const keys = Object.keys(meta.config ?? {});
    /** The core ships `docker` and nothing else, so this flag is there with no plugin asked - which
     *  is the half of the move a Cargo repository actually feels. */
    expect(keys).toContain('dockerNamespace');
    /** And the contributed one beside it: the same mechanism, seen from the other side. */
    expect(keys).toContain('fixtureTag');
    /** `--target`'s choices can only come from the registry now - `'npm' | 'docker'` was written
     *  down by a core that could not know what a repository installed. */
    expect(meta.config?.target?.choices).toEqual(['docker', 'fixture', 'optin']);
  });

  /**
   * Two targets wanting the same flag is a real possibility (npm has a `--registry`, so would a
   * Cargo target), and every rule for picking a winner - registration order, last wins - produces a
   * flag that silently means the other target's thing.
   */
  it('refuses two targets that declare the same option name, instead of letting one win', async () => {
    const dir = fixtureRepo();
    const repository = await createRepository(dir);
    repository.app.publishTargets.add({
      ...fixtureTarget,
      name: 'second',
      options: { fixtureTag: { target: 'cli', describe: 'the same name', type: 'string' } },
    });
    expect(() => publishCommand(repository.app)).toThrow(/both declare an option named "fixtureTag"/);
  });

  describe('a contributed target', () => {
    it("reads its own flag off argv - the core never had to know the flag's name", async () => {
      const dir = fixtureRepo();
      await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--dry-run', '--fixture-tag', 'next'] }));
      expect(callsTo('fixture')[0]?.args.fixtureTag).toBe('next');
    });

    it('is handed the shared filters, so --scope reaches it without the target parsing anything', async () => {
      const dir = fixtureRepo();
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--dry-run', '--scope', 'pkg-a'] }));
      /** Off `ctx.options`, not `ctx.args`: the shared filters are read once by the command through
       *  `readPackageFilterOptions`, so a target never re-parses argv for something every target
       *  needs identically. */
      expect(callsTo('fixture')[0]?.options.scope).toEqual('pkg-a');
      expect(callsTo('fixture')[0]?.packages).toEqual(['pkg-a']);
    });

    it('applyPlan runs only once the plan is confirmed - --dry-run stops before it', async () => {
      const dir = fixtureRepo();
      await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--dry-run'] }));
      expect(callsTo('fixture').map(c => c.method)).toEqual(['getPlan']);

      calls.length = 0;
      await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--yes'] }));
      expect(callsTo('fixture').map(c => c.method)).toEqual(['getPlan', 'applyPlan']);
    });

    it("prints the target's own detail beside a published package, not just the version", async () => {
      const dir = fixtureRepo();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--yes'] }));
      expect(lines.some(l => l.includes('published') && l.includes('fixture:pkg-a'))).toBe(true);
    });
  });

  describe('which packages ship where', () => {
    /**
     * `claims` replaces a hardcoded `['npm']` default in the core - the type half of which was
     * `PublishTarget = 'npm' | 'docker'`. Both are gone: a package that declares nothing is offered
     * to whichever target says it is its own, and a core that knows no ecosystem can say that.
     */
    it('a package declaring no target at all goes to every target that claims it', async () => {
      const dir = fixtureRepo();
      await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--dry-run'] }));
      expect(callsTo('fixture')[0]?.packages).toEqual(['pkg-a']);
      /** And to no target that does not claim it - which is what makes `docker` opt-in. */
      expect(callsTo('optin')[0]?.packages).toEqual([]);
    });

    it('a package declaring a target goes only there, and claims is not consulted at all', async () => {
      const dir = fixtureRepo({ target: ['optin'] });
      await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--dry-run'] }));
      expect(callsTo('optin')[0]?.packages).toEqual(['pkg-a']);
      /** `fixture` claims every `'test'` package, and is still passed over: an explicit
       *  `publish.target` is the whole answer, not one input to it. */
      expect(callsTo('fixture')[0]?.packages).toEqual([]);
    });

    it('list --json reports the same answer publish would - never a guess at ["npm"]', async () => {
      const dir = fixtureRepo();
      await createRepository(dir);
      const items = await service('list').getPackages();
      expect(items.find(i => i.name === 'pkg-a')?.publishTargets).toEqual(['fixture']);
    });

    it('list --json follows an explicit publish.target too, not just what claims it', async () => {
      const dir = fixtureRepo({ target: ['optin'] });
      await createRepository(dir);
      const items = await service('list').getPackages();
      expect(items.find(i => i.name === 'pkg-a')?.publishTargets).toEqual(['optin']);
    });
  });

  describe('a target nothing implements', () => {
    /**
     * This used to be impossible to write: `publish.target` was typed `'npm' | 'docker'` and
     * `--target` carried the same two as `choices`. With targets contributed, the core cannot
     * enumerate them ahead of time, so the check moved to where the facts are - and staying silent
     * would mean a package publishing nowhere at all.
     */
    it('.rmanrc naming an unregistered target fails, naming the ones this repository has', async () => {
      const dir = fixtureRepo({ target: ['cargo'] });
      const lines = await captureLogs(() =>
        expectCliFailure(() => runCli({ cwd: dir, argv: ['publish', '--dry-run'] })),
      );
      const text = lines.join('\n');
      expect(text).toContain('cargo');
      expect(text).toContain('docker, fixture, optin');
    });

    it('--target naming one fails the same way', async () => {
      const dir = fixtureRepo();
      const lines = await captureLogs(() =>
        expectCliFailure(() => runCli({ cwd: dir, argv: ['publish', '--target', 'cargo'] })),
      );
      expect(lines.join('\n')).toContain('cargo');
    });

    it('an explicitly requested target that matches no package is an error, not an empty run', async () => {
      const dir = fixtureRepo();
      const lines = await captureLogs(() =>
        expectCliFailure(() => runCli({ cwd: dir, argv: ['publish', '--target', 'docker'] })),
      );
      expect(lines.some(l => l.includes('no package ships there'))).toBe(true);
    });
  });
});
