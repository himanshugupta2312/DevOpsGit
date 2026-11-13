import { generateFiles, generateSteps } from './generate';
import { recommend } from './recommend';
import type { CI, Config, Deploy, Language, Registry } from './types';
import { envList } from './types';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Generates a matrix of configs, checks invariants, and dumps output to ./.out for external linting.
const cis: CI[] = ['github-actions', 'gitlab-ci', 'jenkins', 'azure-devops', 'other'];
const langs: Language[] = ['node', 'python', 'java', 'dotnet', 'go', 'other'];
const deploys: Deploy[] = ['none', 'kubernetes', 'aws-ecs', 'azure-app-service', 'ssh-vm', 'other'];
const regs: Registry[] = ['ghcr', 'gitlab', 'dockerhub', 'ecr', 'acr', 'other'];

let n = 0;
for (const ci of cis)
  for (const language of langs)
    for (const deploy of deploys)
      for (const registry of regs) {
        const cfg: Config = {
          appName: 'demo-app',
          language,
          ci,
          registry,
          deploy,
          terraform: deploy !== 'none',
          environments: deploy === 'none' ? [] : envList(['dev', 'test', 'production'], 'QA, uat env'),
          custom: {
            languageName: 'Rust', languageImage: 'rust:1.80', languageCommands: 'cargo build\ncargo test', port: '8080',
            ciName: 'CircleCI', registryHost: 'registry.example.com/team', deployName: 'Fly.io',
          },
          security: { deps: true, sast: true, containerScan: true, secrets: true },
        };
        const files = generateFiles(cfg);
        generateSteps(cfg);
        if (!files[0].content.includes('build-test') && ci !== 'jenkins' && !files[0].content.includes('Build & test'))
          throw new Error('missing build job ' + JSON.stringify(cfg));
        if (files.some((f) => !f.content.trim())) throw new Error('empty file');
        if (ci === 'github-actions' && language === 'node' && registry === 'ghcr' && deploy === 'kubernetes') {
          for (const f of files) {
            const out = join('.out', f.path);
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, f.content);
          }
        }
        if (ci !== 'github-actions' && language === 'go' && registry === 'dockerhub' && deploy === 'aws-ecs') {
          writeFileSync(join('.out', files[0].path.replace(/\//g, '_')), files[0].content);
        }
        n++;
      }

const r = recommend({ host: 'github', hostOther: '', cloud: 'aws', cloudOther: '', team: 'small', kubernetes: false });
if (r.ci !== 'github-actions' || r.deploy !== 'aws-ecs' || r.registry !== 'ecr') throw new Error('recommend broken');
const envs = envList(['production', 'dev'], 'QA, uat env');
if (envs.join() !== 'dev,qa,uat-env,production') throw new Error('envList ' + envs.join());
console.log(`ok: ${n} configurations generated`);
