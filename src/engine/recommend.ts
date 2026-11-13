import type { Answers, Recommendation } from './types';

/** Opinionated "which tool should I use?" logic. Each branch records why. */
export function recommend(a: Answers): Recommendation {
  const reasons: string[] = [];
  let cloud = a.cloud;
  if (a.cloud === 'other') {
    const t = a.cloudOther.toLowerCase();
    cloud = /aws|amazon/.test(t) ? 'aws' : /azure|microsoft/.test(t) ? 'azure' : /gcp|google/.test(t) ? 'gcp' : 'none';
    reasons.push(
      cloud === 'none'
        ? `"${a.cloudOther || 'Other'}" isn't a built-in cloud, so I'm treating it as a server you manage (Docker over SSH, or Kubernetes if you have it).`
        : `Reading "${a.cloudOther}" as ${cloud.toUpperCase()}.`,
    );
  }
  if (a.host === 'other' && /bitbucket/i.test(a.hostOther))
    reasons.push('Bitbucket Pipelines is not generated yet; mirror the repo to GitHub/GitLab, or use Jenkins.');

  let ci: Recommendation['ci'];
  if (a.host === 'github') {
    ci = 'github-actions';
    reasons.push('Your code is on GitHub, so GitHub Actions needs no extra server or integration.');
  } else if (a.host === 'gitlab') {
    ci = 'gitlab-ci';
    reasons.push('GitLab CI/CD is built into GitLab: one file, shared runners, no setup.');
  } else if (a.host === 'azure-repos') {
    ci = 'azure-devops';
    reasons.push('Azure Pipelines integrates natively with Azure Repos and Azure resources.');
  } else {
    ci = a.team === 'large' ? 'jenkins' : 'github-actions';
    reasons.push(
      ci === 'jenkins'
        ? 'Self-hosted Jenkins works with any Git host and suits large teams that need full control (but needs maintenance).'
        : 'GitHub Actions is the lowest-effort hosted CI; you can mirror the repo to GitHub.',
    );
  }

  let deploy: Recommendation['deploy'];
  if (a.kubernetes) {
    deploy = 'kubernetes';
    reasons.push('You already run Kubernetes, so deploy there and keep one platform.');
  } else if (cloud === 'aws') {
    deploy = 'aws-ecs';
    reasons.push('AWS ECS runs containers without managing a Kubernetes control plane.');
  } else if (cloud === 'azure') {
    deploy = 'azure-app-service';
    reasons.push('Azure App Service is the simplest managed way to run a container on Azure.');
  } else if (cloud === 'gcp') {
    deploy = 'kubernetes';
    reasons.push('On GCP, GKE (Kubernetes) is the most portable path; Cloud Run is a good alternative.');
  } else {
    deploy = a.team === 'solo' ? 'ssh-vm' : 'kubernetes';
    reasons.push(
      deploy === 'ssh-vm'
        ? 'A single VM over SSH is the cheapest, simplest target for a solo project.'
        : 'Kubernetes gives a team scaling and rollout control without cloud lock-in.',
    );
  }

  let registry: Recommendation['registry'];
  if (cloud === 'aws' && deploy === 'aws-ecs') registry = 'ecr';
  else if (cloud === 'azure' && deploy === 'azure-app-service') registry = 'acr';
  else if (ci === 'github-actions') registry = 'ghcr';
  else if (ci === 'gitlab-ci') registry = 'gitlab';
  else registry = 'dockerhub';
  reasons.push(`Registry: keep images next to where they are deployed/built (${registry}) to simplify auth and cut transfer time.`);

  return { ci, registry, deploy, reasons };
}
