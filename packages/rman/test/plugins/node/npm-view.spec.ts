import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { npmViewReleases } from '../../../src/builtins/publish-targets/npm/npm-view.js';

/**
 * **npm's answer to `view <name>@<range> <fields...> --json` has two shapes**, and `rman deps`
 * reads its releases from it: one object per version, or - when no version in the range sets any of
 * the extra fields - a plain list of version strings. The second dropped every release, so a major
 * published under a caret range (`ts-gems` 4.0.4 against `^3.12.0`) was not even listed as skipped.
 */
describe('publish-targets/npm/npmViewReleases', () => {
  const savedPath = process.env.PATH;
  let dir: string;

  /** A stand-in `npm` answering the range query with `releases` and dist-tags with `latest`. */
  function stubNpm(releases: unknown, latest: string): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-npm-view-'));
    fs.writeFileSync(
      path.join(dir, 'npm'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
console.log(JSON.stringify(args.includes('dist-tags') ? { latest: ${JSON.stringify(latest)} } : ${JSON.stringify(releases)}));
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  }

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a plain list of version strings as releases', async () => {
    stubNpm(['3.12.0', '4.0.0', '4.0.4'], '4.0.4');
    const info = await npmViewReleases('ts-gems', '>=3.12.0', os.tmpdir());
    expect(info?.releases.map(r => r.version)).toEqual(['3.12.0', '4.0.0', '4.0.4']);
    expect(info?.latest).toBe('4.0.4');
  });

  it('reads one version string on its own, and the object form as before', async () => {
    stubNpm('4.0.4', '4.0.4');
    expect((await npmViewReleases('ts-gems', '>=4.0.4', os.tmpdir()))?.releases).toEqual([{ version: '4.0.4' }]);

    stubNpm([{ version: '1.0.0', engines: { node: '>=20' } }, { version: '1.1.0' }], '1.1.0');
    const info = await npmViewReleases('pkg', '>=1.0.0', os.tmpdir());
    expect(info?.releases).toEqual([{ version: '1.0.0', engines: { node: '>=20' } }, { version: '1.1.0' }]);
  });
});
