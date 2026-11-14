// Release tooling only: no bot startup, storage initialization or Discord/Sheets calls.
import { RELEASE, deployRelease, verifyReleaseChecks, type GithubRead, type RailwayRequest } from '../src/release/productionRelease.js';

async function main() {
  const [command, sha] = process.argv.slice(2);
  if (!['check', 'deploy'].includes(command) || !sha) throw Error('Usage: production-release.ts check|deploy EXACT_SHA');
  const token = process.env.GH_TOKEN;
  if (!token) throw Error('A read-only GitHub token is required.');
  const github: GithubRead = async <T>(path: string): Promise<T> => {
    const response = await fetch(`https://api.github.com/repos/${RELEASE.repository}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Error(`GitHub release verification unavailable (${response.status}).`);
    return await response.json() as T;
  };
  if (command === 'check') {
    await verifyReleaseChecks(sha, github);
    console.log(`Dry run passed for ${sha}. No Railway credential or deployment request was used.`);
    return;
  }
  const railwayToken = process.env.RAILWAY_PROJECT_TOKEN;
  if (!railwayToken) throw Error('The protected production environment has no Railway project token.');
  const railway: RailwayRequest = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const response = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST', headers: { 'Project-Access-Token': railwayToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Error(`Railway release request unavailable (${response.status}).`);
    const result = await response.json() as { data?: T; errors?: unknown[] };
    if (result.errors?.length || !result.data) throw Error('Railway release request was not verified.');
    return result.data;
  };
  await deployRelease(sha, { github, railway, environment: process.env,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), log: console.log });
}
main().catch(() => {
  // Do not print API bodies, tokens or raw network errors.
  console.error('Release check or deployment verification failed. Inspect this run and Railway before retrying. No automatic retry or rollback is performed.');
  process.exitCode = 1;
});
