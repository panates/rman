import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * `npm view <name> version` - `undefined` for anything that is not an answer (never published, no
 * network, private or restricted with no access). Catch-everything on purpose: every caller treats
 * "no answer" as a legitimate state rather than a failure.
 *
 * One copy, two callers with different needs: `publish` asks in order to decide whether this exact
 * version is already out there, and can be pointed at another registry from the CLI
 * (`--registry`/`--userconfig`); `packageJsonManifest.publishedVersion` asks so that
 * `detectChangeHash` can guess a tag name, and passes nothing - a bare `npm view` already picks up
 * the repository's own `.npmrc` from `cwd`, which is what that path wants.
 */
export async function npmViewVersion(
  name: string,
  cwd: string,
  options: { registry?: string; userconfig?: string } = {},
): Promise<string | undefined> {
  const argv = ['view', name, 'version'];
  if (options.registry) argv.push('--registry', options.registry);
  if (options.userconfig) argv.push('--userconfig', options.userconfig);
  try {
    const { stdout } = await execFileAsync('npm', argv, { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

const execFileAsync = promisify(execFile);
