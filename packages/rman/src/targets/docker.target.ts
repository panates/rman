import type { PublishTarget } from '../core/publish-target.js';
import { DOCKER_TARGET, type DockerPublishService } from '../services/docker-publish.service.js';

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
