import { ext, clean, normHost, uid, TOKEN_RE, CHAT_RE } from './ext.js';
import { h, icon } from './dom.js';
import { getState, setState, activeProfile, newProfile, DEFAULT_SETTINGS } from './store.js';
import { api, createTopics } from './tg.js';

const app = document.getElementById('app'), toastEl = document.getElementById('toast');
let S, section = 'account', granted = false, toastT;
const SECTIONS = [['account', 'Account'], ['topics', 'Topics'], ['rules', 'Site rules'], ['features', 'Features'], ['helper', 'Helper'], ['history', 'History'], ['about', 'About']];

const toast = (t) => { toastEl.textContent = t; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 1400); };
const persist = async () => { await setState({ profiles: S.profiles, activeId: S.activeId, rules: S.rules, settings: S.settings }); toast('Saved'); };
const prof = () => activeProfile(S);
const group = (...rows) => h('div', { class: 'group' }, rows);
const row = (label, ctl, desc) => h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('div', { class: 'row-label' }, label), desc && h('div', { class: 'row-desc' }, desc)), ctl);
const ctl = (...k) => h('div', { class: 'ctl' }, k);
const page = (title, sub, ...k) => h('main', { class: 'content' }, h('h2', {}, title), h('p', { class: 'sub' }, sub), k);
const result = () => h('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
const line = (box, items) => box.replaceChildren(...items.map(([k, t]) => h('div', { class: k }, (k === 'ok' ? '✓ ' : k === 'err' ? '✕ ' : '! ') + t)));

function account() {
  const p = prof(), out = result();
  const token = h('input', { type: 'password', value: p.token, autocomplete: 'off', spellcheck: false, placeholder: '123456789:AA…', 'aria-label': 'Bot token' });
  const chat = h('input', { type: 'text', value: p.chatId, autocomplete: 'off', placeholder: '-100…', 'aria-label': 'Group ID' });
  token.onchange = () => { const v = token.value.trim(); if (v && !TOKEN_RE.test(v)) return line(out, [['err', 'That does not look like a bot token. It should look like 123456789:AAH…']]); p.token = v; out.replaceChildren(); persist(); };
  chat.onchange = () => { const v = chat.value.trim(); if (v && !CHAT_RE.test(v)) return line(out, [['err', 'Group ID should be a number like -1001234567890.']]); p.chatId = v; out.replaceChildren(); persist(); };
  const choose = (c) => { p.chatId = String(c.id); chat.value = p.chatId; persist(); line(out, [['ok', `Group selected: ${c.title}`]]); };

  const find = async () => {
    try {
      const t = token.value.trim(); if (!TOKEN_RE.test(t)) return line(out, [['err', 'Enter a valid bot token first.']]);
      const chats = new Map();
      for (const u of await api(t, 'getUpdates', { limit: 100 })) { const c = (u.message || u.my_chat_member || u.edited_message || {}).chat; if (c && /group/.test(c.type)) chats.set(c.id, c); }
      if (!chats.size) return line(out, [['warn', 'No group found yet. Add the bot to your group, send a message there, then try again.']]);
      if (chats.size === 1) return choose([...chats.values()][0]);
      out.replaceChildren(h('div', {}, 'Choose your group:'), ...[...chats.values()].map((c) => h('button', { class: 'btn', onclick: () => choose(c) }, c.title)));
    } catch (e) { line(out, [['err', e.message]]); }
  };
  const test = async () => {
    try {
      if (!TOKEN_RE.test(p.token) || !CHAT_RE.test(p.chatId)) return line(out, [['err', 'Enter a valid bot token and group ID first.']]);
      const me = await api(p.token, 'getMe', {}), chatInfo = await api(p.token, 'getChat', { chat_id: p.chatId });
      const items = [['ok', `Bot @${me.username} is valid`], ['ok', `Group found: ${chatInfo.title}`], [chatInfo.is_forum ? 'ok' : 'warn', chatInfo.is_forum ? 'Topics are enabled' : 'Topics are off — enable them in the group settings']];
      const m = await api(p.token, 'getChatMember', { chat_id: p.chatId, user_id: me.id }).catch(() => null);
      items.push(m?.status === 'administrator' && m.can_manage_topics ? ['ok', 'Bot is an admin and can manage topics'] : ['warn', 'Make the bot an admin with the “Manage topics” permission']);
      line(out, items);
    } catch (e) { line(out, [['err', e.message]]); }
  };
  const reveal = h('button', { class: 'btn', type: 'button', onclick: () => { token.type = token.type === 'password' ? 'text' : 'password'; reveal.textContent = token.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');

  return page('Account', 'Connect your Telegram bot and group. Use one profile per group.',
    group(
      row('Group profile', ctl(h('select', { 'aria-label': 'Profile', onchange: (e) => { S.activeId = e.target.value; persist(); render(); } }, S.profiles.map((x) => h('option', { value: x.id, selected: x.id === p.id }, x.name))))),
      row('Profile name', ctl(h('input', { type: 'text', value: p.name, maxLength: 40, 'aria-label': 'Profile name', onchange: (e) => { p.name = clean(e.target.value, 40) || 'Main'; persist(); render(); } }))),
      row('Bot token', ctl(token, reveal), 'From @BotFather. Stored only on this device.'),
      row('Group ID', ctl(chat), 'Starts with -100 for supergroups.')),
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', onclick: find }, 'Find my group'), h('button', { class: 'btn', onclick: test }, 'Test connection'),
      h('button', { class: 'btn', onclick: () => { const n = newProfile(`Group ${S.profiles.length + 1}`); S.profiles.push(n); S.activeId = n.id; persist(); render(); } }, 'New profile'),
      S.profiles.length > 1 && h('button', { class: 'btn danger', onclick: () => { if (!confirm(`Delete profile “${p.name}”? Its saved history stays hidden.`)) return; S.profiles = S.profiles.filter((x) => x.id !== p.id); S.activeId = S.profiles[0].id; persist(); render(); } }, 'Delete profile')),
    out,
    group(row('Setup steps', h('div', { class: 'row-desc', style: 'max-width:340px' }, '1) @BotFather → /newbot → copy the token. 2) Create a group and turn on Topics. 3) Add the bot as admin with Manage topics. 4) Send a message in the group, then press “Find my group”.'))));
}

function topics() {
  const p = prof(), out = result();
  const list = p.cats.map((c, i) => h('div', { class: 'grid3' },
    h('input', { type: 'text', value: c.icon, maxLength: 4, 'aria-label': 'Icon', onchange: (e) => { c.icon = clean(e.target.value, 4) || '📁'; persist(); } }),
    h('input', { type: 'text', value: c.name, maxLength: 30, 'aria-label': 'Name', onchange: (e) => { c.name = clean(e.target.value, 30) || 'Topic'; persist(); } }),
    h('input', { type: 'text', value: p.threads[c.key] || '', placeholder: 'Topic ID', 'aria-label': `${c.name} topic ID`, inputMode: 'numeric', onchange: (e) => { const v = e.target.value.trim(); if (/^\d+$/.test(v)) p.threads[c.key] = +v; else delete p.threads[c.key]; persist(); } }),
    h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${c.name}`, onclick: () => { p.cats.splice(i, 1); delete p.threads[c.key]; persist(); render(); } }, icon('trash', 16))));
  const ni = h('input', { type: 'text', placeholder: '📚', maxLength: 4, 'aria-label': 'New icon' }), nn = h('input', { type: 'text', placeholder: 'New topic name', maxLength: 30, 'aria-label': 'New topic name' });
  const add = () => { const name = clean(nn.value, 30); if (!name) return; p.cats.push({ key: 'c' + uid().slice(0, 8), name, icon: clean(ni.value, 4) || '📁' }); persist(); render(); };
  nn.onkeydown = (e) => { if (e.key === 'Enter') add(); };
  return page('Topics', `Each topic is a category in “${p.name}”. Topic IDs are filled in automatically.`,
    h('div', { class: 'group' }, list, h('div', { class: 'grid3' }, ni, nn, h('span'), h('button', { class: 'icon-btn', title: 'Add', 'aria-label': 'Add topic', onclick: add }, icon('plus', 16)))),
    h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: async () => {
      try { await persist(); const n = await createTopics(p.id); S = await getState(); render(); line(document.querySelector('.result'), [['ok', n ? `Created ${n} topic(s) in Telegram.` : 'All topics already exist.']]); }
      catch (e) { line(out, [['err', e.message]]); } } }, 'Create missing topics in Telegram')), out);
}

function rules() {
  const p = prof(), nh = h('input', { type: 'text', placeholder: 'example.com', 'aria-label': 'Website' });
  const ns = h('select', { 'aria-label': 'Topic' }, p.cats.map((c) => h('option', { value: c.key }, `${c.icon} ${c.name}`)));
  const add = () => { const host = normHost(nh.value); if (!host) return; S.rules = S.rules.filter((r) => r.host !== host); S.rules.push({ host, catKey: ns.value }); persist(); render(); };
  nh.onkeydown = (e) => { if (e.key === 'Enter') add(); };
  return page('Site rules', 'Always send a website (and its subdomains) to a chosen topic.',
    h('div', { class: 'group' }, S.rules.map((r, i) => h('div', { class: 'grid3 rules' }, h('span', {}, r.host), h('span', {}, p.cats.find((c) => c.key === r.catKey)?.name || '— missing topic —'),
      h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove rule ${r.host}`, onclick: () => { S.rules.splice(i, 1); persist(); render(); } }, icon('trash', 16)))),
      h('div', { class: 'grid3 rules' }, nh, ns, h('button', { class: 'icon-btn', title: 'Add', 'aria-label': 'Add rule', onclick: add }, icon('plus', 16)))));
}

function features() {
  const s = S.settings, sw = (key) => h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: s[key], onchange: (e) => { s[key] = e.target.checked; persist(); } });
  const adv = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: granted, onchange: async (e) => {
    try { if (e.target.checked) e.target.checked = await ext.permissions.request({ origins: ['<all_urls>'] }); else await ext.permissions.remove({ origins: ['<all_urls>'] }); }
    catch { e.target.checked = false; }
    granted = e.target.checked; toast(granted ? 'Advanced access on' : 'Advanced access off'); } });
  const max = h('select', { 'aria-label': 'History size', onchange: (e) => { s.historyMax = +e.target.value; persist(); } }, [100, 300, 1000].map((n) => h('option', { value: n, selected: s.historyMax === n }, `${n} items`)));
  return page('Features', 'Everything stays on this device.',
    group(
      row('Advanced access', adv, 'Needed to download files and to save all open tabs. Asks the browser for access to all websites. Off by default.'),
      row('Duplicate warning', sw('dupWarn'), 'Warn if you already saved the same link.'),
      row('Keep history', sw('keepHistory'), 'Powers search, re-send and the duplicate warning.'),
      row('History size', ctl(max))),
    group(row('Keyboard shortcut', h('code', {}, 'Alt + Shift + S'), 'Saves the current page to its detected topic. Change it at chrome://extensions/shortcuts, edge://extensions/shortcuts, or in Firefox: Add-ons → ⚙ → Manage Extension Shortcuts.')));
}

function helper() {
  const s = S.settings, out = result();
  const url = h('input', { type: 'text', value: s.helperUrl, 'aria-label': 'Helper address', onchange: (e) => { s.helperUrl = e.target.value.trim(); persist(); } });
  const sec = h('input', { type: 'password', value: s.helperSecret, autocomplete: 'off', 'aria-label': 'Helper secret', onchange: (e) => { s.helperSecret = e.target.value.trim(); persist(); } });
  return page('Helper', 'A small program on your computer that downloads YouTube and other videos with yt-dlp and uploads them to Telegram.',
    group(
      row('Enable helper', h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: s.helperEnabled, onchange: (e) => { s.helperEnabled = e.target.checked; persist(); } }), 'Adds Video and MP3 buttons and menu items.'),
      row('Address', ctl(url)), row('Secret', ctl(sec), 'Printed when the helper starts.')),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: async () => {
      try { const u = new URL(s.helperUrl); const r = await fetch(u.origin + '/health', { headers: { 'X-Helper-Secret': s.helperSecret } });
        if (r.status === 401 || r.status === 403) return line(out, [['err', 'The helper is running but the secret is wrong.']]);
        const j = await r.json(); line(out, [['ok', 'Helper is running'], [j.yt_dlp ? 'ok' : 'warn', j.yt_dlp ? 'yt-dlp found' : 'yt-dlp is not installed'], [j.ffmpeg ? 'ok' : 'warn', j.ffmpeg ? 'ffmpeg found (MP3 works)' : 'ffmpeg missing — MP3 and merged video need it']]);
      } catch { line(out, [['err', 'Cannot reach the helper. Is it running?']]); } } }, 'Test helper')), out);
}

function history() {
  const out = result();
  return page('History', `${S.history.length} saved item(s).`,
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(S.history, null, 2)], { type: 'application/json' })), download: 'telegram-saver-history.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); } }, 'Export JSON'),
      h('button', { class: 'btn danger', onclick: async () => { if (!confirm('Clear all saved history?')) return; S.history = []; await setState({ history: [] }); toast('History cleared'); render(); } }, 'Clear history')), out);
}

function about() {
  return page('About', `Telegram Saver ${ext.runtime.getManifest().version}`,
    group(row('Privacy', h('div', { class: 'row-desc', style: 'max-width:380px' }, 'Your bot token, groups, rules and history are stored only in this browser. The extension talks only to api.telegram.org and, if you enable it, your own helper on 127.0.0.1. No analytics.')),
      row('Tip', h('div', { class: 'row-desc', style: 'max-width:380px' }, 'Anyone with your bot token can control the bot. If it leaks, revoke it with /revoke in @BotFather.'))));
}

const VIEWS = { account, topics, rules, features, helper, history, about };
function render() {
  app.replaceChildren(
    h('nav', { class: 'side', 'aria-label': 'Settings sections' }, h('h1', {}, h('span', { class: 'logo' }, icon('send', 15)), 'Telegram Saver'),
      SECTIONS.map(([k, l]) => h('button', { 'aria-current': k === section ? 'page' : null, onclick: () => { section = k; render(); } }, l))),
    VIEWS[section]());
}
S = await getState();
granted = await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
render();
