// Scheduled Line Report emails.
// To build reports on its own, the server keeps a copy of the team key, locked with DASHBOARD_SECRET.
// An admin turns this on (or off) in Data & Settings. Emails are sent through Resend.
import crypto from 'node:crypto';
process.env.TZ = 'America/Chicago';   // report dates and times in Central time
import { handle, json, body, httpError, requireUser, getJSON, putJSON, store } from './_lib.js';
import { makeEngine } from './_engine.js';
import { buildEmail } from './_mail.js';

const SETTINGS = 'reports/settings.json';
const KEYFILE = 'reports/key.json';
const STATUS = 'reports/status.json';
const HISTORY = 'reports/history.json';   // 2.27: daily numbers for the Trends tab, sealed with the team key
const HISTORY_KEEP = 800;                 // about 3 years of weekdays
const TREND_WEEKS = 4;                    // trailers due in the next 4 weeks + overdue, the same as Overview
const DEFAULTS = {
  enabled: false, recipients: [], testTo: '', lines: [],
  daily: { on: true, weeks: 4, urgentOnly: true }, weekly: { on: true, day: 1, weeks: 8 },
  leadWeeks: 8, arrivalBuffer: 2, excluded: ['0003', '0019', '0041', '0045', 'FAST', '0069'], dateMode: 'schedule',
  pdf: true, site: '', onlyIfNew: false,
};
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const okEmail = (e) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i.test(e);

function lockKey() {
  const s = process.env.DASHBOARD_SECRET;
  if (!s || s.length < 16) throw httpError(500, 'DASHBOARD_SECRET is not set in Vercel.');
  return crypto.createHash('sha256').update(s + ':scheduled-reports').digest();
}
function lock(raw) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', lockKey(), iv);
  const ct = Buffer.concat([c.update(raw), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function unlock(b64) {
  const b = Buffer.from(b64, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', lockKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}
// files are sealed in the browser with AES-GCM (WebCrypto puts the 16-byte tag at the end)
function openFile(teamKey, ivB64, buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', teamKey, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
}
// sealed the way the browser does it (tcSealText): base64 of 12-byte IV + ciphertext + 16-byte tag
function sealJSON(teamKey, obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', teamKey, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}
function openJSON(teamKey, b64) {
  const b = Buffer.from(b64, 'base64');
  return JSON.parse(openFile(teamKey, b.subarray(0, 12).toString('base64'), b.subarray(12)).toString('utf8'));
}
async function readTeamFile(teamKey, e, kind) {
  const parts = [];
  for (let i = 0; i < e.chunks; i++) {
    const r = await store().get(`data/${kind}/${e.id}/${i}.bin`, false);
    if (!r) throw new Error(`The published ${kind === 'mrp' ? 'MRP' : 'schedule'} is missing a piece. Publish it again.`);
    parts.push(r.buf);
  }
  return openFile(teamKey, e.iv, Buffer.concat(parts));
}

async function loadSettings() { const { data } = await getJSON(SETTINGS, true); return { ...DEFAULTS, ...(data || {}), daily: { ...DEFAULTS.daily, ...(data?.daily || {}) }, weekly: { ...DEFAULTS.weekly, ...(data?.weekly || {}) } }; }
function cleanSettings(s) {
  const n = (v, lo, hi, d) => { v = Math.round(Number(v)); return Number.isFinite(v) && v >= lo && v <= hi ? v : d; };
  const list = (a) => [...new Set((Array.isArray(a) ? a : String(a || '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  const rec = list(s.recipients);
  const bad = rec.filter((e) => !okEmail(e)); if (bad.length) throw httpError(400, 'These email addresses look wrong: ' + bad.join(', '));
  if (rec.length > 50) throw httpError(400, 'Up to 50 email addresses.');
  if (s.testTo && !okEmail(String(s.testTo).trim())) throw httpError(400, 'Your test email address looks wrong.');
  return {
    enabled: !!s.enabled, recipients: rec, testTo: String(s.testTo || '').trim().toLowerCase(),
    lines: (Array.isArray(s.lines) ? s.lines : []).map(String).slice(0, 30),
    daily: { on: !!s.daily?.on, weeks: n(s.daily?.weeks, 1, 26, 4), urgentOnly: s.daily?.urgentOnly !== false },
    weekly: { on: !!s.weekly?.on, day: n(s.weekly?.day, 1, 5, 1), weeks: n(s.weekly?.weeks, 0, 26, 8) },
    leadWeeks: n(s.leadWeeks, 1, 52, 8), arrivalBuffer: n(s.arrivalBuffer, 0, 26, 2),
    excluded: (Array.isArray(s.excluded) ? s.excluded : DEFAULTS.excluded).map(String).slice(0, 100),
    dateMode: s.dateMode === 'sage' ? 'sage' : 'schedule', pdf: s.pdf !== false,
    site: /^https:\/\/[^\s"<>]+$/.test(String(s.site || '')) ? String(s.site) : '', onlyIfNew: !!s.onlyIfNew,
  };
}
function centralNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

// Open the published team files and run the dashboard's numbers on them (done once per run)
async function loadTeam(s, today) {
  const { data: k } = await getJSON(KEYFILE, true);
  if (!k || !k.locked) throw new Error('Scheduled emails are not turned on yet: an admin needs to select “Turn on” in Data & Settings.');
  const teamKey = unlock(k.locked);
  const { data: m } = await getJSON('data/manifest.json', true);
  if (!m || !m.mrp || !m.sched) throw new Error('Publish both an MRP and a schedule to the team first.');
  const [mrpBuf, schedBuf] = await Promise.all([readTeamFile(teamKey, m.mrp, 'mrp'), readTeamFile(teamKey, m.sched, 'sched')]);
  const eng = makeEngine(today, s);
  await eng.load(mrpBuf, m.mrp.name, schedBuf, m.sched.name);
  return { eng, m, teamKey, today };
}

// 2.27: save today's numbers (one entry per Central date; a second run the same day replaces it)
async function recordHistory(t, s) {
  if (!t.eng.eval("typeof trendSnapshot==='function'")) throw new Error('index.html is older than 2.27; deploy the latest index.html.');
  const snap = JSON.parse(t.eng.eval(`JSON.stringify(trendSnapshot(${TREND_WEEKS}))`));
  const pub = (e) => ({ id: e.id, name: e.name, publishedAt: e.publishedAt || 0, by: e.byName || e.by || '' });
  const entry = { date: t.today, at: Date.now(), mrp: pub(t.m.mrp), sched: pub(t.m.sched), ...snap };
  const { data: w } = await getJSON(HISTORY, true);
  let days = [];
  if (w && w.enc) { try { days = openJSON(t.teamKey, w.enc).days || []; } catch (e) { console.warn('history could not be opened; starting a new one', e); } }
  days = days.filter((d) => d.date !== entry.date);
  days.push(entry); days.sort((a, b) => a.date.localeCompare(b.date));
  days = days.slice(-HISTORY_KEEP);
  await putJSON(HISTORY, { enc: sealJSON(t.teamKey, { v: 1, days }), at: Date.now(), n: days.length, last: entry.date, lastRun: { at: Date.now(), ok: true, date: entry.date } });
  return entry;
}
async function historyFailed(err) {
  try { const { data: w } = await getJSON(HISTORY, true); await putJSON(HISTORY, { ...(w || {}), lastRun: { at: Date.now(), ok: false, error: String(err && err.message || err) } }); } catch (e) { console.warn('history status not saved', e); }
}

// Build one report. Returns {subject, html, pdf, info}
export async function buildReport(kind, s, opts = {}) {
  const t = opts.loaded || await loadTeam(s, opts.today || centralNow().iso);
  const { eng, m, today } = t;
  let lines = eng.lines();
  lines = s.lines && s.lines.length ? lines.filter((l) => s.lines.includes(l)) : lines.filter((l) => /^Line\s+\d+$/i.test(l));
  if (!lines.length) throw new Error('None of the chosen lines are on the schedule.');
  const weeks = kind === 'weekly' ? s.weekly.weeks : s.daily.weeks;
  const st = eng.stats(lines, weeks);
  const ageDays = (t) => Math.floor((Date.now() - t) / 86400000);
  const stale = [m.mrp.publishedAt && ageDays(m.mrp.publishedAt) >= 3 ? `The MRP was published ${ageDays(m.mrp.publishedAt)} days ago` : '',
    m.sched.publishedAt && ageDays(m.sched.publishedAt) >= 3 ? `the schedule ${ageDays(m.sched.publishedAt)} days ago` : ''].filter(Boolean).join('; ');
  let pdf = null, pdfError = '';
  if (s.pdf && !opts.noPdf) {
    try {
      const { htmlToPdf } = await import('./_pdf.js');
      const sec = kind === 'weekly' ? { summary: true, risk: true, parts: true, good: true, partsCap: 50, topCap: 25 } : { summary: true, risk: true, parts: true, good: false, partsCap: 25, topCap: 15 };
      pdf = await htmlToPdf(eng.reportHtml(lines, weeks, sec));
    } catch (e) { console.error('PDF failed', e); pdfError = String(e.message || e); }
  }
  const pub = (e) => `${e.name} (published ${new Date(e.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })})`;
  const info = { kind, weeks, urgentOnly: kind === 'daily' && s.daily.urgentOnly, mrp: pub(m.mrp), sched: pub(m.sched), site: s.site,
    stale: stale ? stale.charAt(0).toUpperCase() + stale.slice(1) + '. The numbers below may be out of date.' : '', pdf: !!pdf, pdfError,
    settingsLine: `Steel lead ${s.leadWeeks} wk · arrive ${s.arrivalBuffer} wk early · shortages dated by ${s.dateMode === 'schedule' ? 'the schedule' : 'Sage'} · excluded lines: ${s.excluded.join(', ') || 'none'}.` };
  const { html, subject } = buildEmail(st, info);
  return { html, subject, pdf, pdfError, today, manifest: m, lines };
}

async function sendEmail(to, rep, kind) {
  const keyR = process.env.RESEND_API_KEY;
  if (!keyR) throw new Error('RESEND_API_KEY is not set in Vercel (Settings → Environment Variables).');
  const from = process.env.REPORT_FROM || 'MRP Dashboard <onboarding@resend.dev>';
  const payload = { from, to, subject: rep.subject, html: rep.html };
  if (rep.pdf) payload.attachments = [{ filename: `${kind === 'weekly' ? 'Weekly' : 'Daily'}_Line_Report_${rep.today}.pdf`, content: rep.pdf.toString('base64') }];
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + keyR, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Resend: ' + (out.message || out.error || r.status) + (/resend\.dev/.test(from) ? ' (Until your domain is set up in Resend, emails can only go to the address you signed up to Resend with.)' : ''));
  return out.id;
}
async function saveStatus(st) { try { await putJSON(STATUS, st); } catch (e) { console.warn('status not saved', e); } }

export const GET = handle(async (request, url) => {
  const op = url.searchParams.get('op');
  if (op === 'cron') {   // Vercel calls this on the schedule in vercel.json
    const want = process.env.CRON_SECRET;
    if (!want || (request.headers.get('authorization') || '') !== 'Bearer ' + want) throw httpError(401, 'Not allowed');
    const s = await loadSettings();
    const now = centralNow();
    if (now.dow === 0 || now.dow === 6) return json({ skipped: 'weekend' });
    // 2.27: record today's numbers for the Trends tab first. It only needs the server's key, not emails turned on,
    // and a failure here never stops the email.
    let loaded = null, history = 'no key';
    const { data: k } = await getJSON(KEYFILE, true);
    if (k && k.locked) {
      try { loaded = await loadTeam(s, now.iso); await recordHistory(loaded, s); history = 'recorded'; }
      catch (e) { console.error('trend history failed', e); history = 'failed: ' + (e.message || e); await historyFailed(e); }
    }
    if (!s.enabled) return json({ skipped: 'emails turned off', history });
    const kind = s.weekly.on && now.dow === s.weekly.day ? 'weekly' : s.daily.on ? 'daily' : null;
    if (!kind) return json({ skipped: 'nothing scheduled today', history });
    if (!s.recipients.length) return json({ skipped: 'no recipients', history });
    const { data: last } = await getJSON(STATUS, true);
    if (last && last.date === now.iso && last.ok && !url.searchParams.get('force')) return json({ skipped: 'already sent today', history });
    try {
      if (s.onlyIfNew && last && last.ok) {
        const { data: m } = await getJSON('data/manifest.json', true);
        if (m && m.mrp && m.sched && m.mrp.id === last.mrpId && m.sched.id === last.schedId) { await saveStatus({ ...last, checkedAt: Date.now(), note: 'No new files; nothing sent.' }); return json({ skipped: 'no new files', history }); }
      }
      const rep = await buildReport(kind, s, loaded && !loaded.used ? { loaded } : {});
      const id = await sendEmail(s.recipients, rep, kind);
      await saveStatus({ ok: true, at: Date.now(), date: now.iso, kind, to: s.recipients.length, id, pdf: !!rep.pdf, pdfError: rep.pdfError, mrpId: rep.manifest.mrp.id, schedId: rep.manifest.sched.id, subject: rep.subject });
      return json({ sent: true, kind, history });
    } catch (e) {
      console.error('scheduled report failed', e);
      await saveStatus({ ok: false, at: Date.now(), date: now.iso, kind, error: String(e.message || e) });
      throw e;
    }
  }
  if (op === 'history') {   // 2.27: daily numbers for the Trends tab (sealed; the browser opens them with the team key)
    await requireUser(request);
    const { data } = await getJSON(HISTORY, url.searchParams.get('fresh') === '1');
    return json({ history: data || null });
  }
  if (op === 'settings') {
    await requireUser(request, 'admin');
    const [s, k, st] = await Promise.all([loadSettings(), getJSON(KEYFILE, true), getJSON(STATUS, true)]);
    return json({ settings: s, keyStored: !!(k.data && k.data.locked), keyBy: k.data && k.data.byName, status: st.data || null,
      env: { resend: !!process.env.RESEND_API_KEY, from: process.env.REPORT_FROM || 'MRP Dashboard <onboarding@resend.dev>', cron: !!process.env.CRON_SECRET }, days: DAYS });
  }
  if (op === 'preview') {   // the email as it would look today (no PDF, nothing sent)
    await requireUser(request, 'admin');
    const s = await loadSettings();
    let rep; try { rep = await buildReport(url.searchParams.get('kind') === 'weekly' ? 'weekly' : 'daily', s, { noPdf: true }); } catch (e) { if (e.status) throw e; throw httpError(400, e.message); }
    return new Response(rep.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  throw httpError(404, 'Unknown request');
});

export const POST = handle(async (request, url) => {
  const op = url.searchParams.get('op');
  const { me } = await requireUser(request, 'admin');
  const b = await body(request);
  if (op === 'settings') {
    const s = cleanSettings({ ...(await loadSettings()), ...b.settings });
    await putJSON(SETTINGS, s);
    return json({ settings: s });
  }
  if (op === 'key') {   // turn the server's copy of the team key on or off
    if (b.remove) {
      await store().del([KEYFILE]);
      const s = await loadSettings(); s.enabled = false; await putJSON(SETTINGS, s);
      return json({ keyStored: false });
    }
    const raw = Buffer.from(String(b.key || ''), 'base64');
    if (raw.length !== 32) throw httpError(400, 'Bad key');
    // check it really opens the team's files before keeping it
    const { data: m } = await getJSON('data/manifest.json', true);
    if (m && m.sched) { try { await readTeamFile(raw, m.sched, 'sched'); } catch (e) { throw httpError(400, 'That key does not open the team files.'); } }
    await putJSON(KEYFILE, { locked: lock(raw), at: Date.now(), by: me.u, byName: me.name });
    return json({ keyStored: true });
  }
  if (op === 'record') {   // 2.27: record today's numbers now (admin), e.g. right after publishing a new MRP
    const s = await loadSettings();
    try { const t = await loadTeam(s, centralNow().iso); const e = await recordHistory(t, s); return json({ recorded: true, date: e.date }); }
    catch (e) { if (e.status) throw e; await historyFailed(e); throw httpError(400, e.message); }
  }
  if (op === 'test') {   // build and send one now
    const s = await loadSettings();
    const kind = b.kind === 'weekly' ? 'weekly' : 'daily';
    const to = b.toList ? s.recipients : [s.testTo].filter(Boolean);
    if (!to.length) throw httpError(400, b.toList ? 'Add at least one email address first.' : 'Add your email address for tests first.');
    let rep, id;   // test emails start with "TEST ·" so the Outlook relay flow can skip them
    try { rep = await buildReport(kind, s); if (!b.toList) rep.subject = 'TEST · ' + rep.subject; id = await sendEmail(to, rep, kind); } catch (e) { if (e.status) throw e; throw httpError(400, e.message); }
    return json({ sent: true, to, id, pdf: !!rep.pdf, pdfError: rep.pdfError, subject: rep.subject });
  }
  throw httpError(404, 'Unknown request');
});
