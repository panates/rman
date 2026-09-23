/**
 * The `"workspace:"` dependency protocol - pnpm/yarn's spelling for "this dependency is a sibling in
 * this repository", which npm's own workspaces understand too.
 *
 * **The `node` built-in's, because it is a statement about a `package.json` dependency field.** It sat in
 * rman's core with a comment admitting it was only there because `publish` needed it from out here -
 * and now `publish`, the manifest provider and the dependency-range rewrite all live in this
 * package, so nothing in the core ever looked at it.
 */
export interface ParsedWorkspaceRange {
  /** `'*'`/`'^'`/`'~'` for the bare selector forms; `'explicit'` when the protocol is followed by
   *  a concrete semver version/range instead (e.g. `"workspace:^1.0.0"`, `"workspace:1.0.0"`). */
  selector: '*' | '^' | '~' | 'explicit';
  /** Only set when `selector === 'explicit'` - the literal range following `"workspace:"`. */
  range?: string;
}

/** Parses a dependency range value for the pnpm/yarn `"workspace:"` protocol - `undefined` when
 *  `value` isn't a workspace range at all (a plain semver range, or not a string). */
export function parseWorkspaceRange(value: unknown): ParsedWorkspaceRange | undefined {
  if (typeof value !== 'string' || !value.startsWith('workspace:')) return undefined;
  const rest = value.slice('workspace:'.length);
  if (rest === '*' || rest === '^' || rest === '~') return { selector: rest };
  return { selector: 'explicit', range: rest };
}

/**
 * Resolves a parsed workspace range against `version` (the dependency's actual current version)
 * into the real range a registry consumer would need - the same substitution pnpm/yarn's own
 * publish performs: `"*"` pins the exact version (no operator), `"^"`/`"~"` prepend themselves to
 * it, and an explicit range is used verbatim (it was already a real range, just workspace-prefixed).
 */
export function resolveWorkspaceRange(parsed: ParsedWorkspaceRange, version: string): string {
  switch (parsed.selector) {
    case '*':
      return version;
    case '^':
      return `^${version}`;
    case '~':
      return `~${version}`;
    case 'explicit':
      return parsed.range!;
  }
}
