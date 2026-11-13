# Pipeline Builder

**Answer a few questions, get a working CI/CD pipeline.** Pick your tools (or let the app recommend them) and it generates the pipeline file, Dockerfile, deploy config, a step-by-step setup guide and a checklist of secrets to create. It runs entirely in your browser: nothing is uploaded.

## Quick start

```bash
git clone https://github.com/himanshugupta2312/DevOpsGit.git
cd DevOpsGit
npm install
npm run dev
```

Open <http://localhost:5173>.

## How to use it

| Step | What you do | What you get |
|------|-------------|--------------|
| **1. Get a recommendation** (optional) | Say where your code lives, where it will run, your team size, and whether you use Kubernetes. | A suggested CI tool, registry and deploy target, with the reasons. |
| **2. Choose your stack** | Click the cards: language, CI tool, registry, deploy target. Tick environments and security checks. | The pipeline updates live on the right. |
| **3. Review and download** | Browse each generated file, read the steps, copy or download everything as a `.zip`. | Files ready to drop in your repo. |

### Environments

Tick any of **dev**, **test**, **staging**, **production**, and/or type your own comma-separated list (for example `qa, uat, perf`). They deploy in the order shown. Production-like names (`production`, `prod`, `live`) always go last and require **manual approval**.

### Choosing "Other…"

Every option has an **Other…** card. Picking it opens a small form asking for what the app needs to help you properly, and a banner lists anything still missing:

| Option | What it asks for | What you get |
|--------|------------------|--------------|
| Language | Name, Docker image, build and test commands, port | A pipeline and Dockerfile built from your commands |
| CI tool | Tool name | One shell script per job plus a `PIPELINE.md` outline to recreate in that tool |
| Registry | Registry address | Login and push steps for that address |
| Deploy target | What you deploy to | A deploy job with a clearly marked TODO for your target |
| Code host / cloud | Which one | Used to tailor the recommendation |

## What it generates

```
Pull request ──▶ Verify: build, test, dependency audit, code scan, secret scan
Merge to main ─▶ Package: build image, scan it, push it
                 ──▶ Deploy dev ──▶ test ──▶ staging ──▶ production (manual approval)
```

| Choice | Options |
|--------|---------|
| Languages | Node.js, Python, Java (Maven), .NET, Go, or other |
| CI tools | GitHub Actions, GitLab CI/CD, Jenkins, Azure Pipelines, or other |
| Registries | GitHub (ghcr), GitLab, Docker Hub, Amazon ECR, Azure ACR, or other |
| Deploy targets | Kubernetes, AWS ECS, Azure App Service, single VM over SSH, build only, or other |
| Extras | Terraform starter, Dockerfile, Kubernetes manifests |

Generated files always include the pipeline definition, `Dockerfile`, `.dockerignore`, and, depending on your choices, `k8s/`, `terraform/`, `scripts/` and `PIPELINE-GUIDE.md`.

## Good to know

- **Review before using.** The Dockerfiles contain `TODO` comments (start command, build output folder). The Terraform is a starter, not a full environment, and the pipeline only validates it; it never applies it.
- **Secrets.** The guide lists every secret by exact name, and the pipelines read them from your CI's secret store. Nothing sensitive is generated.
- **Jenkins** needs a Multibranch Pipeline job and Docker on the agent.
- The generated pipelines are checked for valid YAML and consistent structure, but you should run them in a test repo first.

## Commands

| Command | Does |
|---------|------|
| `npm run dev` | Start the app locally |
| `npm run build` | Build a static site into `dist/` that you can host anywhere |
| `npm test` | Generate 1,000+ combinations of choices and check they all work |

## Project layout

```
src/engine/pipeline.ts   tool-neutral pipeline model (jobs, stages, secrets)
src/engine/render.ts     renders it for GitHub Actions, GitLab, Jenkins, Azure
src/engine/generate.ts   Dockerfile, Kubernetes, Terraform, generic scripts, guide
src/engine/recommend.ts  the "which tool should I use?" logic
src/App.tsx              the UI
```

To add a CI tool, language or deploy target, extend the pipeline model once and the renderers pick it up.
