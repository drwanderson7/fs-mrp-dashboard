// Vercel runs this on the schedule in vercel.json (weekdays, early morning Central time).
import { GET as reports } from './reports.js';
export const GET = (request) => { const u = new URL(request.url); u.searchParams.set('op', 'cron'); return reports(new Request(u, { headers: request.headers })); };
