/** Asks GitHub for the very OIDC token npm would request, and prints only the claims npm matches a
 *  trusted publisher on. The token itself is never printed - it is a live credential. */
const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const auth = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if (!url || !auth) {
  console.log('  (no OIDC request vars - nothing to ask)');
  process.exit(0);
}
/* Caught rather than thrown: this probe must never be the reason a release job fails, and a stack
 * trace here would be noise on top of whatever the publish already reported. Only `e.message` is
 * printed - never the response, which carries the token. */
let value;
try {
  const res = await fetch(`${url}&audience=npm:registry.npmjs.org`, { headers: { authorization: `bearer ${auth}` } });
  if (!res.ok) {
    console.log(`  token request failed: ${res.status} ${res.statusText}`);
    process.exit(0);
  }
  ({ value } = await res.json());
} catch (e) {
  console.log(`  token request failed: ${e.message}`);
  process.exit(0);
}
const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString());
for (const k of [
  'iss',
  'aud',
  'repository',
  'repository_owner',
  'workflow_ref',
  'job_workflow_ref',
  'environment',
  'ref',
]) {
  console.log(`  ${k.padEnd(18)} ${claims[k] ?? '(absent)'}`);
}
