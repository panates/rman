import fs from 'fs';
import * as yaml from 'js-yaml';
import { createRequire } from 'module';
import path from 'path';
import merge from 'putil-merge';
import { pathToFileURL } from 'url';

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
    /** Which registries `publish` should target for this package - default `['npm']` (every
     *  existing repo keeps working unchanged). A package that only ever wants Docker images
     *  (typically also `"private": true`, since it's not meant for npm at all) sets `['docker']`;
     *  one that publishes both sets `['npm', 'docker']`. */
    target?: PublishTarget | PublishTarget[];
    docker?: DockerPublishOptions;
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
}

/**
 * Identity helper for authoring a `.rmanrc.cjs`/`.mjs`/`.js` config with full type-checking and
 * autocomplete - the same `defineConfig` pattern Vite/Vitest use. Returns `config` completely
 * unchanged; this exists purely so TypeScript can infer/check against `RmanConfig`, not for any
 * runtime behavior:
 *
 *   // .rmanrc.mjs
 *   import { defineConfig } from 'rman';
 *   export default defineConfig({ packageManager: 'pnpm' });
 *
 *   // .rmanrc.cjs
 *   const { defineConfig } = require('rman');
 *   module.exports = defineConfig({ packageManager: 'pnpm' });
 */
export function defineConfig(config: RmanConfig): RmanConfig {
  return config;
}

/** `.rmanrc.cjs`/`.rmanrc.mjs`/`.rmanrc.js`, checked in this order - a JS module whose default
 *  export (or, lacking one, the module's own exports object) is the config. Both CommonJS (`.cjs`,
 *  or a `.js` under a `"type": "commonjs"` package.json) and native ESM (`.mjs`, or a `.js` under
 *  `"type": "module"`) are supported - the reason `readDirConfig`/`resolveConfig` are async at all. */
const JS_CONFIG_FILES = ['.rmanrc.cjs', '.rmanrc.mjs', '.rmanrc.js'];

const requireJsConfig = createRequire(import.meta.url);

/**
 * Loads `file`'s config object. Tries `require()` first - not just an optimization: a CommonJS
 * module's `module.exports` is more reliably observed this way than through dynamic `import()`'s
 * CJS-interop synthesis, which some ESM loader hooks (e.g. ts-node/swc-node-style transpilers
 * registered via `--import`) can end up short-circuiting into an empty object. `require()` throws
 * `ERR_REQUIRE_ESM` for a genuinely-ESM file (`.mjs`, or `.js` under `"type": "module"`) - only
 * then does this fall back to `import()`, the one case that actually needs it. Either path can
 * hand back an ES module namespace instead of a plain object (Node's `require(esm)` support does
 * this too, not just `import()`), so `.default` is preferred whenever present.
 */
async function loadJsConfig(file: string): Promise<any> {
  let mod: any;
  try {
    mod = requireJsConfig(file);
  } catch (e: any) {
    if (e?.code !== 'ERR_REQUIRE_ESM') throw e;
    mod = await import(pathToFileURL(file).href);
  }
  return mod?.default ?? mod;
}

/**
 * Reads the rman configuration defined at a single directory level, merging
 * (in increasing precedence): `package.json#rman`, `.rmanrc.yml`, `.rmanrc`,
 * then `.rmanrc.cjs`/`.rmanrc.mjs`/`.rmanrc.js` (whichever exist, in that order).
 */
export async function readDirConfig(dirname: string): Promise<RmanConfig> {
  const result: RmanConfig = {};

  const pkgJsonFile = path.join(dirname, 'package.json');
  if (fs.existsSync(pkgJsonFile)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf-8'));
    if (pkgJson && typeof pkgJson.rman === 'object') merge(result, pkgJson.rman, { deep: true });
  }

  const ymlFile = path.join(dirname, '.rmanrc.yml');
  if (fs.existsSync(ymlFile)) {
    const obj = yaml.load(fs.readFileSync(ymlFile, 'utf-8'));
    if (obj && typeof obj === 'object') merge(result, obj, { deep: true });
  }

  const rcFile = path.join(dirname, '.rmanrc');
  if (fs.existsSync(rcFile)) {
    const obj = JSON.parse(fs.readFileSync(rcFile, 'utf-8'));
    if (obj && typeof obj === 'object') merge(result, obj, { deep: true });
  }

  for (const jsFileName of JS_CONFIG_FILES) {
    const jsFile = path.join(dirname, jsFileName);
    if (fs.existsSync(jsFile)) {
      const obj = await loadJsConfig(jsFile);
      if (obj && typeof obj === 'object') merge(result, obj, { deep: true });
    }
  }

  return result;
}

/**
 * Resolves the effective config for `targetDir` by cascading from `rootDir`
 * down to `targetDir` (inclusive), the same way tsconfig's `extends` chain
 * works: each directory level overrides the ones above it. This lets a
 * package (or any intermediate directory) narrow or override the repository's
 * root configuration for itself and everything below it.
 */
export async function resolveConfig(
  rootDir: string,
  targetDir: string,
  cache: Map<string, RmanConfig> = new Map(),
): Promise<RmanConfig> {
  const result: RmanConfig = {};
  for (const dir of dirChain(rootDir, targetDir)) {
    let local = cache.get(dir);
    if (!local) {
      local = await readDirConfig(dir);
      cache.set(dir, local);
    }
    merge(result, local, { deep: true });
  }
  return result;
}

function dirChain(rootDir: string, targetDir: string): string[] {
  const rel = path.relative(rootDir, targetDir);
  if (!rel || rel === '.' || rel.startsWith('..')) return [rootDir];
  const dirs = [rootDir];
  let dir = rootDir;
  for (const segment of rel.split(path.sep)) {
    dir = path.join(dir, segment);
    dirs.push(dir);
  }
  return dirs;
}
