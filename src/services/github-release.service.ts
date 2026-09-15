import fs from 'node:fs';
import path from 'node:path';
import fastGlob from 'fast-glob';
import semver from 'semver';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import { expandTag, tagPattern } from '../utils/change-hash.js';
import { GitHelper } from '../utils/git.js';
import { expandReleaseTag, isCalendarVersion, releaseTagPattern } from '../utils/release-version.js';
import { ChangelogService } from './changelog.service.js';

export namespace GithubReleaseService {
  /** Injectable "does this release already exist" check - mainly for tests, so they don't depend
   *  on network access or a real GitHub token. Same shape as `DockerPublishService.Deps`' own
   *  `imageExists`. */
  export interface Deps {
    releaseExists?: (repository: string, tag: string) => Promise<boolean>;
  }

  export interface Options {
    /** Uncommitted local changes anywhere in the repository make the release `'skip'` instead of
     *  `'error'` - same as `version`/`publish`'s other targets. */
    ignoreDirty?: boolean;
    /** `owner/repo` override - otherwise the root's own `publish.github.repository`, falling back
     *  to the `origin` remote's URL. */
    repository?: string;
  }

  /** The repository's release outcome - see `getPlan`. At most one of these: a GitHub Release
   *  belongs to the repository, not to a package. */
  export interface Entry {
    /** Always the repository root - a release covers the whole source tree, not one package. */
    package: Package;
    /** The repository's own release version (see `buildRootEntry`). */
    version: string;
    status: 'publish' | 'skip' | 'up-to-date' | 'error';
    /** The tag this release belongs to - the repository release tag on a calendar version, the
     *  single shared version's tag otherwise. */
    tag?: string;
    /** `owner/repo` this release lands in - unset only when it couldn't be resolved (an `'error'`). */
    repository?: string;
    reason?: string;
  }

  /**
   * Computes what `publish --target github` *would* do - **one** release per run, or none.
   *
   * A GitHub Release is a property of the repository, not of a package: the tag covers the whole
   * source tree, so everything that shipped under it belongs in it. That makes the `"github"`
   * target a repository-level opt-in (typically in the root `.rmanrc`, alongside `"npm"`); it's
   * honored as soon as *any* package resolves it, since a per-package release would have to invent
   * a tag no package owns.
   *
   * The release is identified by the repository's own version (the root's - see
   * `VersionService`'s `buildRootEntry`): its release tag when that version is a calendar one, and
   * otherwise the tag of the single shared version, which is the group's own tag - so a repo with
   * one version line gets no second name for the release it already has. Whether a release exists
   * for that tag decides `'up-to-date'` vs `'publish'`.
   *
   * Uncommitted changes anywhere make it `'error'` unless `options.ignoreDirty` downgrades it to
   * `'skip'`. An unresolvable `owner/repo`, or a lookup that fails for any reason other than "no
   * such release", is `'error'` too - a blocking misconfiguration rather than a silent "not
   * released yet" that only fails later.
   */
  export async function getPlan(repository: Repository, options: Options = {}, deps: Deps = {}): Promise<Entry[]> {
    const root = repository.rootPackage;
    const wanted = [root, ...repository.getPackages()].some(pkg => targetsGithub(pkg) && !pkg.config.publish?.skip);
    if (!wanted) return [];

    const git = new GitHelper({ cwd: repository.dirname });
    const base = { package: root, version: root.version };

    const repo =
      options.repository ?? root.config?.publish?.github?.repository ?? repoFromRemoteUrl(await git.remoteUrl());
    if (!repo) {
      return [
        {
          ...base,
          status: 'error',
          reason: 'cannot resolve "owner/repo" - set "publish.github.repository" or an "origin" remote',
        },
      ];
    }

    const tag = releaseTagFor(root);
    if ((await git.listDirtyFiles()).length) {
      return [
        {
          ...base,
          tag,
          repository: repo,
          status: options.ignoreDirty ? 'skip' : 'error',
          reason: 'uncommitted local changes',
        },
      ];
    }

    // The tag is `version`'s to create, so a missing one means either it never ran or this clone
    // simply doesn't have the tags. Both are refused rather than released: the notes are bounded by
    // the *previous* release tag, which can't be found without it either, so the release would
    // silently come out covering the entire history instead of what actually shipped.
    if (!(await git.tagExists(tag))) {
      return [
        {
          ...base,
          tag,
          repository: repo,
          status: 'error',
          reason: `release tag "${tag}" does not exist here - run "version" first, or fetch tags into this clone`,
        },
      ];
    }

    const releaseExists = deps.releaseExists ?? defaultReleaseExists;
    try {
      const exists = await releaseExists(repo, tag);
      return [
        {
          ...base,
          tag,
          repository: repo,
          status: exists ? 'up-to-date' : 'publish',
          reason: exists ? `${repo} already has a release for ${tag}` : 'never released',
        },
      ];
    } catch (e: any) {
      return [{ ...base, tag, repository: repo, status: 'error', reason: e.message }];
    }
  }

  /**
   * Creates the repository's GitHub Release, then uploads whatever `publish.github.assets` globs
   * match. The body covers **every** package that shipped under this release - not just the ones
   * naming `"github"` as a target - since the tag covers all of their code either way.
   *
   * Each package's notes are bounded by the *previous repository release*, and headed with that
   * package's own version, so a repo whose packages sit on different version lines still reads
   * correctly. A package with nothing in that range simply contributes no section, which is also
   * how a package that didn't ship in this release is left out - no ancestry arithmetic needed.
   *
   * An existing release for the tag is updated rather than treated as a failure, so a re-run after
   * a partial failure converges.
   */
  export async function applyPlan(repository: Repository, plan: Entry[]): Promise<Entry[]> {
    const entry = plan.find(e => e.status === 'publish');
    if (!entry) return plan;

    const git = new GitHelper({ cwd: repository.dirname });
    try {
      const body = await buildReleaseNotes(repository, git, entry.tag!);
      const release = await createOrUpdateRelease(entry.repository!, entry.tag!, {
        name: entry.tag!,
        body,
        draft: !!repository.rootPackage.config?.publish?.github?.draft,
        prerelease: resolvePrerelease(repository.rootPackage, entry.version),
      });
      await uploadAssets(repository, entry.repository!, release.id);
      return plan;
    } catch (e: any) {
      return plan.map(e2 => (e2 === entry ? { ...e2, status: 'error' as const, reason: e.message } : e2));
    }
  }
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_UPLOADS = 'https://uploads.github.com';

function targetsGithub(pkg: Package): boolean {
  const target = pkg.config.publish?.target;
  const targets = Array.isArray(target) ? target : target ? [target] : (['npm'] as RmanConfig.PublishTarget[]);
  return targets.includes('github');
}

/** The tag naming this repository's release. A calendar root version means several version lines,
 *  so the release needs a name of its own (`release-*`); a plain one means every package shares it,
 *  and that shared version's tag already *is* the release. */
function releaseTagFor(root: Package): string {
  return isCalendarVersion(root.version) ? expandReleaseTag(root, root.version) : expandTag(root, root.version);
}

/** The glob matching the tags `releaseTagFor` produces - for stepping back to the previous one. */
function releaseTagGlob(root: Package): string {
  const pattern = isCalendarVersion(root.version) ? releaseTagPattern(root) : tagPattern(root);
  return pattern.replace('{name}', root.name);
}

function resolvePrerelease(root: Package, version: string): boolean {
  const configured = root.config?.publish?.github?.prerelease;
  // A calendar version's time part is a semver prerelease identifier by construction - it says
  // nothing about the release being a preview, so it must not be read as one.
  return configured ?? (!isCalendarVersion(version) && !!semver.prerelease(version));
}

/** `owner/repo` out of either remote URL form git hands back - `git@github.com:owner/repo.git`
 *  (SSH) or `https://github.com/owner/repo.git` (HTTPS, credentials and all). `undefined` for
 *  anything that isn't recognizably a GitHub remote. */
function repoFromRemoteUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function githubToken(): string {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) environment variable is required to publish to GitHub');
  return token;
}

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${githubToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** `GET /repos/{owner}/{repo}/releases/tags/{tag}` - `false` only for a genuine 404 (no release
 *  for that tag yet). Anything else throws rather than reading as "not published": a bad token or
 *  a typo'd repository would otherwise silently plan a publish that only fails much later. */
async function defaultReleaseExists(repository: string, tag: string): Promise<boolean> {
  const res = await fetch(`${GITHUB_API}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: githubHeaders(),
  });
  if (res.ok) return true;
  if (res.status === 404) return false;
  throw new Error(`GitHub release lookup for "${tag}" failed: ${res.status} ${res.statusText}`);
}

/**
 * The release body: one changelog section per package that shipped since the previous repository
 * release. Generated per package rather than in one call, because each carries its own version -
 * under independent versioning they differ, and a single shared label would misname all but one.
 *
 * The boundary is deliberately the previous *release*, not `changelog`'s own auto-detection: the
 * tag being released already exists by the time `publish` runs, so auto-detection would resolve to
 * it and correctly report nothing at all.
 */
async function buildReleaseNotes(repository: Repository, git: GitHelper, releaseTag: string): Promise<string> {
  const root = repository.rootPackage;
  const previous = (await git.describeTag(releaseTagGlob(root), `${releaseTag}^`)) ?? (await git.rootCommit());
  if (!previous) return '';

  const sections: string[] = [];
  for (const pkg of [...repository.getPackages(), root]) {
    const entries = await ChangelogService.getEntries(repository, {
      from: previous,
      root: true,
      includeSkipped: true,
      scope: pkg.name,
      version: pkg.version,
    });
    for (const entry of entries) sections.push(entry.content.trim());
  }
  return sections.join('\n\n');
}

async function createOrUpdateRelease(
  repository: string,
  tag: string,
  fields: { name: string; body: string; draft: boolean; prerelease: boolean },
): Promise<{ id: number }> {
  const res = await fetch(`${GITHUB_API}/repos/${repository}/releases`, {
    method: 'POST',
    headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, ...fields }),
  });
  if (res.ok) return (await res.json()) as { id: number };

  // 422 is how the API reports "a release for this tag already exists" - converge onto it instead
  // of failing, so re-running after a partially failed release finishes the job.
  if (res.status !== 422) {
    throw new Error(`Unable to create GitHub release "${tag}": ${res.status} ${res.statusText}`);
  }
  const existing = await fetch(`${GITHUB_API}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: githubHeaders(),
  });
  if (!existing.ok) {
    throw new Error(`Unable to create GitHub release "${tag}": ${res.status} ${res.statusText}`);
  }
  const release = (await existing.json()) as { id: number };
  const updated = await fetch(`${GITHUB_API}/repos/${repository}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!updated.ok) {
    throw new Error(`Unable to update GitHub release "${tag}": ${updated.status} ${updated.statusText}`);
  }
  return release;
}

/** Every `publish.github.assets` glob across the repository, each resolved against its own
 *  package's directory - an app ships its artifacts from its own folder, but they all land on the
 *  one release the repository cut. */
async function uploadAssets(repository: Repository, repo: string, releaseId: number): Promise<void> {
  for (const pkg of [repository.rootPackage, ...repository.getPackages()]) {
    const patterns = pkg.config.publish?.github?.assets;
    if (!patterns?.length) continue;

    const files = await fastGlob(patterns, { cwd: pkg.dirname, absolute: true, onlyFiles: true });
    for (const file of files) {
      const name = path.basename(file);
      const res = await fetch(
        `${GITHUB_UPLOADS}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: { ...githubHeaders(), 'Content-Type': 'application/octet-stream' },
          body: fs.readFileSync(file),
        },
      );
      if (!res.ok) throw new Error(`Unable to upload asset "${name}": ${res.status} ${res.statusText}`);
    }
  }
}
