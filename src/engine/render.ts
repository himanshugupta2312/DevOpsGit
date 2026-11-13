import type { Config } from './types';
import type { Job, Pipeline, StageName } from './pipeline';

export const stageTitle = (s: StageName) =>
  s === 'verify' ? 'Verify' : s === 'package' ? 'Package' : `Deploy ${s.slice('deploy-'.length)}`;

const indent = (text: string, n: number) =>
  text
    .split('\n')
    .map((l) => (l ? ' '.repeat(n) + l : l))
    .join('\n');

export const usedStages = (p: Pipeline): StageName[] => [...new Set(p.jobs.map((j) => j.stage))];
const inStage = (p: Pipeline, s: StageName) => p.jobs.filter((j) => j.stage === s);
const prevStage = (p: Pipeline, s: StageName): StageName | undefined => {
  const used = usedStages(p);
  return used[used.indexOf(s) - 1];
};
const sh = (j: Job) => j.script.join('\n');

// ---------------------------------------------------------------- GitHub Actions
export function renderGitHub(p: Pipeline, cfg: Config): string {
  const expr = (s: string) => '$' + '{{ ' + s + ' }}';
  const out: string[] = [];
  out.push('name: CI/CD', '', 'on:', '  push:', '    branches: [main]', '  pull_request:', '    branches: [main]', '');
  out.push('permissions:', '  contents: read');
  if (cfg.registry === 'ghcr') out.push('  packages: write');
  out.push('', 'jobs:');
  for (const j of p.jobs) {
    out.push(`  ${j.id}:`, `    name: ${j.name}`, '    runs-on: ubuntu-latest');
    const prev = prevStage(p, j.stage);
    if (prev) out.push(`    needs: [${inStage(p, prev).map((x) => x.id).join(', ')}]`);
    if (j.stage !== 'verify') out.push("    if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    if (j.environment) out.push(`    environment: ${j.environment}`);
    if (j.image) out.push('    container:', `      image: ${j.image}`);
    out.push('    steps:', '      - uses: actions/checkout@v4');
    if (j.id === 'secret-scan') out.push('        with:', '          fetch-depth: 0');
    out.push(`      - name: ${j.name}`, '        run: |', indent(sh(j), 10));
    if (j.secrets.length) {
      out.push('        env:');
      for (const s of j.secrets) out.push(`          ${s}: ${expr('secrets.' + s)}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------- GitLab CI
export function renderGitLab(p: Pipeline): string {
  const out: string[] = [];
  out.push(`stages: [${usedStages(p).join(', ')}]`, '');
  out.push('workflow:', '  rules:');
  out.push('    - if: $CI_PIPELINE_SOURCE == "merge_request_event"');
  out.push('    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH', '');
  for (const j of p.jobs) {
    out.push(`${j.id}:`, `  stage: ${j.stage}`);
    if (j.docker) {
      out.push('  image: docker:27', '  services:', '    - docker:27-dind', '  variables:');
      out.push('    DOCKER_HOST: tcp://docker:2375', '    DOCKER_TLS_CERTDIR: ""');
    } else if (j.resetEntrypoint) {
      out.push('  image:', `    name: ${j.image}`, '    entrypoint: [""]');
    } else if (j.image) {
      out.push(`  image: ${j.image}`);
    }
    out.push('  script:', '    - |', indent(sh(j), 6));
    if (j.environment) out.push('  environment:', `    name: ${j.environment}`);
    if (j.stage !== 'verify') {
      out.push('  rules:');
      out.push(`    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH${j.manual ? '\n      when: manual' : ''}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------- Jenkins
export function renderJenkins(p: Pipeline): string {
  const stageBody = (j: Job, pad: number) => {
    const o: string[] = [];
    if (j.docker || !j.image) o.push('agent any');
    else
      o.push(
        'agent {',
        '  docker {',
        `    image '${j.image}'`,
        ...(j.resetEntrypoint ? ["    args '--entrypoint='"] : []),
        '  }',
        '}',
      );
    const script = ["sh '''", sh(j), "'''"].join('\n');
    if (j.secrets.length) {
      const creds = j.secrets.map((s) => `string(credentialsId: '${s}', variable: '${s}')`).join(',\n    ');
      o.push('steps {', `  withCredentials([\n    ${creds}\n  ]) {`, indent(script, 4), '  }', '}');
    } else {
      o.push('steps {', indent(script, 2), '}');
    }
    return indent(o.join('\n'), pad);
  };

  const out: string[] = ['pipeline {', '  agent none', '  options {', '    timestamps()', '    disableConcurrentBuilds()', '  }', '  stages {'];
  for (const s of usedStages(p)) {
    const jobs = inStage(p, s);
    out.push(`    stage('${stageTitle(s)}') {`);
    if (s !== 'verify') out.push("      when { expression { env.BRANCH_NAME == 'main' } }");
    if (inStage(p, s).some((j) => j.manual)) {
      out.push(
        '      options { beforeInput true }',
        '      input {',
        "        message 'Deploy to production?'",
        "        ok 'Deploy'",
        '      }',
      );
    }
    if (s === 'verify' && jobs.length > 1) {
      out.push('      parallel {');
      for (const j of jobs) out.push(`        stage('${j.name}') {`, stageBody(j, 10), '        }');
      out.push('      }');
    } else {
      out.push(stageBody(jobs[0], 6));
      if (jobs.length > 1) throw new Error('unexpected multiple jobs in stage ' + s);
    }
    out.push('    }');
  }
  out.push('  }', '}');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- Azure Pipelines
export function renderAzure(p: Pipeline): string {
  const id = (s: string) => s.replace(/-/g, '_');
  const out: string[] = ['trigger:', '  branches:', '    include: [main]', 'pr:', '  branches:', '    include: [main]', '', 'pool:', '  vmImage: ubuntu-latest', '', 'stages:'];
  for (const s of usedStages(p)) {
    out.push(`  - stage: ${id(s)}`, `    displayName: ${stageTitle(s)}`);
    const prev = prevStage(p, s);
    if (prev) out.push(`    dependsOn: ${id(prev)}`);
    if (s !== 'verify')
      out.push("    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))");
    out.push('    jobs:');
    for (const j of inStage(p, s)) {
      const steps: string[] = ['- checkout: self'];
      if (j.id === 'secret-scan') steps.push('  fetchDepth: 0');
      steps.push('- script: |', indent(sh(j), 4), `  displayName: ${j.name}`);
      if (j.secrets.length) {
        steps.push('  env:');
        for (const sec of j.secrets) steps.push(`    ${sec}: $(${sec})`);
      }
      if (j.environment) {
        out.push(`      - deployment: ${id(j.id)}`, `        displayName: ${j.name}`, `        environment: ${j.environment}`);
        if (j.image) out.push(`        container: ${j.image}`);
        out.push('        strategy:', '          runOnce:', '            deploy:', '              steps:', indent(steps.join('\n'), 16));
      } else {
        out.push(`      - job: ${id(j.id)}`, `        displayName: ${j.name}`);
        if (j.image) out.push(`        container: ${j.image}`);
        out.push('        steps:', indent(steps.join('\n'), 10));
      }
    }
  }
  return out.join('\n') + '\n';
}
