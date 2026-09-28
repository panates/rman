import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RmanApplication } from '../core/application.js';
import type { Package } from '../core/package.js';
import { type PublishTarget, targetsOf } from '../core/publish-target.js';
import type { Repository } from '../core/repository.js';
import { Service } from '../core/service.js';
import { exec } from '../utils/exec.js';
import { GitHelper } from '../utils/git.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';

/**
 * The name this target answers to in `publish.target` and `--target`.
 *
 * Declared beside the implementation rather than in `publish-target.ts`: the seam is general and
 * must not know any one target's name, and the adapter in `targets/docker.target.ts` reads it from
 * here, which keeps the dependency pointing one way.
 */
export const DOCKER_TARGET = 'docker';

/**
 * A service class - see `ListService` for the shape and `Service` for the three measured
 * consequences a namespace had. `repository` left the signature because the application carries it.
 */
export class DockerPublishService extends Service {
  /**
   * Computes what `publish --target docker` *would* do. Unlike the npm side (opt-out via
   * `"private"`), the docker target is opt-in: only packages whose own (cascaded) `.rmanrc
   * "publish.target"` includes `"docker"` are candidates at all - everything else is left out of
   * the plan entirely, not shown as `'skip'`, since most packages in a repo aren't docker images.
   *
   * A candidate missing the required `publish.docker.image` config is `'error'` - a clear, blocking
   * misconfiguration (opted into the target, forgot the config) rather than a silent no-op. A
   * candidate with uncommitted local changes is `'error'` too, unless `options.ignoreDirty`
   * downgrades it to `'skip'` - same rule the npm side uses. Otherwise, whether `<image>:<version>`
   * already exists on the registry (via `docker manifest inspect`, queried concurrently) decides
   * the rest: `'up-to-date'` if so, `'publish'` if not.
   */
  async getPlan(
    options: DockerPublishService.Options = {},
    deps: DockerPublishService.Deps = {},
  ): Promise<DockerPublishService.Entry[]> {
    const repository = this.repository;
    const git = new GitHelper({ cwd: repository.dirname });
    /** Which packages are the docker target's is the one question `PublishTarget` answers for every
     *  target alike (`publish.target`, or `claims` when a package declares none) - asked through
     *  `targetsOf` rather than re-read here, so `publish` and `list --json` cannot disagree about
     *  where a package ships. */
    const packages = filterPackages(repository.getPackages({ toposort: true }), options).filter(
      pkg => targetsOf(this.app, pkg).some(t => t.name === DOCKER_TARGET) && !pkg.config.publish?.skip,
    );
    const dirtyFiles = await git.listDirtyFiles({ absolute: true });
    const isDirty = (pkg: Package) => dirtyFiles.some(f => !path.relative(pkg.dirname, f).startsWith('..'));
    const imageExists = deps.imageExists ?? defaultImageExists;

    const entries = new Map<string, DockerPublishService.Entry>();
    const toCheck: { pkg: Package; image: string }[] = [];
    for (const pkg of packages) {
      const docker = pkg.config.publish?.docker;
      if (!docker?.image) {
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          status: 'error',
          reason: '"docker" is a publish target but "publish.docker.image" is not configured',
        });
        continue;
      }
      let image: string;
      try {
        image = resolveImageRef(docker.image, options.namespace);
      } catch (e: any) {
        entries.set(pkg.name, { package: pkg, version: pkg.version, status: 'error', reason: e.message });
        continue;
      }
      if (isDirty(pkg)) {
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          image,
          detail: image,
          status: options.ignoreDirty ? 'skip' : 'error',
          reason: 'uncommitted local changes',
        });
        continue;
      }
      toCheck.push({ pkg, image });
    }

    await Promise.all(
      toCheck.map(async ({ pkg, image }) => {
        const exists = await imageExists(image, pkg.version);
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          image,
          detail: image,
          status: exists ? 'up-to-date' : 'publish',
          reason: exists ? `registry already has ${image}:${pkg.version}` : 'never published',
        });
      }),
    );

    return packages.map(pkg => entries.get(pkg.name)!);
  }

  /**
   * Publishes every `'publish'` entry in `plan`: one `docker login` and one `docker buildx create`
   * up front (each package's own build reuses them), then per package a single `docker buildx
   * build --push` using that package's `publish.docker` config (platforms, named build-contexts,
   * build-args, an optional `cwd` override). A package's `publish.docker.readme` file (default
   * `DOCKER_README.md`), if present, updates the DockerHub repo description afterward. A package's
   * own failure doesn't stop unrelated packages elsewhere in the plan.
   */
  async applyPlan(plan: DockerPublishService.Entry[]): Promise<DockerPublishService.Entry[]> {
    const repository = this.repository;
    const toPublish = plan.filter(e => e.status === 'publish');
    if (!toPublish.length) return plan;

    await dockerLogin(repository.app, repository.dirname);
    await exec('docker buildx create --use', {
      cwd: repository.dirname,
      app: repository.app,
      stdio: 'inherit',
      throwOnError: false,
    });

    const result: DockerPublishService.Entry[] = [];
    for (const entry of plan) {
      if (entry.status !== 'publish') {
        result.push(entry);
        continue;
      }
      try {
        await buildAndPush(repository, entry);
        await updateDescription(entry);
        result.push(entry);
      } catch (e: any) {
        result.push({ ...entry, status: 'error', reason: e.message });
      }
    }
    return result;
  }
}

const execFileAsync = promisify(execFile);

/** `docker manifest inspect <image>:<tag>` - `false` for any failure (tag doesn't exist yet, no
 *  network, not logged in, ...), the same catch-everything shape every target's registry check has:
 *  "is this version out there" must never fail the run for a reason that is not an answer. */
async function defaultImageExists(image: string, tag: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['manifest', 'inspect', `${image}:${tag}`]);
    return true;
  } catch {
    return false;
  }
}

function resolveImageRef(image: string, namespaceOverride: string | undefined): string {
  if (image.includes('/')) return image;
  const namespace = namespaceOverride || process.env.DOCKERHUB_NAMESPACE;
  if (!namespace) {
    throw new Error(
      `"publish.docker.image" ("${image}") has no namespace and no --docker-namespace/DOCKERHUB_NAMESPACE is set`,
    );
  }
  return `${namespace}/${image}`;
}

/** A value of exactly `"$NAME"` expands to `process.env.NAME` (empty string if unset) - anything
 *  else (including a value with `$` only as part of a larger string) is passed through verbatim. */
function expandEnvValue(value: string): string {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return match ? (process.env[match[1]] ?? '') : value;
}

async function dockerLogin(app: RmanApplication, cwd: string): Promise<void> {
  const username = process.env.DOCKERHUB_USERNAME;
  const password = process.env.DOCKERHUB_PASSWORD;
  if (!username || !password) {
    throw new Error('DOCKERHUB_USERNAME/DOCKERHUB_PASSWORD environment variables are required to publish to Docker');
  }
  await exec(`echo "${password}" | docker login --username "${username}" --password-stdin`, {
    cwd,
    app,
    stdio: 'inherit',
  });
}

async function buildAndPush(repository: Repository, entry: DockerPublishService.Entry): Promise<void> {
  const pkg = entry.package;
  const docker = pkg.config.publish!.docker!;
  const platforms = docker.platforms?.length ? docker.platforms : ['linux/amd64'];
  const dockerfile = path.resolve(pkg.dirname, docker.dockerfile || 'Dockerfile');
  const cwd = docker.cwd ? path.resolve(repository.dirname, docker.cwd) : pkg.dirname;

  const args = ['buildx', 'build', '--platform', platforms.join(',')];
  for (const [name, dir] of Object.entries(docker.buildContexts ?? {})) {
    args.push('--build-context', `${name}="${path.resolve(pkg.dirname, dir)}"`);
  }
  for (const [name, value] of Object.entries(docker.buildArgs ?? {})) {
    args.push('--build-arg', `${name}="${expandEnvValue(value)}"`);
  }
  args.push(
    '-f',
    `"${dockerfile}"`,
    '-t',
    `"${entry.image}:${entry.version}"`,
    '-t',
    `"${entry.image}:latest"`,
    '--push',
    '.',
  );

  await exec(`docker ${args.join(' ')}`, { cwd, app: repository.app, stdio: 'inherit' });
}

async function updateDescription(entry: DockerPublishService.Entry): Promise<void> {
  const pkg = entry.package;
  const docker = pkg.config.publish!.docker!;
  const readmeFile = path.join(pkg.dirname, docker.readme || 'DOCKER_README.md');
  if (!fs.existsSync(readmeFile)) return;

  const username = process.env.DOCKERHUB_USERNAME;
  const password = process.env.DOCKERHUB_PASSWORD;
  const loginRes = await fetch('https://hub.docker.com/v2/users/login/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!loginRes.ok) throw new Error(`DockerHub login (for description update) failed: ${loginRes.status}`);
  const { token } = await loginRes.json();

  const slashIdx = entry.image!.indexOf('/');
  const namespace = entry.image!.slice(0, slashIdx);
  const imageName = entry.image!.slice(slashIdx + 1);
  const readme = fs.readFileSync(readmeFile, 'utf-8');
  const res = await fetch(`https://hub.docker.com/v2/repositories/${namespace}/${imageName}/`, {
    method: 'PATCH',
    headers: { Authorization: `JWT ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: pkg.manifest.raw.description, full_description: readme }),
  });
  if (!res.ok) throw new Error(`DockerHub description update failed: ${res.status}`);
}

export namespace DockerPublishService {
  /** Injectable "does this tag already exist" check - mainly for tests, so they don't depend on
   *  network access or a real Docker daemon. Same shape as `PublishService.Deps.npmViewVersion`. */
  export interface Deps {
    imageExists?: (image: string, tag: string) => Promise<boolean>;
  }

  export interface Options extends PackageFilterOptions {
    /** A package with uncommitted local changes is excluded (status `'skip'`) instead of aborting
     *  the whole plan (status `'error'`) - same as `version`/`publish --target npm`'s own option. */
    ignoreDirty?: boolean;
    /** Prefixed onto a bare (no `/`) `publish.docker.image` - falls back to the
     *  `DOCKERHUB_NAMESPACE` environment variable. */
    namespace?: string;
  }

  export type ApplyOptions = Options;

  /**
   * One package's outcome in a docker-publish plan - see `getPlan`.
   *
   * A `PublishTarget.Entry` with one field of its own, which is the shape that interface expects: a
   * target knows things about its own registry that no other target has a word for, and `detail` is
   * where it puts whatever the command should print beside the package.
   */
  export interface Entry extends PublishTarget.Entry {
    /** The fully-qualified `<namespace>/<image>` this entry publishes to - unset only when the
     *  package's own `publish.docker.image` config is missing entirely (an `'error'` entry). */
    image?: string;
  }
}

declare module '../core/service.js' {
  interface ServiceMap {
    dockerPublish: DockerPublishService;
  }
}
