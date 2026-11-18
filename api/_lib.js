// Shared helpers for the dashboard's team functions.
// The server never sees MRP, schedule or status contents: browsers encrypt them
// with the team key before upload. The server only checks who is signed in.
import crypto from 'node:crypto';
import { put, get, del, head, BlobPreconditionFailedError } from '@vercel/blob';

// ---------- storage (Vercel Blob, private store) ----------
const blobStore = {
  async get(path, fresh) {
    // fresh reads ask for the uncompressed, uncached copy
    const r = await get(path, { access: 'private', useCache: !fresh, ...(fresh ? { headers: { 'cache-control': 'no-cache', 'accept-encoding': 'identity' } } : {}) });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
    return { buf, etag: r.blob && r.blob.etag, uploadedAt: r.blob && r.blob.uploadedAt ? new Date(r.blob.uploadedAt).getTime() : 0 };
  },
  // the storage API's own record of the file: the version tag it checks saves against, size, save time
  async head(path) {
    try { const h = await head(path, { access: 'private' }); return { etag: h.etag, size: h.size, uploadedAt: new Date(h.uploadedAt).getTime() }; }
    catch (e) { if (/not.?found|404/i.test(String(e && (e.name + ' ' + e.message)))) return null; throw e; }
  },
  async put(path, data, opts = {}) {
    const o = {
      access: 'private', addRandomSuffix: false, allowOverwrite: true,
      contentType: opts.contentType || 'application/octet-stream', cacheControlMaxAge: 60,
    };
    if (opts.ifMatch) o.ifMatch = opts.ifMatch;
    try { return await put(path, data, o); }
    catch (e) { if (e instanceof BlobPreconditionFailedError) { const c = new Error('conflict'); c.conflict = true; throw c; } throw e; }
  },
  async del(paths) { if (paths && paths.length) await del(paths); },
};
// Tests swap in a local store
export const store = () => globalThis.__TEST_STORE || blobStore;

export async function getJSON(path, fresh) {
  const r = await store().get(path, fresh);
  if (!r) return { data: null, etag: null };
  return { data: JSON.parse(r.buf.toString('utf8')), etag: r.etag, size: r.buf.length, uploadedAt: r.uploadedAt || 0 };
}
const bareTag = (t) => String(t || '').replace(/^W\//, '').replace(/"/g, '');
export function putJSON(path, obj, ifMatch) {
  return store().put(path, JSON.stringify(obj), { contentType: 'application/json', ifMatch });
}

// Read-modify-write. The write only lands if nobody changed the file since we read it (ifMatch), so one save
// can never wipe out another. Right after a save, storage can return the previous version for a few seconds,
// which makes the write look like a clash: wait a little longer each time and read again (up to ~25 s).
const RETRY_WAITS = [250, 500, 1000, 1500, 2500, 4000, 6000, 9000];
export async function updateJSON(path, fn) {
  for (let i = 0; i <= RETRY_WAITS.length; i++) {
    const got = await getJSON(path, true);
    // Save against the storage API's own version tag, and only when the copy just read IS that version
    // (same tag once quotes/W\/ are ignored, or same size and save time). The copy served for reading can
    // carry a differently formatted tag (e.g. when compressed), which must not block every save.
    let ifMatch;
    if (got.data !== null) {
      const h = store().head ? await store().head(path) : null;
      const same = !h || bareTag(h.etag) === bareTag(got.etag) || (h.size === got.size && Math.abs(h.uploadedAt - got.uploadedAt) < 1500);
      if (!same) {   // an older copy was served: wait for storage to catch up
        console.warn('updateJSON: stale read', path, { read: got.etag, current: h.etag, readSize: got.size, size: h.size });
        if (i < RETRY_WAITS.length) { await new Promise((r) => setTimeout(r, RETRY_WAITS[i])); continue; }
        break;
      }
      ifMatch = h ? h.etag : got.etag;
    }
    const next = await fn(got.data);
    if (next === undefined) return got.data;
    try { await putJSON(path, next, ifMatch || undefined); return next; }
    catch (e) { if (!e.conflict) throw e; console.warn('updateJSON: changed while saving', path); }
    if (i < RETRY_WAITS.length) await new Promise((r) => setTimeout(r, RETRY_WAITS[i] + Math.floor(Math.random() * 200)));
  }
  throw httpError(409, 'The team storage is still catching up with a save made a moment ago. Wait a minute and try again.');
}

// ---------- secrets / tokens ----------
function secret() {
  const s = process.env.DASHBOARD_SECRET;
  if (!s || s.length < 16) throw httpError(500, 'DASHBOARD_SECRET is not set in Vercel (Settings → Environment Variables), or is shorter than 16 characters.');
  return s;
}
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function makeToken(u, tv) {
  const body = b64u(JSON.stringify({ u, tv, exp: Date.now() + 30 * 86400000 }));
  return body + '.' + b64u(hmac(secret() + ':session', body));
}
function readToken(tok) {
  if (!tok || typeof tok !== 'string' || !tok.includes('.')) return null;
  const [body, sig] = tok.split('.');
  const want = hmac(secret() + ':session', body);
  const got = Buffer.from(sig || '', 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}

// Fake salt for unknown usernames, so the sign-in screen does not reveal who has an account
export const fakeSalt = (u) => b64u(hmac(secret() + ':salt', String(u)).subarray(0, 16));

export function hashAuth(authKey, authSalt) {
  return crypto.createHash('sha256').update(String(authSalt) + ':' + String(authKey)).digest('hex');
}
export function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
export const newSalt = () => b64u(crypto.randomBytes(16));

// ---------- users ----------
export const USERS = 'auth/users.json';
export async function loadUsers(fresh) {
  const { data } = await getJSON(USERS, fresh);
  return data && data.users ? data : { users: {} };
}
export function publicUser(u, rec) {
  return { u, name: rec.name, role: rec.role, publisher: !!rec.publisher || rec.role === 'admin', active: rec.active !== false, mustChange: !!rec.mustChange };
}
export const cleanName = (u) => String(u || '').trim().toLowerCase();
export const validUsername = (u) => /^[a-z0-9._-]{2,32}$/.test(u);

// Signed-in user for this request, or throws 401
export async function requireUser(request, need) {
  const h = request.headers.get('authorization') || '';
  const p = readToken(h.replace(/^Bearer\s+/i, ''));
  if (!p) throw httpError(401, 'Please sign in again.');
  let db = await loadUsers(false);
  let rec = db.users[p.u];
  // the cached copy can be up to a minute old; re-check before turning someone away
  if (!rec || rec.active === false || (rec.tv || 0) !== p.tv) { db = await loadUsers(true); rec = db.users[p.u]; }
  if (!rec || rec.active === false || (rec.tv || 0) !== p.tv) throw httpError(401, 'Your sign-in has ended. Please sign in again.');
  const me = publicUser(p.u, rec);
  if (need === 'admin' && me.role !== 'admin') throw httpError(403, 'Only an admin can do that.');
  if (need === 'publisher' && !me.publisher) throw httpError(403, 'You are not set up to publish team files. Ask the admin.');
  return { me, rec, db };
}

// ---------- responses ----------
export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
export const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
export function handle(fn) {
  return async (request) => {
    try { return await fn(request, new URL(request.url)); }
    catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      let msg = e.message || 'Server error';
      if (/suspended|blocked/i.test(msg)) msg = 'Team storage is paused (Vercel Blob limit reached). The dashboard will use the team folder or your saved files until it resets.';
      return json({ error: msg, storage: status >= 500 }, status);
    }
  };
}
export async function body(request) { try { return await request.json(); } catch (e) { throw httpError(400, 'Bad request'); } }
