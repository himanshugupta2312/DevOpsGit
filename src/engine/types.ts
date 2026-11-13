export type Language = 'node' | 'python' | 'java' | 'dotnet' | 'go' | 'other';
export type CI = 'github-actions' | 'gitlab-ci' | 'jenkins' | 'azure-devops' | 'other';
export type Registry = 'ghcr' | 'gitlab' | 'dockerhub' | 'ecr' | 'acr' | 'other';
export type Deploy = 'none' | 'kubernetes' | 'aws-ecs' | 'azure-app-service' | 'ssh-vm' | 'other';
export type SourceHost = 'github' | 'gitlab' | 'azure-repos' | 'other';
export type Cloud = 'aws' | 'azure' | 'gcp' | 'none' | 'other';

export interface Config {
  appName: string;
  language: Language;
  ci: CI;
  registry: Registry;
  deploy: Deploy;
  terraform: boolean;
  /** Ordered environment names, e.g. ['dev','test','staging','production']. */
  environments: string[];
  /** Details the user supplies when choosing "Other" on an option. */
  custom: Custom;
  security: { deps: boolean; sast: boolean; containerScan: boolean; secrets: boolean };
}

export interface Custom {
  languageName: string;
  languageImage: string; // Docker image to build/test in, e.g. rust:1.80
  languageCommands: string; // one command per line
  port: string;
  ciName: string;
  registryHost: string; // e.g. registry.example.com/team
  deployName: string; // free text: what/where you deploy
}

export const EMPTY_CUSTOM: Custom = {
  languageName: '', languageImage: '', languageCommands: '', port: '8080', ciName: '', registryHost: '', deployName: '',
};

/** Production-like environments get a manual approval gate. */
export const isProdLike = (env: string) => /^(prod|production|live)$/.test(env);

/** Parse + order environments: presets and custom names, production-like last. */
export function envList(presets: string[], customText: string): string[] {
  const custom = customText.split(',').map((s) => s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean);
  const all = [...new Set([...presets, ...custom])];
  return [...all.filter((e) => !isProdLike(e)), ...all.filter(isProdLike)];
}

export interface GeneratedFile {
  path: string;
  description: string;
  content: string;
  lang: 'yaml' | 'dockerfile' | 'groovy' | 'hcl' | 'text';
}

export interface Step {
  title: string;
  detail: string;
}

export interface Answers {
  host: SourceHost;
  hostOther: string;
  cloud: Cloud;
  cloudOther: string;
  team: 'solo' | 'small' | 'large';
  kubernetes: boolean;
}

export interface Recommendation {
  ci: CI;
  registry: Registry;
  deploy: Deploy;
  reasons: string[];
}

export const LABELS = {
  language: { node: 'Node.js', python: 'Python', java: 'Java (Maven)', dotnet: '.NET', go: 'Go', other: 'Other…' },
  ci: {
    'github-actions': 'GitHub Actions',
    'gitlab-ci': 'GitLab CI/CD',
    jenkins: 'Jenkins',
    'azure-devops': 'Azure Pipelines',
    other: 'Other…',
  },
  registry: {
    ghcr: 'GitHub Container Registry',
    gitlab: 'GitLab Registry',
    dockerhub: 'Docker Hub',
    ecr: 'Amazon ECR',
    acr: 'Azure Container Registry',
    other: 'Other…',
  },
  deploy: {
    none: 'Build only (no deploy)',
    kubernetes: 'Kubernetes',
    'aws-ecs': 'AWS ECS',
    'azure-app-service': 'Azure App Service',
    'ssh-vm': 'Single VM over SSH',
    other: 'Other…',
  },
} as const;
