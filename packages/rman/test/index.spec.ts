import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import * as api from '../src/index.js';
import { testPlugin, useTestEcosystem } from './_fixture.js';

/**
 * A smoke test for the public programmatic API (`src/index.ts`) - it locks in the exported
 * surface itself (so an internal refactor can't silently drop something consumers rely on) and
 * confirms a couple of entry points actually work end-to-end when imported this way, not just
 * when called from within the CLI commands that normally use them.
 */
describe('public API (src/index.ts)', () => {
  useTestEcosystem();

  it("exports Repository, Package, and each domain's namespace (Changelog, List, Run, Version)", () => {
    expect(typeof api.Repository).toBe('function');
    expect(typeof api.Package).toBe('function');
    expect(typeof api.ChangelogService.prototype.getEntries).toBe('function');
    expect(typeof api.ChangelogService.prototype.generateToFile).toBe('function');
    expect(typeof api.ChangeHashService.detect).toBe('function');
    expect(typeof api.ConventionalCommitsService.parseSubject).toBe('function');
    /** The plan and the writes are separate services: `changed` needs only the first, and used to
     *  have to reach through the writer to get it. */
    expect(typeof api.VersionPlanService.getPlanner).toBe('function');
    expect(typeof api.VersionService.prototype.applyPlan).toBe('function');
    // Docker publishing is core: any language's project can publish an image, so it does not
    // belong to the Node plugin even though `publish` is what drives it today.
    expect(typeof api.DockerPublishService.prototype.getPlan).toBe('function');
    /** A class now, reached through the application - `api.ListService` is the constructor, and
     *  `app.getService('list')` is how a command gets the one instance. */
    expect(typeof api.ListService).toBe('function');
    expect(typeof api.ListService.prototype.getPackages).toBe('function');
    expect(typeof api.RunService.prototype.runScript).toBe('function');
    expect(api.LOG_LEVELS).toEqual(['silent', 'error', 'info', 'verbose']);
    expect(typeof api.defineConfig).toBe('function');
    expect(typeof api.definePlugin).toBe('function');
  });

  /**
   * **The npm-shaped services are exported again, and that is not a relapse.** They left with
   * `rman-node` when the plugin was its own package, and came back when it was folded in - a
   * repository installs rman alone now, so naming `CleanService` from anywhere else is impossible.
   *
   * What has *not* come back is the core assuming any of it: they belong to the `node` built-in,
   * which registers only when a repository names it or detection finds one. The pin that matters is
   * therefore about behaviour, not about the export list - `rman clean` in a repository that is not
   * a Node one is still `Unknown argument`, which `plugin.spec.ts` holds.
   */
  it("exports the node built-in's services, which now ship inside rman", () => {
    for (const name of ['CleanService', 'PublishService', 'CiService']) {
      expect((api as Record<string, unknown>)[name]).toBeDefined();
    }
    /** Still private, though: a helper the plugin uses internally is not part of rman's surface. */
    for (const name of ['parseWorkspaceRange', 'DEPENDENCY_KEYS']) {
      expect((api as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  /**
   * The seams a plugin contributes through.
   *
   * **There are no longer five `addProvider`-shaped ones.** A plugin declares a `Plugin` - the
   * manifest reader, the workspace layout, the step source, the bin directories and the version
   * planner as one thing - because declaring any of them apart from the others was never meaningful:
   * npm's step source reads `pkg.manifest.raw?.scripts`, so without npm's manifest reader it parses
   * whatever another technology produced.
   *
   * `VersionScheme` is abstract, so a class rather than a factory, and `SemverScheme` is exported to
   * subclass rather than restate.
   */
  it('exports every plugin seam', () => {
    expect(typeof api.RmanApplication).toBe('function');
    expect(typeof api.Registry).toBe('function');
    expect(typeof api.Service).toBe('function');
    expect(api.basePlugin.name).toBe('');
    expect(typeof api.Manifest.read).toBe('function');
    expect(typeof api.Workspace.resolve).toBe('function');
    expect(typeof api.BinPath.env).toBe('function');
    expect(typeof api.VersionScheme).toBe('function');
    expect(typeof api.SemverScheme).toBe('function');
    expect(api.semverScheme.bumpNames).toEqual(['patch', 'minor', 'major']);
  });

  it('exports what a plugin needs in order to behave like a built-in command', () => {
    // `rman-node` is an ordinary package importing from here, so this surface is a contract:
    // dropping any of it breaks a plugin rather than an internal caller.
    expect(typeof api.exec).toBe('function');
    expect(typeof api.runBin).toBe('function');
    expect(typeof api.GitHelper).toBe('function');
    expect(typeof api.filterPackages).toBe('function');
    expect(typeof api.applyPackageFilterOptions).toBe('function');
    expect(typeof api.readPackageFilterOptions).toBe('function');
    expect(typeof api.assertAllowedBranch).toBe('function');
    expect(typeof api.applyBranchGuardOptions).toBe('function');
    expect(typeof api.readBranchGuardOptions).toBe('function');
    expect(typeof api.ProgressPanel).toBe('function');
    expect(typeof api.formatDuration).toBe('function');
    expect(typeof api.Logger).toBe('function');
    expect(typeof api.resolveRootLogLevel).toBe('function');
  });

  it('createRepository() + List.getPackages() work when imported from the public entry point, returning data with no console output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-api-test-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      );
      fs.mkdirSync(path.join(dir, 'packages/a'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'packages/a/package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }));
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], {
        cwd: dir,
      });

      /** Still created, and still the thing under test: `Repository.create` is what attaches the
       *  repository to the application the service then works on. */
      /** The public entry point, used the way a consumer would: one application, one repository,
       *  and the service reached through it. */
      const app = new api.RmanApplication();
      app.plugins.add(testPlugin);
      await api.Repository.create(dir, { app });
      const originalLog = console.log;
      const logged: unknown[] = [];
      console.log = (...args: unknown[]) => logged.push(args);
      let packages: api.ListService.Item[];
      try {
        packages = await app.getService('list').getPackages();
      } finally {
        console.log = originalLog;
      }
      expect(logged).toEqual([]); // a service returns data - it never prints anything itself.
      expect(packages.some(p => p.name === 'pkg-a')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
