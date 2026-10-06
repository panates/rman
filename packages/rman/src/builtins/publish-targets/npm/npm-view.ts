import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** What the registry knows about one package - the two halves `publish` needs, from one call. */
export interface NpmPackageView {
  /** The version the **`latest` dist-tag** points at, which is what a bare `npm install <name>`
   *  resolves to. Not necessarily the highest: a prerelease published under its own tag, or a
   *  patch to an older line, leaves `latest` where it was. */
  latest?: string;
  /** Every version ever published, `latest` included. */
  versions: string[];
}

/**
 * `npm view <name> version versions --json` - `undefined` for anything that is not an answer (never
 * published, no network, private or restricted with no access). Catch-everything on purpose: every
 * caller treats "no answer" as a legitimate state rather than a failure.
 *
 * **Two fields in one call, because the two questions are genuinely different and `publish` needs
 * both.** Whether *this* version is already out there decides `up-to-date` vs `publish`, and only
 * `versions` can answer it; what `latest` points at is what the plan *reports*, so a reader can see
 * where the registry stands. Asking `latest` alone was the same approximation in both roles, and it
 * is wrong in both directions: a prerelease on its own dist-tag never moves `latest`, so `publish`
 * kept proposing an already-published version until npm answered 403; and a package whose local
 * version is *behind* `latest` was proposed just as wrongly.
 *
 * **`versions` is normalized to an array defensively, and the reason is what happens if it is
 * not.** `includes` exists on a string too, so a bare `"1.0.0"` would answer `versions.includes()`
 * without any error at all - and answer it by substring, where `"1.0.10".includes("1.0.1")` is
 * `true` (measured). npm's own `--json` output *is* a real array here on this npm (measured: a
 * single-entry `maintainers` comes back as `[...]`, not unwrapped), so this guards a shape
 * difference across npm versions rather than one I reproduced - but a silent wrong answer about
 * whether a version is published is worth two lines.
 */
export async function npmViewPackage(
  name: string,
  cwd: string,
  options: { registry?: string; userconfig?: string } = {},
): Promise<NpmPackageView | undefined> {
  const argv = ['view', name, 'version', 'versions', '--json'];
  if (options.registry) argv.push('--registry', options.registry);
  if (options.userconfig) argv.push('--userconfig', options.userconfig);
  try {
    const { stdout } = await execFileAsync('npm', argv, { cwd });
    const text = stdout.trim();
    if (!text) return undefined;
    const raw = JSON.parse(text) as { version?: string; versions?: string | string[] };
    return { latest: raw.version, versions: toVersionList(raw.versions) };
  } catch {
    return undefined;
  }
}

/**
 * `npm view <name> version` - the **`latest` dist-tag's** version, or `undefined` for anything that
 * is not an answer.
 *
 * `packageJsonManifest.publishedVersion` asks this so that `detectChangeHash` can guess a tag name
 * for a package with no release tag at all, and `latest` is the right question for it: it wants the
 * one version the ecosystem considers current, not the set of everything ever published. It passes
 * no options - a bare `npm view` already picks up the repository's own `.npmrc` from `cwd`, which
 * is what that path wants. `publish` asks `npmViewPackage` instead; see there for why.
 */
export async function npmViewVersion(
  name: string,
  cwd: string,
  options: { registry?: string; userconfig?: string } = {},
): Promise<string | undefined> {
  const argv = ['view', name, 'version'];
  if (options.registry) argv.push('--registry', options.registry);
  if (options.userconfig) argv.push('--userconfig', options.userconfig);
  try {
    const { stdout } = await execFileAsync('npm', argv, { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** One published version, as `rman deps` needs it. */
export interface NpmRelease {
  version: string;
  /** The deprecation message, when the version carries one. */
  deprecated?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
}

/** What `rman deps` asks of the registry about one package name. */
export interface NpmReleases {
  /** Every version satisfying the range that was asked about, oldest first. */
  releases: NpmRelease[];
  /** The `latest` dist-tag. */
  latest?: string;
  /** When each version was published, when it was asked for. */
  time?: Record<string, string>;
}

/**
 * `npm view '<name>@<range>' version deprecated peerDependencies peerDependenciesMeta engines` plus
 * the package's `dist-tags` (and `time`, when `withTime`) - two calls, run at once. `undefined` when
 * the registry gave no answer at all.
 *
 * **Not catch-everything, unlike the two above.** A name the registry does not know is an answer
 * `rman deps` has to report, not a state it can treat as "nothing newer".
 */
/* **One call returns every version in the range.** npm answers a range with an array holding one
 * object per matching version - measured at ~0.45s for a range covering dozens - so the cost is
 * per name and not per version. A range matching exactly one version comes back as a bare object
 * instead, which is why the result is normalized.
 *
 * `time` is a separate call because it is the whole package's history: thousands of entries for a
 * package publishing nightlies, so it is fetched only when a minimum age asks for it. */
export async function npmViewReleases(
  name: string,
  range: string,
  cwd: string,
  options: { withTime?: boolean } = {},
): Promise<NpmReleases | undefined> {
  const fields = ['version', 'deprecated', 'peerDependencies', 'peerDependenciesMeta', 'engines'];
  const [releases, tags] = await Promise.all([
    npmViewJson(['view', `${name}@${range}`, ...fields, '--json'], cwd),
    npmViewJson(['view', name, 'dist-tags', ...(options.withTime ? ['time'] : []), '--json'], cwd),
  ]);
  if (tags === undefined) return undefined;
  const list = Array.isArray(releases) ? releases : releases ? [releases] : [];
  const meta = (options.withTime ? tags : { 'dist-tags': tags }) as { 'dist-tags'?: any; time?: any };
  return {
    releases: list.filter((r: any) => typeof r?.version === 'string') as NpmRelease[],
    latest: meta['dist-tags']?.latest,
    time: meta.time,
  };
}

function toVersionList(versions: string | string[] | undefined): string[] {
  if (Array.isArray(versions)) return versions;
  return versions ? [versions] : [];
}

const execFileAsync = promisify(execFile);

/** `npm <argv>` parsed as JSON - `undefined` for a failed call, `null` for an empty answer (a range
 *  no version satisfies). */
async function npmViewJson(argv: string[], cwd: string): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync('npm', argv, { cwd, maxBuffer: 64 * 1024 * 1024 });
    const text = stdout.trim();
    return text ? JSON.parse(text) : null;
  } catch (e: any) {
    /** A range nothing satisfies is answered with `E404 No match found` rather than an empty list. */
    if (argv[1]?.includes('@', 1) && /No match found/.test(String(e?.stdout ?? '') + String(e?.stderr ?? ''))) {
      return null;
    }
    return undefined;
  }
}
