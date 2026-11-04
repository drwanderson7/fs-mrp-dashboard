// Team MRP and schedule files, stored encrypted in pieces of up to 4 MB
// (Vercel functions accept at most 4.5 MB per request).
import { handle, json, httpError, requireUser, getJSON, updateJSON, store } from './_lib.js';

const MANIFEST = 'data/manifest.json';
const KINDS = ['mrp', 'sched', 'snap'];   // snap = compact MRP summary kept for What Changed
const SNAP_KEEP = 10;
const CHUNK_MAX = 4 * 1024 * 1024;
const okId = (s) => /^[a-z0-9]{8,40}$/.test(String(s || ''));
const chunkPath = (kind, id, i) => `data/${kind}/${id}/${i}.bin`;

function parts(url) {
  const kind = url.searchParams.get('kind'), id = url.searchParams.get('id'), i = Number(url.searchParams.get('i'));
  if (!KINDS.includes(kind) || !okId(id) || !Number.isInteger(i) || i < 0 || i > 40) throw httpError(400, 'Bad file request');
  return { kind, id, i };
}

export const GET = handle(async (request, url) => {
  await requireUser(request);
  const op = url.searchParams.get('op');
  if (op === 'manifest') {
    const { data } = await getJSON(MANIFEST, url.searchParams.get('fresh') === '1');
    return json({ manifest: data || {} });
  }
  if (op === 'chunk') {
    const { kind, id, i } = parts(url);
    const r = await store().get(chunkPath(kind, id, i), false);   // pieces never change, so the cache is safe
    if (!r) throw httpError(404, 'That team file is no longer available. Reload the dashboard.');
    return new Response(r.buf, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=86400' } });
  }
  throw httpError(404, 'Unknown request');
});

export const PUT = handle(async (request, url) => {
  await requireUser(request, 'publisher');
  const { kind, id, i } = parts(url);
  const buf = Buffer.from(await request.arrayBuffer());
  if (!buf.length || buf.length > CHUNK_MAX) throw httpError(413, 'File piece too large');
  await store().put(chunkPath(kind, id, i), buf);
  return json({ ok: true });
});

export const POST = handle(async (request, url) => {
  const { me } = await requireUser(request, 'publisher');
  if (url.searchParams.get('op') !== 'commit') throw httpError(404, 'Unknown request');
  const b = await request.json().catch(() => ({}));
  const { kind, id } = b;
  if (!KINDS.includes(kind) || !okId(id) || !Number.isInteger(b.chunks) || b.chunks < 1 || b.chunks > 40) throw httpError(400, 'Bad publish request');
  const entry = {
    id, chunks: b.chunks, gz: !!b.gz, size: Number(b.size) || 0, iv: String(b.iv || '').slice(0, 64),
    name: String(b.name || '').slice(0, 200), modified: Number(b.modified) || 0, fileSize: Number(b.fileSize) || 0,
    publishedAt: Date.now(), by: me.u, byName: me.name,
  };
  if (kind === 'snap') {   // keep the last few MRP summaries (newest first) for everyone's What Changed
    entry.key = String(b.key || '').slice(0, 300); entry.date = Number(b.date) || Date.now();
    let dropped = [];
    const next = await updateJSON(MANIFEST, (m) => {
      m = m || {};
      let list = (m.snaps || []).filter((x) => x.key !== entry.key || x.id === id);
      dropped = (m.snaps || []).filter((x) => x.key === entry.key && x.id !== id);
      list.push(entry); list.sort((a, z) => z.date - a.date);
      dropped = dropped.concat(list.slice(SNAP_KEEP)); m.snaps = list.slice(0, SNAP_KEEP);
      m.updatedAt = Date.now(); return m;
    });
    const paths = []; dropped.forEach((o) => { for (let i = 0; i < o.chunks; i++) paths.push(chunkPath('snap', o.id, i)); });
    try { await store().del(paths); } catch (e) { console.warn('cleanup failed', e); }
    return json({ manifest: next });
  }
  let old = null;
  const next = await updateJSON(MANIFEST, (m) => {
    m = m || {};
    old = m[kind] || null;
    m[kind] = entry; m.updatedAt = Date.now();
    return m;
  });
  // remove the replaced file's pieces (deletes are free)
  if (old && old.id !== id) {
    const paths = []; for (let i = 0; i < old.chunks; i++) paths.push(chunkPath(kind, old.id, i));
    try { await store().del(paths); } catch (e) { console.warn('cleanup failed', e); }
  }
  return json({ manifest: next });
});
