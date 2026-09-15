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
  githubRelease?: RmanConfig.GithubReleaseOptions;
  /** Keyed by npm script name (e.g. `"build"`, `"lint"`, `"test"`). A bare string (or array of
   *  them) is shorthand for `{ exec: ... }` - `test: "mocha"` and `test: { exec: "mocha" }` mean
   *  exactly the same thing. */
  run?: Record<string, string | string[] | RmanConfig.RunScriptOptions>;
  /** In-repo packages this one depends on beyond what its real `package.json` declares - purely
   *  for rman's own dependency graph (topo-sort, `--deps`/`--dependents`, `run`'s scheduling). An
   *  array defaults each entry's range to `"*"`; an object gives an explicit name -> range map.
   *  Declared from the root via a selector (`"[pkg-a]": { dependencies: [...] }`) or in the
   *  package's own `.rmanrc`. */
  dependencies?: string[] | Record<string, string>;
  /**
   * Config for **other** packages, keyed by a `"[selector]"` naming them - `"[*]"` for every
   * package in the repository, `"[*-dialect]"` for a glob over package names, `"[pkg-a]"` for one.
   * Everything else in this object configures the package of the directory declaring it, so this
   * is the only way a `.rmanrc` speaks about anything but its own package - most usefully the
   * repository root's, which otherwise configures the root package alone.
   *
   * ```yaml
   * # the repository root's own .rmanrc.yml
   * run:
   *   build:
   *     before: node support/generate.cjs   # a repo-wide bookend, run once at the root
   * "[*]":
   *   run:
   *     build:
   *       after: node ../../support/postbuild.cjs   # run in each package's own directory
   * ```
   *
   * In YAML the quotes are **required**: a bare `[*]` parses as a flow sequence, and `*` as an
   * alias indicator. Precedence, lowest first: `"[*]"`, then other selectors in declaration order,
   * then the package's own unmarked config.
   */
  [selector: `[${string}]`]: unknown;
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
    /** Keep this package's Dockerfile `org.opencontainers.image.version` label in step with the
     *  version being written. Per-package cascaded. Default `true` - the label's value is, by
     *  specification, the version of the packaged software, so there is only ever one correct
     *  value for it, and `version` is what knows it. Only ever *rewrites* a label the Dockerfile
     *  already declares (never inserts one), and reads the same path `publish --target docker`
     *  builds from (`publish.docker.dockerfile`), so a package without one is a no-op. */
    stampDockerfile?: boolean;
    /** Source files whose `version` constant is rewritten to the version being written, in the same
     *  commit as the bump - paths relative to the package's own directory (e.g.
     *  `["src/constants.ts"]`). Per-package cascaded; a listed file a package doesn't have is a
     *  silent no-op, so one `"[*]"` declaration covers a repo where only some packages carry one.
     *
     *  Stamping the source, not the build output: a build-time rewrite leaves the checked-in file
     *  claiming a placeholder, so anything running from source reports that placeholder, git never
     *  records the released version, and the rewrite has to be redone on every build. */
    stamp?: string | string[];
    /** Command(s) run as this package's own `version` npm-lifecycle step, when its `package.json`
     *  doesn't define one itself. An array runs them in sequence. */
    exec?: string | string[];
    /** Same, for `preversion`. */
    before?: string | string[];
    /** Same, for `postversion`. */
    after?: string | string[];
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
    /** Command(s) to run as this script itself, when the package's `package.json` doesn't define
     *  it. An array runs them in sequence. */
    exec?: string | string[];
    /** Same, for this script's `pre<script>` hook. */
    before?: string | string[];
    /** Same, for its `post<script>` hook. */
    after?: string | string[];
    override?: boolean;
  }

  export interface PublishOptions {
    /** Which **registry** `publish` ships this package to - default `['npm']` (every existing repo
     *  keeps working unchanged). A package that only ever wants Docker images (typically also
     *  `"private": true`, since it's not meant for npm at all) sets `['docker']`; both works too.
     *  Each target answers "is this version already out there?" against its own registry, so a
     *  package is never left without one: npm via `npm view`, docker via `docker manifest inspect`.
     *
     *  Note this is strictly about *package distribution*. The repository's GitHub Release is not
     *  a target here - it isn't a place a package ships to, it's the repository's own record that
     *  a release happened, and it is never opted into: see `githubRelease` and the
     *  `github-release` command. */
    target?: PublishTarget | PublishTarget[];
    docker?: DockerPublishOptions;
    /** Excludes this package from `publish` entirely (every target), regardless of
     *  `target`/`"private"` - a single, explicit "never published" statement, e.g. for a package
     *  released through some separate, unrelated process. `changelog` also skips it by default
     *  (see its own `--include-skipped`) - there's little point changelogging something that's
     *  never actually released. Independent of `version`, which never consults this at all - a
     *  package can still be meaningfully versioned without ever being published. */
    skip?: boolean;
  }

  export type PublishTarget = 'npm' | 'docker';

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

  /** Entirely optional - `github-release` needs no configuration at all, since every required fact
   *  (which tag, which repository, what the notes say) already has a sensible source. Nothing here
   *  decides *whether* a release is cut: a release records that the repository shipped, so it is
   *  always cut, and these are only details about how. */
  export interface GithubReleaseOptions {
    /** Files to attach to the release, as glob patterns relative to the package's own directory
     *  (e.g. `["dist/*.tar.gz"]`). Read from **every** package, since one release covers the whole
     *  source tree. A release with no assets at all is still perfectly valid - it records that the
     *  version shipped, which is all a deploy-elsewhere package needs. */
    assets?: string[];
    /** `owner/repo`. Default: parsed from the `origin` remote's URL. Root-level only. */
    repository?: string;
    /** Create the release as an unpublished draft. Default `false`. Root-level only. */
    draft?: boolean;
    /** Default: whether the version being released is itself a semver prerelease (`1.3.0-beta.0`).
     *  Root-level only. */
    prerelease?: boolean;
  }
}
