import type { Config, GeneratedFile, Language, Step } from './types';
import { isProdLike, LABELS } from './types';
import { buildPipeline, langSpec } from './pipeline';
import type { Pipeline } from './pipeline';
import { renderAzure, renderGitHub, renderGitLab, renderJenkins, stageTitle, usedStages } from './render';

const DOCKERFILES: Record<Exclude<Language, 'other'>, (app: string) => string> = {
  node: () => `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# TODO: if you compile (TypeScript etc.), use a multi-stage build and copy only the output
USER node
EXPOSE 3000
CMD ["npm", "start"]
`,
  python: () => `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd -m appuser
USER appuser
EXPOSE 8000
# TODO: replace with your real entrypoint (e.g. gunicorn app:app -b 0.0.0.0:8000)
CMD ["python", "app.py"]
`,
  java: () => `FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -B dependency:go-offline
COPY src ./src
RUN mvn -B -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/target/*.jar app.jar
RUN useradd -m appuser
USER appuser
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
`,
  dotnet: (app) => `FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
USER app
# TODO: use your real assembly name
ENTRYPOINT ["dotnet", "${app}.dll"]
`,
  go: () => `FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
EXPOSE 8080
ENTRYPOINT ["/app"]
`,
};

function dockerfileFor(cfg: Config): string {
  if (cfg.language !== 'other') return DOCKERFILES[cfg.language](cfg.appName);
  const c = cfg.custom;
  return `# ${c.languageName || 'Custom'} app. TODO: adjust to your runtime.
FROM ${c.languageImage.trim() || 'ubuntu:24.04'}
WORKDIR /app
COPY . .
# Build step(s) from your pipeline settings:
${langSpec(cfg).steps.map((s) => '# RUN ' + s).join('\n')}
EXPOSE ${langSpec(cfg).port}
# TODO: replace with the command that starts your app
CMD ["sh", "-c", "echo 'TODO: set CMD in Dockerfile' && sleep infinity"]
`;
}

const langName = (cfg: Config) => (cfg.language === 'other' ? cfg.custom.languageName.trim() || 'your language' : LABELS.language[cfg.language]);
const ciName = (cfg: Config) => (cfg.ci === 'other' ? cfg.custom.ciName.trim() || 'your CI tool' : LABELS.ci[cfg.ci]);
const deployName = (cfg: Config) => (cfg.deploy === 'other' ? cfg.custom.deployName.trim() || 'your target' : LABELS.deploy[cfg.deploy]);

/** Tool-neutral output for a CI system we don't generate native config for. */
function genericCI(p: Pipeline, cfg: Config): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const md: string[] = [
    `# Pipeline for ${cfg.appName} (${ciName(cfg)})`,
    '',
    `No native template exists for ${ciName(cfg)}, so each job is a standalone shell script in scripts/.`,
    'Create one job per script in your CI tool, running it in the listed image, in the order below.',
    '',
    'Triggers: pull requests run the Verify stage only; pushes to main run everything.',
    'Set the env var GIT_COMMIT_SHA to the commit being built (your CI usually exposes it under another name).',
    '',
  ];
  for (const s of usedStages(p)) {
    md.push(`## ${stageTitle(s)}`);
    for (const j of p.jobs.filter((x) => x.stage === s)) {
      md.push(
        `- **${j.name}** → scripts/${j.id}.sh` +
          (j.image ? ` · image: \`${j.image}\`` : ' · runs on a host with Docker') +
          (j.manual ? ' · requires manual approval' : '') +
          (j.secrets.length ? ` · secrets: ${j.secrets.join(', ')}` : ''),
      );
    }
    md.push('');
  }
  files.push({ path: 'PIPELINE.md', description: `Stage-by-stage outline to recreate in ${ciName(cfg)}`, content: md.join('\n'), lang: 'text' });
  for (const j of p.jobs) {
    files.push({
      path: `scripts/${j.id}.sh`,
      description: `${j.name}${j.image ? ' (image: ' + j.image + ')' : ''}`,
      lang: 'text',
      content: `#!/bin/sh
# ${j.name}
# Image: ${j.image ?? 'host with Docker'}
# Needs env: ${j.secrets.join(', ') || '(none)'}
${j.script.join('\n')}
`,
    });
  }
  return files;
}

const DOCKERIGNORE = `.git
node_modules
bin
obj
target
__pycache__
*.md
.env
.github
.gitlab-ci.yml
Jenkinsfile
azure-pipelines.yml
terraform
`;

function k8sDeployment(cfg: Config): string {
  const port = langSpec(cfg).port;
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${cfg.appName}
spec:
  replicas: 2
  selector:
    matchLabels: { app: ${cfg.appName} }
  template:
    metadata:
      labels: { app: ${cfg.appName} }
    spec:
      containers:
        - name: ${cfg.appName}
          image: IMAGE_PLACEHOLDER   # replaced by the pipeline
          ports:
            - containerPort: ${port}
          readinessProbe:
            httpGet: { path: /, port: ${port} }   # TODO: point at your health endpoint
            initialDelaySeconds: 5
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 512Mi }
      # imagePullSecrets: [{ name: registry-credentials }]   # needed for private registries
`;
}

function k8sService(cfg: Config): string {
  const port = langSpec(cfg).port;
  return `apiVersion: v1
kind: Service
metadata:
  name: ${cfg.appName}
spec:
  selector: { app: ${cfg.appName} }
  ports:
    - port: 80
      targetPort: ${port}
`;
}

function terraformFiles(cfg: Config): GeneratedFile[] {
  const app = cfg.appName;
  const envs = cfg.environments.map((e) => `"${e}"`).join(', ');
  const f = (path: string, description: string, content: string): GeneratedFile => ({ path, description, content, lang: 'hcl' });

  if (cfg.deploy === 'aws-ecs') {
    return [
      f('terraform/main.tf', 'AWS: ECR repo + one ECS cluster per environment', `terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # TODO: configure a remote backend (S3 + DynamoDB lock) before real use
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "environments" {
  type    = set(string)
  default = [${envs}]
}

resource "aws_ecr_repository" "app" {
  name                 = "${app}"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecs_cluster" "env" {
  for_each = var.environments
  name     = "${app}-\${each.key}"
}

# TODO: add task definition (family = "${app}-<env>"), service "${app}", ALB, IAM roles, VPC.
# The pipeline expects the task definition + service to already exist.
`),
    ];
  }
  if (cfg.deploy === 'azure-app-service') {
    return [
      f('terraform/main.tf', 'Azure: resource group, ACR, Linux web app per environment', `terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.100" }
  }
  # TODO: configure a remote backend (azurerm storage account) before real use
}

provider "azurerm" {
  features {}
}

variable "location" {
  type    = string
  default = "eastus"
}

variable "environments" {
  type    = set(string)
  default = [${envs}]
}

resource "azurerm_resource_group" "env" {
  for_each = var.environments
  name     = "rg-${app}-\${each.key}"
  location = var.location
}

resource "azurerm_service_plan" "env" {
  for_each            = var.environments
  name                = "plan-${app}-\${each.key}"
  resource_group_name = azurerm_resource_group.env[each.key].name
  location            = var.location
  os_type             = "Linux"
  sku_name            = "B1"
}

resource "azurerm_linux_web_app" "env" {
  for_each            = var.environments
  name                = "${app}-\${each.key}"
  resource_group_name = azurerm_resource_group.env[each.key].name
  location            = var.location
  service_plan_id     = azurerm_service_plan.env[each.key].id
  site_config {
    application_stack {
      docker_image_name   = "nginx:latest" # placeholder, replaced by the pipeline
      docker_registry_url = "https://index.docker.io"
    }
  }
}
`),
    ];
  }
  if (cfg.deploy === 'kubernetes') {
    return [
      f('terraform/main.tf', 'Kubernetes: one namespace per environment (extend with your cluster module)', `terraform {
  required_version = ">= 1.5"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
  }
}

provider "kubernetes" {
  config_path = "~/.kube/config" # TODO: or provision the cluster (EKS/AKS/GKE) in this config
}

variable "environments" {
  type    = set(string)
  default = [${envs}]
}

resource "kubernetes_namespace" "env" {
  for_each = var.environments
  metadata { name = "${app}-\${each.key}" }
}
`),
    ];
  }
  return [
    f('terraform/main.tf', 'Placeholder: add your VM / network resources', `terraform {
  required_version = ">= 1.5"
}

# TODO: provision the VM (and firewall: 22 for SSH, app port) with your cloud's provider.
# Install Docker on it, and run \`docker login\` once so it can pull private images.
`),
  ];
}

export function generateFiles(cfg: Config): GeneratedFile[] {
  const p = buildPipeline(cfg);
  const files: GeneratedFile[] = [];

  switch (cfg.ci) {
    case 'other':
      files.push(...genericCI(p, cfg));
      break;
    case 'github-actions':
      files.push({ path: '.github/workflows/ci-cd.yml', description: 'GitHub Actions workflow', content: renderGitHub(p, cfg), lang: 'yaml' });
      break;
    case 'gitlab-ci':
      files.push({ path: '.gitlab-ci.yml', description: 'GitLab CI/CD pipeline', content: renderGitLab(p), lang: 'yaml' });
      break;
    case 'jenkins':
      files.push({ path: 'Jenkinsfile', description: 'Jenkins declarative pipeline (multibranch)', content: renderJenkins(p), lang: 'groovy' });
      break;
    case 'azure-devops':
      files.push({ path: 'azure-pipelines.yml', description: 'Azure Pipelines definition', content: renderAzure(p), lang: 'yaml' });
      break;
  }

  files.push({ path: 'Dockerfile', description: `Container image for ${langName(cfg)}`, content: dockerfileFor(cfg), lang: 'dockerfile' });
  files.push({ path: '.dockerignore', description: 'Keeps the build context small', content: DOCKERIGNORE, lang: 'text' });

  if (cfg.deploy === 'kubernetes') {
    files.push({ path: 'k8s/deployment.yaml', description: 'Kubernetes Deployment', content: k8sDeployment(cfg), lang: 'yaml' });
    files.push({ path: 'k8s/service.yaml', description: 'Kubernetes Service', content: k8sService(cfg), lang: 'yaml' });
  }
  if (cfg.terraform) files.push(...terraformFiles(cfg));
  return files;
}

export function generateSteps(cfg: Config): Step[] {
  const p = buildPipeline(cfg);
  const steps: Step[] = [];
  const file = generateFiles(cfg)[0].path;
  const ci = ciName(cfg);

  steps.push({
    title: 'Add the generated files to your repository',
    detail: `Copy everything from the download into your repo root (${file}, Dockerfile, .dockerignore${cfg.deploy === 'kubernetes' ? ', k8s/' : ''}${cfg.terraform ? ', terraform/' : ''}). Review the TODO comments, especially in the Dockerfile.`,
  });
  steps.push({
    title: 'Make sure the app builds and tests locally',
    detail: `The pipeline runs: ${langSpec(cfg).steps.join(' → ')}. Fix anything that fails locally first; it will fail in CI too.`,
  });
  steps.push({
    title: 'Verify the container locally',
    detail: `docker build -t ${cfg.appName} . && docker run -p ${langSpec(cfg).port}:${langSpec(cfg).port} ${cfg.appName}`,
  });
  if (cfg.terraform)
    steps.push({
      title: 'Provision infrastructure with Terraform',
      detail: 'cd terraform && terraform init && terraform plan, then terraform apply. Set up a remote state backend first. The pipeline only validates Terraform; it does not apply it.',
    });

  if (p.secrets.length) {
    const where =
      cfg.ci === 'other'
        ? `Your CI tool's secret/credential store, exposed to the jobs as environment variables with exactly these names`
        : cfg.ci === 'github-actions'
        ? 'Repo → Settings → Secrets and variables → Actions'
        : cfg.ci === 'gitlab-ci'
          ? 'Project → Settings → CI/CD → Variables (mask them, and protect them for the main branch)'
          : cfg.ci === 'jenkins'
            ? 'Manage Jenkins → Credentials (kind "Secret text", ID = the name below)'
            : 'Pipelines → Library → Variable group, or pipeline variables (mark as secret)';
    steps.push({
      title: `Create the secrets in ${ci}`,
      detail: `${where}:\n` + p.secrets.map((s) => `• ${s.name}: ${s.purpose}`).join('\n'),
    });
  }

  if (cfg.environments.length) {
    const prod = cfg.environments.filter(isProdLike);
    const how: Record<string, string> = {
      other: `Create environments (${cfg.environments.join(', ')}) in ${ci}${prod.length ? ' and require manual approval before ' + prod.join(', ') : ''}.`,
      'github-actions': 'Settings → Environments: create "staging"/"production" and add required reviewers to production for manual approval.',
      'gitlab-ci': 'The production job is "manual": click Play on the pipeline to release. Optionally add Deploy → Environments protection.',
      jenkins: 'Production waits on an input prompt; restrict who can approve via Jenkins authorization.',
      'azure-devops': 'Pipelines → Environments: create "staging"/"production" and add an Approval check to production.',
    };
    steps.push({
      title: `Set up environments (${cfg.environments.join(' → ')}) and approvals`,
      detail: how[cfg.ci] + `
Deploys run in this order. ${prod.length ? 'Production-like environments (' + prod.join(', ') + ') need manual approval.' : 'No production-like environment selected, so every deploy is automatic.'}`,
    });
  }

  const deployPrereq: Record<string, string> = {
    none: '',
    kubernetes: `Create a cluster and a service account/kubeconfig that can manage namespaces "${cfg.appName}-<env>". For private registries create an imagePullSecret and uncomment it in k8s/deployment.yaml.`,
    'aws-ecs': `Create ECS cluster "${cfg.appName}-<env>", a task definition family "${cfg.appName}-<env>" and a service named "${cfg.appName}" (Terraform stub provided). The pipeline registers a new task-definition revision per deploy.`,
    'azure-app-service': `Create resource group rg-${cfg.appName}-<env> and a Linux Web App ${cfg.appName}-<env> (Terraform stub provided). Give the service principal Contributor on it.`,
    other: `Prepare ${cfg.custom.deployName.trim() || 'your target'}, then replace the TODO in the deploy job with the real deploy commands. Tell me what it is (Helm, Nomad, Fly.io, Cloud Run…) and I can generate them.`,
    'ssh-vm': 'Provision a VM, install Docker, add the deploy public key to authorized_keys, and run `docker login` once on the VM for private images.',
  };
  if (deployPrereq[cfg.deploy]) steps.push({ title: `Prepare the ${deployName(cfg)} target`, detail: deployPrereq[cfg.deploy] });

  if (cfg.ci === 'jenkins')
    steps.push({
      title: 'Wire up Jenkins',
      detail: 'Create a Multibranch Pipeline job pointing at the repo. The agent needs Docker (Docker Pipeline plugin) and the Credentials Binding plugin.',
    });

  steps.push({
    title: 'Push to a branch and open a pull request',
    detail: 'PRs run only the Verify stage (build, tests, security checks). Merging to main runs Package and then deploys.',
  });
  steps.push({
    title: 'Harden and iterate',
    detail: 'Add branch protection requiring the Verify jobs, pin image versions/digests, add caching to speed builds, and add smoke tests after each deploy.',
  });
  return steps;
}
