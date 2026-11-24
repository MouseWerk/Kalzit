// The local CI as a page: the latest run (or ?run=<id>) as a workflow graph like GitHub's,
// prepare step, the Windows and Linux legs with every job as a card (status, time), the
// statuses at the end, and the earlier runs. It reads the run folders tools/local-ci writes
// (KALZIT_CI_HOME/logs) on every request and reloads itself every 3 seconds; it changes
// nothing.
//
//   node tools/local-ci/status.mjs [port]     (default 39301, on 127.0.0.1 only)

import { createServer } from 'node:http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CI_HOME = process.env.KALZIT_CI_HOME ?? 'C:/Users/klein/kz-ci'
const LOGS = join(CI_HOME, 'logs')
const PORT = Number(process.argv[2] ?? 39301)

// The jobs of each leg in the order they run, with the areas that switch them on (the `job`
// lines of linux.sh and windows.sh).
const JOBS = {
  windows: [
    ['server', ['server']], ['ui', ['ui']], ['sdk', ['sdk']], ['devkit', ['devkit']],
    ['devgen', ['devgen', 'server', 'ui']], ['plugins', ['server']], ['e2e', ['e2e']], ['msi', ['msi-requested']],
  ],
  linux: [
    ['changes', ['always']], ['server', ['server']], ['ui', ['ui']], ['sdk', ['sdk']], ['roadmap', ['roadmap']],
    ['devkit', ['devkit']], ['devgen', ['devgen', 'server', 'ui']], ['plugins', ['server']], ['audit', ['audit']],
    ['update-rights', ['server']], ['postgres', ['server']], ['ldap', ['server']], ['datasources', ['server']],
    ['datasources-sql-kv', ['server']], ['datasources-more', ['server']], ['acme', ['server']], ['e2e', ['e2e']],
    ['packages', ['docker']], ['docker', ['docker']], ['devgen-proof', ['devgen_proof']],
  ],
}
// The jobs of the fast gate (stage.txt `gate`); the rest belongs to the full suite.
const GATE_JOBS = new Set(['changes', 'ui', 'server', 'sdk', 'roadmap', 'devkit', 'devgen', 'e2e'])

const read = path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

function runIds() {
  if (!existsSync(LOGS)) return []
  return readdirSync(LOGS)
    .filter(name => /^\d{8}-\d{6}-/.test(name) && statSync(join(LOGS, name)).isDirectory())
    .sort()
    .reverse()
}

function label(id) {
  // pr391-<sha> for one pull request, pr391+388+386-<sha> for a batch (run.sh PR PR...).
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}-(?:pr([\d+]+)|ref)-([0-9a-f]+)$/.exec(id)
  if (!m) return { title: id, when: '' }
  const prs = m[6] ? m[6].split('+') : []
  const title = prs.length > 1 ? `Batch ${prs.map(n => `#${n}`).join(' + ')}` : prs.length ? `PR #${prs[0]}` : 'Commit'
  return { title, sha: m[7], when: `${m[3]}.${m[2]}. ${m[4]}:${m[5]}`, pr: m[6] }
}

// Progress lines are stamped in UTC by common.sh.
function minutesSince(hms) {
  const [h, m, s] = hms.split(':').map(Number)
  const now = new Date()
  const start = new Date(now)
  start.setUTCHours(h, m, s, 0)
  let ms = now - start
  if (ms < 0) ms += 86400000
  return Math.floor(ms / 60000)
}

function parseLeg(leg, out, result, areas, active, gate) {
  const seen = new Map()
  const re = new RegExp(`^\\[(\\d\\d:\\d\\d:\\d\\d)\\] ${leg}: (\\S+) (started|passed in (\\d+) min|FAILED in (\\d+) min)`)
  for (const line of (out ?? '').split(/\r?\n/)) {
    const m = re.exec(line)
    if (!m) continue
    const [, at, name, what, passed, failed] = m
    if (what === 'started') seen.set(name, { name, state: 'running', time: `${minutesSince(at)} min` })
    else if (passed !== undefined) seen.set(name, { name, state: 'passed', time: `${passed} min` })
    else seen.set(name, { name, state: 'failed', time: `${failed} min`, log: `${leg}-${name}.log` })
  }
  const done = result !== undefined
  const jobs = JOBS[leg].map(([name, wants]) => {
    if (seen.has(name)) return seen.get(name)
    const wanted = (!gate || GATE_JOBS.has(name)) && wants.some(a => a === 'always' || areas.has(a))
    return { name, state: wanted && !done && active ? 'queued' : 'skipped' }
  })
  let state
  if (done) state = result.startsWith('success') ? 'passed' : 'failed'
  else if (!active) state = 'stopped'
  else state = seen.size > 0 ? 'running' : 'queued'
  return { leg, state, jobs }
}

function loadRun(id, newest) {
  const dir = join(LOGS, id)
  const areas = new Set((read(join(dir, 'areas.txt')) ?? '').split(/\r?\n/).filter(l => l.endsWith('=true')).map(l => l.slice(0, -5)))
  const winOut = read(join(dir, 'windows.out'))
  if (winOut?.includes('windows: msi started')) areas.add('msi-requested')
  const active = newest && existsSync(join(CI_HOME, 'run.lock'))
  const gate = (read(join(dir, 'stage.txt')) ?? '').trim() === 'gate'
  const legs = ['windows', 'linux'].map(leg =>
    parseLeg(leg, leg === 'windows' ? winOut : read(join(dir, 'linux.out')), read(join(dir, `${leg}.result`)), areas, active, gate))
  const states = legs.map(l => l.state)
  const state = states.includes('failed') ? 'failed' : states.includes('stopped') ? 'stopped'
    : states.every(s => s === 'passed') ? 'passed' : 'running'
  areas.delete('msi-requested')
  return { id, dir, ...label(id), stage: gate ? 'fast gate' : 'full suite', areas: [...areas], legs, state }
}

const ICON = { passed: '✓', failed: '✕', running: '', queued: '', skipped: '–', stopped: '!' }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function card(job) {
  return `<div class="job ${job.state}"><span class="dot">${ICON[job.state]}</span><span class="name">${esc(job.name)}</span><span class="time">${esc(job.time ?? (job.state === 'queued' ? 'queued' : ''))}</span></div>`
}

function lane(leg) {
  const shown = leg.jobs.filter(j => j.state !== 'skipped')
  const skipped = leg.jobs.filter(j => j.state === 'skipped')
  const title = leg.leg === 'windows' ? 'Windows' : 'Linux (WSL)'
  return `<section class="lane">
    <header><span class="dot ${leg.state}">${ICON[leg.state] ?? ''}</span>${title}<span class="sub">${leg.state}</span></header>
    <div class="chain">${shown.map(card).join('<div class="link"></div>')}</div>
    ${skipped.length ? `<p class="skipped">Skipped: ${skipped.map(j => esc(j.name)).join(', ')}</p>` : ''}
    ${leg.jobs.filter(j => j.log).map(j => `<p class="log">Log: <code>${esc(j.log)}</code></p>`).join('')}
  </section>`
}

function page(run, ids) {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="3"><title>Local CI</title><style>
:root{--bg:#f6f8fa;--card:#fff;--text:#1f2328;--muted:#656d76;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--run:#9a6700;--soft:#eaeef2}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--text:#e6edf3;--muted:#8d96a0;--line:#30363d;--ok:#3fb950;--bad:#f85149;--run:#d29922;--soft:#21262d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px 16px}
h1{font-size:18px;margin:0}.top{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px}.muted{color:var(--muted)}
.badge{font-weight:600;padding:2px 10px;border-radius:999px;font-size:12px;background:var(--soft)}.badge.passed{color:var(--ok)}.badge.failed,.badge.stopped{color:var(--bad)}.badge.running{color:var(--run)}
.graph{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:20px;margin:14px 0;overflow-x:auto}
.flow{display:flex;align-items:flex-start;gap:0;min-width:min-content}
.node{border:1px solid var(--line);border-radius:6px;padding:8px 12px;background:var(--card);white-space:nowrap;align-self:center}
.fork{width:28px;align-self:stretch;position:relative}.fork:before{content:"";position:absolute;left:0;right:0;top:50%;border-top:1px solid var(--line)}
.lanes{display:flex;flex-direction:column;gap:16px;border-left:1px solid var(--line);padding-left:20px}
.lane header{font-weight:600;display:flex;gap:8px;align-items:center;margin-bottom:8px}.sub{color:var(--muted);font-weight:400;font-size:12px}
.chain{display:flex;flex-wrap:wrap;align-items:center;row-gap:8px}
.link{width:18px;border-top:1px solid var(--line)}
.job{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:6px;padding:6px 10px;background:var(--card);min-width:150px}
.job .name{flex:1}.job .time{color:var(--muted);font-size:12px}
.dot{width:16px;height:16px;border-radius:50%;display:inline-grid;place-items:center;font-size:10px;color:#fff;flex:none;background:var(--muted)}
.passed .dot,.dot.passed{background:var(--ok)}.failed .dot,.dot.failed,.dot.stopped{background:var(--bad)}
.running .dot,.dot.running{background:transparent;border:2px solid var(--run);border-right-color:transparent;animation:spin 1s linear infinite}
.queued .dot,.dot.queued{background:transparent;border:2px solid var(--line)}
.job.failed{border-color:var(--bad)}
@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.dot{animation:none!important}}
.skipped,.log{color:var(--muted);font-size:12px;margin:6px 0 0}code{font-size:12px}
.runs{background:var(--card);border:1px solid var(--line);border-radius:8px}.runs a{display:flex;gap:10px;padding:8px 12px;border-top:1px solid var(--line);color:inherit;text-decoration:none}.runs a:first-child{border-top:0}.runs a:hover{background:var(--soft)}
.runs .cur{font-weight:600}h2{font-size:14px;margin:18px 0 8px}
</style></head><body>`
  if (!run) return `${head}<h1>Local CI</h1><p class="muted">No run yet. <code>tools/local-ci/run.sh &lt;pr&gt;</code> starts one.</p></body></html>`
  const stateText = { passed: 'Passed', failed: 'Failed', running: 'Running', stopped: 'Stopped without a result' }[run.state]
  const runs = ids.slice(0, 12).map((id, i) => {
    const r = loadRun(id, i === 0)
    return `<a href="/?run=${encodeURIComponent(id)}" class="${id === run.id ? 'cur' : ''}"><span class="dot ${r.state}">${ICON[r.state] ?? ''}</span><span>${esc(r.title)} ${esc(r.sha ?? '')}</span><span class="muted">${esc(r.when)}</span></a>`
  }).join('')
  return `${head}
<div class="top"><h1>${esc(run.title)} <span class="muted">${esc(run.sha ?? '')} · ${esc(run.stage)}</span></h1><span class="badge ${run.state}">${stateText}</span><span class="muted">${esc(run.when)}</span></div>
<div class="muted">Areas: ${run.areas.length ? run.areas.map(esc).join(' · ') : 'none'}</div>
<div class="graph"><div class="flow">
  <div class="node">Merge onto main<br><span class="muted">detect areas</span></div><div class="fork"></div>
  <div class="lanes">${run.legs.map(lane).join('')}</div><div class="fork"></div>
  <div class="node"><span class="dot ${run.state}">${ICON[run.state] ?? ''}</span> Statuses<br><span class="muted">local/windows · local/linux</span></div>
</div></div>
<div class="muted">Logs: <code>${esc(run.dir)}</code></div>
<h2>Runs</h2><div class="runs">${runs}</div>
</body></html>`
}

createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const ids = runIds()
    const want = url.searchParams.get('run')
    const id = want && ids.includes(want) ? want : ids[0]
    const run = id ? loadRun(id, id === ids[0]) : null
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(page(run, ids))
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(error))
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Local CI status on http://127.0.0.1:${PORT}/`))
