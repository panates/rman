process.env.TS_NODE_PROJECT = __dirname + '/tsconfig-test.json';
/**
 * **The specs never write to the CI job's summary page.** `rman publish` appends its outcome there
 * whenever `GITHUB_STEP_SUMMARY` is set, which it is inside GitHub Actions - so every publish spec run
 * by the test job added a "rman publish - 1 published" table for a fixture's `pkg-a` to the real
 * release run's page (measured: 15 tables from one `--grep publish` run). Removed here, in the main
 * process, so the parallel workers inherit its absence; the one spec about the summary sets its own.
 */
delete process.env.GITHUB_STEP_SUMMARY;
/** @type {import('mocha').MochaOptions} */
module.exports = {
  /**
   * **No root hooks any more.** There used to be one, emptying five module-global registries before
   * every test, because two repositories in a process shared them: whichever spec registered first
   * decided the answer for the rest. Each `Repository.create` builds its own `RmanApplication` now,
   * so there is nothing left that could survive a case.
   */
  require: ['@swc-node/register/esm-register'],
  extension: ['ts'],
  spec: './packages/*/test/**/*.spec.ts',
  timeout: 30000,
  parallel: true,
};
