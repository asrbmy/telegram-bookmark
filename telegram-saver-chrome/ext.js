// Shared helpers: browser API shim, validation, URL utilities.
export const ext = globalThis.browser ?? globalThis.chrome ?? {};
export const actionApi = ext.action ?? ext.browserAction;
export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
export const CHAT_RE = /^(-?\d{5,20}|@[A-Za-z0-9_]{5,32})$/;

export function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; }
  catch { return null; }
}

export const clean = (s, max = 300) =>
  String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function normHost(s) {
  try { return new URL(String(s).includes('://') ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

// Used to compare saved links; ignores #fragments and tracking parameters.
export function normUrl(u) {
  try {
    const x = new URL(u); x.hash = '';
    [...x.searchParams.keys()].forEach((k) => { if (/^(utm_|fbclid$|gclid$|igshid$|si$)/i.test(k)) x.searchParams.delete(k); });
    const s = x.href; return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch { return String(u); }
}

export function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /\.(localhost|local|internal|lan)$/.test(h)) return true;
  if (h.includes(':')) return h === '::1' || h === '::' || /^(fc|fd|fe80)/.test(h);
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function detectCategory(url) {
  let u; try { u = new URL(url); } catch { return 'websites'; }
  const h = u.hostname.replace(/^www\./, ''), p = u.pathname.toLowerCase();
  if (h === 'music.youtube.com') return 'music';
  if (/(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv)$/.test(h)) return 'videos';
  if (/(spotify\.com|soundcloud\.com|gaana\.com|jiosaavn\.com|music\.apple\.com)$/.test(h)) return 'music';
  if (/\.(mp4|mkv|webm|mov)$/.test(p)) return 'videos';
  if (/\.(mp3|m4a|wav|flac|ogg)$/.test(p)) return 'music';
  if (/\.(pdf|docx?|xlsx?|pptx?|zip|epub)$/.test(p)) return 'documents';
  if (/\.(jpe?g|png|gif|webp)$/.test(p)) return 'images';
  return 'websites';
}

// Custom site rules win, then built-in detection, then the first topic.
export function pickCategory(url, rules, cats) {
  const host = normHost(url);
  for (const r of rules || []) {
    if ((host === r.host || host.endsWith('.' + r.host)) && cats.some((c) => c.key === r.catKey)) return r.catKey;
  }
  const k = detectCategory(url);
  return cats.some((c) => c.key === k) ? k : cats[0]?.key;
}
