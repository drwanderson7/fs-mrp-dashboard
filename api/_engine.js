// Runs the dashboard's own calculations (from index.html) on the server, so the scheduled
// Line Report emails always match what people see in the dashboard. No browser is needed:
// the page's scripts run in a sandbox with a stand-in for the screen.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// A stand-in for any screen element: every property and call quietly does nothing.
function inert() {
  const fn = function () {};
  const p = new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;            // not a promise
      if (k === 'length') return 0;
      if (k === 'value' || k === 'textContent' || k === 'innerHTML' || k === 'innerText' || k === 'id' || k === 'className') return '';
      if (k === 'checked' || k === 'disabled') return false;
      if (k === 'files') return [];
      return p;
    },
    set() { return true; },
    apply() { return p; },
    construct() { return p; },
  });
  return p;
}

function findIndexHtml() {
  const tries = [path.join(process.cwd(), 'index.html'), path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'index.html')];
  for (const f of tries) if (fs.existsSync(f)) return f;
  throw new Error('index.html was not found next to the server functions');
}

// todayIso: 'YYYY-MM-DD' in Central time. opts: {leadWeeks, arrivalBuffer, excluded:[...], dateMode}
export function makeEngine(todayIso, opts = {}) {
  const html = fs.readFileSync(findIndexHtml(), 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.length > 1000);
  if (!blocks.length) throw new Error('Could not read the dashboard code from index.html');
  let code = blocks.join('\n;\n');
  // "today" is the report date, not the server's clock (the server runs on UTC)
  code = code.replace(/const TODAY_STR=[^;\n]*\(new Date\(\)\);/, `const TODAY_STR=${JSON.stringify(todayIso)};`);
  if (!code.includes(`const TODAY_STR=${JSON.stringify(todayIso)}`)) throw new Error('Could not set the report date in the dashboard code');

  const el = inert();
  const store = {};
  const ctx = {
    console, Math, JSON, Date, Promise, Set, Map, WeakMap, Array, Object, String, Number, Boolean, RegExp, Error, TypeError,
    Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, Intl, Symbol, Proxy, Reflect, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, atob, btoa, structuredClone, queueMicrotask,
    setTimeout: (f) => { return 0; }, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0,
    XLSX: require('xlsx'), JSZip: require('jszip'),
    document: el, navigator: { userAgent: 'server' }, location: { href: '', search: '', hash: '', origin: '' }, history: el,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    indexedDB: undefined, fetch: undefined, crypto: globalThis.crypto,
    getComputedStyle: () => el, matchMedia: () => ({ matches: false, addEventListener() {} }), alert() {}, confirm: () => false, print() {},
    addEventListener() {}, removeEventListener() {}, open: () => null, scrollTo() {},
    Blob: globalThis.Blob, File: globalThis.File,
    FileReader: class { readAsArrayBuffer(f) { Promise.resolve().then(() => this.onload && this.onload({ target: { result: f.__buf } })); }
                        readAsBinaryString(f) { Promise.resolve().then(() => this.onload && this.onload({ target: { result: f.__buf } })); } },
  };
  // the excluded product lines come from the report settings, not checkboxes
  if (opts.excluded) store.mrp_excl_pl_v1 = JSON.stringify(opts.excluded);
  store.mrp_datemode_v1 = opts.dateMode === 'schedule' ? 'schedule' : 'sage';
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'index.html' });
  const excl = new Set(opts.excluded || ['0003', '0019', '0041', '0045', 'FAST', '0069']);
  ctx.__exclSet = excl;
  vm.runInContext(`getExcludedPL=function(){ return new Set(__exclSet); };
    leadWeeks=${Number(opts.leadWeeks) || 8}; arrivalBuffer=${Number(opts.arrivalBuffer) || 2};
    uiNotice=function(m){ (window.__notices=window.__notices||[]).push(String(m)); };`, ctx);

  async function readSchedule(buf, name) {
    const raw = await new Promise((resolve, reject) => {
      const file = { __buf: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), name, size: buf.length };
      ctx.readScheduleViaZip(file, resolve);
      setTimeout(() => reject(new Error('The schedule file could not be read' + (ctx.__notices ? ': ' + ctx.__notices.join('; ') : ''))), 60000).unref?.();
    });
    return raw;
  }

  return {
    ctx,
    async load(mrpBuf, mrpName, schedBuf, schedName) {
      const schedRaw = await readSchedule(schedBuf, schedName);
      ctx.parseScheduleRaw(schedRaw, schedName);
      if (!(ctx.scheduleBase || []).length) throw new Error('No trailers were found in the schedule file');
      const wb = ctx.XLSX.read(mrpBuf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = ctx.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      ctx.lastRawFileName = mrpName; ctx.lastSchedFileName = schedName;
      ctx.lastRawData = raw;
      vm.runInContext('allData=processRaw(lastRawData, lastRawFileName);', ctx);
      if (!vm.runInContext('(allData||[]).length', ctx)) throw new Error('No parts were found in the MRP file' + (ctx.__notices ? ': ' + ctx.__notices.join('; ') : ''));
      return { parts: vm.runInContext('allData.length', ctx), trailers: ctx.scheduleBase.length };
    },
    lines() { return vm.runInContext(`(()=>{ const c={}; lrAllTrailers().forEach(t=>{ c[t.line||'']=1; }); return Object.keys(c).sort(lrLineSort); })()`, ctx); },
    stats(lines, horizon) { ctx.__a = lines; ctx.__h = horizon; return vm.runInContext('lrComputeStats(__a, __h)', ctx); },
    // the same printable report as the dashboard's Line Reports button
    reportHtml(lines, horizon, sec) {
      ctx.__a = lines; ctx.__h = horizon; ctx.__s = sec;
      return vm.runInContext('buildLineReportHTML(__a, __h, __s)', ctx);
    },
    eval(js) { return vm.runInContext(js, ctx); },
  };
}
