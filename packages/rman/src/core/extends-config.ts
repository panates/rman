import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import { isSelectorKey } from './config.js';
import { loadConfigModule } from './load-config-module.js';
import { mergeConfig } from './merge-config.js';
import { resolveConfigTarget } from './resolve-target.js';

/** The key naming configs to inherit from, the way eslint and tsconfig spell it. */
export const EXTENDS_KEY = 'extends';

/**
 * Resolves `config`'s own `extends` into it: every named config is loaded, merged in declaration
 * order, and `config`'s own keys land on top. Returns a new object with no `extends` left in it.
 *
 * The point is a shared package - `extends: "@panates/rman-monorepo"` - so a repository declares
 * its house rules once instead of restating them. `+key` is what makes that liveable (see
 * `mergeConfig`): without it, adding one step to a base's list means copying the list.
 *
 * `from` is the file the `extends` was written in, and everything resolves relative to **it**: a
 * bare specifier through that file's own `node_modules`, a relative path against its directory.
 * Resolving from rman's own location instead would look in rman's dependencies, where a
 * repository's shared config has no reason to be.
 *
 * `seen` carries the chain being resolved, so a config that extends its way back to itself is
 * reported rather than recursed into forever.
 */
export async function resolveExtends(config: RmanConfig, from: string, seen: string[] = []): Promise<RmanConfig> {
  const declared = (config as Record<string, unknown>)[EXTENDS_KEY];
  if (declared === undefined) return config;

  const targets = Array.isArray(declared) ? declared : [declared];
  for (const target of targets) {
    if (typeof target !== 'string' || !target.trim()) {
      throw new Error(`"extends" in "${from}" must be a config name or path, or an array of them`);
    }
  }

  const base: RmanConfig = {};
  for (const target of targets as string[]) {
    const file = resolveConfigTarget(target, from, EXTENDS_KEY);
    if (seen.includes(file)) {
      throw new Error(`"extends" forms a cycle: ${[...seen, file].map(f => path.basename(f)).join(' -> ')}`);
    }
    const loaded = await loadConfigFile(file);
    assertNoSelectorExtends(loaded, file);
    // Recursive: a shared config may itself be built on another.
    mergeConfig(base, await resolveExtends(loaded, file, [...seen, file]), file);
  }

  const own = { ...(config as Record<string, unknown>) };
  delete own[EXTENDS_KEY];
  return mergeConfig(base, own) as RmanConfig;
}

/**
 * Refuses `extends` inside a `"[selector]"` block. A selector block is typed as a whole
 * `RmanConfig`, so writing one there looks valid and would simply never be resolved - and a config
 * that quietly does nothing is worse than one that won't load. Inheritance is a statement about
 * the file, not about the packages it happens to name.
 */
export function assertNoSelectorExtends(config: RmanConfig, file: string): void {
  for (const [key, value] of Object.entries(config)) {
    if (!isSelectorKey(key) || !value || typeof value !== 'object') continue;
    if (EXTENDS_KEY in (value as Record<string, unknown>)) {
      throw new Error(
        `"${key}" in "${file}" cannot use "extends" - it belongs at the top level, where it is a ` +
          `statement about this config rather than about the packages the selector names.`,
      );
    }
  }
}

/**
 * Loads one resolved target. YAML and JSON are read directly; anything else goes through
 * `loadConfigModule`, so a shared config can be a `defineConfig` module with real logic in it.
 *
 * **Through that function rather than a bare `await import()`, which is what this used to do.**
 * The two are not equivalent under an ESM loader hook: a `.cjs` base came back as an empty object,
 * and an empty object is a valid config, so it contributed nothing and said nothing. See there for
 * the measurement - the same file loaded correctly when it was a *directory's* own `.rmanrc.cjs`,
 * because that path always used the careful loader.
 */
async function loadConfigFile(file: string): Promise<RmanConfig> {
  const ext = path.extname(file);
  if (ext === '.yml' || ext === '.yaml') {
    const obj = yaml.load(fs.readFileSync(file, 'utf-8'));
    return asConfig(obj, file);
  }
  if (ext === '.json') return asConfig(JSON.parse(fs.readFileSync(file, 'utf-8')), file);
  return asConfig(await loadConfigModule(file), file);
}

function asConfig(value: unknown, file: string): RmanConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`"${file}" does not export an rman config object`);
  }
  const config = { ...(value as Record<string, unknown>) };
  // Editor tooling only - meaningless once merged, and `additionalProperties` would reject it
  // wherever it ended up.
  delete config.$schema;
  return config as RmanConfig;
}
