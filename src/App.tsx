import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import JSZip from 'jszip';
import { EMPTY_CUSTOM, envList, isProdLike } from './engine/types';
import type { Answers, CI, Cloud, Config, Custom, Deploy, Language, Registry, SourceHost } from './engine/types';
import { recommend } from './engine/recommend';
import { generateFiles, generateSteps } from './engine/generate';
import { buildPipeline } from './engine/pipeline';
import { stageTitle, usedStages } from './engine/render';

interface Opt<T> { value: T; label: string; hint?: string }

function Choice<T extends string>(props: { legend: string; name: string; value: T; options: Opt<T>[]; onChange: (v: T) => void; children?: ReactNode }) {
  return (
    <fieldset>
      <legend>{props.legend}</legend>
      <div className="choices">
        {props.options.map((o) => (
          <label className="opt" key={o.value}>
            <input type="radio" name={props.name} checked={props.value === o.value} onChange={() => props.onChange(o.value)} />
            <span>{o.label}</span>
            {o.hint && <small>{o.hint}</small>}
          </label>
        ))}
      </div>
      {props.children}
    </fieldset>
  );
}

function Other(props: { title: string; children: ReactNode }) {
  return (
    <div className="other">
      <p><b>{props.title}</b> Fill this in so the output matches your setup.</p>
      {props.children}
    </div>
  );
}

function TextField(props: { id: string; label: string; value: string; placeholder: string; onChange: (v: string) => void; multiline?: boolean; required?: boolean }) {
  const missing = props.required && !props.value.trim();
  const cls = missing ? 'missing' : undefined;
  return (
    <>
      <label className="field" htmlFor={props.id}>{props.label}{props.required ? ' *' : ''}</label>
      {props.multiline ? (
        <textarea id={props.id} className={cls} rows={3} value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />
      ) : (
        <input id={props.id} className={cls} type="text" value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />
      )}
    </>
  );
}

const DEFAULT: Config = {
  appName: 'my-app',
  language: 'node',
  ci: 'github-actions',
  registry: 'ghcr',
  deploy: 'ssh-vm',
  terraform: false,
  environments: [],
  custom: EMPTY_CUSTOM,
  security: { deps: true, sast: true, containerScan: true, secrets: true },
};

const PRESET_ENVS = ['dev', 'test', 'staging', 'production'];

export default function App() {
  const [cfg, setCfg] = useState<Config>(DEFAULT);
  const [envPresets, setEnvPresets] = useState<string[]>(['staging', 'production']);
  const [envCustom, setEnvCustom] = useState('');
  const [ans, setAns] = useState<Answers>({ host: 'github', hostOther: '', cloud: 'none', cloudOther: '', team: 'solo', kubernetes: false });
  const [reasons, setReasons] = useState<string[]>([]);
  const [tab, setTab] = useState<string>('guide');
  const [copied, setCopied] = useState(false);

  const environments = useMemo(() => envList(envPresets, envCustom), [envPresets, envCustom]);
  const eff = useMemo<Config>(() => ({ ...cfg, environments: cfg.deploy === 'none' ? [] : environments }), [cfg, environments]);
  const files = useMemo(() => generateFiles(eff), [eff]);
  const steps = useMemo(() => generateSteps(eff), [eff]);
  const pipeline = useMemo(() => buildPipeline(eff), [eff]);
  const active = files.find((f) => f.path === tab);

  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const setCustom = (k: keyof Custom) => (v: string) => setCfg((c) => ({ ...c, custom: { ...c.custom, [k]: v } }));
  const setSec = (k: keyof Config['security']) => set('security', { ...cfg.security, [k]: !cfg.security[k] });
  const toggleEnv = (e: string) => setEnvPresets((p) => (p.includes(e) ? p.filter((x) => x !== e) : [...p, e]));

  const missing: string[] = [];
  if (cfg.language === 'other') {
    if (!cfg.custom.languageName.trim()) missing.push('language name');
    if (!cfg.custom.languageImage.trim()) missing.push('build image');
    if (!cfg.custom.languageCommands.trim()) missing.push('build/test commands');
  }
  if (cfg.ci === 'other' && !cfg.custom.ciName.trim()) missing.push('CI tool name');
  if (cfg.registry === 'other' && !cfg.custom.registryHost.trim()) missing.push('registry address');
  if (cfg.deploy === 'other' && !cfg.custom.deployName.trim()) missing.push('deploy target');
  if (cfg.deploy !== 'none' && environments.length === 0) missing.push('at least one environment');
  if (ans.host === 'other' && !ans.hostOther.trim()) missing.push('where your code lives (step 1)');
  if (ans.cloud === 'other' && !ans.cloudOther.trim()) missing.push('which cloud/server (step 1)');

  const applyRecommendation = () => {
    const r = recommend(ans);
    setCfg((c) => ({ ...c, ci: r.ci, registry: r.registry, deploy: r.deploy, terraform: r.deploy !== 'ssh-vm' && r.deploy !== 'none' ? true : c.terraform }));
    setReasons(r.reasons);
  };

  const guideMarkdown = () =>
    `# ${cfg.appName} pipeline guide\n\n` +
    steps.map((s, i) => `${i + 1}. **${s.title}**\n   ${s.detail.replace(/\n/g, '\n   ')}`).join('\n\n') +
    (pipeline.secrets.length ? '\n\n## Secrets\n\n' + pipeline.secrets.map((s) => `- \`${s.name}\`: ${s.purpose}`).join('\n') : '') +
    '\n';

  const download = async () => {
    const zip = new JSZip();
    for (const f of files) zip.file(f.path, f.content);
    zip.file('PIPELINE-GUIDE.md', guideMarkdown());
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cfg.appName}-pipeline.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copy = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <>
      <header>
        <h1>Pipeline Builder</h1>
        <p>Pick your tools (or let it recommend), get an end-to-end CI/CD pipeline, config files and a step-by-step plan.</p>
      </header>
      <main>
        <div>
          <section className="card" aria-labelledby="h-help">
            <h2 id="h-help">Step 1 · Not sure? Get a recommendation</h2>
            <Choice<SourceHost> legend="Where does your code live?" name="host" value={ans.host} onChange={(host) => setAns({ ...ans, host })}
              options={[{ value: 'github', label: 'GitHub' }, { value: 'gitlab', label: 'GitLab' }, { value: 'azure-repos', label: 'Azure Repos' }, { value: 'other', label: 'Other…' }]}>
              {ans.host === 'other' && (
                <Other title="Other host.">
                  <TextField id="host-other" label="Which one?" required value={ans.hostOther} placeholder="e.g. Bitbucket, self-hosted Gitea" onChange={(hostOther) => setAns({ ...ans, hostOther })} />
                </Other>
              )}
            </Choice>
            <Choice<Cloud> legend="Where will it run?" name="cloud" value={ans.cloud} onChange={(cloud) => setAns({ ...ans, cloud })}
              options={[{ value: 'none', label: 'My own server' }, { value: 'aws', label: 'AWS' }, { value: 'azure', label: 'Azure' }, { value: 'gcp', label: 'Google Cloud' }, { value: 'other', label: 'Other…' }]}>
              {ans.cloud === 'other' && (
                <Other title="Other platform.">
                  <TextField id="cloud-other" label="Which one?" required value={ans.cloudOther} placeholder="e.g. DigitalOcean, Hetzner, on-prem VMware" onChange={(cloudOther) => setAns({ ...ans, cloudOther })} />
                </Other>
              )}
            </Choice>
            <Choice<Answers['team']> legend="Team size" name="team" value={ans.team} onChange={(team) => setAns({ ...ans, team })}
              options={[{ value: 'solo', label: 'Just me' }, { value: 'small', label: '2–15 people' }, { value: 'large', label: 'Large org' }]} />
            <div className="checks">
              <label><input type="checkbox" checked={ans.kubernetes} onChange={() => setAns({ ...ans, kubernetes: !ans.kubernetes })} /> I already run Kubernetes</label>
            </div>
            <p><button className="primary" onClick={applyRecommendation}>Recommend &amp; fill step 2</button></p>
            {reasons.length > 0 && <ul className="reasons">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          </section>

          <section className="card" aria-labelledby="h-cfg">
            <h2 id="h-cfg">Step 2 · Choose your stack</h2>
            <label className="field" htmlFor="app">App name</label>
            <input id="app" type="text" value={cfg.appName} onChange={(e) => set('appName', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'my-app')} />

            <Choice<Language> legend="Language" name="lang" value={cfg.language} onChange={(v) => set('language', v)}
              options={[{ value: 'node', label: 'Node.js' }, { value: 'python', label: 'Python' }, { value: 'java', label: 'Java', hint: 'Maven' }, { value: 'dotnet', label: '.NET' }, { value: 'go', label: 'Go' }, { value: 'other', label: 'Other…' }]}>
              {cfg.language === 'other' && (
                <Other title="Other language.">
                  <TextField id="l-name" label="Language / framework" required value={cfg.custom.languageName} placeholder="e.g. Rust, Ruby on Rails, PHP" onChange={setCustom('languageName')} />
                  <TextField id="l-img" label="Docker image to build & test in" required value={cfg.custom.languageImage} placeholder="e.g. rust:1.80, ruby:3.3, php:8.3-cli" onChange={setCustom('languageImage')} />
                  <TextField id="l-cmd" label="Build & test commands (one per line)" required multiline value={cfg.custom.languageCommands} placeholder={'cargo build --release\ncargo test'} onChange={setCustom('languageCommands')} />
                  <TextField id="l-port" label="App port" value={cfg.custom.port} placeholder="8080" onChange={setCustom('port')} />
                </Other>
              )}
            </Choice>

            <Choice<CI> legend="CI/CD tool" name="ci" value={cfg.ci} onChange={(v) => set('ci', v)}
              options={[
                { value: 'github-actions', label: 'GitHub Actions', hint: 'Easiest on GitHub' },
                { value: 'gitlab-ci', label: 'GitLab CI/CD', hint: 'Built into GitLab' },
                { value: 'jenkins', label: 'Jenkins', hint: 'Self-hosted' },
                { value: 'azure-devops', label: 'Azure Pipelines' },
                { value: 'other', label: 'Other…', hint: 'Generic scripts' },
              ]}>
              {cfg.ci === 'other' && (
                <Other title="Other CI tool.">
                  <TextField id="ci-name" label="Which tool?" required value={cfg.custom.ciName} placeholder="e.g. CircleCI, Bitbucket Pipelines, TeamCity" onChange={setCustom('ciName')} />
                  <p className="note">You'll get one shell script per job plus a PIPELINE.md outline to recreate in that tool.</p>
                </Other>
              )}
            </Choice>

            <Choice<Registry> legend="Container registry" name="reg" value={cfg.registry} onChange={(v) => set('registry', v)}
              options={[
                { value: 'ghcr', label: 'GitHub (ghcr)' }, { value: 'gitlab', label: 'GitLab' }, { value: 'dockerhub', label: 'Docker Hub' },
                { value: 'ecr', label: 'Amazon ECR' }, { value: 'acr', label: 'Azure ACR' }, { value: 'other', label: 'Other…' },
              ]}>
              {cfg.registry === 'other' && (
                <Other title="Other registry.">
                  <TextField id="reg-host" label="Registry address (and path)" required value={cfg.custom.registryHost} placeholder="e.g. registry.example.com/team, quay.io/myorg" onChange={setCustom('registryHost')} />
                </Other>
              )}
            </Choice>

            <Choice<Deploy> legend="Where to deploy" name="dep" value={cfg.deploy} onChange={(v) => set('deploy', v)}
              options={[
                { value: 'ssh-vm', label: 'Single VM', hint: 'Docker over SSH' },
                { value: 'kubernetes', label: 'Kubernetes' },
                { value: 'aws-ecs', label: 'AWS ECS' },
                { value: 'azure-app-service', label: 'Azure App Service' },
                { value: 'none', label: 'Build only', hint: 'No deploy' },
                { value: 'other', label: 'Other…' },
              ]}>
              {cfg.deploy === 'other' && (
                <Other title="Other deploy target.">
                  <TextField id="dep-name" label="What are you deploying to?" required value={cfg.custom.deployName} placeholder="e.g. Google Cloud Run, Fly.io, Nomad, Helm on GKE" onChange={setCustom('deployName')} />
                  <p className="note">The deploy job will contain a clearly marked TODO with your target's name.</p>
                </Other>
              )}
            </Choice>

            {cfg.deploy !== 'none' && (
              <fieldset>
                <legend>Environments (deployed in this order)</legend>
                <div className="chips">
                  {PRESET_ENVS.map((e) => (
                    <label className="chip" key={e}><input type="checkbox" checked={envPresets.includes(e)} onChange={() => toggleEnv(e)} />{e}</label>
                  ))}
                </div>
                <TextField id="env-custom" label="Custom environments (comma-separated)" value={envCustom} placeholder="e.g. qa, uat, perf" onChange={setEnvCustom} />
                <div className="envflow">
                  {environments.length ? environments.map((e) => (isProdLike(e) ? `${e} (manual approval)` : e)).join(' → ') : 'Pick at least one environment.'}
                </div>
              </fieldset>
            )}

            <fieldset>
              <legend>Security checks</legend>
              <div className="checks">
                <label><input type="checkbox" checked={cfg.security.deps} onChange={() => setSec('deps')} /> Dependency audit</label>
                <label><input type="checkbox" checked={cfg.security.sast} onChange={() => setSec('sast')} /> Code scan (SAST)</label>
                <label><input type="checkbox" checked={cfg.security.secrets} onChange={() => setSec('secrets')} /> Secret scan</label>
                <label><input type="checkbox" checked={cfg.security.containerScan} onChange={() => setSec('containerScan')} /> Image scan</label>
              </div>
            </fieldset>
            <fieldset>
              <legend>Infrastructure as code</legend>
              <div className="checks">
                <label><input type="checkbox" checked={cfg.terraform} onChange={() => set('terraform', !cfg.terraform)} /> Add a Terraform starter</label>
              </div>
            </fieldset>
          </section>
        </div>

        <section className="card" aria-label="Output">
          {missing.length > 0 && <div className="warn" role="status">Still needed for accurate output: {missing.join(', ')}. Fill the highlighted fields on the left.</div>}
          <div className="pipe" aria-label="Pipeline overview">
            {usedStages(pipeline).map((s) => (
              <div className="stage" key={s}>
                <b>{stageTitle(s)}</b>
                {pipeline.jobs.filter((j) => j.stage === s).map((j) => <div key={j.id}>{j.name}{j.manual ? ' (approval)' : ''}</div>)}
              </div>
            ))}
          </div>
          <div className="tabs" role="tablist">
            <button role="tab" className="tab" aria-selected={tab === 'guide'} onClick={() => setTab('guide')}>Steps &amp; secrets</button>
            {files.map((f) => (
              <button key={f.path} role="tab" className="tab" aria-selected={tab === f.path} onClick={() => setTab(f.path)}>{f.path}</button>
            ))}
          </div>

          {tab === 'guide' || !active ? (
            <>
              <ol className="steps">
                {steps.map((s) => (
                  <li key={s.title}><b>{s.title}</b><span>{s.detail}</span></li>
                ))}
              </ol>
              {pipeline.secrets.length > 0 && (
                <>
                  <h3>Secrets to create</h3>
                  <table>
                    <tbody>
                      {pipeline.secrets.map((s) => <tr key={s.name}><td>{s.name}</td><td>{s.purpose}</td></tr>)}
                    </tbody>
                  </table>
                </>
              )}
            </>
          ) : (
            <>
              <div className="toolbar">
                <span className="desc">{active.description}</span>
                <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <pre><code>{active.content}</code></pre>
            </>
          )}
          <p style={{ marginTop: 16 }}>
            <button className="primary" onClick={download}>Download all files (.zip)</button>{' '}
            <span className="note">Generated in your browser; nothing is uploaded.</span>
          </p>
        </section>
      </main>
    </>
  );
}
