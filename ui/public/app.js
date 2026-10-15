// Browser side of the doctor UI. Left: sandboxes from .env with their last run's status.
// Middle: the run form, filled from .env and your edits (kept per sandbox). Right: the
// selected sandbox's current or last run, grouped into one card per step, with the model
// requests and responses as a table.

const $ = (id) => document.getElementById(id);
const form = $('run-form');

const CUSTOM = '_custom';
// { sandbox: { field: value } } for the fields you changed from .env; secrets never saved.
// (v2: earlier versions saved every field, which then hid later .env changes.)
const EDITS_KEY = 'aigw-doctor-edits-v2';
localStorage.removeItem('aigw-doctor-edits');
const SELECTED_KEY = 'aigw-doctor-selected';
const TEXT_FIELDS = ['config', 'region', 'tenantId', 'aigwInstance', 'cbInstance', 'aigwUrl', 'threshold',
  'cpUser', 'cpUrl', 'orgId', 'apiKeyFile', 'models'];
const RADIOS = { scope: 'all', mode: 'check', keySource: 'create' };
const SECRET_FIELDS = { cpPassword: 'CP_PASSWORD', apiKey: 'AIGW_API_KEY' };
const RANK = { fail: 3, warn: 2, pass: 1, skip: 0 };

let sandboxes = [];
let customRun = null;
// The selected sandbox comes from the URL (#my-sandbox, so it can be bookmarked), else the last one used.
let selected = decodeURIComponent(location.hash.slice(1)) || localStorage.getItem(SELECTED_KEY) || CUSTOM;
let state = null;
let source = null;
let viewing = ''; // '' follows the latest run; otherwise the id of an earlier run
let renderQueued = false;

// ---------- sandboxes (left) ----------

async function loadSandboxes() {
  const data = await (await fetch('/api/sandboxes')).json();
  sandboxes = data.sandboxes;
  sandboxDomain = data.sandboxDomain || '';
  customRun = data.custom.run;
  renderNav(data);
  return data;
}

function current() {
  return sandboxes.find((s) => s.name === selected);
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function runStatus(run) {
  if (!run) return 'none';
  if (run.running) return 'running';
  if (run.exit?.signal) return 'skip';
  return run.counts.fail ? 'fail' : run.counts.warn ? 'warn' : 'pass';
}

function navItem(name, label, sub, run) {
  const status = runStatus(run);
  const counts = run && !run.running
    ? el('span', { class: 'nav-counts' },
      el('span', { class: 'c pass' }, String(run.counts.pass)),
      el('span', { class: 'c warn' }, String(run.counts.warn)),
      el('span', { class: 'c fail' }, String(run.counts.fail)))
    : null;
  const li = el('li', { class: name === selected ? 'active' : '', tabindex: '0', role: 'button' },
    el('span', { class: `dot ${status}`, title: status }),
    el('span', { class: 'nav-text' },
      el('span', { class: 'nav-name' }, label),
      el('span', { class: 'nav-sub' }, run?.running ? 'running…' : [sub, ago(run?.endedAt)].filter(Boolean).join(' · ')),
      run?.gateway && el('span', { class: 'nav-sub' }, `AI Gateway ${run.gateway.split(',')[0]}`)),
    counts);
  const pick = () => select(name);
  li.addEventListener('click', pick);
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
  return li;
}

// showVersion: the gateway version line under the sandbox title, from the latest run
// that reported it (or a live check).
function showVersion(text, live) {
  const box = $('gw-version');
  box.className = text ? '' : 'muted';
  box.replaceChildren(text
    ? el('span', {}, el('strong', {}, 'AI Gateway '), text, el('span', { class: 'muted' }, live ? ' · checked now' : ' · from the last run'))
    : 'AI Gateway version: not checked yet');
}

function renderNav(data) {
  const items = sandboxes.map((s) => navItem(s.name, s.label, s.values.region || '', s.run));
  items.push(navItem(CUSTOM, 'Custom run', 'not from .env', customRun));
  $('sandbox-list').replaceChildren(...items);
  const run = selected === CUSTOM ? customRun : current()?.run;
  if (!versionChecked) showVersion(run?.gateway || '', false);
  $('env-info').replaceChildren(data.envFound
    ? el('span', {}, 'Settings: ', el('code', {}, data.envFile))
    : el('span', { class: 'warn-text' }, 'No .env found. Copy ', el('code', {}, '.env.example'), ' to ',
      el('code', {}, data.envFile), ' to list your sandboxes.'));
}

function select(name) {
  if (!sandboxes.some((s) => s.name === name)) name = CUSTOM;
  configLoadedFor = null;
  if (!addForm.hidden) showAdd(false);
  selected = name;
  viewing = '';
  cleared = false;
  skipRunId = null;
  skipping = false;
  versionChecked = false;
  localStorage.setItem(SELECTED_KEY, name);
  history.replaceState(null, '', name === CUSTOM ? location.pathname : `#${encodeURIComponent(name)}`);
  fillForm();
  follow();
  loadRuns();
  loadSandboxes();
  if (tab === 'config' || tab === 'playground') loadConfig();
  $('play-log').replaceChildren();
  newQuestion();
  lastPlay = null;
  $('play-again').disabled = true;
  $('console-msg').textContent = '';
}

// ---------- config overview (Config tab) ----------

let tab = 'results';
let configLoadedFor = null;

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => {
    tab = button.dataset.tab;
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b === button);
    $('results-view').hidden = tab !== 'results';
    $('config-view').hidden = tab !== 'config';
    $('playground-view').hidden = tab !== 'playground';
    $('terminals-view').hidden = tab !== 'terminals';
    if (tab === 'config' || tab === 'playground') loadConfig();
    if (tab === 'terminals') showTerminals();
  });
}

async function loadConfig() {
  const path = form.elements.config.value.trim();
  const key = `${selected}|${path}`;
  if (configLoadedFor === key) return;
  configLoadedFor = key;
  const q = new URLSearchParams({ sandbox: sandboxParam(), path });
  const resp = await fetch(`/api/config?${q}`);
  const data = await resp.json();
  if (configLoadedFor !== key) return; // a newer request is on its way
  configData = resp.ok ? data : null;
  $('config-view').replaceChildren(...(resp.ok ? renderConfig(data) : [el('p', { class: 'empty' }, data.error)]));
  fillPlayModels();
}

let configData = null;

// showRawConfig: the config file as JSON, with private keys and password/token fields redacted.
async function showRawConfig(box, button) {
  if (!box.hidden) {
    box.hidden = true;
    button.textContent = 'Raw JSON';
    return;
  }
  const q = new URLSearchParams({ sandbox: sandboxParam(), path: form.elements.config.value.trim() });
  const resp = await fetch(`/api/config/raw?${q}`);
  const data = await resp.json();
  if (!resp.ok) {
    box.replaceChildren(el('p', { class: 'empty' }, data.error));
  } else {
    const copy = el('button', { type: 'button', class: 'small-btn' }, 'Copy');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(data.text);
      copy.textContent = 'Copied';
    });
    const download = el('a', { class: 'small-btn', download: data.file.split('/').pop(),
      href: URL.createObjectURL(new Blob([data.text], { type: 'application/json' })) }, 'Download');
    box.replaceChildren(
      el('div', { class: 'raw-head' }, el('span', { class: 'muted small' }, `${data.file} · private keys and passwords redacted`), copy, download),
      el('pre', { class: 'raw-json' }, data.text));
  }
  box.hidden = false;
  button.textContent = 'Hide raw JSON';
}

// cacheVerdict: what the doctor's step 7 does with this model's cache, by the same rule:
// a cache type is tested only when cacheConfig.isEnabled and the type are both on.
function cacheVerdict(m) {
  const chat = /text-generation/.test(m.kind);
  const types = ['standard', 'semantic'].filter((t) => m.cache[t]);
  if (!chat) return { tested: [], note: 'not a chat model; no cache test' };
  if (!types.length) return { tested: [], note: 'no cache type on' };
  if (!m.cache.enabled) return { tested: [], note: 'cacheConfig.isEnabled is false: not tested' };
  return { tested: types, note: '' };
}

// duration: a Go duration in nanoseconds (e.g. requestTimeout 30000000000) as seconds.
const duration = (ns) => (typeof ns === 'number' && ns >= 1e6 ? `${ns / 1e9}s` : ns);

const onOff = (label, on) => el('span', { class: `pill ${on ? 'pass' : 'skip'}` }, label);

function kv(label, value) {
  if (value === null || value === undefined || value === '') return null;
  return el('div', { class: 'kv' }, el('span', { class: 'k' }, label), el('span', { class: 'v' }, String(value)));
}

function renderConfig(c) {
  const chat = c.models.filter((m) => /text-generation/.test(m.kind)).length;
  const tested = c.models.filter((m) => cacheVerdict(m).tested.length).length;
  const rawBox = el('div', { class: 'raw-box' });
  rawBox.hidden = true;
  const rawBtn = el('button', { type: 'button', class: 'small-btn' }, 'Raw JSON');
  const fm = fleetManagerUrl(form.elements.cpUrl.value.trim(), selected === CUSTOM ? '' : selected, current()?.values.fmUrl);
  const fmBtn = fm ? el('a', { class: 'small-btn', href: fm, target: '_blank', rel: 'noopener',
    title: 'Download the AI gateway config from Fleet Manager' }, 'Fleet Manager ↗') : null;
  rawBtn.addEventListener('click', () => showRawConfig(rawBox, rawBtn));
  const head = el('div', { class: 'config-head' },
    el('div', {}, el('strong', {}, c.file.split('/').pop()), ' ',
      el('span', { class: 'muted' }, `· modified ${new Date(c.modifiedAt).toLocaleString()}`)),
    el('div', { class: 'config-actions' },
      el('span', { class: 'muted' }, `${c.models.length} models · ${chat} chat · cache tested on ${tested}`), rawBtn, fmBtn));

  const store = el('article', { class: 'step info' },
    el('header', {}, el('h3', {}, 'Cache store')),
    el('div', { class: 'kv-grid' },
      kv('Cluster host', c.store.host),
      kv('Cache keyspace', c.store.cacheKeyspace),
      kv('Batch keyspace', c.store.batchKeyspace),
      kv('DB credential (Secrets Manager name)', c.store.dbCredKey),
      kv('Admin credential (Secrets Manager name)', c.store.adminKey),
      kv('Service', c.serviceName),
      kv('Rate limit', c.rateLimit)));

  const cards = c.models.map((m) => {
    const v = cacheVerdict(m);
    const cc = m.cache;
    const section = (title, ...body) => el('div', { class: 'm-sec' }, el('div', { class: 'm-sec-title' }, title), ...body);
    return el('div', { class: `model-card ${v.tested.length ? 'tested' : ''}` },
      el('div', { class: 'm-head' },
        el('span', { class: 'mono strong' }, m.modelName),
        el('span', { class: `pill ${m.status === 'healthy' ? 'pass' : 'warn'}` }, m.status || '?'),
        el('span', { class: 'chip' }, m.kind),
        el('span', { class: 'chip' }, [m.serverKind, m.region || m.endpoint].filter(Boolean).join(' · ')),
        m.name && el('span', { class: 'muted small' }, m.name),
        el('span', { class: 'muted mono small m-id' }, m.id)),
      el('div', { class: 'm-body' },
        section('Cache',
          el('div', { class: 'pills' }, onOff('cache', cc.enabled), onOff('standard', cc.standard), onOff('semantic', cc.semantic),
            cc.conversational && onOff('conversational', true)),
          el('div', { class: 'muted small' }, [cc.defaultType && `default ${cc.defaultType}`, cc.expiry != null && `expiry ${cc.expiry}s`].filter(Boolean).join(' · ')),
          el('div', { class: `small ${v.tested.length ? 'pass-text' : 'muted'}` }, v.tested.length ? `doctor tests: ${v.tested.join(', ')}` : v.note)),
        cc.semantic && section('Semantic cache',
          kv('embedding', cc.embeddingModel), kv('threshold', cc.threshold), kv('dimensions', cc.dimensions),
          kv('similarity', cc.similarity), kv('search', cc.searchType), kv('store', cc.store), kv('index', cc.index)),
        section('Other',
          el('div', { class: 'pills' }, m.guardrail && onOff('guardrail', true), m.jailbreak && onOff('jailbreak', true),
            m.hallucination && onOff('hallucination', true), m.batch && onOff('batch', true)),
          kv('qps', m.qps), kv('queue', m.queueLength), kv('timeout', duration(m.requestTimeout)),
          kv('embedding dims', /embedding/.test(m.kind) ? m.embeddingDimensions : null))));
  });
  const models = el('article', { class: 'step info' },
    el('header', {}, el('h3', {}, `Models (${c.models.length})`)),
    el('div', { class: 'model-cards' }, cards));
  return [head, rawBox, store, models];
}

// ---------- Couchbase console (middle pane) ----------

function consoleBody(extra) {
  return { sandbox: sandboxParam(), config: form.elements.config.value.trim(), region: form.elements.region.value.trim(), ...extra };
}

async function consoleCall(extra) {
  $('console-msg').textContent = 'looking up…';
  const resp = await fetch('/api/console', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(consoleBody(extra)),
  });
  const data = await resp.json();
  $('console-msg').textContent = resp.ok ? `${data.host} (from ${data.source})` : data.error;
  return resp.ok ? data : null;
}

// Check version: GET /v1/info through the server, with the playground's URL and API key.
let versionChecked = false;
$('version-btn').addEventListener('click', async () => {
  const run = formBody();
  $('gw-version').textContent = 'checking…';
  const resp = await fetch('/api/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sandbox: run.sandbox, config: run.config, region: run.region, aigwUrl: run.aigwUrl,
      keySource: run.keySource, apiKey: form.elements.apiKey.value, apiKeyFile: form.elements.apiKeyFile.value.trim() }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    $('gw-version').className = 'error-text';
    $('gw-version').textContent = data.error;
    return;
  }
  versionChecked = true;
  const down = data.models.filter((m) => m.reachable === false).length;
  showVersion([data.version || '(no version)', data.buildTime && `built ${data.buildTime}`, data.commit && `commit ${data.commit.slice(0, 12)}`,
    `${data.models.length} model entries${down ? `, ${down} unreachable` : ''}`].filter(Boolean).join(', '), true);
});

$('console-open').addEventListener('click', async () => {
  // Open the tab now (in the click) so it is not blocked as a pop-up, then point it at the console.
  const win = window.open('about:blank', '_blank');
  const data = await consoleCall({});
  if (data && win) win.location = data.url;
  else if (win) win.close();
});
$('console-user').addEventListener('click', async () => {
  const data = await consoleCall({ withUser: true });
  if (data?.username) {
    await navigator.clipboard.writeText(data.username);
    $('console-msg').textContent = `user copied (${data.username})`;
  }
});
$('console-pass').addEventListener('click', async () => {
  const data = await consoleCall({ withPassword: true });
  if (data?.password) {
    await navigator.clipboard.writeText(data.password);
    $('console-msg').textContent = 'password copied; paste it in the console login';
  }
});

// ---------- playground (Playground tab) ----------

const playForm = $('play-form');
let lastPlay = null;

// Random questions, from the same topics as the doctor's cache test: two topics and a
// phrasing make a question the cache has not seen, so the first answer is a MISS.
const TOPICS = ['glaciers', 'volcanoes', 'lighthouses', 'honeybees', 'submarines', 'violins', 'tea', 'coral', 'orchids',
  'comets', 'bridges', 'chess', 'pottery', 'falcons', 'deserts', 'sourdough', 'telescopes', 'origami', 'canals', 'tides',
  'lanterns', 'marathons', 'mosaics', 'penguins', 'bamboo', 'typewriters', 'fjords', 'kites', 'saffron', 'sundials',
  'compasses', 'windmills', 'fossils', 'jazz', 'igloos', 'carousels', 'quartz', 'llamas', 'monsoons', 'scrolls'];
const PHRASINGS = [
  (a, b) => `In one short sentence, what do ${a} and ${b} have in common?`,
  (a, b) => `Give one surprising fact that connects ${a} and ${b}.`,
  (a, b) => `How would you explain ${a} to someone who only knows about ${b}? Two sentences.`,
  (a, b) => `Write a haiku about ${a} and ${b}.`,
  (a, b) => `Name three ways ${a} differ from ${b}.`,
];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function randomQuestion() {
  const a = pick(TOPICS);
  let b = pick(TOPICS);
  while (b === a) b = pick(TOPICS);
  return pick(PHRASINGS)(a, b);
}

function newQuestion() {
  playForm.elements.prompt.value = randomQuestion();
}

function fillPlayModels() {
  const select = playForm.elements.model;
  const before = select.value;
  const models = (configData?.models || []).filter((m) => /text-generation|embedding/.test(m.kind));
  select.replaceChildren(...models.map((m) => el('option', { value: m.modelName },
    `${m.modelName}${/embedding/.test(m.kind) ? ' (embeddings)' : ''}`)));
  if (models.some((m) => m.modelName === before)) select.value = before;
  updatePlayCache();
}

// updatePlayCache: mark which cache types the model's config turns on, and pick its default.
function updatePlayCache() {
  const m = configData?.models.find((x) => x.modelName === playForm.elements.model.value);
  const embedding = m && /embedding/.test(m.kind);
  for (const opt of playForm.elements.cacheType.options) {
    if (opt.value === 'none') continue;
    const on = m && m.cache.enabled && m.cache[opt.value];
    opt.textContent = `${opt.value}${on ? '' : ' (off in config)'}`;
  }
  playForm.elements.maxTokens.disabled = Boolean(embedding);
  playForm.elements.temperature.disabled = Boolean(embedding);
}

playForm.elements.model.addEventListener('change', updatePlayCache);

function playEntry(r) {
  const ok = r.status >= 200 && r.status < 300;
  const usage = r.usage ? [r.usage.prompt_tokens != null && `${r.usage.prompt_tokens} in`, r.usage.completion_tokens != null && `${r.usage.completion_tokens} out`].filter(Boolean).join(' · ') : '';
  const prompt = r.request.messages ? r.request.messages[r.request.messages.length - 1].content : r.request.input;
  return el('div', { class: `exchange ${ok ? '' : 'bad'}` },
    el('div', { class: 'ex-head' },
      el('span', { class: 'ex-model' }, r.model),
      el('span', { class: 'chip' }, r.endpoint.split('/v1/')[1] || r.endpoint),
      r.cacheType !== 'none' && el('span', { class: 'chip' }, `${r.cacheType} cache`),
      r.xcache && el('span', { class: `pill ${r.xcache === 'HIT' ? 'pass' : 'skip'}` }, r.xcache),
      el('span', { class: `pill ${ok ? 'pass' : 'fail'}` }, `HTTP ${r.status}`),
      usage && el('span', { class: 'chip' }, usage),
      el('span', { class: 'ex-time' }, `${(r.ms / 1000).toFixed(2)}s · ${new Date(r.at).toLocaleTimeString()}`)),
    el('div', { class: 'ex-body' },
      el('div', { class: 'ex-q' }, el('span', { class: 'ex-label' }, 'Q'), el('span', {}, prompt)),
      el('div', { class: 'ex-a' }, el('span', { class: 'ex-label' }, 'A'), el('span', {}, ok ? r.content : r.error))),
    debugHeaders(r.responseHeaders),
    headerTable('Request headers', r.requestHeaders, `POST ${r.endpoint}`),
    headerTable('Response headers', r.responseHeaders, `HTTP ${r.status}`),
    el('details', {}, el('summary', { class: 'small' }, `Raw response · ${r.keySource} · ${r.endpoint}`),
      el('pre', { class: 'raw-json' }, (() => {
        try {
          return JSON.stringify(JSON.parse(r.raw), null, 2);
        } catch {
          return r.raw;
        }
      })())));
}

// The gateway's cache and debug headers stand out in the header lists.
const notable = (name) => /^x-(cb-|cache$)/i.test(name);

function headerTable(title, headers, first) {
  if (!headers?.length) return null;
  return el('details', {}, el('summary', { class: 'small' }, `${title} (${headers.length})`),
    el('table', { class: 'headers' }, el('tbody', {},
      first && el('tr', {}, el('td', { colspan: '2', class: 'muted mono' }, first)),
      headers.map(([k, v]) => el('tr', { class: notable(k) ? 'notable' : '' }, el('td', { class: 'mono' }, k), el('td', { class: 'mono' }, v))))));
}

// debugHeaders: the X-cb-* headers the gateway returns with X-cb-debug, shown under the answer.
function debugHeaders(headers) {
  const dbg = (headers || []).filter(([k]) => /^x-cb-/i.test(k));
  if (!dbg.length) return null;
  return el('div', { class: 'debug-headers' }, dbg.map(([k, v]) =>
    el('span', { class: 'chip' }, el('span', { class: 'muted' }, `${k}: `), v)));
}

async function sendPlay(body) {
  $('play-send').disabled = true;
  $('play-again').disabled = true;
  $('play-msg').textContent = 'sending…';
  try {
    const resp = await fetch('/api/playground', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      $('play-msg').textContent = data.error;
      return;
    }
    $('play-msg').textContent = '';
    lastPlay = body;
    $('play-log').prepend(playEntry({ ...data, at: Date.now() }));
  } finally {
    $('play-send').disabled = false;
    $('play-again').disabled = !lastPlay;
  }
}

playForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = playForm.elements;
  const run = formBody();
  sendPlay({
    sandbox: run.sandbox, config: run.config, region: run.region, aigwUrl: run.aigwUrl,
    keySource: run.keySource, apiKey: form.elements.apiKey.value, apiKeyFile: form.elements.apiKeyFile.value.trim(),
    model: f.model.value, cacheType: f.cacheType.value, prompt: f.prompt.value, system: f.system.value,
    maxTokens: f.maxTokens.value, temperature: f.temperature.value, debug: f.debug.checked,
  });
});
playForm.elements.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) playForm.requestSubmit();
});
$('play-again').addEventListener('click', () => lastPlay && sendPlay(lastPlay));
$('play-clear').addEventListener('click', () => {
  $('play-log').replaceChildren();
  newQuestion();
});
$('play-new').addEventListener('click', newQuestion);
newQuestion();

// ---------- run history (top of the right pane) ----------

function sandboxParam() {
  return selected === CUSTOM ? '' : selected;
}

function runLabel(r) {
  const when = r.startedAt ? new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : r.id;
  if (r.running) return `${when} · running`;
  const c = r.counts;
  const end = r.exit?.signal || r.exit?.code === 130 ? ' · cancelled' : !r.exit ? ' · interrupted' : '';
  return `${when} · ${c.pass} passed, ${c.warn} warn, ${c.fail} failed${end}`;
}

async function loadRuns() {
  const { runs } = await (await fetch(`/api/runs?sandbox=${encodeURIComponent(sandboxParam())}`)).json();
  const picker = $('run-picker');
  picker.replaceChildren(el('option', { value: '' }, 'Latest (live)'),
    ...runs.map((r) => el('option', { value: r.id }, runLabel(r))));
  picker.value = runs.some((r) => r.id === viewing) ? viewing : '';
  $('history-note').textContent = runs.length ? `${runs.length} saved run${runs.length === 1 ? '' : 's'}` : 'no saved runs';
}

$('run-picker').addEventListener('change', (e) => {
  viewing = e.target.value;
  follow();
});

// ---------- adding a sandbox (middle pane) ----------

const addForm = $('add-form');

function showAdd(show) {
  addForm.hidden = !show;
  form.hidden = show;
  form.previousElementSibling.hidden = show; // the run form's heading
  if (show) {
    addForm.reset();
    $('add-error').textContent = '';
    updateAddVisibility();
    addForm.elements.name.focus();
  }
}

function updateAddVisibility() {
  const upload = addForm.querySelector('input[name="configSource"]:checked').value === 'upload';
  addForm.querySelector('.config-upload').hidden = !upload;
  addForm.querySelector('.config-path').hidden = upload;
  const name = addForm.elements.name.value.trim();
  $('add-prefix').textContent = `${name ? name.toUpperCase().replace(/[^A-Z0-9]/g, '_') : '<NAME>'}_*`;
  const fm = fleetManagerUrl(addForm.elements.cpUrl.value.trim(), name, '');
  for (const a of addForm.querySelectorAll('.fm-link')) {
    a.href = fm || '#';
    a.textContent = fm || 'https://fm.<sandbox>.<domain>/';
  }
}

$('add-btn').addEventListener('click', () => showAdd(true));
$('add-cancel').addEventListener('click', () => showAdd(false));
addForm.addEventListener('input', updateAddVisibility);
addForm.addEventListener('change', updateAddVisibility);

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('add-error').textContent = '';
  const f = addForm.elements;
  const body = {};
  for (const k of ['name', 'label', 'region', 'tenantId', 'cpUrl', 'cpUser', 'models']) body[k] = f[k].value.trim();
  if (addForm.querySelector('input[name="configSource"]:checked').value === 'upload') {
    const file = f.configFile.files[0];
    if (!file) {
      $('add-error').textContent = 'choose the sandbox config.json';
      return;
    }
    body.configJson = await file.text();
  } else {
    body.configPath = f.configPath.value.trim();
  }
  const resp = await fetch('/api/sandboxes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) {
    $('add-error').textContent = data.error;
    return;
  }
  showAdd(false);
  await loadSandboxes();
  select(data.name);
});

// ---------- Fleet Manager link ----------

// SANDBOX_DOMAIN from .env (via /api/sandboxes); without it, the link comes from the control plane URL only.
let sandboxDomain = '';

// fleetManagerUrl: where to download a sandbox's AI gateway config. FM_URL in .env wins;
// else it follows the control plane host (api.<env>.<domain> -> fm.<env>.<domain>), or the
// sandbox name with SANDBOX_DOMAIN from .env (fm.<sandbox>.<SANDBOX_DOMAIN>).
function fleetManagerUrl(cpUrl, name, override) {
  if (override) return override;
  let m = (cpUrl || '').match(/^https:\/\/api\.([^/:]+)/);
  if (m) return `https://fm.${m[1]}/`;
  m = (cpUrl || '').match(/^https:\/\/([^./]+)\.internal-api\.([^/:]+)/);
  if (m) return `https://fm.${m[1]}.${m[2]}/`;
  if (sandboxDomain && /^[a-z0-9][a-z0-9-]*$/i.test(name || '')) return `https://fm.${name.toLowerCase()}.${sandboxDomain}/`;
  return '';
}

function setFmLinks(scope, url) {
  for (const a of scope.querySelectorAll('.fm-link')) {
    a.hidden = !url;
    if (url) {
      a.href = url;
      if (a.textContent.startsWith('https://')) a.textContent = url;
    }
  }
}

function updateFmLink() {
  setFmLinks(form, fleetManagerUrl(form.elements.cpUrl.value.trim(), selected === CUSTOM ? '' : selected, current()?.values.fmUrl));
}

// ---------- form (middle) ----------

function edits() {
  return JSON.parse(localStorage.getItem(EDITS_KEY) || '{}');
}

function radio(name) {
  return form.querySelector(`input[name="${name}"]:checked`).value;
}

function setRadio(name, value) {
  const input = form.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

// baseline: the form values .env gives the selected sandbox.
function baseline() {
  return { ...RADIOS, ...(current()?.values || {}) };
}

// fillForm: .env values for the selected sandbox, then your saved edits on top.
function fillForm() {
  const sb = current();
  const values = { ...baseline(), ...(edits()[selected] || {}) };
  for (const f of TEXT_FIELDS) form.elements[f].value = values[f] || '';
  for (const r of Object.keys(RADIOS)) setRadio(r, values[r]);
  for (const [field, key] of Object.entries(SECRET_FIELDS)) {
    form.elements[field].value = '';
    form.elements[field].placeholder = sb?.secrets[key] ? 'set in .env' : '';
  }
  $('form-title').textContent = sb ? sb.label : 'Custom run';
  updateEditButtons();
  $('save-env-msg').hidden = true;
  $('form-error').textContent = '';
  updateVisibility();
  updateFmLink();
}

// saveEdits keeps only the fields that differ from .env, so later .env changes still show.
function saveEdits() {
  const all = edits();
  const base = baseline();
  const mine = {};
  for (const f of TEXT_FIELDS) if (form.elements[f].value !== (base[f] || '')) mine[f] = form.elements[f].value;
  for (const r of Object.keys(RADIOS)) if (radio(r) !== base[r]) mine[r] = radio(r);
  if (Object.keys(mine).length) all[selected] = mine;
  else delete all[selected];
  localStorage.setItem(EDITS_KEY, JSON.stringify(all));
  updateEditButtons();
}

// updateEditButtons: Reset and Save show for a sandbox from .env when the form differs from
// it (or a password/API key was typed, which Save can store).
function updateEditButtons() {
  const sb = current();
  const changed = Boolean(edits()[selected]);
  const secret = Boolean(form.elements.cpPassword.value || form.elements.apiKey.value);
  $('reset-btn').hidden = !sb || !changed;
  $('save-env-btn').hidden = !sb || (!changed && !secret);
}

$('save-env-btn').addEventListener('click', async () => {
  const resp = await fetch('/api/sandboxes/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sandbox: selected, values: edits()[selected] || {},
      cpPassword: form.elements.cpPassword.value, apiKey: form.elements.apiKey.value }),
  });
  const data = await resp.json();
  const msg = $('save-env-msg');
  if (!resp.ok) {
    msg.hidden = false;
    msg.className = 'hint error-text';
    msg.textContent = data.error;
    return;
  }
  // .env now holds these values, so they are no longer edits.
  const all = edits();
  delete all[selected];
  localStorage.setItem(EDITS_KEY, JSON.stringify(all));
  await loadSandboxes();
  fillForm();
  msg.hidden = false;
  msg.className = 'hint';
  msg.textContent = data.saved.length ? `Saved to .env: ${data.saved.join(', ')} (previous file kept as .env.bak)` : 'Nothing to save.';
});

function updateVisibility() {
  const key = radio('keySource');
  $('models-fields').hidden = radio('scope') === 'infra';
  form.querySelector('.key-file').hidden = key !== 'file';
  form.querySelector('.key-paste').hidden = key !== 'paste';
}

function formBody() {
  const v = (name) => form.elements[name].value.trim();
  const scope = radio('scope');
  const key = radio('keySource');
  const models = scope !== 'infra';
  const body = { sandbox: selected === CUSTOM ? '' : selected, mode: radio('mode'), keySource: key };
  for (const f of TEXT_FIELDS) body[f] = v(f);
  return Object.assign(body, {
    inferenceOnly: scope === 'inference',
    skipInference: scope === 'infra',
    createApiKey: models && key === 'create',
    apiKeyFile: models && key === 'file' ? v('apiKeyFile') : '',
    apiKey: models && key === 'paste' ? form.elements.apiKey.value : '',
    cpUser: models ? v('cpUser') : '',
    cpPassword: models ? form.elements.cpPassword.value : '',
    models: models ? v('models') : '',
  });
}

form.addEventListener('change', (e) => {
  updateVisibility();
  saveEdits();
  if (e.target.name === 'config' && tab !== 'results') loadConfig();
});
form.addEventListener('input', (e) => {
  saveEdits();
  if (e.target.name === 'cpUrl') updateFmLink();
});

$('reset-btn').addEventListener('click', () => {
  const all = edits();
  delete all[selected];
  localStorage.setItem(EDITS_KEY, JSON.stringify(all));
  fillForm();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('form-error').textContent = '';
  saveEdits();
  const resp = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(formBody()),
  });
  if (!resp.ok) {
    $('form-error').textContent = (await resp.json()).error;
    return;
  }
  if (viewing) {
    viewing = ''; // show the run that just started
    follow();
  }
  loadSandboxes();
  loadRuns();
});

$('cancel-btn').addEventListener('click', () => {
  fetch('/api/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sandbox: selected === CUSTOM ? '' : selected }),
  });
  $('cancel-btn').disabled = true;
});

$('problems-only').addEventListener('change', queueRender);

// Clear output: empty the results window before the next run. The stream stays open, so
// the next run of this sandbox shows up here; saved runs stay in the Run list.
// The latest run at the time of clearing is skipped if the server replays it (when
// switching back from an earlier run, or after a reconnect); a new run shows normally.
let cleared = false;
let skipRunId = null;
let skipping = false;
$('clear-btn').addEventListener('click', async () => {
  if (state?.running) return;
  const { runs } = await (await fetch(`/api/runs?sandbox=${encodeURIComponent(sandboxParam())}`)).json();
  skipRunId = runs[0]?.id || null;
  state = null;
  cleared = true;
  if (viewing) {
    viewing = ''; // back to following the latest run
    $('run-picker').value = '';
    follow();
  }
  queueRender();
});
$('show-raw').addEventListener('change', queueRender);

// ---------- output parsing ----------

function newState(event) {
  return {
    steps: [newStep('Start')],
    summary: false,
    counts: { pass: 0, warn: 0, fail: 0 },
    raw: [],
    running: true,
    startedAt: event.startedAt,
    endedAt: null,
    exit: null,
    meta: '',
    logPath: '',
    command: event.args.join(' '),
  };
}

function newStep(title) {
  return { title, checks: [], details: [], exchanges: [] };
}

function currentStep() {
  return state.steps[state.steps.length - 1];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

function handleLine(rawText, stream) {
  const text = rawText.replace(ANSI, '');
  let m;
  if ((m = text.match(/^\s*\[exchange\] (\{.*\})\s*$/))) {
    // One model request and its response; shown as a table, not as raw text.
    try {
      currentStep().exchanges.push(JSON.parse(m[1]));
      state.raw.push(text);
      return;
    } catch { /* fall through and show it as text */ }
  }
  state.raw.push(text);
  if ((m = text.match(/^AI Gateway (?:cache doctor|Doctor)\s+(.*)$/))) {
    state.meta = m[1];
  } else if ((m = text.match(/^\s*Full log: (.+)$/))) {
    state.logPath = m[1].trim();
  } else if ((m = text.match(/^== (.+) ==$/))) {
    state.summary = m[1] === 'Summary';
    if (!state.summary) state.steps.push(newStep(m[1]));
  } else if (state.summary) {
    // The verbose summary repeats every check; the cards already show them.
  } else if ((m = text.match(/^ {3}(PASS|WARN|FAIL|SKIP) (.+)$/))) {
    const status = m[1].toLowerCase();
    currentStep().checks.push({ status, message: m[2] });
    if (status in state.counts) state.counts[status] += 1;
  } else if (/^Result:/.test(text) || /^\s*$/.test(text)) {
    // The counts come from the checks themselves.
  } else {
    currentStep().details.push({ text: text.replace(/^ {3}/, ''), stream });
  }
}

function handleEvent(event) {
  switch (event.type) {
    case 'idle':
      state = null;
      break;
    case 'start':
      skipping = Boolean(skipRunId) && event.id === skipRunId;
      if (skipping) {
        state = null;
        break;
      }
      cleared = false;
      skipRunId = null;
      state = newState(event);
      break;
    case 'line':
      if (state && !skipping) handleLine(event.text, event.stream);
      break;
    case 'exit':
      if (!state || skipping) return;
      state.running = false;
      state.endedAt = event.endedAt;
      state.exit = event;
      if (!viewing) {
        loadSandboxes();
        loadRuns();
      }
      break;
    case 'end':
      // An earlier run was replayed in full; stop the browser from reconnecting.
      source.close();
      if (state?.running) state.running = false; // the server stopped during that run
      break;
  }
  queueRender();
}

// follow: the selected sandbox's run stream. For the latest run the server replays it and
// keeps the stream open for later runs; an earlier run is replayed from disk and ends.
function follow() {
  if (source) source.close();
  state = null;
  queueRender();
  const q = new URLSearchParams();
  if (sandboxParam()) q.set('sandbox', sandboxParam());
  if (viewing) q.set('run', viewing);
  source = new EventSource(`/api/stream?${q}`);
  source.onmessage = (e) => handleEvent(JSON.parse(e.data));
}

// ---------- rendering (right) ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function worst(checks) {
  return checks.reduce((acc, c) => (RANK[c.status] > RANK[acc] ? c.status : acc), checks.length ? 'skip' : 'info');
}

// The doctor echoes commands and remote scripts on stderr, so classify by content
// first and treat only the remaining stderr lines as errors.
function detailLine(d) {
  let cls = 'out';
  if (/^\[fix\]/.test(d.text)) cls = 'cmd fix';
  else if (/^\[check\]/.test(d.text)) cls = 'cmd';
  else if (/^\s*\|/.test(d.text)) cls = 'script';
  else if (d.stream === 'err') cls = 'err';
  return el('span', { class: cls }, d.text + '\n');
}

function exchangeRow(x) {
  const ok = x.code === 200;
  const xc = x.xcache === '-' ? '' : x.xcache;
  return el('div', { class: `exchange ${ok ? '' : 'bad'}` },
    el('div', { class: 'ex-head' },
      el('span', { class: 'ex-model' }, x.model),
      el('span', { class: 'chip' }, x.path.replace('/v1/', '')),
      x.cache !== 'none' && el('span', { class: 'chip' }, `${x.cache} cache`),
      xc && el('span', { class: `pill ${xc === 'HIT' ? 'pass' : 'skip'}` }, xc),
      el('span', { class: `pill ${ok ? 'pass' : 'fail'}` }, `HTTP ${x.code}`),
      el('span', { class: 'ex-time' }, `${x.secs}s`)),
    el('div', { class: 'ex-body' },
      el('div', { class: 'ex-q' }, el('span', { class: 'ex-label' }, 'Q'), el('span', {}, String(x.request ?? ''))),
      el('div', { class: 'ex-a' }, el('span', { class: 'ex-label' }, 'A'), el('span', {}, String(x.response ?? '')))));
}

function renderStep(step, isLast) {
  const onlyProblems = $('problems-only').checked;
  const checks = onlyProblems ? step.checks.filter((c) => c.status === 'fail' || c.status === 'warn') : step.checks;
  if (onlyProblems && !checks.length) return null;
  if (step.title === 'Start' && !step.checks.length && !step.details.length) return null;

  const active = isLast && state.running;
  const status = active ? 'running' : worst(step.checks);
  const card = el('article', { class: `step ${status}` },
    el('header', {},
      el('span', { class: `badge ${status}` }, active ? 'running' : status === 'info' ? 'info' : status.toUpperCase()),
      el('h3', {}, step.title)));

  if (checks.length) {
    card.append(el('ul', { class: 'checks' }, checks.map((c) =>
      el('li', { class: c.status }, el('span', { class: `pill ${c.status}` }, c.status.toUpperCase()), el('span', {}, c.message)))));
  }
  if (step.exchanges.length && !onlyProblems) {
    card.append(el('details', { open: '' },
      el('summary', {}, `Model requests and responses (${step.exchanges.length})`),
      el('div', { class: 'exchanges' }, step.exchanges.map(exchangeRow))));
  }
  if (step.details.length && !onlyProblems) {
    const hasFix = step.details.some((d) => /^\[fix\]/.test(d.text));
    card.append(el('details', hasFix ? { open: '' } : {},
      el('summary', {}, `${hasFix ? 'Fix commands and output' : 'Commands and output'} (${step.details.length} lines)`),
      el('pre', {}, step.details.map(detailLine))));
  }
  return card;
}

function elapsed() {
  const end = state.endedAt || Date.now();
  const s = Math.round((end - state.startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function render() {
  renderQueued = false;
  const running = Boolean(state?.running);
  $('run-btn').disabled = running && !viewing;
  $('cancel-btn').hidden = !running;
  if (!running) $('cancel-btn').disabled = false;

  const counts = state?.counts || { pass: 0, warn: 0, fail: 0 };
  $('count-pass').textContent = `${counts.pass} passed`;
  $('count-warn').textContent = `${counts.warn} warning${counts.warn === 1 ? '' : 's'}`;
  $('count-fail').textContent = `${counts.fail} failed`;
  // Counts take their status color only when non-zero, and hide until there is a run.
  $('count-pass').className = `pill ${counts.pass ? 'pass' : 'skip'}`;
  $('count-warn').className = `pill ${counts.warn ? 'warn' : 'skip'}`;
  $('count-fail').className = `pill ${counts.fail ? 'fail' : 'skip'}`;
  document.querySelector('#status-bar .counts').hidden = !state;

  let status = cleared ? 'Output cleared' : 'No run yet for this sandbox';
  let cls = '';
  if (state) {
    if (running) status = `Running… ${elapsed()}`;
    else if (state.exit?.signal) status = `Cancelled after ${elapsed()}`;
    else status = `${counts.fail ? 'Finished with failures' : 'Finished'} in ${elapsed()} · ${ago(state.endedAt)}`;
    cls = running ? 'running' : counts.fail ? 'fail' : counts.warn ? 'warn' : 'pass';
  }
  $('status-text').textContent = status;
  $('status-text').className = cls;
  $('command').textContent = state?.command ? `$ ${state.command}` : '';
  $('log-path').hidden = !state?.logPath;
  $('log-path').replaceChildren(state?.logPath ? el('span', {}, 'Full log: ', el('code', {}, state.logPath)) : '');

  const raw = $('show-raw').checked;
  $('raw').hidden = !raw || !state;
  $('steps').hidden = raw && Boolean(state);
  $('clear-btn').disabled = running || !state;
  if (!state) {
    $('steps').replaceChildren(el('p', { class: 'empty' }, cleared
      ? 'Output cleared. Press Run check; the new run streams in here (earlier runs are in the Run list).'
      : 'Press Run to check this sandbox. Results stream in here.'));
    return;
  }
  if (raw) {
    $('raw').textContent = state.raw.join('\n');
    return;
  }
  const cards = state.steps.map((s, i) => renderStep(s, i === state.steps.length - 1)).filter(Boolean);
  $('steps').replaceChildren(...cards);
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

// Keep the elapsed time and the sandbox list fresh.
setInterval(() => {
  if (state?.running) queueRender();
}, 1000);
setInterval(loadSandboxes, 10000);

loadSandboxes().then(() => {
  select(selected);
  // ?tab=config opens the Config tab, so it can be bookmarked.
  // ?tab=config or ?tab=playground opens that tab, so it can be bookmarked.
  const t = new URLSearchParams(location.search).get('tab');
  document.querySelector(`.tab[data-tab="${t}"]`)?.click();
});


// ---------- terminals (Terminals tab) ----------

// xterm.js, the browser terminal, is loaded from a CDN the first time the tab opens.
const XTERM = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0';
const XTERM_FIT = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0';
let xtermLoading = null;

function loadXterm() {
  if (window.Terminal) return Promise.resolve();
  xtermLoading ||= new Promise((resolve, reject) => {
    document.head.append(el('link', { rel: 'stylesheet', href: `${XTERM}/css/xterm.min.css` }));
    const lib = el('script', { src: `${XTERM}/lib/xterm.min.js` });
    lib.onload = () => {
      const fit = el('script', { src: `${XTERM_FIT}/lib/addon-fit.min.js` });
      fit.onload = resolve;
      fit.onerror = () => reject(new Error('could not load the xterm fit add-on'));
      document.head.append(fit);
    };
    lib.onerror = () => reject(new Error('could not load xterm.js (no internet?)'));
    document.head.append(lib);
  });
  return xtermLoading;
}

const terms = new Map(); // id -> { term, fit, source, pane, title, done }
let activeTerm = null;
let termsRestored = false;

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function showTerminals() {
  try {
    await loadXterm();
  } catch (err) {
    $('term-msg').textContent = err.message;
    return;
  }
  if (!termsRestored) {
    // Reattach to terminals that are still open on the server (e.g. after a reload).
    termsRestored = true;
    const { terminals } = await (await fetch('/api/terminals')).json();
    for (const t of terminals) attachTerm(t.id, t.title);
  }
  fitActive();
}

function renderTermTabs() {
  $('term-tabs').replaceChildren(...[...terms.entries()].map(([id, t]) => {
    const close = el('button', { type: 'button', class: 'term-close', title: 'Close this session' }, '×');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTerm(id);
    });
    const tab = el('div', { class: `term-tab ${id === activeTerm ? 'active' : ''} ${t.done ? 'done' : ''}`, role: 'button', tabindex: '0' },
      el('span', { class: `dot ${t.done ? 'skip' : 'pass'}` }), el('span', { class: 'term-title' }, t.title), close);
    tab.addEventListener('click', () => activate(id));
    return tab;
  }));
  if (!terms.size) $('term-host').replaceChildren(el('p', { class: 'empty' }, "Open a shell on the sandbox's AI Gateway or Couchbase node."));
}

function activate(id) {
  activeTerm = id;
  for (const [tid, t] of terms) t.pane.hidden = tid !== id;
  renderTermTabs();
  fitActive();
  terms.get(id)?.term.focus();
}

function fitActive() {
  const t = terms.get(activeTerm);
  if (t && !t.pane.hidden) requestAnimationFrame(() => t.fit.fit());
}

function attachTerm(id, title) {
  if (terms.has(id)) return activate(id);
  if (!terms.size) $('term-host').replaceChildren();
  const pane = el('div', { class: 'term-pane' });
  $('term-host').append(pane);
  const term = new window.Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#000000', foreground: '#EDEDED', cursor: '#FC9C0C', selectionBackground: '#97000F' },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  const t = { term, fit, pane, title, done: false, source: null };
  terms.set(id, t);

  // Keystrokes are batched briefly and sent in order.
  let pending = '';
  let sending = Promise.resolve();
  let timer = null;
  term.onData((data) => {
    pending += data;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const chunk = pending;
      pending = '';
      sending = sending.then(() => post('/api/terminals/input', { id, data: chunk })).catch(() => {});
    }, 12);
  });
  term.onResize(({ rows, cols }) => post('/api/terminals/resize', { id, rows, cols }));

  t.source = new EventSource(`/api/terminals/stream?id=${encodeURIComponent(id)}`);
  t.source.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === 'data') term.write(Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0)));
    if (event.type === 'exit') {
      term.write(`\r\n\x1b[33m[session ended${event.code ? `, exit ${event.code}` : ''}]\x1b[0m\r\n`);
      t.done = true;
      t.source.close();
      renderTermTabs();
    }
  };
  activate(id);
}

async function openTerm(node) {
  $('term-msg').textContent = 'connecting…';
  try {
    await loadXterm();
  } catch (err) {
    $('term-msg').textContent = err.message;
    return;
  }
  const run = formBody();
  const resp = await post('/api/terminals', {
    sandbox: run.sandbox, config: run.config, region: run.region, aigwInstance: run.aigwInstance, cbInstance: run.cbInstance,
    node, rows: 30, cols: 120,
  });
  const data = await resp.json();
  if (!resp.ok) {
    $('term-msg').textContent = data.error;
    return;
  }
  $('term-msg').textContent = '';
  attachTerm(data.id, data.title);
  // Size the remote terminal to the pane now that it is laid out.
  const t = terms.get(data.id);
  requestAnimationFrame(() => {
    t.fit.fit();
    post('/api/terminals/resize', { id: data.id, rows: t.term.rows, cols: t.term.cols });
  });
}

function closeTerm(id) {
  const t = terms.get(id);
  if (!t) return;
  post('/api/terminals/close', { id });
  t.source?.close();
  t.term.dispose();
  t.pane.remove();
  terms.delete(id);
  if (activeTerm === id) {
    const next = [...terms.keys()].pop();
    if (next) activate(next);
    else activeTerm = null;
  }
  renderTermTabs();
}

$('term-aigw').addEventListener('click', () => openTerm('aigw'));
$('term-cb').addEventListener('click', () => openTerm('cb'));
window.addEventListener('resize', fitActive);
