// Local web UI for aigw-doctor.sh: lists the sandboxes set up in .env,
// starts runs from a form, and streams each run's output to the browser over
// Server-Sent Events. Each sandbox keeps its own current (or last) run.
//
// It listens on 127.0.0.1 only, because the doctor runs with this machine's AWS
// credentials. Only dry-run and check modes are offered: --fix asks for confirmation
// on the terminal, which a browser cannot answer.
//
// Secrets from .env (CP_PASSWORD, AIGW_API_KEY and their per-sandbox forms) never go to
// the browser; they reach the doctor only through its environment.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'aigw-doctor.sh');
const PUBLIC_DIR = path.join(HERE, 'public');
const ENV_FILE = path.resolve(process.env.ENV_FILE || path.join(HERE, '.env'));
const HOST = '127.0.0.1';
const FIRST_PORT = Number(process.env.PORT || 4545);
const PORT_TRIES = 20; // if the port is taken, try the next ones
let PORT = FIRST_PORT; // the port actually listened on
const MAX_BODY = 64 * 1024;
const MAX_CONFIG_BODY = 2 * 1024 * 1024; // adding a sandbox may upload its config.json
const DEFAULT_CONFIG_DIR = '~/.aigw-doctor/configs';
const CUSTOM = '_custom'; // runs started without picking a sandbox
// Every run's events are kept as JSON lines, one file per run, so finished runs can be
// reopened after a restart. The files hold what the page shows, which has no secrets.
const HISTORY_DIR = path.resolve(expandHome(process.env.UI_HISTORY_DIR || '~/.aigw-doctor/ui-history'));
const HISTORY_KEEP = 50; // runs kept per sandbox

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

// Form fields that map to doctor options. Each value must match its pattern.
const OPTIONS = {
  region: ['--region', /^[a-z]{2}(-[a-z]+)+-\d$/],
  tenantId: ['--tenant-id', /^[0-9a-fA-F-]{8,64}$/],
  cbInstance: ['--cb-instance', /^i-[0-9a-f]{8,17}$/],
  aigwInstance: ['--aigw-instance', /^i-[0-9a-f]{8,17}$/],
  aigwUrl: ['--aigw-url', /^https?:\/\/[\w.-]+(:\d+)?\/?$/],
  cpUser: ['--cp-user', /^[\w.+-]+@[\w.-]+$/],
  cpUrl: ['--cp-url', /^https:\/\/[\w.-]+(:\d+)?(\/v\d+\/organizations\/[0-9a-fA-F-]+)?\/?$/],
  orgId: ['--org-id', /^[0-9a-fA-F-]{8,64}$/],
  models: ['--models', /^[\w.:/@,-]+$/],
  threshold: ['--threshold', /^\d{1,2}$/],
};
const FLAGS = {
  inferenceOnly: '--inference-only',
  createApiKey: '--create-api-key',
  skipInference: '--skip-inference',
};

// .env keys and the form field each fills. "<SANDBOX>_<KEY>" sets one sandbox
// (my-sandbox -> MY_SANDBOX_REGION); the bare key is the default for every sandbox.
const ENV_FIELDS = {
  CONFIG: 'config',
  REGION: 'region',
  TENANT_ID: 'tenantId',
  ORG_ID: 'orgId',
  CP_URL: 'cpUrl',
  CP_USER: 'cpUser',
  AIGW_URL: 'aigwUrl',
  AIGW_INSTANCE: 'aigwInstance',
  CB_INSTANCE: 'cbInstance',
  MODELS: 'models',
  THRESHOLD: 'threshold',
  API_KEY_FILE: 'apiKeyFile',
  API_KEY_SOURCE: 'keySource',
  SCOPE: 'scope',
  MODE: 'mode',
  FM_URL: 'fmUrl', // Fleet Manager, where the gateway config can be downloaded
};
const SECRETS = ['CP_PASSWORD', 'AIGW_API_KEY'];

const runs = new Map(); // sandbox -> current or last run
const watchers = new Map(); // sandbox -> streams following the sandbox's latest run
const history = new Map(); // sandbox -> run summaries, newest first

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

// ---------- history ----------

function historyDir(sandbox) {
  return path.join(HISTORY_DIR, sandbox.replace(/[^\w.-]/g, '_'));
}

// summarize: a run's summary from its events (counts exclude the repeated summary block).
function summarize(id, events) {
  const sum = { id, startedAt: null, endedAt: null, exit: null, counts: { pass: 0, warn: 0, fail: 0 }, logPath: '', gateway: '' };
  let inSummary = false;
  for (const e of events) {
    if (e.type === 'start') sum.startedAt = e.startedAt;
    else if (e.type === 'exit') Object.assign(sum, { endedAt: e.endedAt, exit: { code: e.code, signal: e.signal } });
    else if (e.type === 'line') {
      if (/^== Summary ==/.test(e.text)) inSummary = true;
      const m = !inSummary && e.text.match(/^ {3}(PASS|WARN|FAIL) /);
      if (m) sum.counts[m[1].toLowerCase()] += 1;
      const log = e.text.match(/^\s*Full log: (.+)$/);
      if (log) sum.logPath = log[1].trim();
      const gw = e.text.match(/^ {3}PASS gateway: AI Gateway (.+)$/);
      if (gw) sum.gateway = gw[1].trim();
    }
  }
  return sum;
}

function readEvents(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

// loadHistory: rebuild every sandbox's run list from disk at startup. A run that was
// still going when the server stopped is shown as ended without an exit.
function loadHistory() {
  if (!fs.existsSync(HISTORY_DIR)) return;
  for (const dir of fs.readdirSync(HISTORY_DIR)) {
    const full = path.join(HISTORY_DIR, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    let sandbox = null;
    const list = [];
    for (const f of files) {
      const events = readEvents(path.join(full, f));
      const start = events.find((e) => e.type === 'start');
      if (!start) continue;
      sandbox = start.sandbox;
      list.push(summarize(f.slice(0, -'.jsonl'.length), events));
    }
    if (sandbox) history.set(sandbox, list);
  }
}

// prune keeps the newest HISTORY_KEEP runs of a sandbox.
function prune(sandbox) {
  const list = history.get(sandbox) || [];
  for (const old of list.splice(HISTORY_KEEP)) fs.rmSync(path.join(historyDir(sandbox), `${old.id}.jsonl`), { force: true });
}

// ---------- .env ----------

// readEnv parses KEY=VALUE lines (optional "export ", quotes and # comments). It is read
// on every request, so edits apply without a restart.
function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const env = {};
  for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.match(/^(["'])(.*?)\1(\s+#.*)?$/);
    if (quoted) value = quoted[2]; // a quoted value may be followed by a comment
    else value = value.replace(/\s+#.*$/, '');
    env[m[1]] = value;
  }
  return env;
}

function envPrefix(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function envValue(env, sandbox, key) {
  if (sandbox && sandbox !== CUSTOM) {
    const v = env[`${envPrefix(sandbox)}_${key}`];
    if (v !== undefined && v !== '') return v;
  }
  return env[key] ?? '';
}

// sandboxList: every *.config.json in AIGW_CONFIG_DIR plus the names in SANDBOXES, each
// with its form defaults and which secrets .env holds for it (never the secrets).
function sandboxList(env) {
  const names = new Map();
  const dir = env.AIGW_CONFIG_DIR && expandHome(env.AIGW_CONFIG_DIR);
  if (dir && fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.endsWith('.config.json')) names.set(f.slice(0, -'.config.json'.length), path.join(dir, f));
    }
  }
  for (const n of (env.SANDBOXES || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!names.has(n)) names.set(n, '');
  }
  return [...names].map(([name, discovered]) => {
    const values = {};
    for (const [key, field] of Object.entries(ENV_FIELDS)) {
      const v = envValue(env, name, key);
      if (v) values[field] = v;
    }
    values.config ||= discovered;
    const secrets = Object.fromEntries(SECRETS.map((s) => [s, Boolean(envValue(env, name, s))]));
    return { name, label: envValue(env, name, 'LABEL') || name, values, secrets };
  });
}

// ---------- adding a sandbox ----------

const SANDBOX_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/i;
// Form fields a new sandbox may set, with the .env key each is written to.
const ADD_FIELDS = {
  label: ['LABEL', /^[\w .()-]{1,60}$/],
  region: ['REGION', OPTIONS.region[1]],
  tenantId: ['TENANT_ID', OPTIONS.tenantId[1]],
  orgId: ['ORG_ID', OPTIONS.orgId[1]],
  cpUrl: ['CP_URL', OPTIONS.cpUrl[1]],
  cpUser: ['CP_USER', OPTIONS.cpUser[1]],
  aigwUrl: ['AIGW_URL', OPTIONS.aigwUrl[1]],
  models: ['MODELS', OPTIONS.models[1]],
};

// addSandbox: save an uploaded config into the config directory (or point at an existing
// one) and append the sandbox's settings to .env as a commented block. Values are checked
// against their patterns, so nothing else can be written into .env.
function addSandbox(body) {
  const name = String(body.name || '').trim();
  if (!SANDBOX_NAME.test(name)) throw new Error('name: letters, digits and dashes, e.g. dev-1');
  const env = readEnv();
  if (sandboxList(env).some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    throw Object.assign(new Error(`sandbox ${name} already exists`), { status: 409 });
  }
  const prefix = envPrefix(name);
  const lines = [];
  for (const [field, [key, pattern]] of Object.entries(ADD_FIELDS)) {
    const value = String(body[field] ?? '').trim();
    if (!value) continue;
    if (!pattern.test(value)) throw new Error(`invalid ${field}: ${value}`);
    lines.push(`${prefix}_${key}=${/\s/.test(value) ? `"${value}"` : value}`);
  }

  let configFile;
  let listed = false; // whether the name must be added to SANDBOXES
  if (typeof body.configJson === 'string' && body.configJson.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(body.configJson);
    } catch {
      throw new Error('the uploaded config is not valid JSON');
    }
    if (!parsed || (!parsed.modelConfig && !parsed.modelServiceStoreConfig)) {
      throw new Error('the uploaded file does not look like a gateway config (no modelConfig)');
    }
    if (!env.AIGW_CONFIG_DIR) lines.unshift(`AIGW_CONFIG_DIR=${DEFAULT_CONFIG_DIR}`);
    const dir = expandHome(env.AIGW_CONFIG_DIR || DEFAULT_CONFIG_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    configFile = path.join(dir, `${name}.config.json`);
    if (fs.existsSync(configFile)) throw Object.assign(new Error(`${configFile} already exists`), { status: 409 });
    fs.writeFileSync(configFile, body.configJson, { mode: 0o600, flag: 'wx' });
  } else if (body.configPath) {
    configFile = existingFile(body.configPath, 'config');
    if (!configFile.endsWith('.json')) throw new Error('config must be a .json file');
    lines.unshift(`${prefix}_CONFIG=${configFile}`);
    listed = true;
  } else {
    throw new Error('upload a config.json or give its path');
  }

  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  if (listed) {
    if (/^SANDBOXES=.*$/m.test(text)) {
      text = text.replace(/^SANDBOXES=(.*)$/m, (_, v) => `SANDBOXES=${[v.trim(), name].filter(Boolean).join(',')}`);
    } else {
      lines.unshift(`SANDBOXES=${name}`);
    }
  }
  const block = [`# ${name}: added from the UI on ${new Date().toISOString().slice(0, 10)}`, ...lines].join('\n');
  text = `${text.replace(/\n*$/, '')}${text ? '\n\n' : ''}${block}\n`;
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
  return { name, config: configFile };
}

// ---------- saving form settings to .env ----------

// What each saved field may hold (the run options' patterns, plus the choice fields).
const SAVE_RULES = {
  ...Object.fromEntries(Object.entries(OPTIONS).map(([field, [, pattern]]) => [field, pattern])),
  config: /^[^\s"'#]+$/,
  apiKeyFile: /^[^\s"'#]+$/,
  keySource: /^(create|file|paste)$/,
  scope: /^(all|inference|infra)$/,
  mode: /^(check|dry-run)$/,
};
const FIELD_KEYS = Object.fromEntries(Object.entries(ENV_FIELDS).map(([key, field]) => [field, key]));

// saveSettings: write a sandbox's changed form fields to .env as <NAME>_<KEY> lines. A line
// already there is replaced in place; new ones join the sandbox's other lines (or a new
// block); an empty value removes the line so the default applies. The old file is kept
// as .env.bak.
function saveSettings(body) {
  const sandbox = String(body.sandbox || '');
  if (!SANDBOX_NAME.test(sandbox)) throw new Error('pick a sandbox to save its settings');
  const prefix = envPrefix(sandbox);
  const updates = new Map(); // .env key -> value ('' removes)
  for (const [field, raw] of Object.entries(body.values || {})) {
    const key = FIELD_KEYS[field];
    if (!key) continue;
    const value = String(raw ?? '').trim();
    if (value && !SAVE_RULES[field]?.test(value)) throw new Error(`invalid ${field}: ${value}`);
    if (field === 'config' && value) existingFile(value, 'config');
    updates.set(`${prefix}_${key}`, value);
  }
  // Secrets only when typed; .env is git-ignored and mode 600.
  for (const [field, key] of [['cpPassword', 'CP_PASSWORD'], ['apiKey', 'AIGW_API_KEY']]) {
    const value = typeof body[field] === 'string' ? body[field] : '';
    if (!value) continue;
    if (/[\r\n]/.test(value)) throw new Error(`${field} cannot contain line breaks`);
    updates.set(`${prefix}_${key}`, value);
  }
  if (!updates.size) return { saved: [] };

  // Plain when safe, else quoted with the quote kind the value doesn't contain (the .env
  // reader takes quoted values literally), so a password is saved exactly as typed.
  const quote = (v) => {
    if (/^[^\s"'#\\]*$/.test(v)) return v;
    if (!v.includes("'")) return `'${v}'`;
    if (!v.includes('"')) return `"${v}"`;
    throw new Error('a value with both \' and " cannot be saved; edit .env by hand');
  };
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').replace(/\n+$/, '').split('\n') : [];
  if (fs.existsSync(ENV_FILE)) fs.copyFileSync(ENV_FILE, `${ENV_FILE}.bak`);
  const keyOf = (line) => (line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/) || [])[1];
  const pending = new Map(updates);
  const out = [];
  for (const line of lines) {
    const key = keyOf(line);
    if (key && pending.has(key)) {
      const value = pending.get(key);
      pending.delete(key);
      if (value !== '') out.push(`${key}=${quote(value)}`);
      continue; // an empty value drops the line
    }
    out.push(line);
  }
  const added = [...pending].filter(([, v]) => v !== '').map(([k, v]) => `${k}=${quote(v)}`);
  if (added.length) {
    let at = -1;
    out.forEach((line, i) => { if ((keyOf(line) || '').startsWith(`${prefix}_`)) at = i; });
    if (at >= 0) out.splice(at + 1, 0, ...added);
    else out.push('', `# ${sandbox}: saved from the UI on ${new Date().toISOString().slice(0, 10)}`, ...added);
  }
  fs.writeFileSync(ENV_FILE, `${out.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
  return { saved: [...updates.keys()].map((k) => (k.endsWith('PASSWORD') || k.endsWith('API_KEY') ? `${k} (secret)` : k)) };
}

// ---------- config overview ----------

// endpointLabel: scheme and host of a model URL only, so no path, query or user info leaks.
function endpointLabel(u) {
  if (!u) return '';
  try {
    const url = new URL(u.includes('://') ? u : `https://${u}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

const flag = (v) => v === true || v?.isEnabled === true;

// configSummary: what the page shows about a gateway config. Fields are picked one by
// one; certificates, model keys and other values are never sent. Secrets Manager entries
// appear by name only.
function configSummary(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const store = c.modelServiceStoreConfig || {};
  const defaults = store.defaults || {};
  const models = c.modelConfig?.models || [];
  const nameById = Object.fromEntries(models.map((m) => [m.id, m.modelName]));
  return {
    file,
    modifiedAt: fs.statSync(file).mtimeMs,
    serviceName: c.serviceName || '',
    rateLimit: c.rateLimit ?? null,
    store: {
      host: (store.couchbaseConnectString || '').replace(/^[a-z]+:\/\//, '').split(/[,/?]/)[0],
      cacheKeyspace: defaults.cacheKeyspace || '',
      batchKeyspace: defaults.batchKeyspace || '',
      dbCredKey: defaults.dbCredKey || '',
      adminKey: c.adminConfig?.adminKey || '',
    },
    models: models.map((m) => {
      const cc = m.cacheConfig || {};
      const sem = cc.semanticCache || {};
      const st = cc.cacheStore || {};
      return {
        id: m.id || '',
        modelName: m.modelName || '',
        name: m.name || '',
        kind: m.kind || '',
        serverKind: m.serverKind || '',
        status: m.status || '',
        endpoint: endpointLabel(m.url),
        region: m.bedrockConfig?.region || '',
        embeddingDimensions: m.embeddingDimensions ?? null,
        qps: m.qps ?? null,
        queueLength: m.queueLength ?? null,
        requestTimeout: m.requestTimeout ?? null,
        cache: {
          enabled: cc.isEnabled === true,
          defaultType: cc.defaultCacheType || '',
          expiry: cc.expiryDuration ?? null,
          standard: flag(cc.standardCache),
          semantic: flag(sem),
          conversational: flag(cc.conversationalCache),
          embeddingModel: sem.embeddingModel ? nameById[sem.embeddingModel] || sem.embeddingModel : '',
          threshold: sem.scoreThreshold ?? null,
          dimensions: sem.vectorDimensions ?? null,
          similarity: sem.vectorSimilarity || '',
          searchType: sem.vectorSearchType || '',
          store: [st.couchbaseBucket, st.couchbaseScope, st.couchbaseCollection].filter(Boolean).join('.'),
          index: st.couchbaseIndex || '',
        },
        guardrail: flag(m.guardrailConfig),
        jailbreak: flag(m.jailbreakConfig),
        hallucination: flag(m.hallucinate),
        batch: flag(m.batchConfig),
      };
    }),
  };
}

// ---------- helpers for the console, playground and raw config ----------

// aws: run the AWS CLI with this machine's credentials (no shell); resolves to stdout.
function aws(args) {
  return new Promise((resolve, reject) => {
    execFile('aws', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`aws ${args.slice(0, 2).join(' ')}: ${(stderr || err.message).trim().split('\n').pop()}`));
      else resolve(stdout.trim());
    });
  });
}

// request: an HTTPS (or HTTP) call that, like the doctor's curl -k, accepts the sandbox's
// self-signed certificates. Resolves to { status, headers, text, ms }.
function request(method, url, { headers = {}, body, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method, headers, timeout, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders,
        text: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started,
      }));
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeout / 1000}s`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const basic = (userPass) => `Basic ${Buffer.from(userPass).toString('base64')}`;

// sandboxContext: the sandbox's .env values, overridden by what the form sends, and its config.
function sandboxContext(body) {
  const env = readEnv();
  const sandbox = body.sandbox || '';
  const values = sandboxList(env).find((s) => s.name === sandbox)?.values || {};
  const pick = (k) => String(body[k] || values[k] || '').trim();
  const configFile = existingFile(pick('config'), 'config');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const region = pick('region');
  if (region && !OPTIONS.region[1].test(region)) throw new Error(`invalid region: ${region}`);
  const dbCredKey = config.modelServiceStoreConfig?.defaults?.dbCredKey || '';
  const deployId = (dbCredKey.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/) || [])[1] || '';
  return { env, sandbox: sandbox || CUSTOM, values, pick, config, configFile, region: region || 'us-east-2', dbCredKey, deployId };
}

// lastRunMatch: the first match of RE in the sandbox's latest runs (live, then saved).
function lastRunMatch(sandbox, re) {
  const scan = (events) => {
    for (const e of events) {
      const m = e.type === 'line' && e.text.match(re);
      if (m) return m;
    }
    return null;
  };
  const live = runs.get(sandbox);
  let m = live && scan(live.events);
  for (const h of (history.get(sandbox) || []).slice(0, 10)) {
    if (m) break;
    const file = path.join(historyDir(sandbox), `${h.id}.jsonl`);
    if (fs.existsSync(file)) m = scan(readEvents(file));
  }
  return m;
}

// ---------- Couchbase admin console of the cache cluster ----------

// consoleInfo: the cache node's admin UI URL, from the last run or an AWS lookup of the
// capella-ds-<deployment id> ASG, and the admin user name (from Secrets Manager).
async function consoleInfo(ctx) {
  let host = lastRunMatch(ctx.sandbox, /from this machine: host (\S+), admin (\S+)/)?.[1];
  let source = 'last run';
  if (!host || host.startsWith('<')) {
    if (!ctx.deployId) throw new Error('the config has no dbCredKey with a deployment id');
    const asg = `${ctx.env.DS_ASG_PREFIX || 'capella-ds-'}${ctx.deployId}`;
    const ids = await aws(['autoscaling', 'describe-auto-scaling-groups', '--region', ctx.region,
      '--auto-scaling-group-names', asg, '--query', 'AutoScalingGroups[0].Instances[].InstanceId', '--output', 'text']);
    const id = ids.split(/\s+/).find((x) => x.startsWith('i-'));
    if (!id) throw new Error(`no instance in ASG ${asg} (${ctx.region})`);
    host = await aws(['ec2', 'describe-instances', '--region', ctx.region, '--instance-ids', id,
      '--query', 'Reservations[0].Instances[0].PublicDnsName', '--output', 'text']);
    if (!host || host === 'None') throw new Error(`instance ${id} has no public DNS name`);
    source = `ASG ${asg}`;
  }
  return { url: `https://${host}:18091/ui/index.html`, host, source };
}

async function consoleCredentials(ctx) {
  if (!ctx.dbCredKey) throw new Error('the config has no dbCredKey');
  const secret = await aws(['secretsmanager', 'get-secret-value', '--region', ctx.region,
    '--secret-id', ctx.dbCredKey, '--query', 'SecretString', '--output', 'text']);
  const i = secret.indexOf(':');
  if (i < 1) throw new Error(`secret ${ctx.dbCredKey} is not "user:password"`);
  return { username: secret.slice(0, i), password: secret.slice(i + 1) };
}

// ---------- playground ----------

// Temporary API keys created for the playground, reused for up to an hour per sandbox
// and gateway, and deleted when the server stops.
const playKeys = new Map();

function gatewayUrl(ctx, body) {
  const typed = String(body.aigwUrl || ctx.values.aigwUrl || '').trim();
  if (typed) {
    if (!OPTIONS.aigwUrl[1].test(typed)) throw new Error(`invalid gateway URL: ${typed}`);
    return typed.replace(/\/$/, '');
  }
  const found = lastRunMatch(ctx.sandbox, /control plane: gateway endpoint (https?:\/\/\S+)/)?.[1];
  if (found) return found.replace(/\/$/, '');
  throw new Error('no gateway URL: set it under "Instances, URLs and threshold", or run a check with a Capella login first');
}

async function playgroundKey(ctx, body, gw) {
  if (body.keySource === 'paste') {
    const k = (typeof body.apiKey === 'string' && body.apiKey.trim()) || envValue(ctx.env, ctx.sandbox, 'AIGW_API_KEY');
    if (!k) throw new Error('paste an API key, or set AIGW_API_KEY in .env');
    return { key: k, source: body.apiKey ? 'pasted key' : '.env key' };
  }
  if (body.keySource === 'file') {
    const file = existingFile(body.apiKeyFile || ctx.values.apiKeyFile || '', 'API key file');
    return { key: fs.readFileSync(file, 'utf8').trim(), source: 'key file' };
  }
  const id = `${ctx.sandbox}|${gw}`;
  const cached = playKeys.get(id);
  if (cached && cached.expiresAt > Date.now() + 120000) return { key: cached.key, source: `temporary key ${cached.keyId}` };
  const adminKey = ctx.config.adminConfig?.adminKey;
  if (!adminKey) throw new Error('the config has no adminConfig.adminKey to create a temporary key');
  const admin = await aws(['secretsmanager', 'get-secret-value', '--region', ctx.region,
    '--secret-id', adminKey, '--query', 'SecretString', '--output', 'text']);
  const payload = JSON.stringify({
    name: `aigw-doctor-playground-${Date.now()}`, description: 'temporary key for the aigw-doctor playground',
    createdByUserID: 'aigw-doctor', expiryDuration: 3600,
    accessPolicy: { allowedModels: ['*'], allowedIPs: ['0.0.0.0/0'] },
  });
  const res = await request('POST', `${gw}/v1/apikeys`, {
    headers: { Authorization: basic(admin), 'Content-Type': 'application/json' }, body: payload, timeout: 60000,
  });
  let data = {};
  try {
    data = JSON.parse(res.text);
  } catch { /* reported below */ }
  if (res.status >= 300 || !data.apiKey) throw new Error(`creating a temporary API key: HTTP ${res.status}`);
  playKeys.set(id, { key: data.apiKey, keyId: data.keyId, gw, admin, expiresAt: Date.now() + 3600 * 1000 });
  return { key: data.apiKey, source: `temporary key ${data.keyId}` };
}

async function deletePlayKeys() {
  await Promise.allSettled([...playKeys.values()].map((k) =>
    request('DELETE', `${k.gw}/v1/apikeys/${encodeURIComponent(k.keyId)}`, { headers: { Authorization: basic(k.admin) }, timeout: 15000 })));
  playKeys.clear();
}

// playground: one request to a model in the config, through the gateway.
async function playground(body) {
  const ctx = sandboxContext(body);
  const model = (ctx.config.modelConfig?.models || []).find((m) => m.modelName === body.model);
  if (!model) throw new Error(`model ${body.model} is not in the config`);
  const cacheType = ['none', 'standard', 'semantic'].includes(body.cacheType) ? body.cacheType : 'none';
  const prompt = String(body.prompt || '');
  if (!prompt.trim()) throw new Error('type a prompt');
  const embedding = /embedding/.test(model.kind || '');
  const gw = gatewayUrl(ctx, body);
  const { key, source } = await playgroundKey(ctx, body, gw);

  let path_ = '/v1/embeddings';
  let payload = { model: model.modelName, input: prompt };
  if (!embedding) {
    path_ = '/v1/chat/completions';
    const maxTokens = Math.min(Math.max(parseInt(body.maxTokens, 10) || 256, 1), 8192);
    const temperature = Math.min(Math.max(Number(body.temperature) || 0, 0), 2);
    const messages = [];
    if (String(body.system || '').trim()) messages.push({ role: 'system', content: String(body.system) });
    messages.push({ role: 'user', content: prompt });
    payload = { model: model.modelName, messages, max_tokens: maxTokens, temperature };
  }
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-cb-cache': cacheType };
  if (body.debug === true) headers['X-cb-debug'] = 'true'; // the gateway then adds its X-cb-* debug headers
  const res = await request('POST', `${gw}${path_}`, { headers, body: JSON.stringify(payload) });
  // Headers as sent and received (original casing); the API key is not echoed back.
  const requestHeaders = Object.entries({ ...headers, Authorization: 'Bearer <redacted>' });
  const responseHeaders = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch { /* not JSON */ }
  const content = embedding
    ? json?.data?.[0]?.embedding ? `${json.data[0].embedding.length}-dimension vector: [${json.data[0].embedding.slice(0, 6).map((x) => x.toFixed(4)).join(', ')}, …]` : ''
    : json?.choices?.[0]?.message?.content ?? '';
  return {
    endpoint: `${gw}${path_}`, keySource: source, status: res.status, ms: res.ms,
    xcache: res.headers['x-cache'] || '', cacheType, model: model.modelName, kind: model.kind,
    request: payload, requestHeaders, responseHeaders, content, usage: json?.usage || null,
    error: res.status >= 300 ? json?.error?.message || json?.message || res.text.slice(0, 500) : '',
    raw: res.text.length > 20000 ? `${res.text.slice(0, 20000)}…` : res.text,
  };
}

// ---------- terminals on the gateway and cache nodes ----------

// A terminal runs exactly one of two commands in a pseudo-terminal (pty-bridge.py):
//   SSM: aws ssm start-session --target <instance>   (no SSH keys; needs the Session Manager plugin)
//   SSH: ssh [-i <key>] <user@host>                   (target and key from .env, or ec2-user@<public DNS>)
// The instance comes from the form or from the node's ASG. Output is kept (last 256 KB) so a
// reloaded page can catch up; every terminal is closed when the server stops.
const BRIDGE = path.join(HERE, 'pty-bridge.py');
const MAX_TERMINALS = 6;
const terminals = new Map(); // id -> { proc, title, buffer, viewers, done, exitCode }
const NODE_ROLES = {
  aigw: { label: 'AI Gateway', prefix: (env) => env.AIGW_ASG_PREFIX || 'capella-ai-gateway-', field: 'aigwInstance', sshKey: 'AIGW_SSH' },
  cb: { label: 'Couchbase node', prefix: (env) => env.DS_ASG_PREFIX || 'capella-ds-', field: 'cbInstance', sshKey: 'CB_SSH' },
};

async function nodeInstance(ctx, role, body) {
  const typed = String(body[role.field] || ctx.values[role.field] || '').trim();
  if (typed) {
    if (!OPTIONS[role.field][1].test(typed)) throw new Error(`invalid ${role.field}: ${typed}`);
    return typed;
  }
  if (!ctx.deployId) throw new Error('the config has no dbCredKey with a deployment id to find the node');
  const asg = `${role.prefix(ctx.env)}${ctx.deployId}`;
  const ids = await aws(['autoscaling', 'describe-auto-scaling-groups', '--region', ctx.region,
    '--auto-scaling-group-names', asg, '--query', 'AutoScalingGroups[0].Instances[].InstanceId', '--output', 'text']);
  const id = ids.split(/\s+/).find((x) => /^i-[0-9a-f]{8,17}$/.test(x));
  if (!id) throw new Error(`no instance in ASG ${asg} (${ctx.region})`);
  return id;
}

// terminalUser: the user both terminals switch to (TERMINAL_USER, default ec2-user), or ''
// when TERMINAL_USER=none keeps the login shell.
function terminalUser(ctx) {
  const u = envValue(ctx.env, ctx.sandbox, 'TERMINAL_USER') || 'ec2-user';
  if (/^none$/i.test(u)) return '';
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(u)) throw new Error(`invalid TERMINAL_USER: ${u}`);
  return u;
}

// terminalCommand: SSH when .env names an SSH target for the node (<NAME>_AIGW_SSH or
// <NAME>_CB_SSH), else SSM. Either way the shell becomes a login shell of TERMINAL_USER
// (ec2-user): SSM sessions start as ssm-user, so they run "sudo su - <user>" through
// AWS-StartInteractiveCommand; SSH does the same when it logs in as another user.
async function terminalCommand(ctx, roleName, body) {
  const role = NODE_ROLES[roleName];
  if (!role) throw new Error('node must be aigw or cb');
  const user = terminalUser(ctx);
  const target = envValue(ctx.env, ctx.sandbox, role.sshKey);
  if (target) {
    if (!/^[\w.-]+@[\w.-]+$/.test(target)) throw new Error(`invalid ${role.sshKey}: ${target}`);
    const key = envValue(ctx.env, ctx.sandbox, 'SSH_KEY');
    const args = ['ssh', '-t', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30'];
    if (key) args.push('-i', existingFile(key, 'SSH key'));
    args.push(target);
    const login = target.split('@')[0];
    if (user && user !== login) args.push(`sudo su - ${user}`);
    return { args, title: `${role.label} · ssh ${target}${user && user !== login ? ` → ${user}` : ''}` };
  }
  const id = await nodeInstance(ctx, role, body);
  const args = ['aws', 'ssm', 'start-session', '--region', ctx.region, '--target', id];
  if (user) {
    args.push('--document-name', 'AWS-StartInteractiveCommand',
      '--parameters', JSON.stringify({ command: [`sudo su - ${user}`] }));
  }
  return { args, title: `${role.label} · ${id} (SSM${user ? ` → ${user}` : ''})` };
}

function termSend(t, event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of t.viewers) res.write(frame);
}

async function openTerminal(body) {
  if ([...terminals.values()].filter((t) => !t.done).length >= MAX_TERMINALS) {
    throw new Error(`at most ${MAX_TERMINALS} terminals; close one first`);
  }
  const ctx = sandboxContext(body);
  const { args, title } = await terminalCommand(ctx, body.node, body);
  const rows = Math.min(Math.max(parseInt(body.rows, 10) || 30, 5), 300);
  const cols = Math.min(Math.max(parseInt(body.cols, 10) || 100, 20), 500);
  const proc = spawn('python3', [BRIDGE, String(rows), String(cols), '--', ...args], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const id = `t${Date.now().toString(36)}${proc.pid}`;
  const t = { id, proc, title, sandbox: ctx.sandbox, node: body.node, buffer: [], size: 0, viewers: new Set(), done: false, exitCode: null };
  terminals.set(id, t);
  const onData = (chunk) => {
    t.buffer.push(chunk);
    t.size += chunk.length;
    while (t.size > 256 * 1024 && t.buffer.length > 1) t.size -= t.buffer.shift().length;
    termSend(t, { type: 'data', data: chunk.toString('base64') });
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', (code) => {
    t.done = true;
    t.exitCode = code;
    termSend(t, { type: 'exit', code });
  });
  return { id, title };
}

function closeTerminal(t) {
  if (!t.done) t.proc.stdin.end(); // the bridge hangs up the session
  terminals.delete(t.id);
}

// ---------- raw config ----------

// redact: private keys and password/token/secret fields are replaced, also when the PEM is
// base64-encoded. Certificates, which are public, are kept.
function redact(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (typeof value !== 'string') return value;
  if (/password|passwd|token$|secret$|privateKey/i.test(key) && value) return '<redacted>';
  let decoded = '';
  if (value.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(value)) decoded = Buffer.from(value, 'base64').toString('utf8');
  if (/PRIVATE KEY/.test(value) || /PRIVATE KEY/.test(decoded)) return '<redacted: private key>';
  return value;
}

// ---------- runs ----------

function existingFile(value, label) {
  const p = path.resolve(expandHome(String(value).trim()));
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`${label} not found: ${value}`);
  return p;
}

// buildArgs turns the form into doctor arguments, rejecting anything unexpected.
function buildArgs(body) {
  if (!body.config) throw new Error('config path is required');
  if (!['dry-run', 'check'].includes(body.mode)) throw new Error('mode must be dry-run or check');
  const args = ['--config', existingFile(body.config, 'config'), `--${body.mode}`, '--verbose'];
  for (const [field, [flag, pattern]] of Object.entries(OPTIONS)) {
    const value = String(body[field] ?? '').trim();
    if (!value) continue;
    if (!pattern.test(value)) throw new Error(`invalid ${field}: ${value}`);
    args.push(flag, value);
  }
  for (const [field, flag] of Object.entries(FLAGS)) {
    if (body[field] === true) args.push(flag);
  }
  if (body.apiKeyFile) args.push('--api-key-file', existingFile(body.apiKeyFile, 'API key file'));
  return args;
}

function viewers(sandbox) {
  if (!watchers.has(sandbox)) watchers.set(sandbox, new Set());
  return watchers.get(sandbox);
}

// record stores an event on the run, keeps the PASS/WARN/FAIL counts for the sandbox
// list, and sends it to everyone watching the sandbox.
function record(run, event) {
  run.events.push(event);
  fs.appendFileSync(run.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  if (event.type === 'line') {
    if (/^== Summary ==/.test(event.text)) run.inSummary = true; // the summary repeats the checks
    const m = !run.inSummary && event.text.match(/^ {3}(PASS|WARN|FAIL) /);
    if (m) run.counts[m[1].toLowerCase()] += 1;
    const gw = event.text.match(/^ {3}PASS gateway: AI Gateway (.+)$/);
    if (gw) run.gateway = gw[1].trim();
  }
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of viewers(run.sandbox)) res.write(frame);
}

// pipeLines forwards a child stream one line at a time.
function pipeLines(run, stream, name) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const parts = (pending + chunk).split('\n');
    pending = parts.pop();
    for (const text of parts) record(run, { type: 'line', stream: name, text });
  });
  stream.on('end', () => {
    if (pending) record(run, { type: 'line', stream: name, text: pending });
  });
}

function startRun(body) {
  const sandbox = typeof body.sandbox === 'string' && body.sandbox ? body.sandbox : CUSTOM;
  if (runs.get(sandbox)?.done === false) {
    throw Object.assign(new Error(`${sandbox} is already running`), { status: 409 });
  }
  const args = buildArgs(body);
  const fileEnv = readEnv();
  const env = { ...process.env };
  for (const s of SECRETS) delete env[s];
  // Secrets reach the doctor only through its environment: typed in the form, else .env.
  const apiKey = (typeof body.apiKey === 'string' && body.apiKey.trim()) ||
    (body.keySource === 'paste' ? envValue(fileEnv, sandbox, 'AIGW_API_KEY') : '');
  if (apiKey) env.AIGW_API_KEY = apiKey;
  const cpPassword = (typeof body.cpPassword === 'string' && body.cpPassword) ||
    (body.cpUser ? envValue(fileEnv, sandbox, 'CP_PASSWORD') : '');
  if (cpPassword) env.CP_PASSWORD = cpPassword;

  // detached: the doctor gets its own process group, so Cancel can interrupt it
  // like Ctrl-C and its exit trap still deletes a temporary API key.
  const child = spawn('bash', [SCRIPT, ...args], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const startedAt = Date.now();
  const id = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${child.pid}`;
  fs.mkdirSync(historyDir(sandbox), { recursive: true, mode: 0o700 });
  const run = {
    id, sandbox, child, events: [], done: false, inSummary: false, file: path.join(historyDir(sandbox), `${id}.jsonl`),
    counts: { pass: 0, warn: 0, fail: 0 }, startedAt, endedAt: null, exit: null,
  };
  runs.set(sandbox, run);
  record(run, { type: 'start', id, sandbox, args: ['aigw-doctor.sh', ...args], startedAt });
  pipeLines(run, child.stdout, 'out');
  pipeLines(run, child.stderr, 'err');
  child.on('error', (err) => record(run, { type: 'line', stream: 'err', text: `failed to start: ${err.message}` }));
  child.on('close', (code, signal) => {
    run.done = true;
    run.endedAt = Date.now();
    run.exit = { code, signal };
    record(run, { type: 'exit', code, signal, endedAt: run.endedAt });
    if (!history.has(sandbox)) history.set(sandbox, []);
    history.get(sandbox).unshift(summarize(id, run.events));
    prune(sandbox);
  });
}

// runSummary: the sandbox's live run, else its newest finished run.
function runSummary(sandbox) {
  const run = runs.get(sandbox);
  // The gateway version is the newest one any recent run reported.
  const gateway = run?.gateway || (history.get(sandbox) || []).find((h) => h.gateway)?.gateway || '';
  if (run) return { running: !run.done, counts: run.counts, startedAt: run.startedAt, endedAt: run.endedAt, exit: run.exit, gateway };
  const last = history.get(sandbox)?.[0];
  return last ? { running: false, ...last, gateway } : null;
}

// runList: the sandbox's runs, newest first, including a live one.
function runList(sandbox) {
  const run = runs.get(sandbox);
  const list = history.get(sandbox) || [];
  if (run && !run.done) return [{ id: run.id, running: true, startedAt: run.startedAt, counts: run.counts }, ...list];
  return list;
}

// ---------- HTTP ----------

function readJson(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  // Reject other Host headers (DNS rebinding) and non-JSON posts (cross-site forms).
  const host = req.headers.host || '';
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'forbidden host' });
  if (req.method === 'POST' && !String(req.headers['content-type']).startsWith('application/json')) {
    return send(res, 415, { error: 'expected application/json' });
  }
  const url = new URL(req.url, `http://${host}`);

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(PUBLIC_DIR, file)).pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/sandboxes') {
    const list = sandboxList(readEnv()).map((s) => ({ ...s, run: runSummary(s.name) }));
    return send(res, 200, {
      envFile: ENV_FILE,
      envFound: fs.existsSync(ENV_FILE),
      historyDir: HISTORY_DIR,
      // Domain of the sandboxes' Fleet Managers (fm.<sandbox>.<domain>), if set in .env.
      sandboxDomain: /^[\w.-]+$/.test(readEnv().SANDBOX_DOMAIN || '') ? readEnv().SANDBOX_DOMAIN : '',
      sandboxes: list,
      custom: { run: runSummary(CUSTOM) },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sandboxes/save') {
    try {
      return send(res, 200, saveSettings(await readJson(req)));
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/sandboxes') {
    try {
      return send(res, 200, addSandbox(await readJson(req, MAX_CONFIG_BODY)));
    } catch (err) {
      return send(res, err.status || 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    // The config typed in the form, else the selected sandbox's config from .env.
    const sandbox = url.searchParams.get('sandbox') || '';
    const typed = url.searchParams.get('path') || '';
    const fromEnv = sandboxList(readEnv()).find((s) => s.name === sandbox)?.values.config || '';
    try {
      const file = existingFile(typed || fromEnv, 'config');
      if (!file.endsWith('.json')) throw new Error('config must be a .json file');
      return send(res, 200, configSummary(file));
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/config/raw') {
    const sandbox = url.searchParams.get('sandbox') || '';
    const typed = url.searchParams.get('path') || '';
    const fromEnv = sandboxList(readEnv()).find((s) => s.name === sandbox)?.values.config || '';
    try {
      const file = existingFile(typed || fromEnv, 'config');
      if (!file.endsWith('.json')) throw new Error('config must be a .json file');
      const json = redact(JSON.parse(fs.readFileSync(file, 'utf8')));
      return send(res, 200, { file, text: JSON.stringify(json, null, 2) });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/console') {
    try {
      const body = await readJson(req);
      const ctx = sandboxContext(body);
      const info = await consoleInfo(ctx);
      // The password is returned only when asked for, for the clipboard; it is not kept.
      const creds = body.withPassword || body.withUser ? await consoleCredentials(ctx) : null;
      return send(res, 200, { ...info, username: creds?.username, password: body.withPassword ? creds?.password : undefined });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/terminals') {
    const list = [...terminals.values()].map((t) => ({ id: t.id, title: t.title, sandbox: t.sandbox, node: t.node, done: t.done }));
    return send(res, 200, { terminals: list });
  }

  if (req.method === 'POST' && url.pathname === '/api/terminals') {
    try {
      return send(res, 200, await openTerminal(await readJson(req)));
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/terminals/stream') {
    const t = terminals.get(url.searchParams.get('id') || '');
    if (!t) return send(res, 404, { error: 'no such terminal' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    if (t.buffer.length) res.write(`data: ${JSON.stringify({ type: 'data', data: Buffer.concat(t.buffer).toString('base64') })}\n\n`);
    if (t.done) res.write(`data: ${JSON.stringify({ type: 'exit', code: t.exitCode })}\n\n`);
    t.viewers.add(res);
    req.on('close', () => t.viewers.delete(res));
    return;
  }

  if (req.method === 'POST' && /^\/api\/terminals\/(input|resize|close)$/.test(url.pathname)) {
    const body = await readJson(req).catch(() => ({}));
    const t = terminals.get(body.id || '');
    if (!t) return send(res, 404, { error: 'no such terminal' });
    const action = url.pathname.split('/').pop();
    if (action === 'close') closeTerminal(t);
    else if (t.done) return send(res, 409, { error: 'the session has ended' });
    else if (action === 'input' && typeof body.data === 'string') t.proc.stdin.write(Buffer.from(body.data, 'utf8'));
    else if (action === 'resize') {
      const rows = Math.min(Math.max(parseInt(body.rows, 10) || 0, 5), 300);
      const cols = Math.min(Math.max(parseInt(body.cols, 10) || 0, 20), 500);
      t.proc.stdio[3].write(`${rows} ${cols}\n`);
    }
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/info') {
    // The gateway's version from GET /v1/info, with the playground's URL and API key.
    try {
      const body = await readJson(req);
      const ctx = sandboxContext(body);
      const gw = gatewayUrl(ctx, body);
      const { key } = await playgroundKey(ctx, body, gw);
      const r = await request('GET', `${gw}/v1/info`, { headers: { Authorization: `Bearer ${key}` }, timeout: 30000 });
      const info = JSON.parse(r.text || '{}');
      if (r.status !== 200) throw new Error(`/v1/info returned HTTP ${r.status}: ${info.error?.message || info.message || ''}`);
      const models = (info.models || []).map((m) => ({ name: m.model_name, status: m.status, reachable: m.server_reachable }));
      return send(res, 200, { gateway: gw, version: info.version || '', buildTime: info.build_time || '', commit: info.commit_hash || '', models });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/playground') {
    try {
      return send(res, 200, await playground(await readJson(req)));
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/runs') {
    return send(res, 200, { runs: runList(url.searchParams.get('sandbox') || CUSTOM) });
  }

  if (req.method === 'POST' && url.pathname === '/api/run') {
    try {
      startRun(await readJson(req));
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, err.status || 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const sandbox = url.searchParams.get('sandbox') || CUSTOM;
    const runId = url.searchParams.get('run');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const live = runs.get(sandbox);
    if (runId && runId !== live?.id) {
      // An earlier run: replay it from disk and end the stream.
      const file = path.join(historyDir(sandbox), `${path.basename(runId)}.jsonl`);
      for (const event of fs.existsSync(file) ? readEvents(file) : [{ type: 'idle' }]) write(event);
      write({ type: 'end' });
      return res.end();
    }
    // The latest run: replay it, then follow it and any later runs of the sandbox.
    if (live) live.events.forEach(write);
    else {
      const last = history.get(sandbox)?.[0];
      const file = last && path.join(historyDir(sandbox), `${last.id}.jsonl`);
      (file && fs.existsSync(file) ? readEvents(file) : [{ type: 'idle' }]).forEach(write);
    }
    viewers(sandbox).add(res);
    req.on('close', () => viewers(sandbox).delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/cancel') {
    const body = await readJson(req).catch(() => ({}));
    const run = runs.get(body.sandbox || CUSTOM);
    if (!run || run.done) return send(res, 409, { error: 'nothing is running' });
    process.kill(-run.child.pid, 'SIGINT');
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'not found' });
});

if (!fs.existsSync(SCRIPT)) {
  console.error(`doctor script not found: ${SCRIPT}`);
  process.exit(1);
}
// First start: create .env from .env.example (only for the default location), so the UI
// opens with the documented settings to fill in.
const ENV_EXAMPLE = path.join(HERE, '.env.example');
if (!process.env.ENV_FILE && !fs.existsSync(ENV_FILE) && fs.existsSync(ENV_EXAMPLE)) {
  fs.copyFileSync(ENV_EXAMPLE, ENV_FILE, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(ENV_FILE, 0o600);
  console.log(`created ${ENV_FILE} from .env.example; edit it to add your sandboxes`);
}

fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
loadHistory();
// Delete the playground's temporary API keys on the way out.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    for (const t of terminals.values()) closeTerminal(t);
    await deletePlayKeys();
    process.exit(0);
  });
}

// openBrowser: show the UI in the default browser once it is listening (on whichever port
// it got). NO_OPEN=1 turns this off, e.g. on a remote machine or in scripts.
function openBrowser(url) {
  if (/^(1|true|yes)$/i.test(process.env.NO_OPEN || '')) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => console.log(`open ${url} in your browser`));
  child.unref();
}

// listen: start on FIRST_PORT, or the next free port when it is taken (another copy of the
// UI, say). The Host header check follows PORT, so it accepts only the port in use.
function listen(port) {
  PORT = port;
  // Each attempt has its own handlers, and each removes the other, so a failed attempt
  // leaves nothing behind for the next one.
  const onListening = () => {
    server.removeListener('error', onError);
    console.log(`AI Gateway doctor UI: http://${HOST}:${PORT}`);
    console.log(fs.existsSync(ENV_FILE) ? `settings: ${ENV_FILE}` : `no ${ENV_FILE}; set ENV_FILE or create it`);
    openBrowser(`http://${HOST}:${PORT}/`);
  };
  const onError = (err) => {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && port < FIRST_PORT + PORT_TRIES - 1) {
      console.log(`port ${port} is in use; trying ${port + 1}`);
      listen(port + 1);
    } else {
      console.error(err.code === 'EADDRINUSE'
        ? `ports ${FIRST_PORT}-${port} are all in use; set PORT to a free one`
        : `cannot listen on ${HOST}:${port}: ${err.message}`);
      process.exit(1);
    }
  };
  server.once('listening', onListening);
  server.once('error', onError);
  server.listen(port, HOST);
}
listen(FIRST_PORT);
