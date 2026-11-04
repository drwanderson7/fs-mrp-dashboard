// Work statuses (Contacted / PO Submitted / Confirmed) shared by the team.
// Each person's statuses are one encrypted entry in a single file; browsers merge them.
import { handle, json, httpError, requireUser, getJSON, updateJSON } from './_lib.js';

const FILE = 'status/team.json';

export const GET = handle(async (request, url) => {
  await requireUser(request);
  const { data } = await getJSON(FILE, url.searchParams.get('fresh') === '1');
  return json({ users: (data && data.users) || {} });
});

export const POST = handle(async (request) => {
  const { me } = await requireUser(request);
  const b = await request.json().catch(() => ({}));
  if (typeof b.enc !== 'string' || b.enc.length > 3_000_000) throw httpError(400, 'Bad status save');
  const next = await updateJSON(FILE, (d) => {
    d = d && d.users ? d : { users: {} };
    d.users[me.u] = { enc: b.enc, at: Number(b.at) || Date.now(), seen: Date.now(), name: me.name };
    return d;
  });
  return json({ users: next.users });
});
