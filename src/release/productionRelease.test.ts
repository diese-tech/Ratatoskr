import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RELEASE, REQUIRED_WORKFLOWS, SERVICE_QUERY, approvedRun, assertDeploymentContext, assertJobs,
  assertReleaseSha, deployRelease, startupHealthy, verifyReleaseChecks, type GithubRead, type RailwayRequest,
  type WorkflowRun } from './productionRelease.js';

const sha = 'a'.repeat(40);
const run = (id: number): WorkflowRun => ({ id, workflow_id: id, event: id === REQUIRED_WORKFLOWS[0].id ? 'push' : 'dynamic',
  head_sha: sha, status: 'completed', conclusion: 'success', run_attempt: 2 });
function fixture() {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const environment = { RELEASE_ENABLED: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: RELEASE.repository, GITHUB_WORKFLOW_REF: `${RELEASE.repository}/.github/workflows/release-production.yml@refs/heads/main` };
  const current = { id: 'before', status: 'SUCCESS', projectId: RELEASE.project, serviceId: RELEASE.service,
    environmentId: RELEASE.environment, meta: { commitHash: sha, repo: RELEASE.repository } };
  const state = { projectToken: { projectId: RELEASE.project, environmentId: RELEASE.environment },
    serviceInstanceAutoDeployStatus: { enabled: false },
    serviceInstance: { source: { repo: RELEASE.repository, image: null }, numReplicas: 1, latestDeployment: current },
    environment: { volumeInstances: { edges: [{ node: { serviceId: RELEASE.service, mountPath: '/data', state: 'READY' } }] } } };
  const logs = ['Storage ready (sqlite).', 'Ratatoskr online as Rat', 'Pending league transaction notices reconciled.', 'Scout notification worker started.'];
  let protection = true, comparison = 'identical', mutationFailure = false, checks = true;
  const github: GithubRead = async <T>(path: string): Promise<T> => {
    if (path.startsWith('/compare/')) return { status: comparison } as T;
    if (path.startsWith('/environments/')) return { can_admins_bypass: !protection,
      protection_rules: protection ? [{ type: 'required_reviewers', reviewers: ['owner'] }] : [] } as T;
    const workflow = REQUIRED_WORKFLOWS.find(item => path.includes(String(item.id)))!;
    if (path.includes('/attempts/')) {
      assert.match(path, /\/attempts\/2\/jobs/);
      return { jobs: workflow.jobs.map(name => ({ name, status: 'completed', conclusion: checks ? 'success' : 'cancelled' })) } as T;
    }
    return { workflow_runs: [run(workflow.id)] } as T;
  };
  const railway: RailwayRequest = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    calls.push({ query, variables });
    if (query.startsWith('mutation')) {
      if (mutationFailure) throw Error('response lost');
      state.serviceInstance.latestDeployment = { ...current, id: 'new-deployment' };
      return { serviceInstanceDeploy: true } as T;
    }
    if (query === SERVICE_QUERY) return structuredClone(state) as T;
    return { deploymentLogs: logs.map(message => ({ message })) } as T;
  };
  return { calls, environment, state, logs, github, railway, sleep: async () => {}, log: () => {},
    noProtection: () => { protection = false; }, drift: () => { comparison = 'diverged'; },
    loseResponse: () => { mutationFailure = true; }, failChecks: () => { checks = false; } };
}

test('release dry run checks exact main SHA and both matrix jobs without Railway access', async () => {
  const f = fixture(); await verifyReleaseChecks(sha, f.github); assert.equal(f.calls.length, 0);
  f.drift(); await assert.rejects(verifyReleaseChecks(sha, f.github), /must be on main/);
});
test('release SHA is not a branch, abbreviation, expression or shell input', () => {
  for (const value of ['main', 'a7838db', 'A'.repeat(40), `${sha}; echo secret`, '']) assert.throws(() => assertReleaseSha(value));
});
for (const conclusion of [null, 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
  test(`required workflow refuses ${conclusion}, including a newer rerun after success`, () => {
    const workflow = REQUIRED_WORKFLOWS[0];
    assert.throws(() => approvedRun(sha, workflow, [{ ...run(workflow.id), id: 1 }, { ...run(workflow.id), id: 2, conclusion }]));
  });
}
test('missing, pending and foreign-SHA workflow evidence cannot release', () => {
  const workflow = REQUIRED_WORKFLOWS[0];
  for (const runs of [[], [{ ...run(workflow.id), status: 'in_progress' }], [{ ...run(workflow.id), head_sha: 'b'.repeat(40) }]])
    assert.throws(() => approvedRun(sha, workflow, runs));
});
test('both named jobs must succeed on the approved workflow attempt', () => {
  const workflow = REQUIRED_WORKFLOWS[1];
  const jobs = workflow.jobs.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  assertJobs(workflow, jobs);
  assert.throws(() => assertJobs(workflow, jobs.slice(1)));
  assert.throws(() => assertJobs(workflow, [...jobs, jobs[0]!]));
  assert.throws(() => assertJobs(workflow, jobs.map(item => ({ ...item, conclusion: 'cancelled' }))));
});
test('manual main context and activation are mandatory', () => {
  const f = fixture(); assertDeploymentContext(f.environment);
  for (const change of [{ RELEASE_ENABLED: '' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_WORKFLOW_REF: 'other workflow' }])
    assert.throws(() => assertDeploymentContext({ ...f.environment, ...change }));
});
for (const condition of ['inactive', 'protection', 'checks', 'autodeploy', 'token', 'source', 'replicas', 'volume'] as const) {
  test(`no deployment on unsafe release gate: ${condition}`, async () => {
    const f = fixture();
    if (condition === 'inactive') f.environment.RELEASE_ENABLED = '';
    if (condition === 'protection') f.noProtection();
    if (condition === 'checks') f.failChecks();
    if (condition === 'autodeploy') f.state.serviceInstanceAutoDeployStatus.enabled = true;
    if (condition === 'token') f.state.projectToken.environmentId = 'other' as typeof RELEASE.environment;
    if (condition === 'source') f.state.serviceInstance.source.repo = 'other' as typeof RELEASE.repository;
    if (condition === 'replicas') f.state.serviceInstance.numReplicas = 2;
    if (condition === 'volume') f.state.environment.volumeInstances.edges = [];
    await assert.rejects(deployRelease(sha, f));
    assert.equal(f.calls.filter(item => item.query.startsWith('mutation')).length, 0);
  });
}
test('approved release requests one exact deployment and verifies its startup', async () => {
  const f = fixture(); assert.equal(await deployRelease(sha, f), 'new-deployment');
  const mutations = f.calls.filter(item => item.query.startsWith('mutation'));
  assert.equal(mutations.length, 1);
  assert.match(mutations[0]!.query, /commitSha:\$sha,latestCommit:false/);
  assert.deepEqual(mutations[0]!.variables, { environment: RELEASE.environment, service: RELEASE.service, sha });
});
test('ambiguous deploy response never retries the mutation', async () => {
  const f = fixture(); f.loseResponse(); await assert.rejects(deployRelease(sha, f), /acknowledgement is uncertain/);
  assert.equal(f.calls.filter(item => item.query.startsWith('mutation')).length, 1);
});
test('wrong observed revision cannot be called healthy', async () => {
  const f = fixture(); f.state.serviceInstance.latestDeployment.meta.commitHash = 'b'.repeat(40);
  await assert.rejects(deployRelease(sha, f), /does not match/);
});
test('Railway SUCCESS without startup proof times out without retry or rollback', async () => {
  const f = fixture(); f.logs.length = 0; await assert.rejects(deployRelease(sha, f), /timed out/);
  assert.equal(f.calls.filter(item => item.query.startsWith('mutation')).length, 1);
});
test('private UI and recovery initialization failures invalidate startup proof', () => {
  const f = fixture(); assert.equal(startupHealthy(f.logs), true);
  assert.equal(startupHealthy([...f.logs, 'Private League Ops UI unavailable; read-only legacy review remains available.']), false);
  assert.equal(startupHealthy([...f.logs, 'League transaction recovery failed; continuing existing Scout startup.']), false);
});
test('workflow keeps dry runs credential-free, deploy protected and serialized, and inputs out of shell code', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/release-production.yml', import.meta.url), 'utf8');
  assert.match(yaml, /workflow_dispatch:/); assert.doesNotMatch(yaml, /\n  (push|pull_request|workflow_run):/);
  assert.match(yaml, /cancel-in-progress: false/);
  const [verify, deploy] = yaml.split('\n  deploy:');
  assert.doesNotMatch(verify!, /secrets\.|RAILWAY_PROJECT_TOKEN/);
  assert.match(deploy!, /name: ratatoskr-production/);
  assert.match(deploy!, /vars.RATATOSKR_RELEASE_ENABLED == 'true'/);
  assert.match(yaml, /run: node --import tsx scripts\/production-release.ts check "\$RELEASE_SHA"/);
  assert.doesNotMatch(yaml, /run:.*\$\{\{ inputs\./);
});
