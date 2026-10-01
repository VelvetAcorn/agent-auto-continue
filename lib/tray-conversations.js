'use strict';

// The conversations the menu-bar tray offers, from every harness that can list them.
// Opening the menu must never wait for a harness, and some harnesses start a process
// to list their conversations (Codex starts `codex app-server`), so the tray reads a
// cache that refreshes in the background: at most once per TTL for each harness, and
// only when something asks for it (launch, opening the menu, Refresh, a settings change).
// Each adapter's listConversations() already leaves out conversations another harness
// owns (owned_by_other_harness), archived ones and, by default, settled ones.

const { toErrorInfo } = require('./harnesses/errors');

// Conversations shown per harness, newest activity first.
const PER_HARNESS_LIMIT = 8;
// A harness is listed again at most this often unless the user asks for a refresh.
const REFRESH_TTL_MS = 5 * 60_000;
// A harness that has not answered by then is treated as disconnected until the next refresh.
const LIST_TIMEOUT_MS = 20_000;
const TITLE_LIMIT = 60;

const byRecent = (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);

/**
 * @param {object} options
 * @param {{ list: () => object[] }} options.harnesses The harness registry.
 * @param {() => void} [options.onChange] Called after a refresh changed what the tray would show.
 */
function createConversationCache({ harnesses, now = () => Date.now(), ttlMs = REFRESH_TTL_MS, timeoutMs = LIST_TIMEOUT_MS, limit = PER_HARNESS_LIMIT,
  onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  // harness id -> { conversations, total, fetchedAt, error, loading, again, generation }
  const entries = new Map();
  const listable = () => harnesses.list().filter((adapter) => adapter.capabilities?.canDiscoverConversations);
  const entryFor = (id) => {
    if (!entries.has(id)) entries.set(id, { conversations: [], total: 0, fetchedAt: null, error: null, loading: null, again: false, generation: 0 });
    return entries.get(id);
  };
  const fingerprint = () => {
    const view = snapshot();
    return JSON.stringify([view.loading, view.groups.map((group) => [group.harness, group.total, group.conversations.map((item) => [item.id, item.title, item.projectName, item.updatedAt])])]);
  };

  function withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => reject(Object.assign(new Error('The harness did not list its conversations in time.'), { code: 'timeout' })), timeoutMs);
      timer?.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimer(timer));
  }

  function refreshOne(adapter, force) {
    const entry = entryFor(adapter.id);
    if (entry.loading) { if (force) entry.again = true; return entry.loading; }
    if (!force && entry.fetchedAt !== null && now() - entry.fetchedAt < ttlMs) return Promise.resolve();
    const before = fingerprint();
    const generation = ++entry.generation;
    entry.loading = withTimeout(Promise.resolve().then(() => adapter.listConversations({ showSettled: false })))
      .then((list) => {
        if (generation !== entry.generation) return;
        const seen = new Set();
        const conversations = (Array.isArray(list) ? list : []).filter((item) => item && typeof item.id === 'string' && item.settled !== true && !seen.has(item.id) && seen.add(item.id)).sort(byRecent);
        Object.assign(entry, { conversations: conversations.slice(0, limit), total: conversations.length, error: null });
      }, (error) => {
        if (generation !== entry.generation) return;
        const info = toErrorInfo(error);
        Object.assign(entry, { conversations: [], total: 0, error: { code: info.code, message: info.message } });
      })
      .finally(() => {
        entry.fetchedAt = now();
        entry.loading = null;
        if (fingerprint() !== before) { try { onChange(); } catch { /* The menu is rebuilt on the next change. */ } }
        if (entry.again) { entry.again = false; void refreshOne(adapter, true); }
      });
    return entry.loading;
  }

  /** Starts a background refresh of stale harnesses, or of all of them with `force`. Never rejects. */
  function refresh({ force = false } = {}) {
    return Promise.all(listable().map((adapter) => refreshOne(adapter, force))).then(() => undefined);
  }

  /**
   * What the tray shows now, without waiting: `groups` holds every harness that answered with at least
   * one conversation, in registry order; disconnected, unconfigured and empty harnesses are left out.
   * `loading` is true until every harness has answered once.
   */
  function snapshot() {
    const groups = [];
    let loading = false;
    for (const adapter of listable()) {
      const entry = entries.get(adapter.id);
      if (!entry || entry.fetchedAt === null) { loading = true; continue; }
      if (entry.error || !entry.conversations.length) continue;
      groups.push({ harness: adapter.id, label: adapter.label, noun: adapter.conversationNoun, conversations: entry.conversations, total: entry.total });
    }
    return { groups, loading };
  }

  return { refresh, snapshot };
}

const clip = (text, max = TITLE_LIMIT) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Menu template entries for "Schedule from a conversation": one section per harness with a
 * disabled heading, its most recent conversations, and how many more the window lists.
 * @param {{ groups: object[], loading: boolean }} snapshot
 * @param {{ schedule: (conversation: object) => void, showAll: () => void }} actions
 */
function conversationMenuItems({ groups, loading }, { schedule, showAll }) {
  if (!groups.length) {
    return [{ label: loading ? 'Looking for conversations…' : 'No connected agent has conversations. Check Settings.', enabled: false },
      { label: 'Show all conversations…', click: showAll }];
  }
  const items = [];
  for (const group of groups) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: group.label, enabled: false });
    for (const conversation of group.conversations) {
      const title = conversation.title || '(Untitled)';
      items.push({ label: clip(title), sublabel: conversation.projectName || conversation.projectId || '', click: () => schedule({ ...conversation, harness: group.harness, title }) });
    }
    const more = group.total - group.conversations.length;
    if (more > 0) items.push({ label: `${plural(more, `more ${group.noun}`)} in the window`, enabled: false });
  }
  items.push({ type: 'separator' }, { label: 'Show all conversations…', click: showAll });
  return items;
}

/** The status line under the app name: which harnesses the tray lists conversations from. */
function connectionLabel({ groups, loading }) {
  if (groups.length) return `Conversations from ${groups.map((group) => group.label).join(', ')}`;
  return loading ? 'Looking for conversations…' : 'No connected agent has conversations';
}

module.exports = { LIST_TIMEOUT_MS, PER_HARNESS_LIMIT, REFRESH_TTL_MS, connectionLabel, conversationMenuItems, createConversationCache };
