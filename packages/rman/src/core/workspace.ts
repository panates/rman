import fs from 'node:fs';
import path from 'node:path';
import type { RmanApplication } from './application.js';
import type { Platform } from './plugin.js';

/**
 * How a repository is laid out, and who decides.
 *
 * A namespace for the same reason `Manifest` is one: it is what a plugin can *augment*
 * (`declare module 'rman' { namespace Workspace { ... } }`), so whatever this seam grows later
 * arrives as a member here rather than as another top-level export.
 */
export namespace Workspace {
  /**
   * **Where one directory's own child packages are** - the directories immediately below it that
   * hold a package, as absolute paths. `undefined` for "this is not a directory I recognize".
   *
   * **A provider answers for one directory, not for the repository**, and that is the whole
   * correction. It used to be `(root) => { root, packageDirs }`: asked once, at the top, by the
   * first platform that recognized it - so in a polyglot repository the technology listed first in
   * `plugins` decided which directories were packages *at all*. Measured, and documented as a known
   * limitation for a year: a `Cargo.toml`-only package was simply not found until a provider that
   * looks for both was listed first.
   *
   * Asked per directory, each platform only ever answers about its own packages - which is all a
   * platform knows - and the recursion is the core's (see `walk`). A Cargo workspace nested inside
   * a Node monorepo is then just a node in the tree whose children came from a different platform.
   *
   * **Children, not descendants.** A provider returning the whole subtree would have to know what
   * the platforms below it consider a package; returning one level means it never has to. npm's
   * `workspaces` globs are already one level by construction (`deep: 0`).
   *
   * Still directories rather than `Package` objects, for the reason it always was: discovery runs
   * before any package exists, so a provider returning packages would make discovery the owner of
   * identity too. A path is also unique by construction, where a name is only unique if the
   * ecosystem says so.
   */
  export type Provider = (dir: string) => string[] | undefined;

  /**
   * One directory in the walk's result: which technology claimed it, and what sits below it.
   *
   * A plain tree rather than `Package`s, keeping the line `Provider` draws: `Repository.create`
   * turns this into packages, so identity stays with the manifest provider and discovery stays
   * with this one.
   */
  export interface Node {
    /** Absolute path to the directory. */
    dirname: string;
    /** The technology that claimed it - `basePlatform` when none did, so a reader needs no guard. */
    platform: Platform;
    /** The nodes for the package directories directly below it, in the order the platform gave
     *  them. Empty for a leaf. */
    children: Node[];
  }

  /**
   * What a directory's `.rmanrc "platform"` resolves to, when it declares one - `undefined` when
   * it says nothing, so the walk falls back to the guess.
   *
   * **A callback rather than config knowledge in here**, which keeps this namespace answering one
   * question. Reading a directory's cascaded config, deciding that a declared name has to be
   * loaded, and refusing one that cannot be, are all the repository's business; where the packages
   * are is this one's. `Repository.create` supplies it - and it is also the seam a spec uses to
   * drive the declaration path without writing a config file.
   */
  export type DeclaredPlatform = (dir: string) => Promise<Platform | undefined>;

  /**
   * **The walk**: descend from `rootDir`, asking each directory's own technology where its children
   * are, and repeating for each answer.
   *
   * One step, applied recursively:
   *
   * 1. take the directory's **declared** platform if it has one, and otherwise the first registered
   *    platform whose manifest provider recognizes it (`app.platformFor`, `basePlatform` if none);
   * 2. ask **that** platform's `getWorkspace` for the directories below it holding packages;
   * 3. do the same for each of them.
   *
   * **A declaration wins, and is then held to it.** A platform named for a directory it does not
   * recognize is a statement that is simply untrue, and the failure it would otherwise become is
   * invisible: the manifest reads as nothing, so the package is named after its directory at
   * `0.0.0` and the repository looks like it works. The error names the directory, the platform and
   * the file that platform looked for.
   *
   * The root node always exists - a repository is a package whatever its technology - so this never
   * returns `undefined`. A repository nobody recognizes is a root with no children, which is the
   * single-package answer arrived at rather than guessed.
   *
   * **A directory is visited once.** A provider may legitimately name a directory another one
   * already claimed (two globs overlapping, a symlinked package), and a provider naming an ancestor
   * would otherwise recurse forever. First visit wins, so a package sits where it was first found.
   *
   * `deep` bounds the descent for the same reason `findRoot` bounds its climb: a provider computing
   * paths rather than reading them can produce a chain that never ends, and a guessed depth is
   * better than a hang with nothing printed.
   */
  export async function walk(
    app: RmanApplication,
    rootDir: string,
    options?: { deep?: number; declared?: DeclaredPlatform },
  ): Promise<Node> {
    const visited = new Set<string>();
    const descend = async (dir: string, remaining: number): Promise<Node> => {
      const resolved = path.resolve(dir);
      visited.add(resolved);
      const declared = await options?.declared?.(resolved);
      if (declared && !declared.manifestProvider.read(resolved)) {
        throw new Error(
          `"${resolved}" declares \`platform: '${declared.name}'\`, and that platform does not ` +
            `recognize it - it looks for "${declared.manifestProvider.fileName}". Either the ` +
            `directory is not a ${declared.name} package, or the declaration belongs one level down.`,
        );
      }
      const platform = declared ?? app.platformFor(resolved);
      const node: Node = { dirname: resolved, platform, children: [] };
      if (remaining <= 0) return node;
      /**
       * **Its own platform is asked, and nobody else.** A platform that did not claim the directory
       * has no standing to say what is under it - that was the old first-wins rule, one level up.
       * `basePlatform` has no `getWorkspace`, so a directory no technology claimed has no children,
       * which is the documented behaviour of a repository naming no plugin.
       */
      for (const child of platform.getWorkspace?.(resolved) ?? []) {
        const childDir = path.resolve(child);
        if (visited.has(childDir)) continue;
        node.children.push(await descend(childDir, remaining - 1));
      }
      return node;
    };
    return descend(rootDir, options?.deep ?? 10);
  }

  /** Every node below `node`, depth-first, excluding `node` itself - the flat list `Repository`
   *  reports as its packages, since the root is not one of its own members. */
  export function flatten(node: Node): Node[] {
    return node.children.flatMap(child => [child, ...flatten(child)]);
  }

  /**
   * Where the repository starts, decided **without knowing anything about any ecosystem** - it has
   * to be, because the plugins that do know are named in the config file this walk is looking for.
   *
   * Walking up from `from`, stopping after a directory holding `.git`, the root is:
   *
   * 1. the **outermost** directory in that chain holding an `.rmanrc*` - outermost, because a
   *    *package* may have its own `.rmanrc` (that is a supported thing), and from inside such a
   *    package the nearest one is the package's, not the repository's;
   * 2. otherwise the `.git` directory itself, the ordinary meaning of "repository root";
   * 3. otherwise `from`, which is all that is left to go on.
   *
   * **What "outermost" costs**, since the two cases genuinely conflict and only one can win: a
   * self-contained project nested inside a larger git repository *and sharing its `.git`* resolves
   * to the outer root, not to itself (measured). That is the same repository by any definition git
   * recognizes, so it is the defensible answer - and a nested project with a `.git` of its own is
   * found correctly, because the walk stops there before the outer `.rmanrc` is ever seen (also
   * measured). A per-package `.rmanrc` is the common case and it is the one served.
   */
  export function findRoot(from: string, deep = 10): string {
    const chain: string[] = [];
    let dir = path.resolve(from);
    let remaining = deep;
    while (remaining-- >= 0 && fs.existsSync(dir)) {
      chain.push(dir);
      if (fs.existsSync(path.join(dir, '.git'))) break;
      const parent = path.resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }

    const withConfig = chain.filter(hasRmanConfig);
    if (withConfig.length) return withConfig[withConfig.length - 1];

    const gitRoot = chain.find(d => fs.existsSync(path.join(d, '.git')));
    return gitRoot ?? path.resolve(from);
  }

  /** Every file form a `.rmanrc` comes in - `package.json#rman` is deliberately *not* one of them
   *  here: it would make the root question npm-shaped again. */
  const CONFIG_FILES = ['.rmanrc', '.rmanrc.yml', '.rmanrc.cjs', '.rmanrc.mjs', '.rmanrc.js'];

  function hasRmanConfig(dir: string): boolean {
    return CONFIG_FILES.some(name => fs.existsSync(path.join(dir, name)));
  }
}
