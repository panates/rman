import type { PublishFilesKeys, PublishTarget } from '../../../core/interfaces/publish-target.js';
import type { ConfigValue, ScopedVars } from '../../../interfaces/rman-config.interface.js';
import { DOCKER_TARGET, type DockerPublishService } from './docker-publish.service.js';

/**
 * **`publish.docker.*`** - this target's own config block, declared here rather than centrally.
 *
 * Reaches `RmanConfig` through the `PublishTargetConfigs` slot `publish.command.ts` exports, which
 * is the same slot the `node` built-in declares `publish.npm.*` in. Whoever reads a key declares it: the
 * only thing that reads these is `DockerPublishService`, two files away.
 *
 * Required once `"docker"` is one of a package's `publish.target`s - `publish --target docker`
 * errors clearly on a package that opts in and leaves this out.
 */
export interface DockerPublishOptions extends DockerPublishOptionsKeys, ScopedVars {}

/** Every key here is a **value**, so every one is a `ConfigValue` - this target declares no step,
 *  which is what makes the whole block uniform (see `VersionExtraKeys` for the interface where it
 *  is not). */
export interface DockerPublishOptionsKeys extends PublishFilesKeys {
  /** DockerHub image name/repository - bare (e.g. `"my-app"`) to be prefixed with
   *  `--docker-namespace`/`DOCKERHUB_NAMESPACE`, or already-namespaced (contains a `/`) to use
   *  verbatim. */
  image: ConfigValue<string>;
  /** Relative to the package's own directory. Default `"Dockerfile"`. */
  dockerfile?: ConfigValue<string>;
  /**
   * The architectures to build for - `docker buildx build --platform`. Default `["linux/amd64"]`.
   */
  /* **Named `architectures` rather than `platforms`, and that is a collision rather than a
   * preference.** `platforms` is a top-level config key - the technologies a repository holds - and
   * `CODE_SUBTREES` skips that name **at every level** of `Resolved<T>`, so a nested key sharing it
   * came back typed as its own unresolved `ConfigValue`. Measured: `Property 'join' does not exist
   * on type 'ConfigValue<string[]>'`, while the *runtime* resolved it perfectly well - it matches
   * only the first path segment. The type and the runtime disagreeing is the defect; renaming the
   * nested key is the contained half of the fix. Docker's own flag is still `--platform`. */
  architectures?: ConfigValue<string[]>;
  /** Build `cwd` override, relative to the repository root - only needed when the Dockerfile's
   *  own `COPY`/`ADD` paths expect something other than the package's own directory (rare). */
  cwd?: ConfigValue<string>;
  /** Named `docker buildx build --build-context <name>=<path>` entries, keyed by name - each
   *  path is relative to the package's own directory (or absolute). */
  buildContexts?: ConfigValue<Record<string, string>>;
  /** `docker buildx build --build-arg <name>=<value>` entries - a value of exactly `"$NAME"`
   *  expands to `process.env.NAME` at build time (e.g. to pass a CI secret through). */
  buildArgs?: ConfigValue<Record<string, string>>;
  /** A file (relative to the package's own directory) whose contents become the DockerHub repo's
   *  full description, if present. Default `"DOCKER_README.md"`. */
  readme?: ConfigValue<string>;
  /**
   * `docker buildx build --secret` entries, keyed by the secret's id: a build-time value the image's
   * layers never record, where a `buildArgs` value is visible in its history. `"$NAME"` takes it
   * from `process.env.NAME`; anything else is a file, relative to the package. A Dockerfile reads
   * one with `RUN --mount=type=secret,id=<id>`.
   */
  secrets?: ConfigValue<Record<string, string>>;
  /** Tags pushed besides the version's own and its floating one (`latest`, or a prerelease's
   *  identifier) - `"${{ semver.major(pkg.version) }}"` for a major line. */
  tags?: ConfigValue<string[]>;
  /** `docker buildx build --target` - the stage of a multi-stage Dockerfile that becomes the image. */
  target?: ConfigValue<string>;
  /** `--cache-from` / `--cache-to` - where the build reads and writes its layer cache
   *  (`type=gha` on GitHub Actions). Each a single value or a list. */
  cache?: ConfigValue<{ from?: string | string[]; to?: string | string[] }>;
  /** `docker buildx build --label` entries - labels on the image beside the Dockerfile's own. */
  labels?: ConfigValue<Record<string, string>>;
}

/**
 * **Docker, as a publish target** - the core's own, and the reason `PublishTarget` is in the core
 * rather than in a plugin.
 *
 * Any language's project can ship an image; nothing about `docker buildx build --push` is npm's, or
 * Cargo's, or Maven's. It was already a core *service*, and could still only be reached through
 * `rman-node`'s `publish` command - so a repository with no JavaScript in it had to install a Node
 * plugin to push a container. This file is the ten lines that fix that.
 *
 * Opt-in, and therefore no `claims`: most packages in a repository are not images, so a package
 * ships here only by naming `"docker"` in its own `publish.target`.
 */
export const dockerPublishTarget: PublishTarget = {
  name: DOCKER_TARGET,
  describe: 'Build and push a container image (docker buildx build --push)',
  /** An image installs its dependencies from the registries the other targets push to. */
  publishesLast: true,
  options: {
    dockerNamespace: {
      target: 'cli',
      cliName: 'docker-namespace',
      describe:
        'Prefixed onto a bare (no "/") "publish.docker.image" - default: the DOCKERHUB_NAMESPACE ' +
        'environment variable.',
      type: 'string',
    },
  },
  getPlan(ctx) {
    return ctx.app.getService('dockerPublish').getPlan(optionsOf(ctx));
  },
  applyPlan(ctx, plan) {
    /** The entries are this target's own - `getPlan` produced them - so the cast reads back what
     *  was put in rather than claiming anything new. The command only ever passes a plan back to
     *  the target that made it. */
    return ctx.app.getService('dockerPublish').applyPlan(plan as DockerPublishService.Entry[]);
  },
};

/** The shared filters plus the one flag this target declared - read here rather than in the service,
 *  so the service keeps taking a plain options object and stays callable without a CLI. */
function optionsOf(ctx: PublishTarget.Context): DockerPublishService.Options {
  return { ...ctx.options, namespace: ctx.args.dockerNamespace as string | undefined };
}
