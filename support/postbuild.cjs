const fs = require('node:fs');
const path = require('node:path');

/**
 * Prepares a package's `build` directory for publishing. **One script for the whole repository**,
 * run from each package (`node ../../support/postbuild.cjs`) - there is nothing package-specific in
 * it, and a copy per package is a copy to keep in step.
 *
 * Everything package-relative comes from `process.cwd()`, which is the package npm is running the
 * script for; the repository root comes from this file's own location rather than `../..` of the
 * cwd, so a package nested any deeper than `packages/<name>` still finds it.
 */
function postBuild() {
  const packageDir = process.cwd();
  const repoRoot = path.resolve(__dirname, '..');
  const json = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'),
  );

  const buildDir = path.join(packageDir, 'build');
  if (!fs.existsSync(buildDir)) {
    throw new Error(`Build directory not found: ${buildDir}`);
  }

  json.type = 'module';
  delete json.private;
  delete json.scripts;
  delete json.devDependencies;

  fs.writeFileSync(
    path.join(buildDir, 'package.json'),
    JSON.stringify(json, undefined, 2),
    'utf-8',
  );

  /** The package's own README, the repository's LICENCE - the one is about this package, the other
   *  covers the whole tree. */
  copyIfPresent(
    path.join(packageDir, 'README.md'),
    path.join(buildDir, 'README.md'),
  );
  copyIfPresent(path.join(repoRoot, 'LICENSE'), path.join(buildDir, 'LICENSE'));

  /**
   * **Every `bin` entry gets the execute bit.** `tsc` writes 644, and npm only sets 755 while
   * installing or packing - so a build directory linked into another repository's `node_modules`
   * (`ln -s .../packages/rman/build node_modules/rman`) leaves `node_modules/.bin/rman` pointing at
   * a file the shell refuses: `permission denied`, with the shebang present and correct, which
   * sends the reader looking at the wrong thing entirely. Measured.
   */
  for (const target of Object.values(json.bin ?? {})) {
    const file = path.join(buildDir, target.replace(/^\.\//, ''));
    if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
  }

  /** The `version = '1'` placeholder a package exports, wherever it keeps it. Checked against a
   *  short list rather than guessed at: a silent miss here ships a package reporting version 1. */
  for (const candidate of ['constants.js', 'index.js']) {
    const file = path.join(buildDir, candidate);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(
      `version = '1'`,
      `version = '${json.version}'`,
    );
    if (after !== before) {
      fs.writeFileSync(file, after, 'utf-8');
      return;
    }
  }
}

function copyIfPresent(from, to) {
  if (fs.existsSync(from)) fs.copyFileSync(from, to);
}

postBuild();
