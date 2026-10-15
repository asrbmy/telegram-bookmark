import { ext, uid, normUrl } from './ext.js';

export const DEFAULT_CATS = [
  { key: 'videos', name: 'Videos', icon: '🎬' },
  { key: 'music', name: 'Music', icon: '🎵' },
  { key: 'websites', name: 'Websites', icon: '🌐' },
  { key: 'documents', name: 'Documents', icon: '📄' },
  { key: 'images', name: 'Images', icon: '🖼️' },
  { key: 'later', name: 'Read later', icon: '📌' }
];
export const DEFAULT_SETTINGS = {
  dupWarn: true, keepHistory: true, historyMax: 300,
  helperEnabled: false, helperUrl: 'http://127.0.0.1:8765', helperSecret: ''
};
export const newProfile = (name = 'Main') =>
  ({ id: uid(), name, token: '', chatId: '', cats: structuredClone(DEFAULT_CATS), threads: {} });

export async function getState() {
  const s = await ext.storage.local.get(null);
  if (!Array.isArray(s.profiles) || !s.profiles.length) {            // first run or upgrade from v1
    const p = newProfile('Main');
    Object.assign(p, { token: s.token || '', chatId: s.chatId || '', cats: s.cats || p.cats, threads: s.threads || {} });
    const fresh = { profiles: [p], activeId: p.id, rules: [], settings: { ...DEFAULT_SETTINGS }, history: [] };
    await ext.storage.local.set(fresh);
    await ext.storage.local.remove(['token', 'chatId', 'cats', 'threads']);
    return fresh;
  }
  return {
    activeId: s.profiles[0].id, rules: [], history: [], ...s,
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) }
  };
}
export const setState = (patch) => ext.storage.local.set(patch);
export const activeProfile = (s) => s.profiles.find((p) => p.id === s.activeId) || s.profiles[0];

export function findDup(st, profileId, url) {
  const n = normUrl(url);
  return (st.history || []).find((e) =>
    e.profileId === profileId && ['link', 'file', 'page', 'video', 'audio'].includes(e.mode) && normUrl(e.url) === n) || null;
}
