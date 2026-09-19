import fs from 'node:fs';
import path from 'node:path';
import { interpolateConfig } from '../core/config.js';
import { Manifest } from '../core/manifest.js';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import type { RunStepValue } from '../core/run-step.js';
import { Service } from '../core/service.js';
import { GitHelper } from '../utils/git.js';
import { expandReleaseTag, isCalendarVersion } from '../utils/release-version.js';
import { stampVersionLabel } from '../utils/version-stamp.js';
import { ChangeHashService } from './change-hash.service.js';
import { RunService } from './run.service.js';
import { VersionPlanService } from './version-plan.service.js';

/**
 * Applying a version plan: the writes. Every manifest edit, dependency-range refresh, stamp,
 * commit and tag lives here; **what** to write is `VersionPlanService`'s answer.
 *
 * Nothing here knows what a `package.json` is, names an npm script, or runs a command: the version
 * goes through `Manifest`/`ManifestProvider`, refreshing a sibling's dependency range goes through
 * the same provider, and the lifecycle hooks around the write go through
 * `RunService.runLifecycleSlot` - this module only supplies the `.rmanrc version.<slot>` fallback,
 * which is its own config. What is left is git, that config, and the version stamps.
 */
/**
 * A service class - see `ListService` for the shape and `Service` for the three measured
 * consequences a namespace had.
 *
 * **Only `applyPlan` became a method**, because only it takes a repository. `buildCommitMessage`,
 * `stampDockerfile`, `stampSourceFiles` and `normalizeScriptValue` take a `Package` or nothing and
 * stay functions on the namespace below - the same rule that leaves `ChangeHashService` a namespace
 * entirely.
 *
 * **Declared before the namespace**, which TypeScript requires: the other order is
 * `A namespace declaration cannot be located prior to a class with which it is merged`.
 */
export class VersionService extends Service {
  /**
   * Writes every `'bump'` entry's new version into its own manifest (and refreshes any other bumped
   * package's dependency range on it), runs that package's own version-lifecycle hooks or its
   * `.rmanrc version.before`/`.exec`/`.after` around the write - see the `hook` closure below -
   * then commits and tags **once per group** - so independently-versioned groups each get their own clean commit/tag rather than one entangled
   * commit spanning unrelated version lines. Pushes only when `options.push` is set - same as a
   * plain `npm version`, this never reaches the network on its own otherwise.
   */
  async applyPlan(
    plan: VersionPlanService.Entry[],
    options: VersionService.ApplyOptions = {},
  ): Promise<VersionService.ApplyResult> {
    const repository = this.repository;
    const git = new GitHelper({ cwd: repository.dirname });
    // The root's own entry is only ever a real package to write/commit like any other when this
    // *isn't* a monorepo (see `getPlan`) - in a monorepo it's the separate, purely informational
    // entry handled below instead, since it's never published on its own.
    const isRealEntry = (e: VersionPlanService.Entry) => !(repository.monorepo && e.package === repository.rootPackage);
    const bumped = plan.filter(e => e.status === 'bump' && isRealEntry(e));
    /** Keyed by package, not by name: what a manifest calls a sibling is the ecosystem's business,
     *  and the provider doing the rewrite is the thing that knows. */
    const bumpedVersions = new Map(bumped.map(e => [e.package, e.to!] as const));
    /** Repo-relative paths of every file stamped with the new version below (a Dockerfile label, a
     *  source constant), so each lands in the same commit as the bump that made it stale - keyed by
     *  package, the way `changelogFileByPackage` is. */
    const stampedByPackage = new Map<string, string[]>();

    /**
     * Every `version.stamp` entry is checked **before the first write**.
     *
     * "This file names no version I can rewrite" is a *configuration* mistake, knowable without
     * touching anything - and finding it mid-loop left the tree torn: the manifest already bumped
     * on disk, no commit, no tag (measured, exit 1 with `package.json` at the new version). A
     * pre-flight costs one extra read per listed file and turns that into a clean refusal.
     */
    for (const entry of bumped) assertStampable(entry.package, entry.to!);

    for (const entry of bumped) {
      const pkg = entry.package;
      /** The scope these hooks are evaluated against - the only place `${{ pkg.targetVersion }}`
       *  can mean anything, and the reason `DEFERRED_PATHS` left them raw until now. */
      const scope = repository.configScope(pkg, { targetVersion: entry.to! });
      /**
       * One slot of the version lifecycle. This module contributes only the *fallback* - its own
       * `.rmanrc version.<slot>`, evaluated here because these three paths are in `DEFERRED_PATHS`
       * and `${{ pkg.targetVersion }}` exists nowhere else. Whether the package's own declaration
       * pre-empts it, and running the thing, are `RunService`'s (`runLifecycleSlot`), so nothing
       * here names a script, a file, or a shell.
       */
      const hook = (slot: 'before' | 'exec' | 'after') =>
        RunService.runLifecycleSlot(
          pkg,
          VERSION_LIFECYCLE,
          slot,
          RunService.normalizeScriptValue(
            /** `at`: the path is what tells a step function from a value one, and this is a fragment -
             *  without it a function here was called while the hook was being prepared. */
            interpolateConfig(pkg.config?.version?.[slot], scope, { at: ['version', slot] }),
            `version.${slot}`,
          ),
        );
      await hook('before');
      /** Through the manifest, not through a `package.json` field: where a version is written is
       *  the provider's business (see `ManifestProvider`), and this is the one place rman changes
       *  it. */
      pkg.manifest.version = entry.to!;
      /** Which fields hold a sibling reference, and what a reference even looks like, is the
       *  ecosystem's - npm's four fields and its `"workspace:"` protocol used to be spelled out
       *  here. See `ManifestProvider.updateDependencyVersions`. */
      Manifest.updateDependencyVersions(pkg, bumpedVersions);
      await hook('exec');
      pkg.writeManifest();
      // Before the `after` hook, so a script reacting to the bump sees the whole new state.
      const stamped = [
        VersionService.stampDockerfile(pkg, entry.to!),
        ...VersionService.stampSourceFiles(pkg, entry.to!),
      ].filter((f): f is string => !!f);
      if (stamped.length) {
        stampedByPackage.set(
          pkg.name,
          stamped.map(f => path.relative(repository.dirname, f)),
        );
      }
      await hook('after');
    }

    const rootEntry = repository.monorepo ? plan.find(e => e.package === repository.rootPackage) : undefined;
    if (rootEntry?.status === 'bump') {
      repository.rootPackage.manifest.version = rootEntry.to!;
      repository.rootPackage.writeManifest();
    }

    /** Written before the per-group commits below so each group's changelog file lands in the
     *  *same* commit as its version bump, rather than needing a separate `changelog --write` run.
     *  Bounded by each package's own *pre-bump* tag (the same one `getPlan` measured "changed
     *  since" from - see `expandTag`) rather than `changelog`'s own default auto-detection (an npm
     *  registry lookup, falling back to not-yet-pushed commits) - that boundary can drift from the
     *  one `version` itself just used, and the not-yet-pushed fallback needs a configured remote
     *  `version` never required at all. Falls back to `changelog`'s own default only when this
     *  package genuinely has no prior tag (a first-ever release). */
    const changelogFileByPackage = new Map<string, string>();
    if (options.changelog) {
      for (const entry of bumped) {
        const fromTag = ChangeHashService.expandTag(entry.package, entry.from);
        const from = (await git.tagExists(fromTag)) ? fromTag : undefined;
        const changelogEntries = await this.app.getService('changelog').generateToFile({
          scope: entry.package.name,
          root: true,
          from,
          // The tag for this release doesn't exist yet (it's created below), so changelog's own
          // tag-derived version would resolve to the *previous* release and label the entry with it.
          version: entry.to,
          // version doesn't consult "publish.skip" at all (a package can still be meaningfully
          // versioned/changelogged without ever being published) - this entry was already decided
          // to bump, so its folded-in changelog shouldn't then be silently dropped by that flag.
          includeSkipped: true,
        });
        for (const ce of changelogEntries) {
          changelogFileByPackage.set(
            ce.package.name,
            path.relative(repository.dirname, path.join(ce.package.dirname, ce.filePath)),
          );
        }
      }
    }

    /** The root's own informational version write isn't part of any group's release, but still
     *  needs to land in *some* commit rather than being left as an uncommitted local edit. Committed
     *  *before* the group commits, so the last commit this makes is always a tagged release commit -
     *  otherwise the tag sits one commit behind HEAD and every `git tag --points-at HEAD` consumer
     *  (CI capturing the tag it just released, say) comes up empty in a monorepo. */
    const commits: VersionService.Commit[] = [];
    const tagged: VersionService.Tag[] = [];

    if (rootEntry?.status === 'bump') {
      const message = `chore: sync root version to ${rootEntry.to}`;
      const sha = await git.commit(
        [path.relative(repository.dirname, repository.rootPackage.manifestFileName)],
        message,
      );
      /** No packages: this commit carries the root's informational version and nothing releasable,
       *  which is why `updated` does not count it either. */
      commits.push({ sha, message, packages: [] });
    }

    const byGroup = new Map<string, VersionPlanService.Entry[]>();
    for (const entry of bumped) {
      const list = byGroup.get(entry.groupKey);
      if (list) list.push(entry);
      else byGroup.set(entry.groupKey, [entry]);
    }
    for (const [, groupEntries] of byGroup) {
      const files = groupEntries.map(e => path.relative(repository.dirname, e.package.manifestFileName));
      for (const e of groupEntries) {
        const changelogFile = changelogFileByPackage.get(e.package.name);
        if (changelogFile) files.push(changelogFile);
        files.push(...(stampedByPackage.get(e.package.name) ?? []));
      }
      const message = VersionService.buildCommitMessage(repository, groupEntries, options.message);
      const sha = await git.commit(files, message);
      commits.push({ sha, message, packages: groupEntries.map(e => e.package.name) });
      const tags = new Set(groupEntries.map(e => ChangeHashService.expandTag(e.package, e.to!)));
      for (const tag of tags) {
        const exists = await git.tagExists(tag);
        if (!exists) await git.createTag(tag);
        tagged.push({ name: tag, created: !exists });
      }
    }

    /** A repository release tag, on top of the per-group ones - but only once the root is on a
     *  calendar version. With a single version line the group's own tag already *is* the release
     *  (same version, same commit), and a second name for it would only add noise to every existing
     *  repo's tag space. Created last, so it lands on HEAD rather than behind whichever group
     *  happened to be committed last. */
    if (rootEntry?.status === 'bump' && isCalendarVersion(rootEntry.to!)) {
      const releaseTag = expandReleaseTag(repository.rootPackage, rootEntry.to!);
      if (await git.tagExists(releaseTag)) {
        throw new Error(
          `Release tag "${releaseTag}" already exists - a second release within the same minute. ` +
            'Wait a moment and run again.',
        );
      }
      await git.createTag(releaseTag);
      tagged.push({ name: releaseTag, created: true, release: true });
    }

    const pushed = !!options.push && bumped.length > 0;
    if (pushed) await git.push();
    return { entries: plan, updated: bumped, commits, tags: tagged, pushed };
  }
}

export namespace VersionService {
  export interface ApplyOptions {
    /** Push the resulting commit(s) and tag(s) to the remote once applied. Default false - same
     *  as a plain `npm version`, which never pushes on its own either. */
    push?: boolean;
    /** Overrides `.rmanrc version.commitMessage` (and the built-in default) for every group's
     *  commit this run produces - `{version}` is still substituted the same way. */
    message?: string;
    /** Also writes each bumped package's `CHANGELOG.md` (via `ChangelogService.generateToFile`,
     *  scoped to just the packages this run actually bumped) and folds those file changes into the
     *  same per-group commit, instead of requiring a separate `rman changelog --write` run. */
    changelog?: boolean;
  }

  /**
   * **What `applyPlan` actually did** - which is not derivable from the plan it was given.
   *
   * It used to return that plan, untouched, so the one caller could only re-print the table it had
   * already shown while the commits, the tags and the push stayed silent - the three things a
   * reader does not already know. A `version` run can produce several commits (one per group, plus
   * the root's informational one), tag each group, add a repository release tag, and skip a tag that
   * already existed; none of that is visible from the outside.
   */
  export interface ApplyResult {
    /** The plan, as given - `'bump'` entries included, so a caller can still relate the rest to it. */
    entries: VersionPlanService.Entry[];
    /** The entries whose manifest was actually written. **Not every `'bump'` entry**: a monorepo
     *  root's is informational, and `updated` is the number worth reporting. */
    updated: VersionPlanService.Entry[];
    commits: Commit[];
    /** Every tag this run considered, in creation order. `created: false` means it was already
     *  there and left alone - which is a different outcome from having made it. */
    tags: Tag[];
    /** Whether `git push` ran. `false` is the default and the common case, and saying so is the
     *  point: a release that is committed but not pushed looks identical otherwise. */
    pushed: boolean;
  }

  export interface Commit {
    /** Short sha. */
    sha: string;
    message: string;
    /** The packages whose version this commit carries - empty for the root's informational sync. */
    packages: string[];
  }

  export interface Tag {
    name: string;
    created: boolean;
    /** True for the repository's own release tag, which belongs to no single package. */
    release?: boolean;
  }

  /** `.rmanrc version.commitMessage` (root-level; `{version}` is replaced when every bumped package
   *  in this commit shares one version) - defaults to `"chore(release): v{version}"`, or a plain
   *  listing of `name@version` pairs when this particular commit spans different versions (a
   *  cross-group ripple can land a lone forced patch in a group that otherwise didn't move). */
  export function buildCommitMessage(
    repository: Repository,
    entries: VersionPlanService.Entry[],
    messageOverride?: string,
  ): string {
    const versions = new Set(entries.map(e => e.to));
    if (versions.size === 1) {
      const template = messageOverride ?? repository.rootPackage.config?.version?.commitMessage;
      const version = entries[0].to!;
      if (typeof template === 'string' && template) return template.replace(/\{version\}/g, version);
      return `chore(release): v${version}`;
    }
    if (messageOverride) return messageOverride;
    return `chore(release): ${entries.map(e => `${e.package.name}@${e.to}`).join(', ')}`;
  }

  /**
   * A `version.<slot>` value: one step, or several to run in sequence - the same shape, and now the
   * same function, as `run.<script>.before`/`.exec`/`.after`.
   *
   * It used to be a second implementation living here, and it differed in two ways that both had to
   * go. It **joined an array with `' && '`** into one shell line, which a function step cannot be
   * part of and which was not even right for shell steps - `cd x && y` in one process is not two
   * processes. And it **dropped anything it did not recognize**, so a function here was silently
   * never run. (The doc comment also still named `.script`/`.preScript`/`.postScript`, three keys
   * that have been `before`/`exec`/`after` for a long time.)
   */
  export function normalizeScriptValue(value: unknown, at: string): RunStepValue[] {
    return RunService.normalizeScriptValue(value, at);
  }

  /**
   * Keeps a package's Dockerfile `org.opencontainers.image.version` label in step with the version
   * just written, returning the absolute path when it actually changed (so the caller can fold it
   * into the same commit) and `undefined` otherwise.
   *
   * Here rather than in a build script: the label is a *statement of the package's version*, so it
   * belongs to whatever writes that version - which keeps it in the bump commit, leaves the tree
   * clean, and makes it right for anyone building the Dockerfile by hand. A build-time rewrite is
   * both later than it needs to be and invisible to git.
   *
   * The same path `publish --target docker` builds from (`publish.docker.dockerfile`, default
   * `Dockerfile`), so the two can never disagree about which file this is. Opt out with `.rmanrc
   * "version": { "stampDockerfile": false }`; a package with no Dockerfile, or one that doesn't
   * declare the label, is a no-op either way.
   */
  export function stampDockerfile(pkg: Package, version: string): string | undefined {
    if (pkg.config?.version?.stampDockerfile === false) return undefined;
    const file = path.resolve(pkg.dirname, pkg.config?.publish?.docker?.dockerfile || 'Dockerfile');
    if (!fs.existsSync(file)) return undefined;
    const stamped = stampVersionLabel(fs.readFileSync(file, 'utf-8'), version);
    if (stamped === undefined) return undefined;
    fs.writeFileSync(file, stamped, 'utf-8');
    return file;
  }

  /**
   * Keeps every `.rmanrc "version.stamp"` file's hard-coded version in step with the one just
   * written, returning the absolute paths of the ones that actually changed.
   *
   * Explicitly listed rather than discovered: unlike the OCI Dockerfile label there is no standard
   * saying "this file holds the version". **A listed file a package does not have stays a silent
   * no-op** - that is what lets one `"[*]"` declaration cover a repo where only some packages carry
   * one.
   *
   * **A listed file that exists and cannot be stamped throws.** It used to be the same silent
   * no-op as a missing file, and the two are not the same thing at all: the second means "not this
   * package", the first means the repository asked for something and did not get it. Measured, and
   * it is the bad kind of quiet - a package listing a file holding `const VERSION` (capital, so the
   * pattern missed it) released a tagged commit with a stale constant and said nothing. The error
   * names the file and, when the package's ecosystem declared none, says so.
   *
   * *How* a version is declared is the provider's (`ManifestProvider.stampVersion`); *which* files
   * hold one is the repository's, which is why the list is config and the rewrite is a seam.
   */
  export function stampSourceFiles(pkg: Package, version: string): string[] {
    const stamped: string[] = [];
    for (const entry of readStampEntries(pkg)) {
      const file = path.resolve(pkg.dirname, entry.file);
      if (!fs.existsSync(file)) continue;
      const before = fs.readFileSync(file, 'utf-8');
      const next = Manifest.stampVersion(pkg, file, before, version, { constant: entry.constant });
      if (next === undefined) {
        const relative = path.relative(pkg.dirname, file);
        throw new Error(
          `"version.stamp" lists "${relative}" for "${pkg.name}", but nothing in it could be ` +
            `rewritten to ${version}.\n` +
            (pkg.provider
              ? `  The "${pkg.provider}" provider looked and found no version to change. Name the ` +
                `identifier with { file, constant } if it is not "version", or drop the entry.`
              : `  This package belongs to no ecosystem (no plugin claimed it), so nothing knows how ` +
                `a version is declared in it. Name a plugin in .rmanrc "plugins".`),
        );
      }
      /** Matched, but already reads the target - nothing to write and nothing to report. Distinct
       *  from the `undefined` above, which is "nothing here to rewrite at all". */
      if (next === before) continue;
      fs.writeFileSync(file, next, 'utf-8');
      stamped.push(file);
    }
    return stamped;
  }
}

/**
 * The lifecycle name `runVersionScript` asks the contributed step sources about. `'version'` because
 * that is what the operation is called - which npm then spells `preversion`/`version`/`postversion`
 * on its own, since `pre`/`post` is its convention and its source knows it. Another ecosystem's
 * source is free to answer this name however it spells the same idea.
 */
const VERSION_LIFECYCLE = 'version';

/**
 * `.rmanrc "version.stamp"`, normalized: a bare string is the file, an object may also name the
 * identifier that holds the version (`{ file: 'src/version.go', constant: 'Version' }`).
 *
 * The object form exists because the identifier was unnameable: `stampVersionConstant` took a
 * `name` and nothing ever passed it, so only the exact lowercase word `version` was ever matched -
 * `VERSION`, `Version` and `appVersion` were all silently skipped.
 */
function readStampEntries(pkg: Package): { file: string; constant?: string }[] {
  const configured = pkg.config?.version?.stamp;
  const list = Array.isArray(configured) ? configured : configured ? [configured] : [];
  const entries: { file: string; constant?: string }[] = [];
  for (const item of list) {
    if (typeof item === 'string') entries.push({ file: item });
    else if (item && typeof item === 'object' && typeof (item as any).file === 'string') {
      entries.push({ file: (item as any).file, constant: (item as any).constant });
    }
  }
  return entries;
}

/**
 * Throws unless every `.rmanrc "version.stamp"` file that exists for `pkg` holds a version its own
 * ecosystem can rewrite - the dry half of `stampSourceFiles`, run before anything is written.
 *
 * A file that is already at `version` passes: it matched, which is the question being asked here.
 */
function assertStampable(pkg: Package, version: string): void {
  for (const entry of readStampEntries(pkg)) {
    const file = path.resolve(pkg.dirname, entry.file);
    if (!fs.existsSync(file)) continue;
    const next = Manifest.stampVersion(pkg, file, fs.readFileSync(file, 'utf-8'), version, {
      constant: entry.constant,
    });
    if (next !== undefined) continue;
    const relative = path.relative(pkg.dirname, file);
    throw new Error(
      `"version.stamp" lists "${relative}" for "${pkg.name}", but nothing in it could be ` +
        `rewritten to ${version}.\n` +
        (pkg.provider
          ? `  The "${pkg.provider}" provider looked and found no version to change. Name the ` +
            `identifier with { file, constant } if it is not "version", or drop the entry.`
          : `  This package belongs to no ecosystem (no plugin claimed it), so nothing knows how a ` +
            `version is declared in it. Name a plugin in .rmanrc "plugins".`),
    );
  }
}

declare module '../core/service.js' {
  interface ServiceMap {
    version: VersionService;
  }
}
