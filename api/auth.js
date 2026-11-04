// Sign-in and team members.
// Passwords never reach the server: each browser turns the password into two keys,
// sends only the "auth key" (checked here) and keeps the other to unlock the team key.
import {
  handle, json, body, httpError, requireUser, loadUsers, updateJSON, USERS, makeToken,
  fakeSalt, hashAuth, sameHash, newSalt, publicUser, cleanName, validUsername,
} from './_lib.js';

const needStr = (v, n = 4000) => typeof v === 'string' && v.length > 0 && v.length <= n;

export const GET = handle(async (request, url) => {
  const op = url.searchParams.get('op');
  if (op === 'state') {
    const db = await loadUsers(false);
    return json({ ok: true, setup: Object.keys(db.users).length === 0 });
  }
  if (op === 'salt') {
    const u = cleanName(url.searchParams.get('u'));
    const db = await loadUsers(false);
    const rec = db.users[u];
    return json({ salt: rec ? rec.salt : fakeSalt(u) });
  }
  if (op === 'me') {
    const { me, rec } = await requireUser(request);
    return json({ user: me, wrapped: rec.wrapped });
  }
  if (op === 'users') {
    const { db } = await requireUser(request, 'admin');
    return json({ users: Object.entries(db.users).map(([u, r]) => ({ ...publicUser(u, r), createdAt: r.createdAt })) });
  }
  throw httpError(404, 'Unknown request');
});

export const POST = handle(async (request, url) => {
  const op = url.searchParams.get('op');
  const b = await body(request);

  if (op === 'setup') {   // first admin, only while no one exists
    if (b.code !== process.env.DASHBOARD_SECRET) throw httpError(403, 'That setup code does not match DASHBOARD_SECRET in Vercel.');
    const u = cleanName(b.u);
    if (!validUsername(u)) throw httpError(400, 'Username: 2–32 letters, numbers, dots, dashes or underscores.');
    if (!needStr(b.name, 80) || !needStr(b.salt, 64) || !needStr(b.authKey, 128) || !needStr(b.wrapped)) throw httpError(400, 'Missing details');
    let made = null;
    await updateJSON(USERS, (data) => {
      const db = data && data.users ? data : { users: {} };
      if (Object.keys(db.users).length) throw httpError(409, 'Setup is already done. Sign in instead.');
      const authSalt = newSalt();
      db.users[u] = { name: b.name.trim(), role: 'admin', publisher: true, active: true, salt: b.salt, authSalt,
        authHash: hashAuth(b.authKey, authSalt), wrapped: b.wrapped, mustChange: false, tv: 1, createdAt: Date.now() };
      made = db.users[u];
      return db;
    });
    return json({ token: makeToken(u, made.tv), user: publicUser(u, made), wrapped: made.wrapped });
  }

  if (op === 'login') {
    const u = cleanName(b.u);
    const db = await loadUsers(true);
    const rec = db.users[u];
    if (!rec || rec.active === false || !needStr(b.authKey, 128) || !sameHash(hashAuth(b.authKey, rec.authSalt), rec.authHash)) {
      await new Promise((r) => setTimeout(r, 600));   // slow down guessing
      throw httpError(401, rec && rec.active === false ? 'This account is turned off. Ask the admin.' : 'Wrong username or password.');
    }
    return json({ token: makeToken(u, rec.tv || 0), user: publicUser(u, rec), wrapped: rec.wrapped });
  }

  if (op === 'password') {   // change my own password
    const { me } = await requireUser(request);
    if (!needStr(b.oldAuthKey, 128) || !needStr(b.salt, 64) || !needStr(b.authKey, 128) || !needStr(b.wrapped)) throw httpError(400, 'Missing details');
    let saved = null;
    await updateJSON(USERS, (db) => {
      const rec = db.users[me.u];
      if (!sameHash(hashAuth(b.oldAuthKey, rec.authSalt), rec.authHash)) throw httpError(403, 'Your current password is not right.');
      rec.salt = b.salt; rec.authSalt = newSalt(); rec.authHash = hashAuth(b.authKey, rec.authSalt);
      rec.wrapped = b.wrapped; rec.mustChange = false; rec.tv = (rec.tv || 0) + 1;
      saved = rec; return db;
    });
    return json({ token: makeToken(me.u, saved.tv), user: publicUser(me.u, saved) });
  }

  if (op === 'saveuser') {   // admin: add a person, change role, reset password, turn on/off
    const { me } = await requireUser(request, 'admin');
    const u = cleanName(b.u);
    if (!validUsername(u)) throw httpError(400, 'Username: 2–32 letters, numbers, dots, dashes or underscores.');
    let out = null;
    await updateJSON(USERS, (db) => {
      const isNew = !db.users[u];
      if (isNew && !(needStr(b.salt, 64) && needStr(b.authKey, 128) && needStr(b.wrapped))) throw httpError(400, 'A new person needs a temporary password.');
      if (isNew && b.create !== true) throw httpError(404, 'That person no longer exists.');
      if (!isNew && b.create === true) throw httpError(409, 'That username is already taken.');
      const rec = db.users[u] || { createdAt: Date.now(), tv: 1 };
      if (needStr(b.name, 80)) rec.name = b.name.trim();
      if (b.role === 'admin' || b.role === 'buyer') rec.role = b.role;
      if (typeof b.publisher === 'boolean') rec.publisher = b.publisher;
      if (typeof b.active === 'boolean') { if (rec.active !== b.active) rec.tv = (rec.tv || 0) + 1; rec.active = b.active; }
      if (rec.active === undefined) rec.active = true;
      if (!isNew && b.salt) rec.tv = (rec.tv || 0) + 1;   // a reset signs them out everywhere
      if (needStr(b.salt, 64) && needStr(b.authKey, 128) && needStr(b.wrapped)) {
        rec.salt = b.salt; rec.authSalt = newSalt(); rec.authHash = hashAuth(b.authKey, rec.authSalt);
        rec.wrapped = b.wrapped; rec.mustChange = true;
      }
      if (u === me.u && (rec.role !== 'admin' || rec.active === false)) throw httpError(400, 'You cannot remove your own admin access.');
      if (!rec.name) rec.name = u;
      db.users[u] = rec; out = rec; return db;
    });
    return json({ user: publicUser(u, out) });
  }

  if (op === 'deluser') {
    const { me } = await requireUser(request, 'admin');
    const u = cleanName(b.u);
    if (u === me.u) throw httpError(400, 'You cannot remove yourself.');
    await updateJSON(USERS, (db) => { delete db.users[u]; return db; });
    return json({ ok: true });
  }
  throw httpError(404, 'Unknown request');
});
