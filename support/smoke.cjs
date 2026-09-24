/**
 * **Does the built CLI start, and does it still do the things the build is for.**
 *
 * `npm test` cannot answer either question. Mocha resolves `rman` through
 * `tsconfig-test.json`'s `paths` to `src`, which is a *different module graph* from the compiled
 * one - so an ESM cycle can be fatal in `build/` and invisible to 821 passing specs. Measured
 * exactly that way: every command in the published layout died with
 * `ReferenceError: Cannot access 'VersionPlanService' before initialization`, and the suite was
 * green through the whole time it was broken.
 *
 * Deliberately three commands and nothing more. `--version` is answered before the repository is
 * touched, so it proves the module graph alone; `list` needs the repository, the config cascade and
 * a workspace provider; `clean --dry-run` needs a *contributed* command to exist, which is the
 * half `plugins: ['node']` is responsible for and the half an `extends` pointing at a deleted
 * package silently took away. It writes nothing - `--dry-run` - so this is safe to run anywhere.
 *
 * Run against this repository itself, which is the only checkout that is certainly present.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const cli = path.join(__dirname, '..', 'packages', 'rman', 'build', 'cli.js');
const repo = path.join(__dirname, '..');

const checks = [
  {
    argv: ['--version'],
    expect: /^\d+\.\d+\.\d+/,
    what: 'the module graph loads at all',
  },
  {
    argv: ['list'],
    expect: /Package\(s\) found/,
    what: 'the repository and its workspace resolve',
  },
  {
    argv: ['clean', '--dry-run'],
    expect: /succeeded/,
    what: "a contributed command exists (plugins: ['node'])",
  },
];

let failed = 0;
for (const { argv, expect, what } of checks) {
  const label = `rman ${argv.join(' ')}`;
  try {
    const out = execFileSync(process.execPath, [cli, ...argv], {
      cwd: repo,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    if (!expect.test(out)) {
      failed++;
      console.error(
        `FAIL  ${label}\n      expected ${expect} - ${what}\n      got: ${out.trim().split('\n')[0]}`,
      );
    } else {
      process.stdout.write(`ok    ${label}\n`);
    }
  } catch (e) {
    failed++;
    const reason = [e.stdout, e.stderr, e.message]
      .filter(Boolean)
      .join('\n')
      .trim()
      .split('\n')
      .slice(0, 6);
    console.error(`FAIL  ${label} - ${what}\n      ${reason.join('\n      ')}`);
  }
}

failed += typeCheckConsumer();

if (failed) {
  console.error(
    `\n${failed} of ${checks.length + 1} smoke checks failed. Run \`npm run build\` first if the build is stale.`,
  );
  process.exit(1);
}
process.stdout.write(`\n${checks.length + 1} smoke checks passed.\n`);

/**
 * **What a consumer's compiler sees**, which `npm run typecheck` cannot answer.
 *
 * `packages/rman/test/tsconfig.json` includes every source file, so a `declare module` augmentation
 * is in the program whether or not the entry point reaches it - a spec asserting one is typed
 * passes either way. `support/smoke-types/` resolves `rman` to the built `index.d.ts` and to
 * nothing else, which is the only vantage point that can tell.
 *
 * Measured: deleting the import that carries the node plugin's augmentation left `npm run
 * typecheck` completely clean, `mocha` at 839 passing, and turned this red.
 *
 * A function declaration, so the call above it hoists - the same reason `plugin.ts`'s `declaredKey`
 * is one.
 */
function typeCheckConsumer() {
  const project = path.join(__dirname, 'smoke-types');
  try {
    execFileSync(
      process.execPath,
      [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', project],
      {
        cwd: repo,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    process.stdout.write('ok    consumer types (support/smoke-types)\n');
    return 0;
  } catch (e) {
    const out = [e.stdout, e.stderr]
      .filter(Boolean)
      .join('\n')
      .trim()
      .split('\n')
      .slice(0, 8);
    console.error(
      'FAIL  consumer types - a key or export is missing from the built package\n      ' +
        out.join('\n      '),
    );
    return 1;
  }
}
