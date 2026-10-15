import { ext, safeUrl, pickCategory } from './ext.js';
import { h, icon, timeAgo } from './dom.js';
import { getState, setState, activeProfile, findDup } from './store.js';

const app = document.getElementById('app');
let st, p, tab, tabs = [], view = 'save', cat, mode = 'link', extra = false, dup = null, busy = false, q = '', noteText = '', statusEl;

async function init() {
  [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  await reload();
  extra = await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (extra) tabs = (await ext.tabs.query({ currentWindow: true })).filter((t) => safeUrl(t.url));
  defaults(); render();
}
async function reload() { st = await getState(); p = activeProfile(st); }
function defaults() {
  const url = safeUrl(tab?.url);
  cat = url ? pickCategory(url, st.rules, p?.cats || []) : p?.cats?.[0]?.key;
  mode = url && extra && /\.(pdf|docx?|xlsx?|pptx?|zip|mp3|m4a|mp4|jpe?g|png|webp|epub)$/i.test(new URL(url).pathname) ? 'file' : 'link';
  dup = url && st.settings.keepHistory && st.settings.dupWarn ? findDup(st, p?.id, url) : null;
}
const setStatus = (t, kind = '') => { if (statusEl) { statusEl.textContent = t; statusEl.className = 'status ' + kind; } };
const catOf = (key) => p?.cats.find((c) => c.key === key);

function header() {
  const sel = st.profiles.length > 1 && h('select', { 'aria-label': 'Telegram group', onchange: async (e) => { await setState({ activeId: e.target.value }); await reload(); defaults(); render(); } },
    st.profiles.map((x) => h('option', { value: x.id, selected: x.id === p.id }, x.name)));
  return h('div', { class: 'top' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('send', 15)), 'Telegram Saver'),
    sel, h('button', { class: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', onclick: () => { ext.runtime.openOptionsPage(); window.close(); } }, icon('sliders')));
}

function pageCard() {
  const url = safeUrl(tab?.url), fav = tab?.favIconUrl;
  const img = fav && (safeUrl(fav) || fav.startsWith('data:image/')) ? h('img', { src: fav, alt: '', onerror: (e) => e.target.remove() }) : null;
  return h('div', { class: 'card page' },
    h('div', { class: 'fav' }, img, !img && (url ? new URL(url).hostname[0].toUpperCase() : '!')),
    h('div', {}, h('div', { class: 'page-title' }, tab?.title || tab?.url || 'No page'), h('div', { class: 'page-host' }, url ? new URL(url).hostname : 'This page can’t be saved')));
}

function modes() {
  const m = [['link', 'Link', 'Send the link'], ['file', 'File', extra ? 'Download the file and upload it' : 'Enable Advanced access in Settings → Features'],
    ['shot', 'Shot', 'Screenshot of the visible area'], ['page', 'Page', 'Save an HTML copy of this page']];
  if (st.settings.helperEnabled) m.push(['video', 'Video', 'Download video with the helper'], ['audio', 'MP3', 'Download audio with the helper']);
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Save as' }, m.map(([k, label, tip]) =>
    h('button', { role: 'radio', 'aria-checked': String(mode === k), title: tip, disabled: k === 'file' && !extra, onclick: () => { mode = k; render(); } }, label)));
}

async function doSend(job) {
  busy = true; render(); setStatus('Sending…');
  const r = await ext.runtime.sendMessage({ type: 'save', job }).catch(() => null);
  busy = false;
  await reload();
  const url = safeUrl(tab?.url);
  dup = url && st.settings.keepHistory && st.settings.dupWarn ? findDup(st, p?.id, url) : null;
  render();
  if (r?.ok) { noteText = ''; setStatus(r.msg, 'ok'); }
  else if (r?.dup) { dup = dup || { ts: Date.now() }; render(); setStatus(r.error, 'err'); }
  else setStatus(r?.error || 'Something went wrong.', 'err');
}

function saveView() {
  const url = safeUrl(tab?.url);
  if (!p?.token || !p?.chatId) return h('div', { class: 'empty' }, h('h2', {}, 'Connect Telegram'), 'Add your bot token and group to start saving.',
    h('div', {}, h('button', { class: 'btn primary', onclick: () => { ext.runtime.openOptionsPage(); window.close(); } }, 'Open Settings')));
  const note = h('input', { type: 'text', placeholder: 'Add a note or #tags (optional)', maxLength: 300, 'aria-label': 'Note', value: noteText, oninput: (e) => { noteText = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter' && url && !busy) go(); } });
  const go = () => doSend({ url: tab.url, title: tab.title, catKey: cat, mode, note: noteText, tabId: tab.id, windowId: tab.windowId, force: !!dup });
  statusEl = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  return h('div', { class: 'main' },
    pageCard(),
    dup && h('div', { class: 'banner' }, `Already saved ${timeAgo(dup.ts)}${catOf(dup.catKey) ? ' in ' + catOf(dup.catKey).name : ''}. Sending again creates a duplicate.`),
    h('div', {}, h('div', { class: 'label' }, 'Topic'), h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Topic' }, p.cats.map((c) =>
      h('button', { class: 'chip', role: 'radio', 'aria-checked': String(c.key === cat), onclick: () => { cat = c.key; render(); } }, `${c.icon} ${c.name}`)))),
    h('div', {}, h('div', { class: 'label' }, 'Save as'), modes()),
    note,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', disabled: !url || busy, onclick: go }, busy ? 'Sending…' : dup ? 'Send again' : 'Send to Telegram'),
      extra && tabs.length > 1 && h('button', { class: 'btn text', disabled: busy, onclick: () => doSend({ mode: 'tabs', catKey: cat, note: noteText, items: tabs.map((t) => ({ url: t.url, title: t.title })) }) }, `Save all ${tabs.length} tabs`)),
    statusEl);
}

function historyView() {
  const list = h('div', { class: 'hist' });
  const fill = () => {
    const rows = (st.history || []).filter((e) => e.profileId === p?.id && (!q || `${e.title} ${e.url} ${e.note || ''}`.toLowerCase().includes(q))).slice(0, 60);
    list.replaceChildren(...(rows.length ? rows.map((e) => h('div', { class: 'card item' },
      h('div', { class: 'item-icon' }, catOf(e.catKey)?.icon || '📁'),
      h('div', { class: 'item-body' }, h('div', { class: 'item-title', title: e.title }, e.title), h('div', { class: 'item-meta' }, `${timeAgo(e.ts)} · ${e.mode}${e.note ? ' · ' + e.note : ''}`)),
      safeUrl(e.url) && h('a', { class: 'icon-btn', href: safeUrl(e.url), target: '_blank', rel: 'noopener noreferrer', title: 'Open', 'aria-label': 'Open link' }, icon('external', 16)),
      h('button', { class: 'icon-btn', title: 'Send again', 'aria-label': 'Send again', onclick: async () => {
        setStatus('Sending…'); const r = await ext.runtime.sendMessage({ type: 'save', job: { url: e.url, title: e.title, catKey: e.catKey, mode: 'link', note: e.note, force: true } }).catch(() => null);
        await reload(); fill(); setStatus(r?.ok ? 'Sent again.' : r?.error || 'Failed.', r?.ok ? 'ok' : 'err'); } }, icon('refresh', 16))))
      : [h('div', { class: 'empty' }, st.settings.keepHistory ? 'Nothing saved yet.' : 'History is turned off in Settings.')]));
  };
  fill();
  statusEl = h('div', { class: 'status', role: 'status' });
  return h('div', { class: 'main' },
    h('div', { class: 'search' }, icon('search', 16), h('input', { type: 'text', placeholder: 'Search history', 'aria-label': 'Search history', value: q, oninput: (e) => { q = e.target.value.toLowerCase(); fill(); } })),
    list, statusEl);
}

function nav() {
  return h('div', { class: 'seg nav', role: 'tablist' }, [['save', 'Save'], ['history', 'History']].map(([k, l]) =>
    h('button', { role: 'tab', 'aria-selected': String(view === k), onclick: () => { view = k; render(); } }, l)));
}

function render() { app.replaceChildren(header(), view === 'save' ? saveView() : historyView(), nav()); }
init();
