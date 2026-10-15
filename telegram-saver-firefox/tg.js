import { ext, clean, safeUrl, isPrivateHost, sleep, uid, TOKEN_RE, CHAT_RE } from './ext.js';
import { getState, setState, activeProfile, findDup } from './store.js';

const MAX = 50 * 1024 * 1024; // Bot API upload limit
export class TgError extends Error {}
export class DupError extends TgError {}

function friendly(d) {
  const t = d.description || '';
  if (d.error_code === 401) return 'Invalid bot token.';
  if (/message thread not found|TOPIC_DELETED|TOPIC_CLOSED/i.test(t)) return 'That topic no longer exists. Open Settings → Topics → Create topics.';
  if (/chat not found/i.test(t)) return 'Group not found. Check the Group ID and make sure the bot is in the group.';
  if (/not enough rights|CHAT_ADMIN_REQUIRED/i.test(t)) return 'The bot needs admin rights (including Manage topics) in the group.';
  if (/kicked|not a member/i.test(t)) return 'The bot was removed from the group. Add it again.';
  if (/webhook/i.test(t)) return 'This bot has a webhook set. Remove it, or enter the Group ID manually.';
  return t || 'Telegram returned an error.';
}

export async function api(token, method, body, isForm = false, retry = 1) {
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, isForm
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new TgError('Cannot reach Telegram. Check your internet connection.'); }
  let data; try { data = await res.json(); } catch { throw new TgError('Unexpected reply from Telegram.'); }
  if (data.ok) return data.result;
  if (data.error_code === 429 && retry > 0) {
    await sleep(Math.min(data.parameters?.retry_after || 1, 15) * 1000);
    return api(token, method, body, isForm, retry - 1);
  }
  throw new TgError(friendly(data));
}

const form = (base, fields) => { const f = new FormData(); for (const [k, v] of Object.entries({ ...base, ...fields })) f.append(k, v); return f; };
const fileName = (s, fb) => (String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120)) || fb;
const hasAdvanced = () => ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);

async function readLimited(res) {
  const reader = res.body.getReader(), chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    n += value.length; if (n > MAX) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' });
}

// Returns true if a file was uploaded, false if the link is not a downloadable file (or is too large).
async function uploadFile(p, base, url, caption) {
  if (isPrivateHost(new URL(url).hostname)) throw new TgError('Downloads from local or private network addresses are blocked.');
  if (!(await hasAdvanced())) throw new TgError('Turn on Advanced access in Settings → Features to download files.');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 120000);
  try {
    let res;
    try { res = await fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }); } catch { return false; }
    const finalUrl = safeUrl(res.url);
    if (!res.ok || !finalUrl || isPrivateHost(new URL(finalUrl).hostname)) return false;
    if ((res.headers.get('content-type') || '').includes('text/html')) return false;
    if ((+res.headers.get('content-length') || 0) > MAX) return false;
    const blob = await readLimited(res); if (!blob) return false;
    const cd = (res.headers.get('content-disposition') || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    let name = 'file'; try { name = cd ? decodeURIComponent(cd[1]) : decodeURIComponent(new URL(finalUrl).pathname.split('/').pop()); } catch { /* keep default */ }
    await api(p.token, 'sendDocument', form(base, { caption, document: new File([blob], fileName(name, 'file')) }), true);
    return true;
  } finally { clearTimeout(timer); }
}

function grab() {          // runs inside the page: returns a script-free copy of the HTML
  const c = document.documentElement.cloneNode(true);
  c.querySelectorAll('script').forEach((s) => s.remove());
  const head = c.querySelector('head');
  if (head) {
    const b = document.createElement('base'); b.href = location.href; head.prepend(b);
    const m = document.createElement('meta'); m.httpEquiv = 'Content-Security-Policy'; m.content = "script-src 'none'"; head.prepend(m);
  }
  return '<!doctype html>' + c.outerHTML;
}
async function pageHtml(tabId) {
  try {
    if (ext.scripting?.executeScript) return (await ext.scripting.executeScript({ target: { tabId }, func: grab }))[0].result;
    return (await ext.tabs.executeScript(tabId, { code: `(${grab.toString()})()` }))[0];
  } catch { throw new TgError("This page can't be copied (browser pages and some protected sites are blocked)."); }
}

async function callHelper(st, p, base, { url, caption }, kind) {
  const s = st.settings; let u;
  if (!s.helperEnabled) throw new TgError('Turn on the download helper in Settings → Helper.');
  try { u = new URL(s.helperUrl); } catch { throw new TgError('The helper address is invalid.'); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new TgError('The helper address must be http://127.0.0.1:PORT.');
  let res;
  try {
    res = await fetch(u.origin + '/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helper-Secret': s.helperSecret },
      body: JSON.stringify({ url, kind, token: p.token, chat_id: p.chatId, thread_id: base.message_thread_id || null, caption })
    });
  } catch { throw new TgError('Cannot reach the helper. Is it running?'); }
  if (res.status === 401 || res.status === 403) throw new TgError('Wrong helper secret. Copy it again in Settings → Helper.');
  if (!res.ok) throw new TgError('The helper rejected this link.');
}

async function log(p, entries) {
  const st = await ext.storage.local.get(['settings', 'history']);
  if (st.settings && st.settings.keepHistory === false) return;
  const max = st.settings?.historyMax || 300;
  const rows = entries.map((e) => ({ id: uid(), ts: Date.now(), profileId: p.id, ...e }));
  await ext.storage.local.set({ history: [...rows, ...(st.history || [])].slice(0, max) });
}

export async function send(job) {
  const st = await getState(), p = activeProfile(st);
  if (!p?.token || !p?.chatId) throw new TgError('Open Settings and connect your Telegram bot and group first.');
  if (!TOKEN_RE.test(p.token)) throw new TgError('The bot token looks invalid. Check Settings.');
  if (!CHAT_RE.test(p.chatId)) throw new TgError('The group ID looks invalid. Check Settings.');
  const catKey = p.cats.some((c) => c.key === job.catKey) ? job.catKey : p.cats[0]?.key;
  const base = { chat_id: p.chatId }; if (p.threads?.[catKey]) base.message_thread_id = p.threads[catKey];
  const note = clean(job.note, 300), mode = job.mode;

  if (mode === 'tabs') {
    const items = (job.items || []).map((i) => ({ url: safeUrl(i.url), title: clean(i.title, 120) })).filter((i) => i.url).slice(0, 200);
    if (!items.length) throw new TgError('No saveable tabs found.');
    const lines = items.map((i) => `• ${i.title || i.url}\n${i.url}`);
    const head = `📚 ${items.length} tabs${note ? ' — ' + note : ''}`;
    let chunk = head;
    const flush = async () => { await api(p.token, 'sendMessage', { ...base, text: chunk, link_preview_options: { is_disabled: true } }); };
    for (const l of lines) { if ((chunk + '\n\n' + l).length > 3800) { await flush(); chunk = ''; } chunk = chunk ? chunk + '\n\n' + l : l; }
    await flush();
    await log(p, items.map((i) => ({ url: i.url, title: i.title || i.url, catKey, mode: 'tabs', note })));
    return { msg: `${items.length} tabs sent to Telegram.`, badge: '✓' };
  }

  const url = safeUrl(job.url);
  if (!url) throw new TgError("This page can't be saved (only http and https links work).");
  const title = clean(job.title, 200) || url;
  const caption = [title, url, note].filter(Boolean).join('\n');

  if (['link', 'file', 'page', 'video', 'audio'].includes(mode) && st.settings.keepHistory && st.settings.dupWarn && !job.force) {
    const d = findDup(st, p.id, url);
    if (d) throw new DupError(`Already saved on ${new Date(d.ts).toLocaleDateString()}. Send again to save a duplicate.`);
  }

  let msg, badge = '✓', used = mode;
  if (mode === 'link') {
    await api(p.token, 'sendMessage', { ...base, text: caption.slice(0, 4000) }); msg = 'Link sent to Telegram.';
  } else if (mode === 'text') {
    const text = String(job.text || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 3000);
    if (!text) throw new TgError('No text selected.');
    await api(p.token, 'sendMessage', { ...base, text: `${text}\n\n— ${title}\n${url}${note ? '\n' + note : ''}`.slice(0, 4096) }); msg = 'Text sent to Telegram.';
  } else if (mode === 'file') {
    if (await uploadFile(p, base, url, caption.slice(0, 1000))) { msg = 'File sent to Telegram.'; badge = '⬇'; }
    else { await api(p.token, 'sendMessage', { ...base, text: caption.slice(0, 4000) }); msg = 'Sent as a link (not a downloadable file, or larger than 50 MB).'; used = 'link'; }
  } else if (mode === 'shot') {
    let dataUrl;
    try { dataUrl = await ext.tabs.captureVisibleTab(job.windowId ?? ext.windows.WINDOW_ID_CURRENT, { format: 'png' }); }
    catch { throw new TgError("Can't capture this page."); }
    const blob = await (await fetch(dataUrl)).blob();
    const cap = caption.slice(0, 1000);
    let done = false;
    if (blob.size < 9 * 1024 * 1024) { try { await api(p.token, 'sendPhoto', form(base, { caption: cap, photo: new File([blob], 'screenshot.png') }), true); done = true; } catch { /* retry as document */ } }
    if (!done) await api(p.token, 'sendDocument', form(base, { caption: cap, document: new File([blob], 'screenshot.png') }), true);
    msg = 'Screenshot sent to Telegram.';
  } else if (mode === 'page') {
    const html = await pageHtml(job.tabId);
    const blob = new Blob([html], { type: 'text/html' });
    if (blob.size > MAX) throw new TgError('This page is larger than 50 MB.');
    await api(p.token, 'sendDocument', form(base, { caption: caption.slice(0, 1000), document: new File([blob], fileName(title, 'page') + '.html') }), true);
    msg = 'Page copy sent to Telegram.';
  } else if (mode === 'video' || mode === 'audio') {
    await callHelper(st, p, base, { url, caption: caption.slice(0, 1000) }, mode);
    msg = 'Download started. It will appear in the topic when ready.'; badge = '…';
  } else throw new TgError('Unknown save mode.');

  await log(p, [{ url, title, catKey, mode: used, note }]);
  return { msg, badge };
}

export async function createTopics(profileId) {
  const st = await getState(), p = st.profiles.find((x) => x.id === profileId);
  if (!p || !TOKEN_RE.test(p.token) || !CHAT_RE.test(p.chatId)) throw new TgError('Enter a valid bot token and group ID first.');
  const chat = await api(p.token, 'getChat', { chat_id: p.chatId });
  if (!chat.is_forum) throw new TgError('Topics are off in this group. Open the group → Edit → turn on Topics.');
  let made = 0;
  for (const c of p.cats) {
    if (p.threads[c.key]) continue;
    const t = await api(p.token, 'createForumTopic', { chat_id: p.chatId, name: clean(`${c.icon} ${c.name}`, 120) });
    p.threads[c.key] = t.message_thread_id; made++;
    await setState({ profiles: st.profiles });
  }
  return made;
}
