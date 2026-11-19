// The Line Report email: a short summary that reads well in Outlook and on a phone
// (plain tables and inline styles only), with the full printable report attached as a PDF.
const C = { navy: '#1E2A3A', bg: '#F5F6F8', border: '#E2E4E8', text: '#1A1A2E', muted: '#6B7280', blue: '#2563EB',
  green: '#16A34A', yellow: '#CA8A04', orange: '#EA580C', red: '#DC2626', purple: '#7C3AED' };
const URG = { CRITICAL: [C.red, '#FEF2F2'], EXPEDITE: [C.purple, '#F5F3FF'], HIGH: [C.orange, '#FFF7ED'], MEDIUM: [C.yellow, '#FEFCE8'], LOW: [C.green, '#F0FDF4'], NONE: [C.green, '#F0FDF4'] };
const ORDER = { EXPEDITE: 0, CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4, NONE: 5 };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const F = "font-family:'Segoe UI',Arial,sans-serif;";
const tag = (u) => { const [c, b] = URG[u] || [C.muted, '#F0F1F3']; return `<span style="${F}display:inline-block;font-size:10px;font-weight:700;color:${c};background:${b};border:1px solid ${c};border-radius:3px;padding:0 4px;white-space:nowrap">${u === 'NONE' ? 'CLEAR' : esc(u)}</span>`; };
const th = (t, right) => `<th style="${F}font-size:10px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.04em;text-align:${right ? 'right' : 'left'};padding:6px 8px;background:#F0F1F3;border-bottom:1px solid ${C.border}">${t}</th>`;
const td = (v, s = '') => `<td style="${F}font-size:12px;color:${C.text};padding:6px 8px;border-bottom:1px solid ${C.border};vertical-align:top;${s}">${v}</td>`;
const fmtDay = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
const shortLine = (l) => (/^Line\s+(\d+)$/i.exec(l) ? 'L' + /^Line\s+(\d+)$/i.exec(l)[1] : l || 'Not on schedule');

// st = engine.stats(lines, weeks); info = {kind, today, weeks, urgentOnly, mrp, sched, site, settingsLine, stale, pdf}
export function buildEmail(st, info) {
  const { stats, todayStr } = st;
  const sum = (k) => stats.reduce((a, s) => a + (typeof s[k] === 'number' ? s[k] : s[k].length), 0);
  const title = info.kind === 'weekly' ? 'Weekly Line Report' : 'Daily Line Report';
  const windowTxt = `Trailers due in the next ${info.weeks} weeks, plus overdue`;
  const kpi = (label, n, color, bg) => `<td width="20%" style="padding:4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${color === C.text ? C.border : color};background:${bg};border-radius:6px"><tr><td style="${F}padding:8px 10px">
    <div style="font-size:10px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.05em">${label}</div><div style="font-size:22px;font-weight:700;color:${color}">${n}</div></td></tr></table></td>`;

  const lineRows = stats.map((s) => `<tr>${td(`<b>${esc(s.line || 'Not on schedule')}</b>`)}${td(s.ts.length, 'text-align:right')}${td(`<b style="color:${s.risk.length ? C.red : C.text}">${s.risk.length}</b>`, 'text-align:right')}
    ${td(`${s.pctGood}%`, 'text-align:right')}${td(s.crit || '—', 'text-align:right')}${td(s.exp || '—', 'text-align:right')}${td(s.overdueRisk || '—', 'text-align:right')}
    ${td(s.parts.length, 'text-align:right')}${td(s.noPO || '—', 'text-align:right')}${td(esc(s.nextRisk || '—'), 'white-space:nowrap')}</tr>`).join('');

  // trailers to look at, by line
  const CAP = 12;
  const lineBlocks = stats.map((s) => {
    let ts = s.risk;
    if (info.urgentOnly) ts = ts.filter((t) => t.worst_urgency === 'CRITICAL' || t.worst_urgency === 'EXPEDITE');
    if (!s.ts.length) return '';
    const head = `<tr><td style="${F}padding:16px 0 6px;font-size:14px;font-weight:700;color:${C.text}">${esc(s.line || 'Not on schedule')}
      <span style="font-size:12px;font-weight:400;color:${C.muted}"> · ${s.risk.length} of ${s.ts.length} open trailers at risk${info.urgentOnly ? ` · ${ts.length} critical or expedite` : ''}</span></td></tr>`;
    if (!ts.length) return head + `<tr><td style="${F}font-size:12px;color:${C.green};padding:2px 0 6px">${s.risk.length ? 'No critical or expedite trailers.' : 'No trailers at risk. 🎉'}</td></tr>`;
    const rows = ts.slice(0, CAP).map((t) => {
      const ps = [...(t.at_risk_parts || [])].sort((a, b) => (ORDER[a.urgency] ?? 9) - (ORDER[b.urgency] ?? 9));
      const chips = ps.slice(0, 4).map((p) => { const [c] = URG[p.urgency] || [C.muted]; return `<span style="color:${c};font-weight:600;white-space:nowrap">${esc(p.ItemCode)}</span>`; }).join(', ') + (ps.length > 4 ? ` <span style="color:${C.muted}">+${ps.length - 4}</span>` : '');
      const od = t.due_date && t.due_date < todayStr;
      return `<tr>${td(`<b style="color:${C.blue}">${esc(t.trailer)}</b>`)}${td(`${esc(t.due_date || '—')}${od ? `<br><span style="font-size:10px;font-weight:700;color:${C.red}">OVERDUE</span>` : ''}`, `white-space:nowrap;${od ? 'color:' + C.red + ';font-weight:600' : ''}`)}
        ${td(`${esc(t.customer || '—')}<br><span style="font-size:11px;color:${C.muted}">${esc(t.model || '')}</span>`)}${td(tag(t.worst_urgency))}${td(t.at_risk_count, 'text-align:right')}${td(chips)}</tr>`;
    }).join('');
    const more = ts.length > CAP ? `<tr><td style="${F}font-size:11px;color:${C.muted};padding:4px 0">+${ts.length - CAP} more on ${esc(s.line)}${info.pdf ? ' in the attached PDF' : ' in the dashboard'}.</td></tr>` : '';
    return head + `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${C.border};background:#fff">
      <tr>${th('Trailer')}${th('Due')}${th('Customer · model')}${th('Worst')}${th('Parts', 1)}${th('Blocking parts')}</tr>${rows}</table></td></tr>` + more;
  }).join('');

  // parts blocking the most trailers across all lines
  const xm = {};
  stats.forEach((s) => s.parts.forEach((p) => { const x = xm[p.ItemCode] || (xm[p.ItemCode] = { p, total: 0, by: [] }); x.total += p.trailers.length; x.by.push(shortLine(s.line) + ' ' + p.trailers.length); }));
  const top = Object.values(xm).sort((a, b) => b.total - a.total || (ORDER[a.p.urgency] ?? 9) - (ORDER[b.p.urgency] ?? 9)).slice(0, 10);
  const topRows = top.map((x) => { const p = x.p; const po = String(p.PurchaseOrders || '').trim();
    return `<tr>${td(`<b>${esc(p.ItemCode)}</b><br><span style="font-size:11px;color:${C.muted}">${esc(p.ItemCodeDesc || '')}</span>`)}${td(tag(p.urgency))}${td(esc(p.VendorName || '—'))}${td(esc(p.BuyerCode || '—'))}
      ${td(`<b>${x.total}</b><br><span style="font-size:10px;color:${C.muted}">${esc(x.by.join(' · '))}</span>`, 'text-align:right')}${td(Math.abs(p.min_available || 0).toLocaleString(), `text-align:right;color:${C.red};font-weight:700`)}
      ${td(po ? esc(po.length > 24 ? po.slice(0, 24) + '…' : po) : `<b style="color:${C.red}">No PO</b>`)}</tr>`; }).join('');

  const warn = info.stale ? `<tr><td style="${F}padding:10px 14px;background:#FFF7ED;border:1px solid #FED7AA;color:#C2410C;font-size:12px;font-weight:600">⚠ ${esc(info.stale)}</td></tr><tr><td height="10"></td></tr>` : '';
  const btn = info.site ? `<a href="${esc(info.site)}" style="${F}display:inline-block;background:${C.blue};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px">Open the dashboard</a>` : '';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="760" cellpadding="0" cellspacing="0" style="max-width:760px;width:100%">
<tr><td style="${F}background:${C.navy};color:#fff;padding:14px 18px;border-radius:8px 8px 0 0">
  <div style="font-size:19px;font-weight:700">${title} · ${esc(fmtDay(todayStr))}</div>
  <div style="font-size:12px;color:#C6CED9;margin-top:3px">Fontaine Specialized · Trailers at Risk by production line · ${esc(windowTxt)}</div></td></tr>
<tr><td style="background:#fff;border:1px solid ${C.border};border-top:0;padding:14px 16px;border-radius:0 0 8px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${warn}
<tr><td style="${F}font-size:11px;color:${C.muted};padding-bottom:8px">MRP: ${esc(info.mrp)} · Schedule: ${esc(info.sched)}</td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
  ${kpi('Open trailers', sum('ts'), C.text, '#fff')}${kpi('At risk', sum('risk'), C.red, '#FEF2F2')}${kpi('On track', (sum('ts') ? Math.round(sum('good') / sum('ts') * 100) : 0) + '%', C.green, '#F0FDF4')}
  ${kpi('Worst = critical', sum('crit'), C.red, '#FEF2F2')}${kpi('Worst = expedite', sum('exp'), C.purple, '#F5F3FF')}</tr></table></td></tr>
<tr><td style="${F}padding:14px 0 6px;font-size:14px;font-weight:700;color:${C.text}">By line</td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${C.border}">
  <tr>${th('Line')}${th('Open', 1)}${th('At risk', 1)}${th('On track', 1)}${th('Critical', 1)}${th('Expedite', 1)}${th('Overdue', 1)}${th('Parts short', 1)}${th('No PO', 1)}${th('Next at-risk due')}</tr>${lineRows}</table></td></tr>
<tr><td style="${F}padding:18px 0 0;font-size:15px;font-weight:700;color:${C.text}">${info.urgentOnly ? 'Critical and expedite trailers' : 'Trailers at risk'}</td></tr>
${lineBlocks}
${top.length ? `<tr><td style="${F}padding:18px 0 6px;font-size:15px;font-weight:700;color:${C.text}">Parts blocking the most trailers</td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${C.border}">
  <tr>${th('Part')}${th('Urgency')}${th('Supplier')}${th('Buyer')}${th('Trailers', 1)}${th('Shortage', 1)}${th('Open PO')}</tr>${topRows}</table></td></tr>` : ''}
<tr><td style="padding:18px 0 6px">${btn}</td></tr>
<tr><td style="${F}font-size:11px;color:${C.muted};line-height:1.5">${info.pdf ? 'The full Line Report (needs attention, parts to chase' + (info.kind === 'weekly' ? ', looks good' : '') + ') is attached as a PDF. ' : (info.pdfError ? 'The PDF could not be made today; use Line Reports in the dashboard. ' : '')}${esc(info.settingsLine)}<br>
Sent automatically by the MRP Dashboard. A trailer is at risk when a part it needs goes short in the MRP by its build week.</td></tr>
</table></td></tr></table></td></tr></table></body></html>`;
  const subject = `${title} · ${fmtDay(todayStr)} · ${sum('risk')} trailers at risk (${sum('crit')} critical, ${sum('exp')} expedite)`;
  return { html, subject };
}
