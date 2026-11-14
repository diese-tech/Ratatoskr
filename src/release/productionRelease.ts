/** Release tooling only. Never imported by the bot or used to open application storage. */
export const RELEASE = {
  repository: 'diese-tech/Ratatoskr',
  project: '40ae1533-b171-461e-b2e1-8b68b4d48b39',
  environment: '89f84014-d527-4496-839d-26885d1bb7c1',
  service: '8ae03a74-c126-4939-b59c-979855a8a02f',
  githubEnvironment: 'ratatoskr-production',
} as const;

export type WorkflowRun = { id: number; workflow_id: number; head_sha: string; event: string;
  status: string; conclusion: string | null; run_attempt: number };
export type CheckJob = { name: string; status: string; conclusion: string | null };
export const REQUIRED_WORKFLOWS = [
  { id: 340763552, event: 'push', jobs: ['build-and-test (ubuntu-latest)', 'build-and-test (windows-latest)'] },
  { id: 373679467, event: 'dynamic', jobs: ['Analyze (actions)', 'Analyze (javascript-typescript)'] },
] as const;

export function assertReleaseSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw Error('Supply the exact lowercase 40-character commit SHA.');
}
export function approvedRun(sha: string, workflow: typeof REQUIRED_WORKFLOWS[number], runs: WorkflowRun[]): WorkflowRun {
  const run = runs.filter(item => item.workflow_id === workflow.id && item.head_sha === sha && item.event === workflow.event)
    .sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success')
    throw Error(`Required workflow ${workflow.id} is missing or has not succeeded for this SHA.`);
  return run;
}
export function assertJobs(workflow: typeof REQUIRED_WORKFLOWS[number], jobs: CheckJob[]): void {
  for (const name of workflow.jobs) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0]!.status !== 'completed' || matches[0]!.conclusion !== 'success')
      throw Error(`Required job ${name} is missing or has not succeeded.`);
  }
}

export type GithubRead = <T>(path: string) => Promise<T>;
export async function verifyReleaseChecks(sha: string, github: GithubRead): Promise<void> {
  assertReleaseSha(sha);
  const comparison = await github<{ status: string }>(`/compare/${sha}...main`);
  if (!['ahead', 'identical'].includes(comparison.status)) throw Error('The release SHA must be on main.');
  for (const workflow of REQUIRED_WORKFLOWS) {
    const runs: WorkflowRun[] = [];
    for (let page = 1; ; page++) {
      const result = await github<{ workflow_runs: WorkflowRun[] }>(`/actions/workflows/${workflow.id}/runs?head_sha=${sha}&per_page=100&page=${page}`);
      runs.push(...result.workflow_runs);
      if (result.workflow_runs.length < 100) break;
    }
    const run = approvedRun(sha, workflow, runs);
    const jobs: CheckJob[] = [];
    for (let page = 1; ; page++) {
      const result = await github<{ jobs: CheckJob[] }>(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
      jobs.push(...result.jobs);
      if (result.jobs.length < 100) break;
    }
    assertJobs(workflow, jobs);
  }
}

export function assertDeploymentContext(environment: NodeJS.ProcessEnv): void {
  if (environment.RELEASE_ENABLED !== 'true' || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_REPOSITORY !== RELEASE.repository
    || environment.GITHUB_WORKFLOW_REF !== `${RELEASE.repository}/.github/workflows/release-production.yml@refs/heads/main`)
    throw Error('Production releases are inactive or this is not the trusted manual main workflow.');
}
export async function verifyApprovalProtection(github: GithubRead): Promise<void> {
  const environment = await github<{ can_admins_bypass: boolean; protection_rules: Array<{ type: string; reviewers?: unknown[] }> }>(
    `/environments/${RELEASE.githubEnvironment}`);
  if (environment.can_admins_bypass !== false || !environment.protection_rules.some(rule => rule.type === 'required_reviewers' && rule.reviewers?.length))
    throw Error('Configure required production reviewers and disable administrator approval bypass first.');
}

export type Deployment = { id: string; status: string; projectId: string; environmentId: string; serviceId: string | null;
  meta: { commitHash?: string; repo?: string } | null };
export type RailwayRequest = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
export const SERVICE_QUERY = `query($environment: String!, $service: String!, $project: String!) {
  projectToken { projectId environmentId }
  serviceInstanceAutoDeployStatus(projectId:$project,environmentId:$environment,serviceId:$service) { enabled }
  serviceInstance(environmentId:$environment,serviceId:$service) {
    source { repo image } numReplicas
    latestDeployment { id status projectId environmentId serviceId meta }
  }
  environment(id:$environment) { volumeInstances { edges { node {serviceId mountPath state} } } }
}`;
const variables = { environment: RELEASE.environment, service: RELEASE.service, project: RELEASE.project };
type ServiceState = { projectToken: { projectId: string; environmentId: string };
  serviceInstanceAutoDeployStatus: { enabled: boolean };
  serviceInstance: { source: { repo: string | null; image: string | null } | null; numReplicas: number | null; latestDeployment: Deployment | null };
  environment: { volumeInstances: { edges: Array<{ node: { serviceId: string | null; mountPath: string; state: string | null } }> } } };
export function assertService(state: ServiceState): void {
  if (state.projectToken.projectId !== RELEASE.project || state.projectToken.environmentId !== RELEASE.environment
    || state.serviceInstanceAutoDeployStatus.enabled || state.serviceInstance.source?.repo !== RELEASE.repository
    || state.serviceInstance.source?.image || state.serviceInstance.numReplicas !== 1
    || !state.environment.volumeInstances.edges.some(({ node }) => node.serviceId === RELEASE.service && node.mountPath === '/data' && node.state === 'READY'))
    throw Error('Production token, source, autodeploy, replica or volume configuration does not match the approved service.');
}
export function assertDeployment(deployment: Deployment, sha: string): void {
  if (deployment.projectId !== RELEASE.project || deployment.environmentId !== RELEASE.environment || deployment.serviceId !== RELEASE.service
    || deployment.meta?.commitHash !== sha || deployment.meta?.repo !== RELEASE.repository)
    throw Error('Observed deployment does not match the approved service and exact SHA. Inspect Railway; do not retry automatically.');
}
export function startupHealthy(messages: string[]): boolean {
  return messages.some(line => line.includes('Storage ready (sqlite).'))
    && messages.some(line => line.includes('Ratatoskr online as '))
    && messages.some(line => line.includes('Pending league transaction notices reconciled.'))
    && messages.some(line => line.includes('Scout notification worker started.'))
    && !messages.some(line => /Private League Ops UI unavailable|League transaction recovery failed|Unhandled promise rejection|League worker failed/.test(line));
}

/** Exactly one mutation request; ambiguous responses never trigger a second deploy. */
export async function deployRelease(sha: string, ports: { github: GithubRead; railway: RailwayRequest;
  environment: NodeJS.ProcessEnv; sleep(ms: number): Promise<void>; log(message: string): void }): Promise<string> {
  assertDeploymentContext(ports.environment);
  await verifyApprovalProtection(ports.github);
  await verifyReleaseChecks(sha, ports.github); // Recheck after the approval/concurrency wait.
  const before = await ports.railway<ServiceState>(SERVICE_QUERY, variables);
  assertService(before);
  let accepted: { serviceInstanceDeploy: boolean };
  try {
    accepted = await ports.railway(`mutation($environment: String!, $service: String!, $sha: String!) {
      serviceInstanceDeploy(environmentId:$environment,serviceId:$service,commitSha:$sha,latestCommit:false)
    }`, { environment: RELEASE.environment, service: RELEASE.service, sha });
  } catch {
    throw Error('Deployment acknowledgement is uncertain. Inspect Railway before any new release request; no automatic retry was made.');
  }
  if (!accepted.serviceInstanceDeploy) throw Error('Railway did not accept the deployment. Inspect it before requesting another release.');
  for (let attempt = 0; attempt < 90; attempt++) {
    await ports.sleep(10_000);
    const state = await ports.railway<ServiceState>(SERVICE_QUERY, variables);
    assertService(state);
    const deployed = state.serviceInstance.latestDeployment;
    if (!deployed || deployed.id === before.serviceInstance.latestDeployment?.id) continue;
    assertDeployment(deployed, sha);
    if (['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED'].includes(deployed.status))
      throw Error(`Deployment ${deployed.id} is ${deployed.status}. Inspect recovery evidence; no rollback or retry was attempted.`);
    if (deployed.status !== 'SUCCESS') continue;
    const logs = await ports.railway<{ deploymentLogs: Array<{ message: string }> }>(
      'query($id:String!) { deploymentLogs(deploymentId:$id,limit:500) {message} }', { id: deployed.id });
    if (!startupHealthy(logs.deploymentLogs.map(line => line.message))) continue;
    ports.log(`Verified ${sha} on deployment ${deployed.id}: Railway success, SQLite startup, Discord connection and recovery startup. Human smoke testing remains required.`);
    return deployed.id;
  }
  throw Error('Deployment or startup verification timed out. Inspect Railway; no automatic retry or rollback was made.');
}
