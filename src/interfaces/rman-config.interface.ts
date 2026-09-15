/**
 * The shape of `.rmanrc`/`.rmanrc.yml`/`.rmanrc.cjs`/`.mjs`/`.js` (and `package.json`'s own
 * `"rman"` key) - see docs/api.md#configuration-rmanrc-rmanrcyml for the full reference. Every
 * field is optional and cascades from the repository root down to each package's own directory.
 * Purely a typing aid (used by `defineConfig` below, and importable on its own for a `.rmanrc.ts`/
 * `.mts` authored config, or a plain `: RmanConfig` annotation) - never read by rman itself, which
 * only ever sees the plain JS object a JS config file exports.
 */
export interface RmanConfig {
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
  logLevel?: 'silent' | 'error' | 'info' | 'verbose';
  allowBranch?: string | string[];
  ignoreBranch?: string | string[];
  group?: boolean | string;
  version?: RmanConfig.VersionOptions;
  changelog?: RmanConfig.ChangelogOptions;
  clean?: RmanConfig.CleanOptions;
  publish?: RmanConfig.PublishOptions;
  /** Keyed by npm script name (e.g. `"build"`, `"lint"`, `"test"`). */
  run?: Record<string, RmanConfig.RunScriptOptions>;
  /** Keyed by the in-repo package's own name. */
  packages?: Record<string, RmanConfig.PackageOptions>;
}

export namespace RmanConfig {
  export interface VersionOptions {
    commitMessage?: string;
    /** Default for `version --changelog` when the CLI flag isn't given - a standing "always fold
     *  the changelog into the version-bump commit" policy, rather than something that behaves
     *  differently on the one run someone forgets to pass `--changelog`. An explicit `--changelog`/
     *  `--no-changelog` on the command line still wins either way. Root-level only. Default `false`. */
    changelog?: boolean;
    /** Tag naming the repository's own release, as opposed to the per-package/group tags
     *  `changelog.tagPattern` names - only created when the root is on a calendar version (a repo
     *  with more than one version line). Root-level only. Default `"release-*"`. Must **not** match
     *  any package's own `changelog.tagPattern`, or that package's changelog boundary will resolve
     *  to the repository release instead of its own last release. */
    releaseTagPattern?: string;
    script?: string | string[];
    preScript?: string | string[];
    postScript?: string | string[];
  }

  export interface ChangelogOptions {
    ignoreTypes?: string[];
    template?: string;
    filePath?: string;
    tagPattern?: string;
  }

  export interface CleanOptions {
    include?: string | string[];
    exclude?: string | string[];
    skip?: boolean;
  }

  export interface RunScriptOptions {
    concurrency?: number;
    topo?: boolean;
    bail?: boolean;
    progress?: boolean;
    logLevel?: 'silent' | 'error' | 'info' | 'verbose';
    changedSince?: string;
    skip?: boolean;
    if?: string;
    script?: string | string[];
    preScript?: string | string[];
    postScript?: string | string[];
    override?: boolean;
  }

  export interface PackageOptions {
    dependencies?: string[] | Record<string, string>;
  }

  export interface PublishOptions {
    /** Where `publish` should release this package to - default `['npm']` (every existing repo
     *  keeps working unchanged). A package that only ever wants Docker images (typically also
     *  `"private": true`, since it's not meant for npm at all) sets `['docker']`; a standalone app
     *  shipped as GitHub Release assets - or deployed elsewhere entirely, with the release only
     *  recording that it happened - sets `['github']`; any combination works (`['npm', 'github']`).
     *  Each target answers "is this version already out there?" against its own registry, so a
     *  package is never left without one: npm via `npm view`, docker via `docker manifest inspect`,
     *  github via the release for that version's tag. */
    target?: PublishTarget | PublishTarget[];
    docker?: DockerPublishOptions;
    github?: GithubPublishOptions;
    /** Excludes this package from `publish` entirely (every target), regardless of
     *  `target`/`"private"` - a single, explicit "never published" statement, e.g. for a package
     *  released through some separate, unrelated process. `changelog` also skips it by default
     *  (see its own `--include-skipped`) - there's little point changelogging something that's
     *  never actually released. Independent of `version`, which never consults this at all - a
     *  package can still be meaningfully versioned without ever being published. */
    skip?: boolean;
  }

  export type PublishTarget = 'npm' | 'docker' | 'github';

  /** Required once `"docker"` is one of this package's `publish.target`s - `publish --target
   *  docker` errors clearly on a package that opts in here but leaves this out. */
  export interface DockerPublishOptions {
    /** DockerHub image name/repository - bare (e.g. `"my-app"`) to be prefixed with
     *  `--docker-namespace`/`DOCKERHUB_NAMESPACE`, or already-namespaced (contains a `/`) to use
     *  verbatim. */
    image: string;
    /** Relative to the package's own directory. Default `"Dockerfile"`. */
    dockerfile?: string;
    /** Default `["linux/amd64"]`. */
    platforms?: string[];
    /** Build `cwd` override, relative to the repository root - only needed when the Dockerfile's
     *  own `COPY`/`ADD` paths expect something other than the package's own directory (rare). */
    cwd?: string;
    /** Named `docker buildx build --build-context <name>=<path>` entries, keyed by name - each
     *  path is relative to the package's own directory (or absolute). */
    buildContexts?: Record<string, string>;
    /** `docker buildx build --build-arg <name>=<value>` entries - a value of exactly `"$NAME"`
     *  expands to `process.env.NAME` at build time (e.g. to pass a CI secret through). */
    buildArgs?: Record<string, string>;
    /** A file (relative to the package's own directory) whose contents become the DockerHub repo's
     *  full description, if present. Default `"DOCKER_README.md"`. */
    readme?: string;
  }

  /** Optional even when `"github"` is one of this package's `publish.target`s - unlike docker,
   *  every required fact (which tag, which repository, what release notes) already has a sensible
   *  source, so a bare `"target": ["github"]` is a complete configuration on its own. */
  export interface GithubPublishOptions {
    /** Files to attach to the release, as glob patterns relative to the package's own directory
     *  (e.g. `["dist/*.tar.gz"]`). A release with no assets is still perfectly valid - it records
     *  that the version shipped, which is all a deploy-elsewhere package needs. */
    assets?: string[];
    /** `owner/repo`. Default: parsed from the `origin` remote's URL. */
    repository?: string;
    /** Create the release as an unpublished draft. Default `false`. */
    draft?: boolean;
    /** Default: whether the version being released is itself a semver prerelease (`1.3.0-beta.0`). */
    prerelease?: boolean;
  }
}
