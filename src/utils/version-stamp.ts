/** Keeping a package's version truthful wherever the package itself declares it - its Dockerfile's
 *  OCI label, and any source file that hard-codes it as a constant. Both are `version`'s job rather
 *  than a build step's: a version is being written, these are places it is written, and doing it
 *  here puts them in the bump commit instead of leaving the repository disagreeing with itself. */

/** The OCI label whose value is, by specification, "version of the packaged software" - so a
 *  package's own `package.json` version is the only correct value it can hold, which is what makes
 *  stamping it automatic rather than something to configure. */
export const OCI_VERSION_LABEL = 'org.opencontainers.image.version';

/**
 * Rewrites every `org.opencontainers.image.version` value in a Dockerfile's `LABEL` instructions to
 * `version`, returning the new content - or `undefined` when there was nothing to change (no such
 * label, or it already holds this version), so a caller can skip writing the file at all.
 *
 * Only ever *rewrites*: a Dockerfile that doesn't declare the label is left exactly as it is rather
 * than having one inserted. Which labels an image carries is the author's decision; keeping one
 * they already declared truthful is not.
 *
 * The existing quoting style is preserved, so the diff is the version and nothing else.
 */
export function stampVersionLabel(content: string, version: string): string | undefined {
  const lines = content.split('\n');
  let changed = false;
  // A LABEL's key=value pairs can spill over several lines via trailing backslashes, so the
  // instruction a line belongs to is tracked rather than assumed from the line itself. Anything
  // outside a LABEL is left alone - the same key in an ARG, an ENV or a comment is not a label.
  let continuing = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inLabel = continuing || /^\s*LABEL\b/i.test(line);
    continuing = inLabel && /\\\s*$/.test(line);
    if (!inLabel) continue;

    lines[i] = line.replace(LABEL_VALUE, (whole, key: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      const next = `${key}${quote}${version}${quote}`;
      if (next !== whole) changed = true;
      return next;
    });
  }

  return changed ? lines.join('\n') : undefined;
}

/**
 * Rewrites the string assigned to a `name` constant (default `version`) in a source file to
 * `version`, returning the new content - or `undefined` when there was nothing to change, so a
 * caller can skip writing the file at all. Both an assignment and an object property are matched:
 *
 * ```ts
 * export const version = '1';   ->   export const version = '6.0.10';
 * { name: 'app', version: '1' } ->   { name: 'app', version: '6.0.10' }
 * ```
 *
 * Unlike the Dockerfile label there is no standard naming a file as holding the version, so this
 * only ever runs against files `.rmanrc "version.stamp"` explicitly lists - which is also what
 * keeps a match this broad safe.
 *
 * Stamping the *source* rather than the build output is the point: a build-time rewrite leaves the
 * checked-in file claiming some placeholder, so anything running from source (tests, ts-node, the
 * dev loop) reports that placeholder, git never records the released version, and the rewrite has
 * to be redone on every build.
 */
export function stampVersionConstant(content: string, version: string, name = 'version'): string | undefined {
  let changed = false;
  const pattern = new RegExp(`(\\b${escapeRegExp(name)}\\s*[:=]\\s*)(['"\`])([^'"\`\\n]*)\\2`, 'g');
  const result = content.replace(pattern, (whole, prefix: string, quote: string) => {
    const next = `${prefix}${quote}${version}${quote}`;
    if (next !== whole) changed = true;
    return next;
  });
  return changed ? result : undefined;
}

const LABEL_VALUE = new RegExp(
  `(${OCI_VERSION_LABEL.replace(/\./g, '\\.')}\\s*=\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s\\\\]+)`,
  'g',
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
