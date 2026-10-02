(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Compose = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Pure helpers for the one-screen interface: what the chips mean, what Edit may change, the plan
  // sentence under the Continue button, the meta line of a queued row, the merged conversation list
  // and the status of each agent in the header. No DOM here, so node:test covers them directly.
  const WHEN = Object.freeze([['5', '5 min'], ['30', '30 min'], ['60', '1 hour'], ['tomorrow', 'Tomorrow 9:00'], ['available', 'When free'], ['custom', 'Custom…']]);
  const QUICK = new Set(['5', '30', '60', 'tomorrow']);

  // Turns a draft into the schedule request's time fields. Quick chips are resolved from `now`,
  // so "5 min" means five minutes after pressing Continue, not after opening the app.
  function resolveWhen(draft, time, now = Date.now()) {
    if (draft.when === 'available') return { trigger: 'available' };
    const trigger = draft.waitIfLimited ? 'time-then-available' : 'time';
    if (QUICK.has(draft.when)) {
      const wall = time.quickTime(draft.when, draft.timeZone, now);
      return { trigger, whenISO: time.resolveWallTime(wall.date, wall.time, draft.timeZone, '', now).iso };
    }
    return { trigger, whenISO: time.resolveWallTime(draft.date, draft.time, draft.timeZone, draft.occurrence, now).iso };
  }

  function farLabel(draft) {
    const phrase = draft.far !== 'once' && typeof draft.stopPhrase === 'string' && draft.stopPhrase.trim() ? `, or at “${draft.stopPhrase.trim()}”` : '';
    if (draft.far === 'until') return `until done${phrase}`;
    if (draft.far === 'upto') {
      const limit = Number(draft.turnLimit);
      return `${Number.isInteger(limit) && limit >= 1 ? `up to ${limit} ${limit === 1 ? 'turn' : 'turns'}` : 'up to ? turns'}${phrase}`;
    }
    return 'once';
  }

  // What Edit may change: everything until anything has been sent, then only the stop phrase of a
  // continuation that is running or paused and may send more than one turn, and nothing once it ended.
  function editScope(job, { stopPhrase = false } = {}) {
    const status = job.deliveryStatus || job.status;
    const auto = job.automation;
    if (status === 'pending' && (!auto || (auto.state === 'active' && auto.currentTurn === 1))) return 'all';
    if (auto && ['active', 'paused'].includes(auto.state) && auto.limit !== 1 && stopPhrase) return 'stopPhrase';
    return null;
  }
  // The edit Save changes sends when only the stop phrase may change, so every other setting stays as saved.
  function stopPhraseEdit(draft) {
    return { stopPhrase: String(draft.stopPhrase ?? '').trim() || null };
  }

  // One line that says exactly what Continue will do.
  function planSentence({ draft, label, availability, time, display, now = Date.now(), supportsTurns = true }) {
    if (draft.editScope === 'stopPhrase') return `From the next finished turn · ${farLabel(draft)}`;
    const far = supportsTurns ? ` · ${farLabel(draft)}` : '';
    if (draft.when === 'available') {
      const reset = availability?.state === 'limited' && availability.resetsAt ? `, around ${display(availability.resetsAt, draft.timeZone, 'time')}` : '';
      return `When ${label} is free${reset}${far}`;
    }
    const wait = draft.waitIfLimited ? ', or when free if limited' : '';
    if (QUICK.has(draft.when)) {
      const text = { 5: 'In 5 minutes', 30: 'In 30 minutes', 60: 'In 1 hour' }[draft.when];
      if (text) return `${text}${wait}${far}`;
      try { const wall = time.quickTime('tomorrow', draft.timeZone, now); return `Tomorrow ${wall.time}${wait}${far}`; } catch { return `Tomorrow 09:00${far}`; }
    }
    try {
      const candidates = time.wallTimeCandidates(draft.date, draft.time, draft.timeZone);
      if (!candidates.length) return 'That time does not exist when the clocks move forward. Choose another time.';
      const chosen = candidates.length === 1 ? candidates[0] : candidates.find((item) => item.iso === draft.occurrence);
      if (!chosen) return 'This time occurs twice. Choose which one to use.';
      return `${display(chosen.iso, draft.timeZone, 'full')}${wait}${far}`;
    } catch (error) {
      return String(error?.message || 'Choose a valid date and time.');
    }
  }

  // The second line of a queued row. `labelled: false` leaves the status to a pill beside the row.
  function queueMeta(job, { display, relative, localZone, labelled = true }) {
    const status = job.displayStatus || job.deliveryStatus || job.status;
    const zone = job.timeZone || localZone;
    const auto = job.automation;
    const far = auto ? (auto.unlimited ? 'until done' : auto.limit === 1 ? 'once' : `up to ${auto.limit} turns`) : 'once';
    if (status === 'running') return `${auto ? auto.progressLabel.replace(/^Turn/, 'Running turn') : 'Agent working'} · sent ${display(job.dispatchedAt || job.updatedAt, zone, 'time')}`;
    if (status === 'dispatching') return 'Sending…';
    if (status === 'waiting') return `${job.deliveryLabel || 'Waiting'}${auto ? ` · ${auto.progressLabel.toLowerCase()}` : ''}`;
    if (status === 'pending') return `${relative(job.effectiveAt || job.scheduleAt)} · ${far}${auto && auto.currentTurn > 1 ? ` · ${auto.progressLabel.toLowerCase()}` : ''}`;
    const when = display(job.updatedAt || job.scheduleAt, zone, 'short');
    const labels = { sent: 'Done', failed: 'Failed', canceled: 'Canceled', unconfirmed: 'Delivery unconfirmed', paused: 'Paused', stopped: 'Stopped', finished: 'Done' };
    const detail = status === 'paused' && auto?.reason ? ` · ${auto.reason}` : status === 'failed' && job.error?.message ? ` · ${job.error.message}` : auto && ['finished', 'stopped'].includes(status) ? ` · ${auto.sentTurns} ${auto.sentTurns === 1 ? 'turn' : 'turns'}` : '';
    return `${labelled ? `${labels[status] || status} ` : ''}${when}${detail}`;
  }

  // Every visible agent's conversations in one list, newest first. Each entry keeps its harness.
  function mergeConversations(sources, { showSettled = false, query = '' } = {}) {
    const needle = query.trim().toLocaleLowerCase();
    const rows = [];
    for (const source of sources) {
      for (const thread of source.threads || []) {
        if (!showSettled && thread.settled === true) continue;
        if (needle && !`${thread.title} ${thread.projectName || thread.projectId || ''}`.toLocaleLowerCase().includes(needle)) continue;
        rows.push({ ...thread, harness: source.harness, harnessLabel: source.label });
      }
    }
    return rows.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || String(a.title).localeCompare(String(b.title)));
  }

  // The dot beside an agent mark and the sentence in Settings. Hidden agents are not probed.
  function agentStatus({ info, online, connectionError, availability, compatibility, hidden }) {
    const label = info?.label || info?.id || 'Agent';
    if (hidden) return { tone: 'off', text: 'Hidden from the picker and the header' };
    if (connectionError?.code === 'permission_required') return { tone: 'off', text: 'Needs Accessibility permission', action: 'permission' };
    if (online === false) {
      const code = connectionError?.code || '';
      const text = code === 'app_not_running' || code === 'app_not_installed' ? connectionError.message : code === 'connection_refused' || code === 'cli_not_found' ? connectionError.message : `${label} is not reachable`;
      return { tone: 'off', text };
    }
    if (compatibility && compatibility.checkedAt && !compatibility.ok) return { tone: 'limited', text: `${compatibility.label || label} ${compatibility.appVersion || ''} is not supported yet`.replace(/\s+/g, ' ') };
    if (availability?.state === 'limited') return { tone: 'limited', text: availability.resetsAt ? `Limited until ${availability.resetsAtLabel || availability.resetsAt}` : 'At a usage limit, reset time unknown' };
    if (online === true) return { tone: 'ok', text: info?.kind === 'desktop-app' ? `${label} is open` : 'Connected' };
    return { tone: 'unknown', text: 'Checking…' };
  }

  return { WHEN, QUICK, resolveWhen, farLabel, editScope, stopPhraseEdit, planSentence, queueMeta, mergeConversations, agentStatus };
});
