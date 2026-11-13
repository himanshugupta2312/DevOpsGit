import { isProdLike } from './types';
import type { CI, Config, Language } from './types';

/**
 * Tool-neutral pipeline model. One model is built from the user's choices,
 * then rendered into GitHub Actions / GitLab CI / Jenkins / Azure Pipelines.
 * Scripts are POSIX sh and reference secrets by their exact secret name.
 */
export type StageName = 'verify' | 'package' | `deploy-${string}`;

export interface Job {
  id: string;
  name: string;
  stage: StageName;
  /** Container image the job runs in. Omit for jobs that need the host Docker daemon. */
  image?: string;
  /** Image has an ENTRYPOINT that must be cleared so the CI can run shell commands. */
  resetEntrypoint?: boolean;
  /** Job builds images (needs a Docker daemon). */
  docker?: boolean;
  script: string[];
  secrets: string[];
  environment?: string;
  manual?: boolean;
}

export interface Pipeline {
  jobs: Job[];
  secrets: { name: string; purpose: string }[];
}

export const LANGS: Record<
  Exclude<Language, 'other'>,
  { image: string; steps: string[]; audit: string; port: number }
> = {
  node: {
    image: 'node:20',
    steps: ['npm ci', 'npm test --if-present', 'npm run build --if-present'],
    audit: 'npm audit --audit-level=high',
    port: 3000,
  },
  python: {
    image: 'python:3.12',
    steps: ['pip install -r requirements.txt', 'pip install pytest', 'pytest'],
    audit: 'pip install pip-audit\npip-audit -r requirements.txt',
    port: 8000,
  },
  java: {
    image: 'maven:3.9-eclipse-temurin-21',
    steps: ['mvn -B verify'],
    audit: 'mvn -B org.owasp:dependency-check-maven:check -DfailBuildOnCVSS=8',
    port: 8080,
  },
  dotnet: {
    image: 'mcr.microsoft.com/dotnet/sdk:8.0',
    steps: ['dotnet restore', 'dotnet build -c Release --no-restore', 'dotnet test -c Release --no-build'],
    audit: 'dotnet list package --vulnerable --include-transitive',
    port: 8080,
  },
  go: {
    image: 'golang:1.23',
    steps: ['go vet ./...', 'go test ./...', 'go build ./...'],
    audit: 'go install golang.org/x/vuln/cmd/govulncheck@latest\n"$(go env GOPATH)"/bin/govulncheck ./...',
    port: 8080,
  },
};

export interface LangSpec { image: string; steps: string[]; audit: string; port: number }

/** Language settings; for "other" they come from what the user typed. */
export function langSpec(cfg: Config): LangSpec {
  if (cfg.language !== 'other') return LANGS[cfg.language];
  const c = cfg.custom;
  const steps = c.languageCommands.split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    image: c.languageImage.trim() || 'ubuntu:24.04',
    steps: steps.length ? steps : ['echo "TODO: add your build and test commands"'],
    audit: '',
    port: Number(c.port) || 8080,
  };
}

const SHA_VAR: Record<CI, string> = {
  other: 'GIT_COMMIT_SHA',
  'github-actions': 'GITHUB_SHA',
  'gitlab-ci': 'CI_COMMIT_SHA',
  jenkins: 'GIT_COMMIT',
  'azure-devops': 'BUILD_SOURCEVERSION',
};

const sfx = (name: string, env: string) => `${name}_${env.toUpperCase().replace(/-/g, '_')}`;

interface RegistrySpec {
  imageLine: string;
  login: string;
  setup: string[]; // extra installs (only needed on Alpine docker image used by GitLab)
  secrets: { name: string; purpose: string }[];
}

function registrySpec(cfg: Config): RegistrySpec {
  const app = cfg.appName;
  const customHost = (cfg.custom.registryHost.trim() || 'registry.example.com').replace(/\/+$/, '');
  const lower = (s: string) => `$(echo "${s}" | tr '[:upper:]' '[:lower:]')`;
  const generic = (host: string) => ({
    login: `echo "$REGISTRY_PASSWORD" | docker login ${host} -u "$REGISTRY_USER" --password-stdin`,
    secrets: [
      { name: 'REGISTRY_USER', purpose: `Username for ${host}` },
      { name: 'REGISTRY_PASSWORD', purpose: `Password / access token for ${host}` },
    ],
  });
  switch (cfg.registry) {
    case 'ghcr':
      if (cfg.ci === 'github-actions')
        return {
          imageLine: `IMAGE=${lower('ghcr.io/$GITHUB_REPOSITORY')}`,
          login: 'echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin',
          setup: [],
          secrets: [],
        };
      return {
        imageLine: `IMAGE=${lower(`ghcr.io/$REGISTRY_NAMESPACE/${app}`)}`,
        setup: [],
        ...generic('ghcr.io'),
        secrets: [
          ...generic('ghcr.io').secrets,
          { name: 'REGISTRY_NAMESPACE', purpose: 'GitHub user/org that owns the images' },
        ],
      };
    case 'gitlab':
      if (cfg.ci === 'gitlab-ci')
        return {
          imageLine: 'IMAGE=$CI_REGISTRY_IMAGE',
          login: 'echo "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" --password-stdin',
          setup: [],
          secrets: [],
        };
      return {
        imageLine: `IMAGE=registry.gitlab.com/$REGISTRY_NAMESPACE/${app}`,
        setup: [],
        ...generic('registry.gitlab.com'),
        secrets: [
          ...generic('registry.gitlab.com').secrets,
          { name: 'REGISTRY_NAMESPACE', purpose: 'GitLab group/project path' },
        ],
      };
    case 'dockerhub':
      return {
        imageLine: `IMAGE=$REGISTRY_USER/${app}`,
        setup: [],
        ...generic('docker.io'),
      };
    case 'ecr': {
      const host = '$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com';
      return {
        imageLine: `IMAGE=${host}/${app}`,
        login: `aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin ${host}`,
        setup: ['apk add --no-cache aws-cli'],
        secrets: [
          { name: 'AWS_ACCESS_KEY_ID', purpose: 'IAM user/role key allowed to push to ECR (and update ECS)' },
          { name: 'AWS_SECRET_ACCESS_KEY', purpose: 'Secret for the key above' },
          { name: 'AWS_REGION', purpose: 'e.g. us-east-1' },
          { name: 'AWS_ACCOUNT_ID', purpose: '12-digit AWS account id' },
        ],
      };
    }
    case 'other':
      return {
        imageLine: `IMAGE=${customHost}/${app}`,
        setup: [],
        ...generic(customHost.split('/')[0]),
      };
    case 'acr':
      return {
        imageLine: `IMAGE=$ACR_NAME.azurecr.io/${app}`,
        login: 'echo "$ACR_PASSWORD" | docker login "$ACR_NAME.azurecr.io" -u "$ACR_USERNAME" --password-stdin',
        setup: [],
        secrets: [
          { name: 'ACR_NAME', purpose: 'Registry name (without .azurecr.io)' },
          { name: 'ACR_USERNAME', purpose: 'Service principal id (or ACR admin user)' },
          { name: 'ACR_PASSWORD', purpose: 'Service principal secret (or ACR admin password)' },
        ],
      };
  }
}

function deployJob(cfg: Config, env: string, reg: RegistrySpec): Job | null {
  const app = cfg.appName;
  const full = `${app}-${env}`;
  const port = langSpec(cfg).port;
  const tagLine = `TAG=$(echo "$${SHA_VAR[cfg.ci]}" | cut -c1-12)`;
  const base = {
    id: `deploy-${env}`,
    name: `Deploy to ${env}`,
    stage: `deploy-${env}` as StageName,
    environment: env,
    manual: isProdLike(env),
  };
  const S = (n: string) => sfx(n, env);
  const imgSecrets = reg.secrets.filter((s) => reg.imageLine.includes('$' + s.name)).map((s) => s.name);

  switch (cfg.deploy) {
    case 'none':
      return null;
    case 'other':
      return {
        ...base,
        image: 'alpine:3.20',
        secrets: [],
        script: [
          'set -eu',
          reg.imageLine,
          tagLine,
          `# TODO: deploy "$IMAGE:$TAG" to ${cfg.custom.deployName.trim() || 'your target'} (${env})`,
          '# Put your deploy commands here (helm upgrade, nomad run, ssh ..., fly deploy, gcloud run deploy ...).',
          'echo "Deploying $IMAGE:$TAG to ' + env + '"',
        ],
      };
    case 'kubernetes':
      return {
        ...base,
        image: 'alpine/k8s:1.30.2',
        resetEntrypoint: true,
        secrets: [S('KUBE_CONFIG'), ...imgSecrets],
        script: [
          'set -eu',
          reg.imageLine,
          tagLine,
          `echo "$${S('KUBE_CONFIG')}" | base64 -d > "$PWD/kubeconfig"`,
          'export KUBECONFIG="$PWD/kubeconfig"',
          `kubectl create namespace ${full} --dry-run=client -o yaml | kubectl apply -f -`,
          `sed "s|IMAGE_PLACEHOLDER|$IMAGE:$TAG|" k8s/deployment.yaml | kubectl -n ${full} apply -f -`,
          `kubectl -n ${full} apply -f k8s/service.yaml`,
          `kubectl -n ${full} rollout status deployment/${app} --timeout=180s`,
        ],
      };
    case 'aws-ecs':
      return {
        ...base,
        image: 'amazon/aws-cli:latest',
        resetEntrypoint: true,
        secrets: [...new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', ...imgSecrets])],
        script: [
          'set -eu',
          'command -v jq >/dev/null || yum install -y jq',
          reg.imageLine,
          tagLine,
          `TD=$(aws ecs describe-task-definition --task-definition ${full} --query taskDefinition)`,
          `NEW=$(echo "$TD" | jq --arg IMG "$IMAGE:$TAG" 'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy) | .containerDefinitions[0].image=$IMG')`,
          'ARN=$(aws ecs register-task-definition --cli-input-json "$NEW" --query taskDefinition.taskDefinitionArn --output text)',
          `aws ecs update-service --cluster ${full} --service ${app} --task-definition "$ARN" >/dev/null`,
          `aws ecs wait services-stable --cluster ${full} --services ${app}`,
        ],
      };
    case 'azure-app-service':
      return {
        ...base,
        image: 'mcr.microsoft.com/azure-cli:latest',
        resetEntrypoint: true,
        secrets: ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', ...imgSecrets],
        script: [
          'set -eu',
          reg.imageLine,
          tagLine,
          'az login --service-principal -u "$AZURE_CLIENT_ID" -p "$AZURE_CLIENT_SECRET" --tenant "$AZURE_TENANT_ID" >/dev/null',
          'az account set --subscription "$AZURE_SUBSCRIPTION_ID"',
          `az webapp config container set --name ${full} --resource-group rg-${full} --container-image-name "$IMAGE:$TAG"`,
          `az webapp restart --name ${full} --resource-group rg-${full}`,
        ],
      };
    case 'ssh-vm':
      return {
        ...base,
        image: 'alpine:3.20',
        secrets: [S('SSH_HOST'), S('SSH_USER'), S('SSH_KEY'), ...imgSecrets],
        script: [
          'set -eu',
          'command -v ssh >/dev/null || apk add --no-cache openssh-client',
          reg.imageLine,
          tagLine,
          'mkdir -p ~/.ssh',
          `echo "$${S('SSH_KEY')}" > ~/.ssh/deploy_key && chmod 600 ~/.ssh/deploy_key`,
          `ssh-keyscan -H "$${S('SSH_HOST')}" >> ~/.ssh/known_hosts`,
          `ssh -i ~/.ssh/deploy_key "$${S('SSH_USER')}@$${S('SSH_HOST')}" "docker pull $IMAGE:$TAG && (docker rm -f ${full} || true) && docker run -d --name ${full} --restart unless-stopped -p ${port}:${port} $IMAGE:$TAG"`,
        ],
      };
  }
}

export function buildPipeline(cfg: Config): Pipeline {
  const lang = langSpec(cfg);
  const reg = registrySpec(cfg);
  const jobs: Job[] = [];

  jobs.push({
    id: 'build-test',
    name: 'Build & test',
    stage: 'verify',
    image: lang.image,
    script: ['set -eu', ...lang.steps],
    secrets: [],
  });

  if (cfg.security.deps && lang.audit)
    jobs.push({
      id: 'dependency-audit',
      name: 'Dependency audit',
      stage: 'verify',
      image: lang.image,
      script: ['set -eu', ...lang.audit.split('\n')],
      secrets: [],
    });
  if (cfg.security.sast)
    jobs.push({
      id: 'sast',
      name: 'SAST (Semgrep)',
      stage: 'verify',
      image: 'semgrep/semgrep:latest',
      resetEntrypoint: true,
      script: ['set -eu', 'semgrep scan --config auto --error .'],
      secrets: [],
    });
  if (cfg.security.secrets)
    jobs.push({
      id: 'secret-scan',
      name: 'Secret scan (Gitleaks)',
      stage: 'verify',
      image: 'zricethezav/gitleaks:latest',
      resetEntrypoint: true,
      script: ['set -eu', 'git config --global --add safe.directory "$PWD"', 'gitleaks detect --source . --no-banner --redact'],
      secrets: [],
    });
  if (cfg.terraform)
    jobs.push({
      id: 'terraform-validate',
      name: 'Terraform validate',
      stage: 'verify',
      image: 'hashicorp/terraform:1.9',
      resetEntrypoint: true,
      script: ['set -eu', 'cd terraform', 'terraform init -backend=false', 'terraform fmt -check', 'terraform validate'],
      secrets: [],
    });

  const dockerScript = ['set -eu', ...reg.setup, reg.imageLine, `TAG=$(echo "$${SHA_VAR[cfg.ci]}" | cut -c1-12)`];
  dockerScript.push('docker build -t "$IMAGE:$TAG" -t "$IMAGE:latest" .');
  if (cfg.security.containerScan)
    dockerScript.push(
      'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.57.1 image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$IMAGE:$TAG"',
    );
  dockerScript.push(reg.login, 'docker push "$IMAGE:$TAG"', 'docker push "$IMAGE:latest"');
  jobs.push({
    id: 'docker',
    name: 'Build & push image',
    stage: 'package',
    docker: true,
    script: dockerScript,
    secrets: [
      ...(cfg.registry === 'ghcr' && cfg.ci === 'github-actions' ? ['GITHUB_TOKEN'] : []),
      ...reg.secrets.map((s) => s.name),
    ],
  });

  const secrets = [...reg.secrets];
  for (const env of cfg.environments) {
    const j = deployJob(cfg, env, reg);
    if (j) jobs.push(j);
  }
  const jobSecrets = new Set(jobs.flatMap((j) => j.secrets));
  const known = new Map<string, string>();
  const note = (name: string, purpose: string) => known.set(name, purpose);
  secrets.forEach((s) => note(s.name, s.purpose));
  for (const n of jobSecrets) {
    if (known.has(n) || n === 'GITHUB_TOKEN') continue;
    if (n.startsWith('KUBE_CONFIG')) note(n, 'Base64-encoded kubeconfig:  base64 -w0 ~/.kube/config');
    else if (n.startsWith('SSH_HOST')) note(n, 'Hostname/IP of the target VM');
    else if (n.startsWith('SSH_USER')) note(n, 'SSH user on the VM (must be able to run docker)');
    else if (n.startsWith('SSH_KEY')) note(n, 'Private deploy key (public half in ~/.ssh/authorized_keys)');
    else if (n.startsWith('AWS_')) note(n, 'AWS credential / setting used for deployment');
    else if (n.startsWith('AZURE_CLIENT_ID')) note(n, 'Service principal app id');
    else if (n.startsWith('AZURE_CLIENT_SECRET')) note(n, 'Service principal password');
    else if (n.startsWith('AZURE_TENANT_ID')) note(n, 'Azure AD tenant id');
    else if (n.startsWith('AZURE_SUBSCRIPTION_ID')) note(n, 'Azure subscription id');
  }
  return { jobs, secrets: [...known].map(([name, purpose]) => ({ name, purpose })) };
}
