import { ext, actionApi, pickCategory } from './ext.js';
import { getState, activeProfile } from './store.js';
import { send, DupError } from './tg.js';

let chain = Promise.resolve();
const queueMenus = () => (chain = chain.then(buildMenus).catch(() => {}));

async function buildMenus() {
  const st = await getState(), p = activeProfile(st);
  await ext.contextMenus.removeAll();
  const all = ['page', 'link', 'image', 'video', 'audio', 'selection'];
  ext.contextMenus.create({ id: 'root', title: 'Save to Telegram', contexts: all });
  (p?.cats || []).forEach((c) => ext.contextMenus.create({ id: 'cat:' + c.key, parentId: 'root', title: `${c.icon} ${c.name}`, contexts: all }));
  ext.contextMenus.create({ id: 'sep', parentId: 'root', type: 'separator', contexts: all });
  ext.contextMenus.create({ id: 'dl', parentId: 'root', title: '⬇️ Download file instead', contexts: ['link', 'image', 'video', 'audio'] });
  if (st.settings.helperEnabled) {
    ext.contextMenus.create({ id: 'hv', parentId: 'root', title: '🎞 Download video (helper)', contexts: ['page', 'link', 'video'] });
    ext.contextMenus.create({ id: 'ha', parentId: 'root', title: '🎧 Download audio (helper)', contexts: ['page', 'link', 'video', 'audio'] });
  }
}
queueMenus();
ext.runtime.onInstalled?.addListener(queueMenus);
ext.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.profiles || ch.activeId || ch.settings)) queueMenus(); });

const quiet = (v) => Promise.resolve(v).catch(() => {});
function flash(text, color) {
  quiet(actionApi.setBadgeBackgroundColor({ color }));
  quiet(actionApi.setBadgeText({ text }));
  setTimeout(() => quiet(actionApi.setBadgeText({ text: '' })), 2500);
}

async function run(job) {
  try { const r = await send(job); flash(r.badge, '#1e8e3e'); return { ok: true, msg: r.msg }; }
  catch (e) {
    const dup = e instanceof DupError;
    flash(dup ? '=' : '!', dup ? '#e37400' : '#d93025');
    return { ok: false, dup, error: e?.message || 'Something went wrong.' };
  }
}

ext.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  if (id === 'root' || id === 'sep') return;
  const st = await getState(), p = activeProfile(st);
  const onTarget = !!(info.linkUrl || info.srcUrl);
  const url = info.linkUrl || info.srcUrl || info.pageUrl || tab?.url;
  const title = onTarget && info.selectionText ? info.selectionText : (tab?.title || url);
  const auto = pickCategory(url || '', st.rules, p?.cats || []);
  let job;
  if (id.startsWith('cat:')) job = { catKey: id.slice(4), mode: info.selectionText && !onTarget ? 'text' : 'link' };
  else if (id === 'dl') job = { catKey: auto, mode: 'file' };
  else if (id === 'hv') job = { catKey: auto, mode: 'video' };
  else if (id === 'ha') job = { catKey: auto, mode: 'audio' };
  else return;
  run({ ...job, url, title, text: info.selectionText, tabId: tab?.id, windowId: tab?.windowId });
});

ext.commands?.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'quick-save') return;
  tab = tab || (await ext.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) return;
  const st = await getState(), p = activeProfile(st);
  run({ url: tab.url, title: tab.title, catKey: pickCategory(tab.url || '', st.rules, p?.cats || []), mode: 'link' });
});

ext.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== ext.runtime.id || msg?.type !== 'save') return false;   // only our own pages
  run(msg.job).then(reply);
  return true;
});
