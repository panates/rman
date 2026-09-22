import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Loads a config module - a `.rmanrc.cjs`/`.mjs`/`.js`, or an `extends` target that is one.
 *
 * **`require()` first, and that is not an optimization.** A CommonJS module's `module.exports` is
 * more reliably observed this way than through dynamic `import()`'s CJS-interop synthesis, which
 * some ESM loader hooks - ts-node/swc-node-style transpilers registered via `--import` - can
 * short-circuit into an **empty object**. `require()` throws `ERR_REQUIRE_ESM` for a genuinely-ESM
 * file (`.mjs`, or `.js` under `"type": "module"`), and only then does this fall back to
 * `import()`, the one case that actually needs it.
 *
 * Either path can hand back an ES module namespace rather than a plain object - Node's
 * `require(esm)` support does this too, not just `import()` - so `.default` is preferred whenever
 * present.
 *
 * **It lives here because `extends` needs it too, and did not have it.** A directory's own
 * `.rmanrc.cjs` went through this while `extends-config.ts` used a bare `await import()`, so the
 * *same file* loaded correctly as a directory's config and came back empty when another config
 * named it - and an empty object is a valid config, so nothing was reported. Measured under mocha:
 * a base declaring `"[*]": { version: { stamp: ['build'] } }`, reached by
 * `extends: './base.cjs'`, contributed nothing; the identical fixture with `base.json` contributed
 * normally, and the same `.cjs` worked from the CLI, where no loader hook is registered.
 *
 * `createRequire` is based on this module's own URL rather than on the config file. That is right
 * here and *not* right for resolving a bare specifier - see `resolveConfigTarget`, which is based
 * on the config file so a package name resolves through the repository's `node_modules` rather than
 * rman's own. By the time a file reaches this function it is already an absolute path.
 */
export async function loadConfigModule(file: string): Promise<any> {
  let mod: any;
  try {
    mod = requireConfigModule(file);
  } catch (e: any) {
    if (e?.code !== 'ERR_REQUIRE_ESM') throw e;
    mod = await import(pathToFileURL(file).href);
  }
  return mod?.default ?? mod;
}

const requireConfigModule = createRequire(import.meta.url);
