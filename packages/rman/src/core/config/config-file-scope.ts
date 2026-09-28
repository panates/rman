import fs from 'node:fs';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import ini from 'ini';
import * as yaml from 'js-yaml';

/**
 * The two members of the expression scope that answer questions about the filesystem: `file`, which
 * says **where** something is, and `read`, which says what is **in** it.
 *
 * Both are built per directory - a package's own - so one `"[*]"` declaration asks each package
 * about its own files. The parse cache is per *instance* and shared across those directories, so
 * twenty packages reading one file parse it once.
 *
 * ```yaml
 * "[*]":
 *   run:
 *     build:
 *       exec: 'tsc -b ${{ file.resolveFirst("tsconfig-build.json", "tsconfig.json") }}'
 *   version:
 *     stamp: '${{ read("pom.xml").getElementsByTagName("version")[0].textContent }}'
 * ```
 *
 * **Everything here is a query, and must stay one.** These run while a config resolves, which
 * *every* command does - so anything that *did* something would do it on `rman list`, `rman info`
 * and `rman config`, once per package, with nothing having asked.
 */
/* **Do not add `copy`, `write` or `mkdir`, however reasonable the request sounds.** It has already
 * been tried, in the only way a function that does not exist can be: a shared config reaching for
 * `file.copyMany(...)` made **every** rman command exit 1. The loud failure was the lucky outcome -
 * had the member existed, `rman list` would have quietly copied files. Work goes in a step, which
 * is the one thing rman runs on purpose, and a step can be a function too. */
export class ConfigFileScope {
  /**
   * One parsed file per path, kept against the identity of the bytes it came from.
   *
   * Passed in to share one cache across several instances; left out, the instance owns its own.
   */
  /* **Per instance rather than per scope**, because the scope is built once *per package*: a cache
   * living in one pass never helps across them, and twenty packages reading one shared file would
   * parse it twenty times. */
  constructor(protected readonly cache: Map<string, ConfigFileScope.CachedFile> = new Map()) {}

  /**
   * The `file` member, resolving against `dirname`.
   *
   * @param dirname the package directory a relative path is resolved against
   */
  fileScope(dirname: string): ConfigFileScope.FileScope {
    return {
      exists: (target: string) => {
        const { path: resolved, found } = this._locate(dirname, target);
        return found ? resolved : '';
      },
      resolve: (target: string) => {
        const { path: resolved, found } = this._locate(dirname, target);
        if (!found) {
          throw new Error(
            `file.resolve("${target}") found nothing at ${resolved}\n` +
              `  Use file.exists() instead if its absence is a case to handle rather than a mistake.`,
          );
        }
        return resolved;
      },
      resolveFirst: (...targets: string[]) => {
        if (!targets.length) throw new Error('file.resolveFirst() needs at least one path');
        for (const target of targets) {
          const { path: resolved, found } = this._locate(dirname, target);
          if (found) return resolved;
        }
        throw new Error(
          `file.resolveFirst() found none of: ${targets.map(t => `"${t}"`).join(', ')}\n  Looked in ${dirname}.`,
        );
      },
    };
  }

  /**
   * The `read` member, resolving against `dirname`.
   *
   * @param dirname the package directory a relative path is resolved against
   */
  readScope(dirname: string): ConfigFileScope.ReadFile {
    return (target: string, format?: ConfigFileScope.FileFormat): unknown => {
      if (typeof target !== 'string' || !target.trim()) {
        throw new Error('read() needs a path - it was given ' + JSON.stringify(target));
      }
      return this.readStructured(path.resolve(dirname, target), format);
    };
  }

  /**
   * Reads and parses one file, deeply frozen and memoized.
   *
   * Throws when the file is absent - `file.exists(p) ? read(p) : fallback` is the optional form, so
   * there is no second function for it.
   */
  /* **Memoized against the identity of the contents, not the path**: the key is `mtimeNs:size`.
   * Both halves were measured.
   *
   * A stat rather than a re-read: `statSync` is 1.3µs where `readFileSync` + `JSON.parse` is 16.1µs
   * on a 2KB manifest, so the check costs a thirteenth of what it saves.
   *
   * Keyed on the stat rather than held for the run, because **rman writes files while it runs** -
   * `version` rewrites every bumped manifest and then re-interpolates its deferred hooks, and a
   * path-keyed cache would hand those back as they were before the write. `mtimeNs` is nanoseconds,
   * so a same-millisecond rewrite does not slip through.
   *
   * **Frozen once on the way in and shared**, rather than copied per caller: every package gets the
   * same object, so a mutation would quietly change what the next one sees. A copy costs 5.6µs on
   * every call where freezing costs ~1µs once, and it turns the mistake into a `TypeError` rather
   * than an effect at a distance. */
  protected readStructured(file: string, format?: ConfigFileScope.FileFormat): unknown {
    let stat: fs.BigIntStats;
    try {
      stat = fs.statSync(file, { bigint: true });
    } catch {
      throw new Error(
        `read("${path.basename(file)}") found nothing at ${file}\n` +
          `  Use file.exists() first if its absence is a case to handle rather than a mistake.`,
      );
    }
    if (stat.isDirectory()) throw new Error(`read() was given a directory, not a file: ${file}`);

    const stamp = `${stat.mtimeNs}:${stat.size}`;
    const cached = this.cache.get(file);
    if (cached?.stamp === stamp) return cached.value;

    const resolved = format ?? this.formatOf(file);
    const text = fs.readFileSync(file, 'utf-8');
    let value: unknown;
    try {
      value = this.parse(text, resolved);
    } catch (e: any) {
      /** The parser's own message says what is wrong with the syntax but never which file it was
       *  reading - and an expression can name several. */
      throw new Error(`read("${path.basename(file)}") could not parse ${file} as ${resolved}: ${e?.message}`, {
        cause: e,
      });
    }
    deepFreeze(value);
    this.cache.set(file, { stamp, value });
    return value;
  }

  /**
   * What format a file name says it is. An unrecognized name is an error naming the four, rather
   * than a guess at JSON.
   */
  /* The extension decides because the caller already wrote it - naming the parser as well would
   * restate it and let the two disagree (`json("x.yml")`). A name that says nothing takes the
   * explicit argument instead. */
  protected formatOf(file: string): ConfigFileScope.FileFormat {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.json') return 'json';
    if (ext === '.yml' || ext === '.yaml') return 'yaml';
    if (ext === '.ini') return 'ini';
    if (XML_EXTENSIONS.has(ext)) return 'xml';
    throw new Error(
      `read() cannot tell what "${path.basename(file)}" is from its name.\n` +
        `  Name the format: read("${path.basename(file)}", "json" | "yaml" | "ini" | "xml").`,
    );
  }

  /** Parses text in one of the four formats. Override to add another. */
  protected parse(text: string, format: ConfigFileScope.FileFormat): unknown {
    if (format === 'json') return JSON.parse(text);
    /** `load`, not `loadAll`: a multi-document stream has no single value to be, and js-yaml says
     *  so clearly enough ("expected a single document in the stream") to leave alone. */
    if (format === 'yaml') return yaml.load(text);
    if (format === 'xml') return this.parseXml(text);
    return ini.parse(text);
  }

  /**
   * Parses XML into a **DOM**, not a plain object.
   *
   * ```yaml
   * version: '${{ read("pom.xml").getElementsByTagName("version")[0].textContent }}'
   * ```
   */
  /* **The asymmetry with the other three formats is the honest shape rather than an omission.** XML
   * has no lossless object form: an element can repeat, carry attributes and hold text at the same
   * time, so any flattening has to pick a convention (`$`? `_text`? array-or-not?) and be wrong for
   * somebody. A DOM is the shape XML actually has.
   *
   * **Freezing a DOM is safe** - measured, not assumed: a frozen `@xmldom/xmldom` document still
   * answers `getElementsByTagName` for a tag first asked about *after* the freeze (the
   * live-collection case that would have broken it), reads attributes, resolves namespaces, walks
   * `childNodes` and serialises back.
   *
   * **A malformed file must throw.** xmldom reports problems through a handler and otherwise
   * carries on with whatever it salvaged - so without the check a truncated file came back as a
   * half-parsed DOM and the expression reading it simply found nothing. `read()` throws for a
   * broken JSON file; it has to throw for this one too. */
  protected parseXml(text: string): unknown {
    const problems: string[] = [];
    const doc = new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') problems.push(message.split('\n')[0]!);
      },
    }).parseFromString(text, 'text/xml');
    if (problems.length) throw new Error(problems[0]);
    return doc;
  }

  /** Where a relative target lands, and whether anything is there. */
  protected _locate(dirname: string, target: string): { path: string; found: boolean } {
    if (typeof target !== 'string' || !target.trim()) {
      throw new Error('file.exists()/file.resolve() need a path - they were given ' + JSON.stringify(target));
    }
    const resolved = path.resolve(dirname, target);
    return { path: resolved, found: fs.existsSync(resolved) };
  }
}

export namespace ConfigFileScope {
  /**
   * Where a file is - the `file` member of the expression scope.
   *
   * Three read-only members, and that is the whole of it; see the class doc for why nothing here
   * changes anything.
   */
  export interface FileScope {
    /**
     * The absolute path if it exists, **`''` if it does not** - so `a || b || c` picks the first one
     * present, and so a miss never reaches the "nullish inside a string" guard that `undefined`
     * would trip. Takes a relative path (against the package directory) or an absolute one.
     */
    /* It returns a path rather than a boolean on purpose: the caller almost always wants the path,
     * and a separate `file.path()` to fetch it after a boolean test would read the disk twice and
     * invite the two calls to disagree. */
    exists(target: string): string;

    /** The absolute path, or **throws** - for a file whose absence is a mistake rather than a case
     *  to handle. The error names the config path holding the expression, like any other. */
    resolve(target: string): string;

    /**
     * The first of several that exists, or **throws** naming every candidate it tried:
     *
     * ```yaml
     * exec: 'tsc -b ${{ file.resolveFirst("tsconfig-build.json", "tsconfig.json") }}'
     * ```
     */
    /* The same thing an `exists() || exists() || resolve()` chain does, said once - and it cannot be
     * got subtly wrong the way that chain can: ending the chain in `exists()` leaves `tsc -b ` with
     * no argument when nothing matches, and tsc then silently falls back to the directory's default
     * rather than reporting that the package has no build config. */
    resolveFirst(...targets: string[]): string;
  }

  /** What `read` can parse. */
  /* **`.env` is deliberately absent, and that is the durable part of this list**: `env` is already
   * in scope, and a `.env` file exists to be loaded *into* an environment by something else - a
   * config reading one as data would mean two different things called the environment.
   *
   * Nothing else is excluded on principle. `xml` arrived because a `pom.xml` or a `.csproj` holds a
   * version exactly the way a `package.json` does, and rman is language-agnostic; the earlier line
   * ("no new parsers") did not survive it, since xmldom *is* a new one. */
  export type FileFormat = 'json' | 'yaml' | 'ini' | 'xml';

  /** `read(path)`, or `read(path, 'ini')` for a file whose name does not say what it is
   *  (`.npmrc`). */
  export type ReadFile = (target: string, format?: FileFormat) => unknown;

  /** One parsed file, kept against the identity of the bytes it came from. */
  export interface CachedFile {
    /** `mtimeNs:size`. */
    stamp: string;
    value: unknown;
  }
}

/** The XML family worth recognizing by name: a project file is XML whatever its extension calls
 *  itself, and `.csproj`/`.pom` are what a .NET or Maven repository actually holds. Anything else
 *  still reads with an explicit `read(p, 'xml')`. */
const XML_EXTENSIONS = new Set(['.xml', '.csproj', '.vbproj', '.fsproj', '.props', '.targets', '.nuspec', '.plist']);

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
}
