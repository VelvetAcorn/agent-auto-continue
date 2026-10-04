'use strict';
// The one-screen interface: pick a conversation, pick when, press Continue. The queue sits
// underneath, and everything else (agents, keep-awake, remote control, appearance) is behind
// the gear. The same renderer serves the menu-bar rail and the expanded window; only the
// body class differs.
(() => {
  const api = window.autoContinue;
  const time = window.SchedulerTime;
  const sticker = window.SupportStar;
  const remote = window.RemoteSettings;
  const compose = window.Compose;
  const icons = window.AgentIcons;
  const app = document.getElementById('app');
  const $ = (selector) => document.querySelector(selector);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  function preference(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
  // How strongly the painting shows behind the controls, in percent. Above the cap, text over it stops being readable.
  const PAINTING_MAX = 60;
  function paintingStrength(value) { const number = Number(value); return Number.isFinite(number) ? Math.min(PAINTING_MAX, Math.max(0, Math.round(number))) : 30; }
  const CORNERS = ['tl', 'tr', 'bl', 'br'].map((corner) => `<svg class="corner ${corner}" aria-hidden="true"><use href="#o-corner"/></svg>`).join('');
  const RULE = '<div class="rule" aria-hidden="true"><i></i><svg><use href="#o-rule"/></svg><i></i></div>';
  const THEMES = [['light', 'Day', 'i-sun'], ['dark', 'Night', 'i-moon'], ['system', 'Follow system', 'i-auto']];
  const RECENT_ROWS = 5;
  const RAIL_MIN_HEIGHT = 360;
  const RAIL_MAX_HEIGHT = 760;
  const state = {
    layout: 'rail', view: 'home', returnView: 'home',
    harnesses: [], agents: [], settings: null, storageError: null,
    sources: {}, availability: {}, keepAwake: null, compatibility: [], update: null,
    upcoming: [], history: [], upcomingTotal: 0, historyTotal: 0, unacknowledged: 0, historyLimit: 50, historyFilter: '', search: '',
    draft: null, messageOpen: false, showSettled: false, pickerQuery: '',
    selected: null, selectedJob: null, confirmCancel: false, confirmMark: false,
    sections: new Set(['agents']), settingsDraft: null, harnessDraft: null, keepAwakeDraft: null, tipOpen: false,
    theme: preference('scheduler-theme', 'light'), painting: paintingStrength(preference('scheduler-painting', '30')), reduceMotion: preference('scheduler-motion', 'system') === 'reduce',
    loading: true, busy: false, actionError: '', jobsError: ''
  };
  let jobRequest = 0, timer, toastTimer, lastRefresh = 0, stopped = false, failuresKnown = false, lastHeight = 0;
  const sourceRequests = new Map();
  const knownProblems = new Set();
  const mediaTheme = matchMedia('(prefers-color-scheme: dark)');
  const mediaMotion = matchMedia('(prefers-reduced-motion: reduce)');
  // The sticker's phrase and spin live outside the DOM so re-renders never reset or stutter it.
  const starState = { phrase: '', spin: sticker.idle(performance.now()), frame: 0, paintedAt: 0, held: false, layouts: new Map() };
  let measureContext;
  const cleanup = [];

  // ---------- Agents ----------
  const harnessInfo = (id) => state.harnesses.find((item) => item.id === id);
  const harnessLabel = (id) => harnessInfo(id)?.label || (id === 't3' ? 'T3 Code' : id || 'Agent');
  const noun = (id) => harnessInfo(id)?.conversationNoun || 'conversation';
  // Agents in display order; everything is visible until the arrangement arrives.
  function arrangedAgents() {
    if (!state.harnesses.length) return [];
    const ids = state.harnesses.map((item) => item.id);
    const arranged = state.agents.length ? state.agents.filter((item) => ids.includes(item.id)) : [];
    const missing = ids.filter((id) => !arranged.some((item) => item.id === id)).map((id) => ({ id, hidden: false }));
    return arranged.concat(missing);
  }
  const visibleAgents = () => arrangedAgents().filter((item) => !item.hidden).map((item) => harnessInfo(item.id)).filter(Boolean);
  const isVisible = (id) => visibleAgents().some((item) => item.id === id);
  // What a harness supports automatically; until metadata loads, nothing automatic is offered.
  function support(id) {
    const loading = { supported: false, reason: `Checking what ${harnessLabel(id)} supports…` };
    return harnessInfo(id)?.automation || { whenAvailable: loading, multipleTurns: loading };
  }
  const editScopeOf = (job) => compose.editScope(job, { stopPhrase: Boolean(support(job.harness || 't3').stopPhrase?.supported) });
  function badge(id, { small = false, title } = {}) {
    const info = harnessInfo(id);
    const { mark, round } = icons.markFor(id, info?.kind);
    const status = agentStatus(id);
    const dot = `<i class="dot ${escape(status.tone)}"></i>`;
    const body = mark ? `<svg aria-hidden="true"><use href="#${mark}"/></svg>` : `<span class="monogram" aria-hidden="true">${escape(icons.monogram(info?.label || id))}</span>`;
    return `<span class="badge${round ? ' round' : ''}${small ? ' sm' : ''}" data-agent-badge="${escape(id)}" title="${escape(title ?? `${harnessLabel(id)} · ${status.text}`)}">${body}${dot}</span>`;
  }
  function availabilityFor(id) {
    const entry = state.availability[id];
    const value = entry?.availability;
    return value ? { ...value, resetsAtLabel: value.resetsAt ? display(value.resetsAt, localZone, 'time') : '' } : null;
  }
  function agentStatus(id) {
    const source = state.sources[id];
    return compose.agentStatus({
      info: harnessInfo(id), hidden: arrangedAgents().find((item) => item.id === id)?.hidden === true,
      online: source?.online ?? null, connectionError: source?.error || null, availability: availabilityFor(id),
      compatibility: state.compatibility.find((item) => item.harness === id) || null
    });
  }

  // ---------- Formatting ----------
  function errorMessage(error) {
    return String(error?.message || 'Something went wrong. Please try again.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
  function display(iso, zone = localZone, style = 'default') {
    if (!iso) return 'Time unavailable';
    try {
      const f = time.formatInstant(iso, zone);
      const today = time.formatInstant(new Date().toISOString(), zone).date;
      if (style === 'time') return f.date === today ? f.time : `${f.date} ${f.time}`;
      if (style === 'short') return `${f.date} ${f.time}`;
      if (style === 'full') return `${f.date} ${f.time} ${f.offset}`;
      if (style === 'seconds') return `${f.date} · ${f.time}:${f.seconds} ${f.offset}`;
      return `${f.date} · ${f.time} ${f.offset}`;
    } catch { return 'Time unavailable'; }
  }
  function relative(iso) {
    const diff = Date.parse(iso) - Date.now();
    if (!Number.isFinite(diff)) return 'Time unavailable';
    const absolute = Math.abs(diff);
    if (absolute < 60000) return diff > 0 ? 'In less than a minute' : 'Just now';
    const unit = absolute < 3600000 ? 'min' : absolute < 86400000 ? 'hour' : 'day';
    const value = Math.floor(absolute / (unit === 'min' ? 60000 : unit === 'hour' ? 3600000 : 86400000));
    const plural = value !== 1 && unit !== 'min' ? 's' : '';
    return diff > 0 ? `In ${value} ${unit}${plural}` : `${value} ${unit}${plural} ago`;
  }
  const labels = { pending: 'Scheduled', dispatching: 'Sending', sent: 'Sent', failed: 'Failed', canceled: 'Canceled', unconfirmed: 'Delivery unconfirmed', running: 'Agent working', paused: 'Paused', stopped: 'Stopped', finished: 'Finished', waiting: 'Waiting' };
  const pill = (status, text) => `<span class="pill ${escape(status)}">${escape(text || labels[status] || status)}</span>`;
  const jobPill = (job) => pill(job.displayStatus || job.deliveryStatus || job.status, job.deliveryLabel);
  const CONTACT_POINT_NAMES = { app_path: 'App files', deep_link: 'Conversation links', content_match: 'Open conversation title', composer_label: 'Message box label', send_label: 'Send button label', stop_label: 'Stop button label', label_catalogue: 'Translated labels', session_store: 'Session store', live_registry: 'Working status', transcript: 'Transcript format', originator: 'Conversation owner', app_server: 'Codex server replies' };
  const contactPointName = (id) => CONTACT_POINT_NAMES[id] ? `${CONTACT_POINT_NAMES[id]} (${id})` : id;
  function technical(info) {
    if (!info?.details && !info?.code) return '';
    const details = info.details || {};
    const appText = details.appVersion ? `${details.app || 'App'} ${details.appVersion}${details.verifiedVersion && details.verifiedVersion !== details.appVersion ? ` (verified with ${details.verifiedVersion})` : ''}` : '';
    return `<details><summary>Technical details</summary><p>${[info.code, details.status ? 'HTTP ' + details.status : '', details.endpoint, details.contentType, appText, details.contactPoint && contactPointName(details.contactPoint), details.hint].filter(Boolean).map(escape).join(' · ')}</p></details>`;
  }

  // ---------- Draft ----------
  function newDraft(harness = visibleAgents()[0]?.id || state.harnesses[0]?.id || 't3', threadId = '', message = 'Continue', zone = localZone) {
    const when = time.quickTime(5, zone);
    return { harness, threadId, threadTitle: '', projectName: '', message, when: '5', whenTouched: false, date: when.date, time: when.time, timeZone: zone, occurrence: '',
      waitIfLimited: false, far: 'once', turnLimit: '1', stopPhrase: '', editId: null, editScope: null, bufferSeconds: state.settings?.bufferSeconds ?? 5 };
  }
  const draft = () => { if (!state.draft) state.draft = newDraft(); return state.draft; };
  // Automation fields of a job or scheduleAgain payload, in draft form.
  function automationDraft(source) {
    const trigger = source.trigger || source.automation?.trigger || 'time';
    const limit = source.automation ? source.automation.limit : source.turnLimit;
    const continuous = source.automation ? source.automation.unlimited : source.continuous === true;
    return { waitIfLimited: trigger === 'time-then-available', far: continuous ? 'until' : Number(limit) > 1 ? 'upto' : 'once', turnLimit: String(continuous ? 1 : limit || 1), stopPhrase: source.automation?.stopPhrase || source.stopPhrase || '' };
  }
  // Keeps a draft within what its harness supports.
  function fitDraft(d) {
    const can = support(d.harness);
    if (!can.whenAvailable.supported) { if (d.when === 'available') d.when = '5'; d.waitIfLimited = false; }
    if (!can.multipleTurns.supported) { d.far = 'once'; d.turnLimit = '1'; }
    if (!can.stopPhrase?.supported) d.stopPhrase = '';
  }
  function chooseConversation(harness, threadId, title = '', projectName = '') {
    const d = draft();
    Object.assign(d, { harness, threadId, threadTitle: title, projectName });
    fitDraft(d);
    void refreshAvailability(harness, true);
  }
  function conversationOf(d) {
    return state.sources[d.harness]?.threads?.find((item) => item.id === d.threadId) || null;
  }

  // ---------- Header ----------
  function header() {
    const titles = { picker: `Choose a ${noun(draft().harness)}`, settings: 'Settings', detail: 'Details', history: 'History' };
    if (state.view !== 'home') {
      return `<header class="head sub"><button type="button" class="ghost back" data-action="back">← Back</button><span class="title">${escape(titles[state.view])}</span><span class="spacer"></span></header>`;
    }
    const agents = visibleAgents().map((item) => badge(item.id)).join('');
    return `<header class="head"><span class="brand"><img class="logo" src="assets/logo.webp" alt="" width="22" height="22">Auto-Continue</span><div class="tools"><div class="agents" aria-label="Agents">${agents}</div><span class="sep"></span>${awakeToggle()}${state.layout === 'rail'
      ? '<button type="button" class="icon-btn" data-action="layout" data-layout="window" title="Open as a window" aria-label="Open as a window"><svg aria-hidden="true"><use href="#i-expand"/></svg></button>'
      : '<button type="button" class="icon-btn" data-action="layout" data-layout="rail" title="Back to the menu bar" aria-label="Back to the menu bar"><svg aria-hidden="true"><use href="#i-collapse"/></svg></button>'}<button type="button" class="icon-btn" data-action="settings" title="Settings" aria-label="Settings"><svg aria-hidden="true"><use href="#i-gear"/></svg></button></div></header>`;
  }
  function awakeToggle() {
    const k = state.keepAwake;
    const on = Boolean(k?.settings?.enabled);
    const holding = Boolean(k?.holding);
    const title = !k ? 'Keep-awake is starting' : !on ? 'Keep-awake is off' : holding ? (k.state === 'releasing' ? 'Letting your Mac sleep soon' : `Keeping your Mac awake${k.holding === 'display' ? ' with the display on' : ''}`) : k.state === 'paused' ? 'Keep-awake paused on battery' : k.state === 'ended' ? 'Your Mac can sleep' : 'Keep-awake is on';
    const body = !k ? '' : !on ? 'Turn on to keep the Mac awake while queued work waits or runs.' : k.reason;
    const hint = !k ? '' : on ? 'Click to turn keep-awake off.' : 'Click to turn it on.';
    return `<span class="tipwrap"><button type="button" id="awake-toggle" class="icon-btn awake${on ? ' on' : ''}${holding ? ' holding' : ''}" data-action="awake" aria-pressed="${on}" aria-label="${escape(title)}" aria-describedby="awake-tip" ${k ? '' : 'disabled'}><svg aria-hidden="true"><use href="#i-awake"/></svg></button><span class="tip${state.tipOpen ? ' open' : ''}" id="awake-tip" role="tooltip"><b>${escape(title)}</b>${escape(body)}${hint ? ` ${escape(hint)}` : ''}</span></span>`;
  }

  // ---------- Notices ----------
  function notices() {
    const storage = state.storageError ? `<div class="notice" role="alert"><div><strong>Local schedule storage needs attention</strong><p>${escape(state.storageError.message)}</p></div></div>` : '';
    const d = state.draft;
    const source = d ? state.sources[d.harness] : null;
    const offline = d && source?.online === false && isVisible(d.harness) ? `<div class="notice" role="status"><div><strong>${escape(harnessLabel(d.harness))} is unavailable</strong><p>${escape(source.error?.message || `Check that ${harnessLabel(d.harness)} is running. Your queue and history remain available.`)}</p>${technical(source.error)}</div>${source.error?.code === 'permission_required' ? '<button type="button" data-action="open-permission-settings">Open System Settings</button>' : ''}<button type="button" data-action="check" data-harness="${escape(d.harness)}">Check</button></div>` : '';
    return storage + offline + keepAwakeNotice() + compatibilityNotices() + updateNotice();
  }
  // A downloaded update waits quietly for a restart; it also installs on the next quit.
  function updateNotice() {
    const u = state.update;
    if (u?.state !== 'ready') return '';
    return `<div class="update" role="status"><span><b>Update ready</b> · version ${escape(u.version)}</span><button type="button" class="link" data-action="restart-update" title="${escape(`Restart Agent Auto-Continue to install version ${u.version}. It also installs the next time you quit.`)}">Restart</button></div>`;
  }
  // One notice per desktop app whose installed version changed in a way this version does not understand.
  function compatibilityNotices() {
    return state.compatibility.filter((item) => item.problems?.length).map((item) => {
      const name = `${item.label}${item.appVersion ? ' ' + item.appVersion : ''}`;
      const atRisk = state.upcoming.filter((job) => job.harness === item.harness && job.risk).length;
      const facts = [item.verifiedVersion ? `Verified with ${item.verifiedVersion}` : '', `Changed: ${item.problems.map((problem) => contactPointName(problem.contactPoint)).join(', ')}`, item.checkedAt ? `Last checked ${relative(item.checkedAt).toLocaleLowerCase()}` : ''].filter(Boolean);
      return `<div class="notice" role="status"><div><strong>${escape(name)} isn’t supported yet</strong><p>${escape(item.problems[0].message)}</p>${atRisk ? `<p>${atRisk === 1 ? 'One scheduled message is' : `${atRisk} scheduled messages are`} at risk. ${atRisk === 1 ? 'It stays' : 'They stay'} scheduled, and if the problem remains when ${atRisk === 1 ? 'it is' : 'one is'} due, nothing is sent.</p>` : ''}<details><summary>Technical details</summary><p>${facts.map(escape).join(' · ')}</p></details></div><button type="button" data-action="copy-diagnostics">Copy diagnostics</button><button type="button" class="ghost" data-action="recheck-compatibility" data-harness="${escape(item.harness)}">Check again</button></div>`;
    }).join('');
  }
  // Keep-awake only interrupts when something is not routine: it paused, ended, hit its limit or macOS slept anyway.
  function keepAwakeNotice() {
    const k = state.keepAwake;
    if (!k?.enabled) return '';
    const holding = Boolean(k.holding);
    const capped = k.capped || [];
    const slept = k.lastSleep?.whileHolding && k.since && k.lastSleep.from >= k.since;
    if (holding && !capped.length && !slept) return '';
    if (!holding && !['paused', 'ended'].includes(k.state) && !capped.length && !slept) return '';
    const title = holding ? 'Keeping your Mac awake' : k.state === 'paused' ? 'Keep-awake paused' : 'Your Mac can sleep';
    const item = (task, over) => `<li><span>${escape(task.label)}</span> · ${escape(task.detail || task.state)}${task.until ? ` · ${task.state === 'waiting' ? 'starts' : 'until'} ${escape(display(task.until))}` : ''}${over ? ' · reached the time limit' : ''}</li>`;
    const tasks = k.tasks.map((task) => item(task, false)).concat(capped.map((task) => item(task, true))).join('');
    const count = (n) => `${n} ${n === 1 ? 'task' : 'tasks'}`;
    const summary = [k.tasks.length ? `${count(k.tasks.length)} ${holding ? (k.tasks.length === 1 ? 'needs it' : 'need it') : 'still tracked'}` : '', capped.length ? `${count(capped.length)} reached the time limit` : ''].filter(Boolean).join(' · ');
    const sleptText = slept ? `<p>macOS slept anyway from ${escape(display(k.lastSleep.from))} to ${escape(display(k.lastSleep.to))}. Missed schedules catch up after waking.</p>` : '';
    const overLimit = holding && capped.length ? `<p>${capped.length} ${capped.length === 1 ? 'task' : 'tasks'} reached the time limit and no longer ${capped.length === 1 ? 'keeps' : 'keep'} the Mac awake.</p>` : '';
    const button = holding ? '<button type="button" data-action="keep-awake-stop">Let Mac sleep</button>' : k.state === 'ended' && k.ended?.reason !== 'battery-floor' && (k.tasks.length || capped.length) ? '<button type="button" data-action="keep-awake-resume">Keep awake again</button>' : '';
    return `<div class="notice awake${holding ? ' holding' : ''}" role="status"><div><strong>${title}</strong><p>${escape(k.reason)}</p>${overLimit}${sleptText}${tasks ? `<details><summary>${summary}</summary><ul class="awake-tasks">${tasks}</ul></details>` : ''}</div>${button}</div>`;
  }

  // ---------- Home: compose ----------
  function composeBlock() {
    const d = draft();
    const can = support(d.harness);
    const label = harnessLabel(d.harness);
    const conversation = conversationOf(d);
    // Once a continuation has started, only its stop phrase can change; everything else stays visible but locked.
    const locked = d.editScope === 'stopPhrase';
    const title = conversation?.title || d.threadTitle || (d.threadId ? `${noun(d.harness).replace(/^./, (c) => c.toUpperCase())} ${d.threadId}` : `Choose a ${noun(d.harness)}`);
    const project = conversation?.projectName || d.projectName || '';
    const sub = d.threadId ? [label, project, conversation?.updatedAt ? relative(conversation.updatedAt).toLocaleLowerCase() : ''].filter(Boolean).join(' · ') : 'Most recent first, from every agent';
    const picker = `<button type="button" class="pick" id="pick" data-action="pick" ${d.editId ? 'disabled' : ''} aria-label="${escape(d.threadId ? `Conversation: ${title}` : `Choose a ${noun(d.harness)}`)}">${d.threadId ? badge(d.harness, { title: label }) : '<span class="badge empty" aria-hidden="true">?</span>'}<span class="t"><b>${escape(title)}</b><small>${escape(sub)}</small></span><span class="chev" aria-hidden="true">${d.editId ? '' : '▾'}</span></button>`;
    const whenChips = compose.WHEN.map(([value, text]) => {
      const off = value === 'available' && !can.whenAvailable.supported;
      return `<button type="button" data-when="${value}" class="${d.when === value ? 'active' : ''}" aria-pressed="${d.when === value}" ${off ? `disabled title="${escape(can.whenAvailable.reason)}"` : locked ? 'disabled' : ''}>${text}</button>`;
    }).join('');
    const availability = availabilityFor(d.harness);
    const limited = availability?.state === 'limited';
    const hint = can.whenAvailable.supported && limited && !locked ? `<div class="hint">${escape(label)} is limited${availability.resetsAt ? ` until ${escape(availability.resetsAtLabel)}` : ', reset time unknown'} <button type="button" class="link" data-action="check-availability">check again</button></div>` : '';
    const wait = can.whenAvailable.supported && d.when !== 'available' ? `<label class="check"><input id="wait-if-limited" type="checkbox" ${d.waitIfLimited ? 'checked' : ''} ${locked ? 'disabled' : ''}> If ${escape(label)} is at a usage limit then, wait for it</label>` : '';
    const custom = d.when === 'custom' ? `<div class="custom" id="custom-time"><div class="two"><label class="sr-only" for="date">Date, yyyy-mm-dd</label><input id="date" inputmode="numeric" value="${escape(d.date)}" placeholder="yyyy-mm-dd" aria-describedby="plan-error" ${locked ? 'disabled' : ''}><label class="sr-only" for="time">Time, 24-hour</label><input id="time" inputmode="numeric" value="${escape(d.time)}" placeholder="HH:mm" aria-describedby="plan-error" ${locked ? 'disabled' : ''}></div>${occurrence(d)}<label class="zone">Timezone <input id="timezone" list="timezones" value="${escape(d.timeZone)}" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''}><datalist id="timezones">${zones().map((zone) => `<option value="${escape(zone)}"></option>`).join('')}</datalist></label></div>` : '';
    const far = can.multipleTurns.supported ? `<div class="lbl" id="far-label">How far</div><div class="seg" role="group" aria-labelledby="far-label">${[['once', 'Once'], ['upto', 'Up to'], ['until', 'Until done']].map(([value, text]) => `<button type="button" data-far="${value}" class="${d.far === value ? 'active' : ''}" aria-pressed="${d.far === value}" ${locked ? 'disabled' : ''}>${text}</button>${value === 'upto' ? `<input id="turn-limit" class="num" type="text" inputmode="numeric" value="${escape(d.turnLimit)}" aria-label="Turn limit" ${d.far === 'upto' && !locked ? '' : 'disabled'}>` : ''}`).join('')}</div>${can.stopPhrase?.supported && d.far !== 'once' ? `<label class="zone phrase">Or stop at <input id="stop-phrase" type="text" maxlength="200" spellcheck="false" placeholder="a phrase in the agent's last message, e.g. TASK COMPLETE" value="${escape(d.stopPhrase)}" title="${escape(can.stopPhrase.reason)}"></label>` : ''}` : '';
    const message = state.messageOpen
      ? `<textarea id="message" maxlength="4000" rows="3" aria-label="Message">${escape(d.message)}</textarea>`
      : `<div class="msg" id="message-line"><span>${escape(d.message)}</span>${locked ? '' : '<button type="button" class="ghost" data-action="edit-message">Edit</button>'}</div>`;
    const plan = compose.planSentence({ draft: d, label, availability, time, display, supportsTurns: can.multipleTurns.supported });
    const editing = d.editId ? `<div class="editing"><span>${locked ? `Editing a ${findJob(d.editId)?.automation?.state === 'paused' ? 'paused' : 'running'} continuation` : 'Editing a queued message'}</span><button type="button" class="ghost" data-action="cancel-edit">Cancel</button></div>${locked ? '<p class="help" id="edit-scope">This continuation has already started, so only its stop phrase can change.</p>' : ''}` : '';
    return `<section class="compose" aria-label="Continue a conversation"><form id="continue-form">${editing}${picker}<div class="lbl" id="when-label">When</div><div class="seg" role="group" aria-labelledby="when-label">${whenChips}</div>${hint}${wait}${custom}${far}<div class="lbl">Message</div>${message}<p class="error" id="plan-error" role="alert"></p><div class="go"><button type="submit" class="primary" id="continue">${d.editId ? 'Save changes' : 'Continue'}</button><small id="plan">${escape(plan)}</small></div></form></section>`;
  }
  function occurrence(d) {
    let candidates;
    try { candidates = time.wallTimeCandidates(d.date, d.time, d.timeZone); } catch { return ''; }
    if (candidates.length < 2) return '';
    return `<label class="zone">This time occurs twice <select id="occurrence" ${d.editScope === 'stopPhrase' ? 'disabled' : ''}><option value="">Choose which</option>${candidates.map((candidate, index) => `<option value="${candidate.iso}" ${d.occurrence === candidate.iso ? 'selected' : ''}>${index === 0 ? 'First' : 'Second'} · ${time.offsetLabel(candidate.offsetMinutes)}</option>`).join('')}</select></label>`;
  }
  function zones() { try { return [localZone, 'UTC', ...Intl.supportedValuesOf('timeZone')].filter((value, index, list) => list.indexOf(value) === index); } catch { return [localZone, 'UTC', 'Europe/London', 'America/New_York', 'Asia/Tokyo']; } }

  // ---------- Home: queue and recent ----------
  const rowContext = () => ({ display, relative, localZone });
  function jobRow(job, { history = false } = {}) {
    const status = job.displayStatus || job.deliveryStatus || job.status;
    const running = status === 'running';
    const auto = job.automation;
    const scope = history ? null : editScopeOf(job);
    const act = (name, text, cls = 'ghost', extra = '') => `<button type="button" class="${cls}" data-action="${name}" data-job="${escape(job.id)}" ${extra}>${text}</button>`;
    const actions = history
      ? (job.canResume ? act('resume', 'Resume') : status === 'unconfirmed' ? act('reconcile', 'Check') : '')
      : `${scope ? act('edit', 'Edit', 'ghost', scope === 'stopPhrase' ? 'title="Edit stop phrase"' : '') : ''}${job.canStop ? (auto ? act('stop', 'Stop') : act('cancel', '×', 'x', 'title="Cancel" aria-label="Cancel"')) : ''}`;
    const pills = history ? jobPill(job) : job.risk ? '<span class="pill risk">At risk</span>' : '';
    return `<div class="q${running ? ' running' : ''}" data-job="${escape(job.id)}"><button type="button" class="open" data-open="${escape(job.id)}" aria-label="${escape(job.threadTitle || job.threadId)}">${badge(job.harness || 't3', { small: true, title: harnessLabel(job.harness || 't3') })}<span class="t"><b>${escape(job.threadTitle || job.threadId)}</b><small data-meta="${history ? 'history' : 'queue'}">${escape(compose.queueMeta(job, { ...rowContext(), labelled: !history }))}</small></span></button>${pills}<span class="acts" data-acts="${escape(job.id)}">${actions}</span></div>`;
  }
  function queue() {
    if (state.storageError) return '<section class="queue"><div class="empty"><b>Scheduling is paused</b><small>Your saved records have not been replaced. Repair local storage to continue.</small></div></section>';
    const active = state.upcoming.filter((job) => job.automation?.state === 'active');
    const stopAll = active.length ? `<button type="button" class="ghost" data-action="stop-all" title="Stop every running continuation">Stop all</button>` : '';
    const rows = state.upcoming.length ? state.upcoming.map((job) => jobRow(job)).join('') : state.loading ? '<div class="empty"><small>Loading…</small></div>' : '<div class="empty"><b>Nothing queued</b><small>Pick a conversation above and press Continue.</small></div>';
    const recent = state.history.slice(0, RECENT_ROWS);
    const attention = state.unacknowledged ? `<small>${state.unacknowledged} ${state.unacknowledged === 1 ? 'needs' : 'need'} a look</small>` : '';
    return `<section class="queue" aria-label="Queued">${RULE}${state.jobsError ? `<div class="notice"><div><strong>Could not read the queue</strong><p>${escape(state.jobsError)}</p></div><button type="button" data-action="refresh">Try again</button></div>` : ''}<div class="qhead"><span class="overline">Queued${state.upcomingTotal ? ` · ${state.upcomingTotal}` : ''}</span>${stopAll}</div>${rows}${recent.length ? `<details class="recent" open><summary><span class="overline">Recent</span>${attention}</summary>${recent.map((job) => jobRow(job, { history: true })).join('')}<button type="button" class="link more" data-action="history">All history</button></details>` : ''}</section>`;
  }

  // ---------- Picker ----------
  function picker() {
    const d = draft();
    const sources = visibleAgents().map((info) => ({ harness: info.id, label: info.label, threads: state.sources[info.id]?.threads || [] }));
    const rows = compose.mergeConversations(sources, { showSettled: state.showSettled, query: state.pickerQuery });
    const offline = visibleAgents().filter((info) => state.sources[info.id]?.online === false).map((info) => `<div class="note"><span>${escape(info.label)}: ${escape(state.sources[info.id].error?.message || 'not reachable')}</span><button type="button" class="link" data-action="check" data-harness="${escape(info.id)}">Check</button></div>`).join('');
    const loading = visibleAgents().some((info) => !state.sources[info.id]);
    const list = rows.length ? rows.map((row) => `<button type="button" class="q pickrow${row.harness === d.harness && row.id === d.threadId ? ' chosen' : ''}" data-thread="${escape(row.id)}" data-harness="${escape(row.harness)}">${badge(row.harness, { small: true, title: row.harnessLabel })}<span class="t"><b>${escape(row.title)}</b><small>${escape([row.harnessLabel, row.projectName || row.projectId, row.updatedAt ? relative(row.updatedAt).toLocaleLowerCase() : ''].filter(Boolean).join(' · '))}</small></span>${row.settled === true ? pill('quiet', 'Settled') : row.state && row.state !== 'unknown' ? pill(row.state, row.state) : ''}</button>`).join('')
      : `<div class="empty"><b>${loading ? 'Loading conversations…' : state.pickerQuery ? 'No matching conversations' : 'No conversations yet'}</b><small>${loading ? '' : state.pickerQuery ? 'Try another search.' : visibleAgents().length ? 'Start a conversation in one of your agents, or show settled ones.' : 'Show at least one agent in Settings.'}</small></div>`;
    return `<section class="picker"><div class="search"><input id="picker-search" type="search" placeholder="Find a conversation…" aria-label="Find a conversation" value="${escape(state.pickerQuery)}"></div>${offline}<div class="list">${list}</div><button type="button" class="link more" data-action="toggle-settled">${state.showSettled ? 'Hide settled' : 'Show settled too'}</button></section>`;
  }

  // ---------- Detail ----------
  function findJob(id = state.selected) { return [...state.upcoming, ...state.history].find((job) => job.id === id) || (state.selectedJob?.id === id ? state.selectedJob : null); }
  function detail() {
    const job = findJob();
    if (!job) return '<div class="empty"><b>Message unavailable</b><small>Go back and refresh.</small></div>';
    const zone = job.timeZone || localZone;
    const status = job.deliveryStatus || job.status;
    const auto = job.automation;
    const label = job.harnessLabel || harnessLabel(job.harness || 't3');
    const timed = !auto || auto.trigger !== 'available' || auto.currentTurn > 1;
    const mark = status === 'unconfirmed' && job.canMarkNotDelivered ? (state.confirmMark ? `<div class="confirm" role="group" aria-label="Confirm not delivered"><p>Only after checking the ${escape(noun(job.harness))} yourself. The app checks once more and confirms the delivery instead if it finds the message. After marking, a continuation sends the same message again on Resume, so if it did arrive the agent would receive it twice.</p><button type="button" class="danger" data-action="confirm-mark">Mark as not delivered</button> <button type="button" class="ghost" data-action="keep-mark">Keep</button></div>` : '<button type="button" class="ghost danger" data-action="mark-not-delivered">Mark as not delivered…</button>') : '';
    const problem = ['failed', 'unconfirmed'].includes(status) ? `<div class="error-detail"><h3>${status === 'unconfirmed' ? 'Check delivery before trying again' : 'This message could not be delivered'}</h3><p>${escape(job.error?.message || job.note)}</p>${technical(job.error)}${job.lastReconciledAt ? `<p>Last checked ${escape(display(job.lastReconciledAt, zone))}. ${status === 'unconfirmed' ? 'Delivery is still unconfirmed. No resend was attempted.' : ''}</p>` : ''}<div class="actions"><button type="button" data-action="ack" ${job.acknowledgedAt ? 'disabled' : ''}>${job.acknowledgedAt ? 'Acknowledged ✓' : 'Acknowledge'}</button>${mark}</div></div>` : '';
    const info = problem || (auto ? (['waiting', 'pending'].includes(job.displayStatus) && job.note ? `<p class="help">${escape(job.note)}</p>` : '') : status === 'sent' ? `<p class="help">${escape(label)} accepted the message.${job.turn ? '' : ' This does not confirm that the agent completed its work.'}</p>` : job.note ? `<p class="help">${escape(job.note)}</p>` : '');
    const risky = Boolean(job.risk) && (status === 'pending' || auto?.state === 'active');
    const risk = risky ? `<div class="risk-detail"><h3>${auto ? 'The next turn may not be sent' : 'This message may not be sent'}</h3><p>${escape(job.risk.message)}</p><p>${auto ? 'The continuation keeps going. If the problem remains when its next turn is due, nothing is sent and it pauses.' : 'It stays scheduled. If the problem remains when it is due, it fails without sending anything.'}</p></div>` : '';
    const actions = auto ? automationActions(job, status) : status === 'pending' ? '<button type="button" class="primary" data-action="edit">Edit</button><button type="button" class="ghost danger" data-action="cancel">Cancel message</button>' : status === 'unconfirmed' ? '<button type="button" class="primary" data-action="reconcile">Check delivery</button>' : status !== 'dispatching' ? '<button type="button" class="primary" data-action="again">Continue again</button>' : '<p class="help">Sending has started. This message can no longer be changed or canceled.</p>';
    const confirm = state.confirmCancel ? '<div class="confirm" role="group" aria-label="Confirm cancellation"><p>Cancel this queued message? The record stays in History.</p><button type="button" class="danger" data-action="confirm-cancel">Cancel message</button> <button type="button" class="ghost" data-action="keep">Keep it</button></div>' : '';
    return `<section class="detail"><div class="detail-header">${badge(job.harness || 't3', { title: label })}<span class="overline">${escape([label, job.projectName || job.projectId].filter(Boolean).join(' · '))}</span><span class="pills">${risky ? '<span class="pill risk">At risk</span>' : ''}${jobPill(job)}</span></div><h2>${escape(job.threadTitle || job.threadId)}</h2><p class="message">${escape(job.message)}</p>${auto ? `<div class="actions">${actions}</div>${risk}${info}${automationDetail(job, zone)}` : ''}<dl class="key-values"><dt>Agent</dt><dd>${escape(label)}</dd>${auto ? '' : turnSummary(job)}${timed ? `<dt>Requested time</dt><dd>${escape(display(job.scheduleAt, zone))}</dd>` : `<dt>Start</dt><dd>When ${escape(label)} is available</dd>`}${auto && !['pending', 'dispatching'].includes(status) ? '' : `<dt>${job.displayStatus === 'waiting' ? 'Next check' : 'Effective send time'}</dt><dd>${escape(display(job.effectiveAt, zone, 'seconds'))}</dd>`}<dt>Timezone</dt><dd>${escape(zone)}${job.timeZone ? '' : ' (legacy record)'}</dd><dt>Safety buffer</dt><dd>${job.bufferSeconds} seconds</dd><dt>Last updated</dt><dd>${escape(display(job.updatedAt || job.createdAt || job.scheduleAt, zone))}</dd>${job.lateBySeconds > 0 ? `<dt>Catch-up delay</dt><dd>${job.lateBySeconds} seconds</dd>` : ''}</dl>${auto ? '' : `${risk}${info}<div class="actions">${actions}</div>`}${confirm}</section>`;
  }
  const turnLabels = { running: 'Running', completed: 'Finished', failed: 'Stopped with an error', interrupted: 'Interrupted', unknown: 'Unknown' };
  function turnSummary(job) {
    if (!job.turn) return '';
    const reset = job.turn.usageLimit?.resetsAt ? ` · limit resets ${display(job.turn.usageLimit.resetsAt, job.timeZone || localZone)}` : '';
    return `<dt>Agent turn</dt><dd>${escape((turnLabels[job.turn.state] || job.turn.state) + reset)}</dd>`;
  }
  const turnStates = { completed: 'Finished', failed: 'Failed', interrupted: 'Interrupted', unknown: 'Ended unclear', running: 'Agent working', delivered: 'Delivered' };
  const chainStates = { active: 'Running', paused: 'Paused', stopped: 'Stopped', finished: 'Finished' };
  const triggers = { time: 'At a time', available: 'When available', 'time-then-available': 'At a time, then when available' };
  function automationDetail(job, zone) {
    const auto = job.automation;
    const availability = job.waiting?.availability || (job.displayStatus === 'waiting' ? job.availability : null);
    const turns = auto.turns.length ? `<ol class="turn-list">${auto.turns.map((turn) => `<li><strong>Turn ${turn.number}</strong><span>${escape(turn.usageLimit ? 'Stopped at a usage limit' : turnStates[turn.state] || turn.state)}${turn.error?.message ? ` · ${escape(turn.error.message)}` : ''}</span><small>${turn.sentAt ? `Sent ${escape(display(turn.sentAt, zone))}` : 'Send time unknown'}${turn.completedAt ? ` · ended ${escape(display(turn.completedAt, zone))}` : ''}</small></li>`).join('')}</ol>` : '<p class="help">No turns sent yet.</p>';
    const omitted = auto.earlierTurnsOmitted ? `<p class="help">${auto.earlierTurnsOmitted} earlier ${auto.earlierTurnsOmitted === 1 ? 'turn is' : 'turns are'} not shown.</p>` : '';
    const reason = auto.reason ? `<div class="chain-reason ${escape(auto.state)}"><p>${escape(auto.reason)}</p>${auto.state === 'paused' && !job.acknowledgedAt && !['failed', 'unconfirmed'].includes(job.deliveryStatus) ? '<button type="button" class="ghost" data-action="ack">Acknowledge</button>' : ''}</div>` : '';
    return `<section class="chain" aria-label="Automatic continuation"><div class="chain-head"><span class="overline">Continuation</span><strong>${escape(auto.progressLabel)}</strong></div><dl class="key-values"><dt>Start</dt><dd>${escape(triggers[auto.trigger] || auto.trigger)}</dd><dt>How far</dt><dd>${auto.unlimited ? 'Until done · continuous until you stop it' : auto.limit === 1 ? 'Once' : `Up to ${auto.limit} turns`}</dd><dt>Turns sent</dt><dd>${auto.sentTurns}${auto.unlimited ? '' : ` of ${auto.limit}`}</dd>${auto.stopPhrase ? `<dt>Stop phrase</dt><dd>${escape(auto.stopPhrase)}</dd>` : ''}<dt>State</dt><dd>${escape(chainStates[auto.state] || auto.state)}</dd>${availability ? `<dt>Availability</dt><dd>${escape(availabilityLine(availability))}</dd>` : ''}</dl>${reason}<h3>Turns</h3>${turns}${omitted}</section>`;
  }
  function availabilityLine(value) {
    const what = { available: 'Available', limited: value.resetsAt ? `Limited until ${display(value.resetsAt)}` : 'Limited, reset time unknown', unavailable: value.reason === 'screen_locked' ? 'Mac locked' : value.reason === 'conversation_busy' ? 'Agent still working in this conversation' : 'Unavailable', unknown: 'Unknown' }[value.state] || 'Unknown';
    return `${what} · ${value.source === 'none' ? 'no source' : value.source} · checked ${display(value.checkedAt)}`;
  }
  function automationActions(job, status) {
    const auto = job.automation;
    const actions = [];
    if (job.canResume) actions.push('<button type="button" class="primary" data-action="resume">Resume</button>');
    if (status === 'unconfirmed') actions.push('<button type="button" class="primary" data-action="reconcile">Check delivery</button>');
    const scope = editScopeOf(job);
    if (scope) actions.push(`<button type="button" data-action="edit">${scope === 'stopPhrase' ? 'Edit stop phrase' : 'Edit'}</button>`);
    if (job.canStop) actions.push('<button type="button" class="danger" data-action="stop">Stop continuing</button>');
    if (!job.canStop && !['pending', 'dispatching', 'unconfirmed'].includes(status)) actions.push('<button type="button" class="primary" data-action="again">Continue again</button>');
    if (job.canStop) actions.push(`<p class="help stop-help">Stopping takes effect at once and never sends.${status === 'sent' && auto.state === 'active' ? ' The turn in progress keeps running in the agent.' : ''}</p>`);
    return actions.join('');
  }

  // ---------- History ----------
  function history() {
    const query = state.search.trim().toLocaleLowerCase();
    const rows = state.history.filter((job) => !query || `${job.threadTitle || job.threadId} ${job.projectName || ''} ${job.harnessLabel || ''} ${job.message}`.toLocaleLowerCase().includes(query));
    const filters = [['', 'All'], ['sent', 'Sent'], ['failed', 'Failed'], ['unconfirmed', 'Unconfirmed'], ['canceled', 'Canceled']].map(([value, label]) => `<button type="button" data-filter="${value}" class="${state.historyFilter === value ? 'active' : ''}" aria-pressed="${state.historyFilter === value}">${label}</button>`).join('');
    return `<section class="history"><div class="search"><input id="search" type="search" placeholder="Search history…" aria-label="Search history" value="${escape(state.search)}"></div><div class="seg filters" aria-label="History filters">${filters}</div>${state.unacknowledged ? `<div class="note"><span>${state.unacknowledged} ${state.unacknowledged === 1 ? 'delivery needs' : 'deliveries need'} a look. Open one to acknowledge it.</span></div>` : ''}<div class="list">${rows.length ? rows.map((job) => jobRow(job, { history: true })).join('') : `<div class="empty"><b>${query ? 'No matching messages' : 'No history yet'}</b><small>${query ? 'Try another search.' : 'Outcomes appear here after a message is sent.'}</small></div>`}</div>${state.history.length < state.historyTotal ? `<button type="button" class="link more" data-action="more">Load more (${state.history.length} of ${state.historyTotal})</button>` : ''}<p class="help">Sent confirms delivery, not that the agent finished its work.</p></section>`;
  }

  // ---------- Settings ----------
  function settings() {
    if (!state.settings) return '<p class="help">Loading settings…</p>';
    const sections = [['agents', 'Agents', `${visibleAgents().length} shown`], ['awake', 'Keep the Mac awake', keepAwakeSummary()], ['remote', 'Remote control', remoteSummary()], ['appearance', 'Appearance', { system: 'Follows system', light: 'Day', dark: 'Night' }[state.theme]], ['advanced', 'Advanced', `${state.settings.bufferSeconds} s safety buffer`], ['updates', 'Updates', updatesSummary()], ['support', 'Support the app', 'ko-fi.com/velvetacorn']];
    const open = (id) => state.sections.has(id);
    return `<div class="settings">${sections.map(([id, label, summary]) => `<button type="button" class="srow${open(id) ? ' open' : ''}" data-section="${id}" aria-expanded="${open(id)}" aria-controls="section-${id}"><span class="t">${label}<small>${escape(summary)}</small></span><span class="chev" aria-hidden="true">${open(id) ? '▴' : '▾'}</span></button>${open(id) ? `<div class="section" id="section-${id}">${sectionBody(id)}</div>` : ''}`).join('')}</div>`;
  }
  function sectionBody(id) {
    if (id === 'agents') return agentsSection();
    if (id === 'awake') return keepAwakeSection();
    if (id === 'remote') return '<div id="remote-slot"></div>';
    if (id === 'appearance') return `<div class="themes" id="theme" role="radiogroup" aria-label="Appearance">${THEMES.map(([value, label, icon]) => `<button type="button" role="radio" data-theme="${value}" aria-checked="${state.theme === value}" aria-label="${label}" title="${label}"><svg aria-hidden="true"><use href="#${icon}"/></svg></button>`).join('')}</div><div class="setting-row"><label for="painting">Painting</label><span class="range"><input id="painting" type="range" min="0" max="${PAINTING_MAX}" step="5" value="${state.painting}"><output for="painting">${state.painting}%</output></span></div><div class="setting-row"><label for="motion">Reduce motion</label><input id="motion" type="checkbox" ${state.reduceMotion ? 'checked' : ''}></div><p class="help">Your system’s reduced-motion preference is always respected.</p>`;
    if (id === 'advanced') return `<form id="advanced-form"><label class="field" for="buffer">Safety buffer · seconds</label><input id="buffer" type="number" min="0" max="300" required value="${escape(state.settingsDraft?.bufferSeconds ?? state.settings.bufferSeconds)}"><p class="help">Added after the chosen time, or after a usage limit resets, before anything is sent. Applies to new messages.</p><p class="error" id="advanced-error" role="alert"></p><div class="actions"><button type="submit" class="primary">Save</button></div></form>`;
    if (id === 'updates') return updatesSection();
    if (id === 'support') return `<div class="support">${star()}<div><h2>Buy me a coffee</h2><button type="button" data-action="support" aria-describedby="support-note">Support on Ko-fi</button><p id="support-note" class="help">Opens ko-fi.com/velvetacorn in your browser.</p></div></div>`;
    return '';
  }
  const capabilityText = { requiresUnlockedScreen: ['Needs an unlocked screen', 'Works while locked'], canConfirmDelivery: ['Confirms delivery'], canDetectCompletion: ['Reports when the agent finishes'], canDetectUsageLimit: ['Detects usage limits'], requiresAccessibilityPermission: ['Needs Accessibility permission'] };
  function capabilities(item) {
    const caps = item.capabilities || {};
    return Object.entries(capabilityText).map(([key, [yes, no]]) => caps[key] ? yes : no).filter(Boolean).join(' · ');
  }
  function compatibilityLine(item) {
    if (item.kind !== 'desktop-app') return '';
    const checked = state.compatibility.find((entry) => entry.harness === item.id);
    const text = !checked?.checkedAt ? 'Not checked yet' : `${checked.appVersion ? `Version ${checked.appVersion} · ` : ''}${checked.ok ? 'Supported' : 'Not supported yet'} · checked ${relative(checked.checkedAt).toLocaleLowerCase()}`;
    return `<small class="caps${checked?.checkedAt && !checked.ok ? ' risk' : ''}">${escape(text)}</small>`;
  }
  function agentsSection() {
    if (!state.harnesses.length) return '<p class="help">Loading agents…</p>';
    if (!state.harnessDraft) state.harnessDraft = {};
    if (!state.settingsDraft) state.settingsDraft = { t3Token: '', httpPort: state.settings.httpPort, bufferSeconds: state.settings.bufferSeconds };
    const stored = state.settings.harnesses || {};
    const arranged = arrangedAgents();
    const rows = arranged.map((entry, index) => {
      const item = harnessInfo(entry.id);
      const status = agentStatus(entry.id);
      const fields = item.id === 't3'
        ? `<label>Token<input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="${state.settings.usingEnvironmentToken ? 'Using T3_TOKEN from the environment' : state.settings.hasStoredToken ? 'Saved. Leave blank to keep it' : 'Paste a bearer token'}" value="${escape(state.settingsDraft.t3Token)}"></label><label>Port<input id="port" type="number" min="1" max="65535" required value="${escape(state.settingsDraft.httpPort)}"></label>`
        : item.settings.map((setting) => {
          const id = `harness-${item.id}-${setting.key}`;
          const saved = stored[item.id]?.[setting.key] || {};
          const value = state.harnessDraft[item.id]?.[setting.key] ?? (setting.type === 'secret' ? '' : saved.value ?? '');
          const placeholder = setting.type === 'secret' ? (saved.usingEnvironment ? `Using ${setting.env} from the environment` : saved.hasStoredValue ? 'Saved. Leave blank to keep it' : 'Optional') : setting.type === 'port' ? String(setting.default ?? '') : 'Found automatically';
          return `<label>${escape(setting.label.replace(/^.*\b(port|password|executable)\b.*$/i, (_, word) => word.replace(/^./, (c) => c.toUpperCase())))}<input id="${escape(id)}" data-harness-key="${escape(item.id + ':' + setting.key)}" ${setting.type === 'port' ? 'type="number" min="1" max="65535"' : setting.type === 'secret' ? 'type="password" autocomplete="off"' : 'type="text"'} spellcheck="false" value="${escape(value)}" placeholder="${escape(placeholder)}" title="${escape(setting.help || '')}"></label>`;
        }).join('');
      const permission = status.action === 'permission' ? '<button type="button" class="mini" data-action="open-permission-settings">Allow</button>' : '';
      const check = entry.hidden ? '' : `<button type="button" class="mini" data-action="check" data-harness="${escape(item.id)}">Check</button>`;
      return `<div class="agent${entry.hidden ? ' hidden-agent' : ''}" data-agent="${escape(item.id)}"><div class="agent-head">${badge(item.id, { title: item.label })}<span class="t"><b>${escape(item.label)}</b><small><span class="dot ${escape(status.tone)}"></span> ${escape(status.text)}</small>${compatibilityLine(item)}</span><span class="agent-tools">${permission}${check}<button type="button" class="info" data-tip="${escape(`${item.description} ${capabilities(item)}`)}" aria-label="About ${escape(item.label)}" title="${escape(`${item.description}\n${capabilities(item)}`)}">ⓘ</button><button type="button" class="mini" data-agent-move="${escape(item.id)}" data-direction="-1" ${index === 0 ? 'disabled' : ''} aria-label="Move ${escape(item.label)} up">▲</button><button type="button" class="mini" data-agent-move="${escape(item.id)}" data-direction="1" ${index === arranged.length - 1 ? 'disabled' : ''} aria-label="Move ${escape(item.label)} down">▼</button><label class="show"><input type="checkbox" data-agent-show="${escape(item.id)}" ${entry.hidden ? '' : 'checked'}> Show</label></span></div>${fields ? `<div class="fields">${fields}</div>` : ''}</div>`;
    }).join('');
    return `<form id="agents-form"><p class="help">Shown agents appear in the header and the conversation picker, in this order. Hidden agents are not checked.</p>${rows}<p class="error" id="agents-error" role="alert"></p><div class="actions"><button type="submit" class="primary">Save</button></div></form>`;
  }
  function keepAwakeSummary() {
    const k = state.keepAwake;
    if (!k) return 'Loading…';
    return k.settings.enabled ? (k.holding ? k.reason : 'On') : 'Off';
  }
  function updatesSummary() {
    const u = state.update;
    if (!u) return 'Loading…';
    const suffix = { ready: ' · update ready', downloading: ' · downloading an update', checking: ' · checking' }[u.state] || (u.state === 'idle' && u.checkedAt ? ' · up to date' : '');
    return `Version ${u.currentVersion}${suffix}`;
  }
  function updatesSection() {
    const u = state.update;
    if (!u) return '<p class="help">Loading…</p>';
    if (!u.enabled) {
      return u.disabledReason === 'location'
        ? '<p class="help">This copy is running from a temporary location, so it cannot update itself. Move it to the Applications folder to get updates.</p><div class="actions"><button type="button" data-action="check-updates">Move to Applications…</button></div>'
        : '<p class="help">This copy is not a release build, so it does not update itself.</p>';
    }
    const status = {
      checking: 'Checking for a new version…',
      downloading: `Downloading version ${u.version}${u.percent ? ` · ${u.percent}%` : ''}. It installs the next time you quit.`,
      ready: `Version ${u.version} is ready. Restart to install it now, or it installs by itself the next time you quit.`,
      error: u.error?.message || 'The last check did not finish.'
    }[u.state] || (u.checkedAt ? `Up to date. Last checked ${relative(u.checkedAt).toLocaleLowerCase()}.` : 'Not checked yet.');
    const busy = ['checking', 'downloading'].includes(u.state);
    const button = u.state === 'ready' ? '<button type="button" class="primary" data-action="restart-update">Restart to update</button>' : `<button type="button" data-action="check-updates" ${busy ? 'disabled' : ''}>Check for updates</button>`;
    return `<p class="help${u.state === 'error' ? ' warning' : ''}" id="update-status">${escape(status)}</p><p class="help">New versions download from GitHub Releases in the background. The app never restarts on its own, so queued messages are not interrupted.</p><div class="actions">${button}</div>`;
  }
  function remoteSummary() { return remote?.summary ? remote.summary() : 'Phone and MCP access'; }
  function keepAwakeSection() {
    const k = state.keepAwake;
    if (!k) return '<p class="help">Loading keep-awake settings…</p>';
    if (!state.keepAwakeDraft) state.keepAwakeDraft = { ...k.settings };
    const d = state.keepAwakeDraft;
    const box = (id, key, label) => `<div class="setting-row"><label for="${id}">${label}</label><input id="${id}" type="checkbox" ${d[key] ? 'checked' : ''}></div>`;
    return `<form id="keep-awake-form">${box('ka-enabled', 'enabled', 'Keep this Mac awake while queued work waits or runs')}${box('ka-display', 'keepDisplayOn', 'Keep the display on too')}${box('ka-agents', 'includeRunningAgents', 'Also stay awake while any T3 Code agent turn runs')}<div class="setting-row"><label for="ka-power">On battery</label><select id="ka-power">${[['any', 'Keep awake on battery too'], ['ac-only', 'Only when connected to power']].map(([value, label]) => `<option value="${value}" ${d.powerSource === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="two"><label class="field">Stop at battery · %<input id="ka-floor" type="number" min="0" max="95" required value="${escape(d.batteryFloorPercent)}" ${d.powerSource === 'ac-only' ? 'disabled' : ''}></label><label class="field">Time limit · hours<input id="ka-hours" type="number" min="1" max="72" required value="${escape(d.maxHours)}"></label></div><p class="help" id="ka-status">${escape(keepAwakeStatus())}</p><details class="help"><summary>Lid, lock screen and sleep</summary><p>Locking the screen or letting the display sleep does not stop queued work, except for agents that drive a desktop app (Claude Desktop, ChatGPT Codex threads), which need the Mac unlocked to send. Closing a laptop lid sleeps the Mac unless it is in closed-display mode. Missed schedules catch up after waking.</p></details><p class="error" id="keep-awake-error" role="alert"></p><div class="actions"><button type="submit" class="primary">Save</button></div></form>`;
  }
  function keepAwakeStatus() {
    const k = state.keepAwake;
    return k ? `Status: ${k.enabled ? k.reason : 'Off. Your Mac sleeps on its usual schedule.'}` : '';
  }

  // ---------- Support sticker ----------
  function star() {
    if (!starState.phrase) starState.phrase = sticker.pickPhrase(sticker.STICKER_PHRASES);
    const points = Array.from({ length: 32 }, (_, index) => { const angle = index * Math.PI / 16, radius = index % 2 ? 39.5 : 50; return `${50 + radius * Math.sin(angle)},${50 - radius * Math.cos(angle)}`; }).join(' ');
    return `<button type="button" class="star" id="support-star" aria-label="Shuffle sticker phrase" aria-describedby="star-phrase"><svg viewBox="-3 -3 106 106" aria-hidden="true"><polygon points="${points}" fill="#D3A065" stroke="var(--outline)" stroke-width="2.5"/></svg><span class="star-text" aria-hidden="true">${starLines()}</span><span id="star-phrase" hidden>${escape(starState.phrase)}</span></button><span id="star-status" class="sr-only" role="status"></span>`;
  }
  function starLayout(phrase) {
    if (!starState.layouts.has(phrase)) {
      if (!measureContext) { measureContext = document.createElement('canvas').getContext('2d'); measureContext.font = '900 100px Georgia, serif'; }
      starState.layouts.set(phrase, sticker.layoutPhrase(phrase, (text) => measureContext.measureText(text).width / 100));
    }
    return starState.layouts.get(phrase);
  }
  const starLines = () => starLayout(starState.phrase).lines.map((line) => `<span>${escape(line)}</span>`).join('');
  const starMoves = () => !state.reduceMotion && !mediaMotion.matches;
  function paintStar(now) {
    const shape = document.querySelector('#support-star polygon');
    starState.paintedAt = Math.max(now, starState.paintedAt);
    if (shape) shape.style.transform = `rotate(${sticker.sample(starState.spin, starState.paintedAt).angle.toFixed(3)}deg)`;
    return Boolean(shape);
  }
  function starFrame(now) { starState.frame = 0; if (!starMoves()) syncStar(); else if (paintStar(now)) starState.frame = requestAnimationFrame(starFrame); }
  function syncStar() {
    const button = $('#support-star'), now = performance.now();
    if (!button) { cancelAnimationFrame(starState.frame); starState.frame = 0; if (starState.held) { starState.held = false; starState.spin = sticker.release(starState.spin, now, false); } return; }
    button.querySelector('.star-text').style.setProperty('--fit', starLayout(starState.phrase).size.toFixed(4));
    if (!starMoves() && starState.spin.kind !== 'still') { starState.held = false; starState.spin = sticker.freeze(starState.spin, now); }
    else if (starMoves() && starState.spin.kind === 'still') starState.spin = sticker.release(starState.spin, now, false);
    paintStar(now);
    if (starMoves() && !starState.frame) starState.frame = requestAnimationFrame(starFrame);
    if (!starMoves()) { cancelAnimationFrame(starState.frame); starState.frame = 0; }
  }
  function holdStar() { if (!starMoves() || starState.held) return; starState.held = true; starState.spin = sticker.press(starState.spin, performance.now()); }
  function spinStar() {
    starState.held = false;
    if (starMoves()) starState.spin = sticker.release(starState.spin, performance.now(), true);
    starState.phrase = sticker.pickPhrase(sticker.STICKER_PHRASES, starState.phrase);
    const text = document.querySelector('#support-star .star-text');
    if (text) { text.innerHTML = starLines(); $('#star-phrase').textContent = starState.phrase; $('#star-status').textContent = starState.phrase; }
    syncStar();
  }
  function letGoStar() { setTimeout(() => { if (!starState.held) return; starState.held = false; starState.spin = sticker.release(starState.spin, performance.now(), false); }); }

  // ---------- Render ----------
  function render(focusSelector) {
    const active = document.activeElement;
    const activeId = active?.id;
    const activeData = active?.dataset ? Object.entries(active.dataset).find(([key]) => ['action', 'open', 'thread', 'filter', 'when', 'far', 'section', 'agentMove', 'agentShow', 'harnessKey'].includes(key)) : null;
    const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    document.body.className = `${state.theme === 'dark' || (state.theme === 'system' && mediaTheme.matches) ? 'dark' : ''} ${state.reduceMotion ? 'motion-off' : ''} layout-${state.layout} view-${state.view}`;
    const body = state.view === 'picker' ? picker() : state.view === 'settings' ? settings() : state.view === 'detail' ? detail() : state.view === 'history' ? history() : composeBlock() + queue();
    applyPainting();
    app.innerHTML = `${header()}<main id="main" class="main">${CORNERS}<div id="notices">${state.view === 'home' || state.view === 'detail' ? notices() : ''}</div>${state.actionError ? `<p class="error" role="alert">${escape(state.actionError)}</p>` : ''}${body}</main>`;
    bind();
    if (state.busy) app.querySelectorAll('button, input, textarea, select').forEach((control) => { control.disabled = true; });
    if (focusSelector) $(focusSelector)?.focus();
    else if (activeId && document.getElementById(activeId)) {
      const replacement = document.getElementById(activeId); replacement.focus();
      if (selection && replacement.setSelectionRange && !['number', 'checkbox'].includes(replacement.type)) replacement.setSelectionRange(...selection);
    } else if (activeData) app.querySelector('[data-' + activeData[0].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + '="' + CSS.escape(activeData[1]) + '"]')?.focus();
    syncStar();
    fitWindow();
  }
  function applyPainting() {
    document.documentElement.style.setProperty('--art', (state.painting / 100).toFixed(2));
    const slider = $('#painting');
    if (slider) { slider.style.setProperty('--pct', `${(state.painting / PAINTING_MAX) * 100}%`); slider.nextElementSibling.textContent = `${state.painting}%`; }
  }
  // The rail grows and shrinks with its content, within a sensible range, so it never shows empty space.
  function fitWindow() {
    if (state.layout !== 'rail' || !api.fitWindow) return;
    requestAnimationFrame(() => {
      // The content's own height, not the viewport's, so the rail shrinks back after a long view.
      const height = Math.min(RAIL_MAX_HEIGHT, Math.max(RAIL_MIN_HEIGHT, Math.ceil(app.getBoundingClientRect().height)));
      if (height === lastHeight) return;
      lastHeight = height;
      void api.fitWindow(height).catch(() => {});
    });
  }
  function updateChrome() {
    const notices_ = $('#notices');
    if (notices_ && ['home', 'detail'].includes(state.view)) { notices_.innerHTML = notices(); bindActions(notices_); }
    document.querySelectorAll('[data-agent-badge]').forEach((node) => { const fresh = document.createElement('div'); fresh.innerHTML = badge(node.dataset.agentBadge, { small: node.classList.contains('sm'), title: node.title }); node.replaceWith(fresh.firstChild); });
    const toggle = $('.tipwrap');
    if (toggle && !state.busy) { const fresh = document.createElement('div'); fresh.innerHTML = awakeToggle(); toggle.replaceWith(fresh.firstChild); bindActions(app.querySelector('.tipwrap')); bindTip(); }
    if ($('#ka-status')) $('#ka-status').textContent = keepAwakeStatus();
    fitWindow();
  }
  function toast(message, jobId) {
    clearTimeout(toastTimer);
    const target = $('#toast'); target.hidden = false;
    target.innerHTML = `${escape(message)}${jobId ? '<button type="button" id="toast-view">View</button>' : ''}<button type="button" class="ghost" id="toast-dismiss" aria-label="Dismiss notification">×</button>`;
    $('#toast-dismiss').onclick = () => { target.hidden = true; };
    if (jobId) $('#toast-view').onclick = () => { target.hidden = true; openDetail(jobId, 'home'); };
    toastTimer = setTimeout(() => { target.hidden = true; }, jobId ? 10000 : 5000);
  }
  async function perform(operation, { errorTarget, success } = {}) {
    if (state.busy) return;
    state.busy = true; state.actionError = '';
    const disabledBefore = new Map([...app.querySelectorAll('button, input, select, textarea')].map((control) => [control, control.disabled]));
    disabledBefore.forEach((_disabled, control) => { control.disabled = true; });
    try { const value = await operation(); if (success) await success(value); }
    catch (error) { if (errorTarget && $(errorTarget)) $(errorTarget).textContent = errorMessage(error); else state.actionError = errorMessage(error); }
    finally {
      state.busy = false;
      if (errorTarget && $(errorTarget)?.textContent) disabledBefore.forEach((disabled, control) => { if (control.isConnected) control.disabled = disabled; });
      else render();
    }
  }

  // ---------- Navigation ----------
  function navigate(view, { focus = 'h1, .title' } = {}) {
    if (state.view === 'settings' && view !== 'settings') remote?.leave();
    if (view === 'settings' && state.view !== 'settings') starState.phrase = sticker.pickPhrase(sticker.STICKER_PHRASES, starState.phrase);
    state.actionError = ''; state.confirmCancel = false; state.confirmMark = false; state.tipOpen = false;
    state.view = view;
    render(focus);
    window.scrollTo(0, 0);
    if (view === 'settings' && state.sections.has('remote')) void remote?.load(remoteContext());
    if (view === 'history' || view === 'home') void refreshJobs();
    if (view === 'picker') void refreshSources();
  }
  function openDetail(jobId, returnView = state.view === 'detail' ? state.returnView : state.view) {
    state.returnView = ['home', 'history'].includes(returnView) ? returnView : 'home';
    state.selected = jobId; state.selectedJob = findJob(jobId);
    navigate('detail');
    void refreshJobs(true);
  }
  function remoteContext() {
    return { api, escape, display, $, perform, toast, render, errorMessage, isVisible: () => state.view === 'settings' && state.sections.has('remote') };
  }

  // ---------- Binding ----------
  function bindActions(root) {
    root.querySelectorAll('[data-action]').forEach((button) => { button.onclick = () => action(button.dataset.action, button.dataset); });
  }
  function bindTip() {
    const wrap = $('.tipwrap');
    if (!wrap) return;
    const show = () => { wrap.querySelector('.tip')?.classList.add('open'); };
    const hide = () => { if (!state.tipOpen) wrap.querySelector('.tip')?.classList.remove('open'); };
    wrap.onmouseenter = show; wrap.onmouseleave = hide;
    wrap.onfocusin = show; wrap.onfocusout = hide;
  }
  function bind() {
    bindActions(app);
    bindTip();
    document.querySelectorAll('[data-open]').forEach((button) => { button.onclick = () => openDetail(button.dataset.open); });
    document.querySelectorAll('[data-thread]').forEach((button) => { button.onclick = () => {
      const row = state.sources[button.dataset.harness]?.threads?.find((item) => item.id === button.dataset.thread);
      chooseConversation(button.dataset.harness, button.dataset.thread, row?.title || '', row?.projectName || '');
      state.pickerQuery = '';
      navigate('home', { focus: '#continue' });
    }; });
    document.querySelectorAll('[data-when]').forEach((button) => { button.onclick = () => { const d = draft(); d.when = button.dataset.when; d.whenTouched = true; d.occurrence = ''; if (d.when === 'available') d.waitIfLimited = false; render(`[data-when="${d.when}"]`); void refreshAvailability(d.harness); }; });
    document.querySelectorAll('[data-far]').forEach((button) => { button.onclick = () => { draft().far = button.dataset.far; render(button.dataset.far === 'upto' ? '#turn-limit' : `[data-far="${button.dataset.far}"]`); }; });
    document.querySelectorAll('[data-filter]').forEach((button) => { button.onclick = () => { state.historyFilter = button.dataset.filter; state.historyLimit = 50; state.history = []; state.search = ''; render(); void refreshJobs(); }; });
    document.querySelectorAll('[data-section]').forEach((button) => { button.onclick = () => { const id = button.dataset.section; if (state.sections.has(id)) state.sections.delete(id); else state.sections.add(id); render(`[data-section="${id}"]`); if (id === 'remote' && state.sections.has(id)) void remote?.load(remoteContext()); }; });
    document.querySelectorAll('[data-agent-move]').forEach((button) => { button.onclick = () => moveAgent(button.dataset.agentMove, Number(button.dataset.direction)); });
    document.querySelectorAll('[data-agent-show]').forEach((input) => { input.onchange = () => showAgent(input.dataset.agentShow, input.checked); });
    document.querySelectorAll('[data-harness-key]').forEach((input) => { input.oninput = (event) => { const [id, key] = input.dataset.harnessKey.split(':'); state.harnessDraft[id] = { ...state.harnessDraft[id], [key]: event.target.value }; }; });
    if ($('#turn-limit')) $('#turn-limit').oninput = (event) => { draft().turnLimit = event.target.value; updatePlan(); };
    if ($('#stop-phrase')) $('#stop-phrase').oninput = (event) => { draft().stopPhrase = event.target.value; updatePlan(); };
    if ($('#wait-if-limited')) $('#wait-if-limited').onchange = (event) => { draft().waitIfLimited = event.target.checked; updatePlan(); if (event.target.checked) void refreshAvailability(draft().harness); };
    if ($('#message')) $('#message').oninput = (event) => { draft().message = event.target.value; clearPlanError(); };
    ['date', 'time', 'timezone'].forEach((id) => { if ($('#' + id)) $('#' + id).oninput = (event) => { draft()[id === 'timezone' ? 'timeZone' : id] = event.target.value; draft().occurrence = ''; updatePlan(); }; });
    if ($('#occurrence')) $('#occurrence').onchange = (event) => { draft().occurrence = event.target.value; updatePlan(); };
    if ($('#picker-search')) $('#picker-search').oninput = (event) => { state.pickerQuery = event.target.value; render('#picker-search'); };
    if ($('#search')) $('#search').oninput = (event) => { state.search = event.target.value; render('#search'); };
    if ($('#continue-form')) $('#continue-form').onsubmit = submit;
    ['token', 'port'].forEach((id) => { if ($('#' + id)) $('#' + id).oninput = (event) => { state.settingsDraft[id === 'token' ? 't3Token' : 'httpPort'] = id === 'token' ? event.target.value : Number(event.target.value); }; });
    if ($('#buffer')) $('#buffer').oninput = (event) => { if (!state.settingsDraft) state.settingsDraft = { t3Token: '', httpPort: state.settings.httpPort, bufferSeconds: state.settings.bufferSeconds }; state.settingsDraft.bufferSeconds = Number(event.target.value); };
    if ($('#agents-form')) $('#agents-form').onsubmit = (event) => {
      event.preventDefault();
      const values = {};
      for (const [id, fields] of Object.entries(state.harnessDraft || {})) {
        const item = harnessInfo(id); if (!item) continue;
        values[id] = {};
        for (const [key, value] of Object.entries(fields)) { const setting = item.settings.find((entry) => entry.key === key); if (setting) values[id][key] = setting.type === 'port' ? Number(value) : value; }
      }
      const s = state.settingsDraft || {};
      void perform(() => api.saveSettings({ httpPort: s.httpPort ?? state.settings.httpPort, bufferSeconds: state.settings.bufferSeconds, t3Token: s.t3Token || '', harnesses: values }), { errorTarget: '#agents-error', success: async () => { state.settings = await api.getSettings(); state.harnessDraft = null; state.settingsDraft = null; toast('Agent settings saved.'); void refreshSources(true); } });
    };
    if ($('#advanced-form')) $('#advanced-form').onsubmit = (event) => {
      event.preventDefault();
      const buffer = state.settingsDraft?.bufferSeconds ?? state.settings.bufferSeconds;
      void perform(() => api.saveSettings({ httpPort: state.settings.httpPort, bufferSeconds: buffer }), { errorTarget: '#advanced-error', success: async () => { state.settings = await api.getSettings(); state.settingsDraft = null; if (state.draft && !state.draft.editId) state.draft.bufferSeconds = state.settings.bufferSeconds; toast('Settings saved.'); } });
    };
    const keepAwakeFields = { 'ka-enabled': ['enabled', 'checked'], 'ka-display': ['keepDisplayOn', 'checked'], 'ka-agents': ['includeRunningAgents', 'checked'], 'ka-power': ['powerSource', 'value'], 'ka-floor': ['batteryFloorPercent', 'value'], 'ka-hours': ['maxHours', 'value'] };
    Object.entries(keepAwakeFields).forEach(([id, [key, property]]) => { if ($('#' + id)) $('#' + id)[property === 'checked' || id === 'ka-power' ? 'onchange' : 'oninput'] = (event) => { state.keepAwakeDraft[key] = property === 'checked' ? event.target.checked : id === 'ka-power' ? event.target.value : Number(event.target.value); if (id === 'ka-power') $('#ka-floor').disabled = event.target.value === 'ac-only'; if ($('#keep-awake-error')) $('#keep-awake-error').textContent = ''; }; });
    if ($('#keep-awake-form')) $('#keep-awake-form').onsubmit = (event) => { event.preventDefault(); void perform(() => api.configureKeepAwake({ ...state.keepAwakeDraft }), { errorTarget: '#keep-awake-error', success: (snapshot) => { state.keepAwake = snapshot; state.keepAwakeDraft = null; toast(snapshot.enabled ? 'Keep-awake is on.' : 'Keep-awake is off.'); } }); };
    app.querySelectorAll('[data-theme]').forEach((button) => { button.onclick = () => { state.theme = button.dataset.theme; savePreferences(); render(`[data-theme="${state.theme}"]`); }; });
    if ($('#painting')) { applyPainting(); $('#painting').oninput = (event) => { state.painting = paintingStrength(event.target.value); savePreferences(); applyPainting(); }; }
    if ($('#motion')) $('#motion').onchange = (event) => { state.reduceMotion = event.target.checked; savePreferences(); render('#motion'); };
    const starButton = $('#support-star');
    if (starButton) { starButton.onpointerdown = (event) => { if (event.isPrimary && event.button === 0) holdStar(); }; starButton.onkeydown = (event) => { if (event.key === 'Enter' && event.repeat) event.preventDefault(); if (event.key === ' ' && !event.repeat) holdStar(); }; starButton.onclick = spinStar; }
    remote?.bind(remoteContext());
  }
  function savePreferences() { try { localStorage.setItem('scheduler-theme', state.theme); localStorage.setItem('scheduler-painting', String(state.painting)); localStorage.setItem('scheduler-motion', state.reduceMotion ? 'reduce' : 'system'); } catch { /* Cosmetic preferences can remain session-only. */ } }
  function clearPlanError() { if ($('#plan-error')) $('#plan-error').textContent = ''; }
  function updatePlan() {
    clearPlanError();
    const d = draft();
    const target = $('#plan');
    if (target) target.textContent = compose.planSentence({ draft: d, label: harnessLabel(d.harness), availability: availabilityFor(d.harness), time, display, supportsTurns: support(d.harness).multipleTurns.supported });
    if (d.when === 'custom' && $('#custom-time')) {
      const existing = $('#occurrence');
      const markup = occurrence(d);
      if (Boolean(existing) !== Boolean(markup)) render(document.activeElement?.id ? '#' + document.activeElement.id : undefined);
    }
  }
  function submit(event) {
    event.preventDefault();
    const d = draft();
    const phraseOnly = d.editScope === 'stopPhrase';
    let when, input;
    try {
      // A started continuation accepts an edit of its stop phrase alone, so nothing else is sent.
      if (phraseOnly) input = compose.stopPhraseEdit(d);
      else {
        if (!d.threadId) throw new Error(`Choose a ${noun(d.harness)} first.`);
        if (!d.message.trim()) throw new Error('Enter a message.');
        if (d.far === 'upto' && !/^\d+$/.test(String(d.turnLimit).trim())) throw new Error('Turn limit must be a whole number of 1 or more.');
        when = compose.resolveWhen(d, time);
        input = { harness: d.harness, threadId: d.threadId, message: d.message, timeZone: d.timeZone, trigger: when.trigger, continuous: d.far === 'until', ...(d.far === 'until' ? {} : { turnLimit: d.far === 'upto' ? Number(d.turnLimit) : 1 }), ...(d.far !== 'once' ? { stopPhrase: d.stopPhrase.trim() || null } : {}), ...(when.whenISO ? { whenISO: when.whenISO } : {}) };
      }
    } catch (error) { $('#plan-error').textContent = errorMessage(error); return; }
    const editId = d.editId;
    void perform(() => editId ? api.editJob(editId, input) : api.createSchedule(input), { errorTarget: '#plan-error', success: async () => {
      state.draft = newDraft(d.harness); state.messageOpen = false;
      await refreshJobs(false);
      toast(phraseOnly ? (input.stopPhrase ? 'Stop phrase updated.' : 'Stop phrase removed.') : editId ? 'Message updated.' : when.trigger === 'available' ? `Waiting for ${harnessLabel(d.harness)} to be free.` : 'Queued.');
    } });
  }
  // Arrangement changes save at once; there is nothing else to confirm.
  function moveAgent(id, direction) {
    const order = arrangedAgents().map((item) => item.id);
    const index = order.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    order.splice(index, 1); order.splice(target, 0, id);
    saveArrangement({ order, hidden: arrangedAgents().filter((item) => item.hidden).map((item) => item.id) }, `[data-agent-move="${id}"][data-direction="${direction}"]`);
  }
  function showAgent(id, shown) {
    const hidden = new Set(arrangedAgents().filter((item) => item.hidden).map((item) => item.id));
    if (shown) hidden.delete(id); else hidden.add(id);
    saveArrangement({ order: arrangedAgents().map((item) => item.id), hidden: [...hidden] }, `[data-agent-show="${id}"]`);
  }
  function saveArrangement(agents, focus) {
    void perform(() => api.saveSettings({ httpPort: state.settings.httpPort, bufferSeconds: state.settings.bufferSeconds, agents }), { errorTarget: '#agents-error', success: async () => {
      state.settings = await api.getSettings(); state.agents = state.settings.agents || [];
      if (state.draft && !isVisible(state.draft.harness) && !state.draft.threadId) state.draft.harness = visibleAgents()[0]?.id || state.draft.harness;
      render(focus); void refreshSources(true);
    } });
  }
  function action(name, data = {}) {
    if (name === 'settings') return navigate('settings', { focus: '[data-section="agents"]' });
    if (name === 'back') { const target = state.view === 'detail' ? state.returnView : 'home'; state.pickerQuery = ''; return navigate(target, { focus: state.view === 'picker' ? '#pick' : undefined }); }
    if (name === 'history') { state.returnView = 'home'; return navigate('history', { focus: '#search' }); }
    if (name === 'pick') { if (draft().editId) return; return navigate('picker', { focus: '#picker-search' }); }
    if (name === 'toggle-settled') { state.showSettled = !state.showSettled; render('[data-action="toggle-settled"]'); return; }
    if (name === 'edit-message') { state.messageOpen = true; render('#message'); return; }
    if (name === 'cancel-edit') { state.draft = newDraft(draft().harness); state.messageOpen = false; render('#pick'); return; }
    if (name === 'layout') { void perform(() => api.setLayout(data.layout)); return; }
    if (name === 'awake') {
      const k = state.keepAwake; if (!k) return;
      void perform(() => api.configureKeepAwake({ ...k.settings, enabled: !k.settings.enabled }), { success: (snapshot) => { state.keepAwake = snapshot; state.keepAwakeDraft = null; toast(snapshot.enabled ? 'Keep-awake is on.' : 'Keep-awake is off.'); } });
      return;
    }
    if (name === 'support') { void perform(() => api.openSupport()); return; }
    if (name === 'keep-awake-stop') { void perform(() => api.stopKeepAwake(), { success: (snapshot) => { state.keepAwake = snapshot; toast('Your Mac can sleep now.'); } }); return; }
    if (name === 'keep-awake-resume') { void perform(() => api.resumeKeepAwake(), { success: (snapshot) => { state.keepAwake = snapshot; toast('Keeping your Mac awake again.'); } }); return; }
    if (name === 'restart-update') { void perform(() => api.restartToUpdate()); return; }
    if (name === 'check-updates') {
      void perform(() => api.checkForUpdates(), { success: (snapshot) => {
        state.update = snapshot || state.update;
        if (!snapshot?.enabled) return;
        toast({ ready: 'Update ready. Restart to install it.', downloading: `Downloading version ${snapshot.version}.`, error: snapshot.error?.message || 'Could not check for updates.' }[snapshot.state] || 'You’re up to date.');
      } });
      return;
    }
    if (name === 'copy-diagnostics') { void perform(() => api.copyDiagnostics(), { success: () => toast('Diagnostics copied. Paste them into your bug report.') }); return; }
    if (name === 'recheck-compatibility') { void perform(() => api.checkCompatibility(data.harness), { success: async (list) => { state.compatibility = Array.isArray(list) ? list : []; await refreshJobs(false); const item = state.compatibility.find((entry) => entry.harness === data.harness); toast(item?.ok ? `${item.label} looks supported again.` : `${item?.label || harnessLabel(data.harness)} still needs an update of Agent Auto-Continue.`); } }); return; }
    if (name === 'open-permission-settings') { void perform(() => api.openPermissionSettings()); return; }
    if (name === 'check') { const harness = data.harness || draft().harness; void perform(() => api.checkConnection(harness), { success: async (result) => { if (result.online) toast(`Connected to ${harnessLabel(harness)}.`); else { const error = result.errorInfo || (typeof result.error === 'object' ? result.error : { message: result.error }); state.sources[harness] = { ...(state.sources[harness] || { threads: [] }), online: false, error }; toast(`${harnessLabel(harness)}: ${error?.message || 'not reachable'}`); } await refreshSources(false, [harness]); } }); return; }
    if (name === 'check-availability') { void refreshAvailability(draft().harness, true); return; }
    if (name === 'refresh') { void refreshJobs(); void refreshSources(); return; }
    if (name === 'stop-all') { void perform(() => api.stopAllContinuations(), { success: async (result) => { await refreshJobs(false); toast(`Stopped ${result.stopped.length} ${result.stopped.length === 1 ? 'continuation' : 'continuations'}. Nothing more will be sent.`); } }); return; }
    if (name === 'more') { state.historyLimit += 50; void refreshJobs(); return; }
    const job = findJob(data.job || state.selected);
    if (!job) return;
    if (name === 'edit') { startEdit(job); return; }
    if (name === 'stop') { void perform(() => api.stopJob(job.id), { success: async (updated) => { state.selectedJob = updated; await refreshJobs(false); toast('Stopped. Nothing more will be sent.'); } }); return; }
    if (name === 'resume') { void perform(() => api.resumeJob(job.id), { success: async (updated) => { state.selectedJob = updated; await refreshJobs(false); toast('Continuation resumed.'); } }); return; }
    if (name === 'cancel') { if (state.view === 'detail') { state.confirmCancel = true; render('[data-action="confirm-cancel"]'); } else void perform(() => api.cancelJob(job.id), { success: async () => { await refreshJobs(false); toast('Canceled. The record stays in History.'); } }); return; }
    if (name === 'keep') { state.confirmCancel = false; render('[data-action="cancel"]'); return; }
    if (name === 'mark-not-delivered') { state.confirmMark = true; render('[data-action="confirm-mark"]'); return; }
    if (name === 'keep-mark') { state.confirmMark = false; render('[data-action="mark-not-delivered"]'); return; }
    // The service refuses the mark when its last check finds the message, having confirmed the delivery instead; that is good news, not an error.
    if (name === 'confirm-mark') { void perform(() => api.markNotDelivered(job.id, { confirm: true }).catch(async (error) => { const fresh = await api.getJob(job.id).catch(() => null); if (fresh && (fresh.deliveryStatus || fresh.status) === 'sent') return fresh; throw error; }), { success: async (updated) => { state.selectedJob = updated; state.confirmMark = false; await refreshJobs(false); toast((updated.deliveryStatus || updated.status) === 'sent' ? 'The message was found after all. Delivery confirmed.' : 'Marked as not delivered.'); } }); return; }
    if (name === 'confirm-cancel') { void perform(() => api.cancelJob(job.id), { success: async (updated) => { state.selectedJob = updated; state.confirmCancel = false; await refreshJobs(false); toast('Canceled. The record stays in History.'); } }); return; }
    if (name === 'ack') { void perform(() => api.acknowledgeJob(job.id), { success: async (updated) => { state.selectedJob = updated; await refreshJobs(false); toast('Acknowledged. The record stays in History.'); } }); return; }
    if (name === 'reconcile') { void perform(() => api.reconcileJob(job.id), { success: async (result) => { if (!result.ok) throw new Error(result.error?.message || 'Could not check delivery.'); state.selectedJob = result.job; await refreshJobs(false); toast((result.job.deliveryStatus || result.job.status) === 'sent' ? 'Delivery confirmed.' : 'Delivery remains unconfirmed. No resend was attempted.'); } }); return; }
    if (name === 'again') { void perform(() => api.scheduleAgain(job.id), { success: (payload) => { state.draft = { ...newDraft(payload.harness || job.harness || 't3', payload.threadId, payload.message, payload.timeZone || localZone), threadTitle: job.threadTitle, projectName: job.projectName, ...automationDraft(payload) }; fitDraft(state.draft); state.messageOpen = false; state.view = 'home'; void refreshAvailability(state.draft.harness); } }); }
  }
  function startEdit(job) {
    const scope = editScopeOf(job);
    if (!scope) return;
    const wall = time.formatInstant(job.scheduleAt, job.timeZone || localZone);
    state.draft = { ...newDraft(job.harness || 't3', job.threadId, job.message, job.timeZone || localZone), ...wall, when: job.automation?.trigger === 'available' ? 'available' : 'custom', whenTouched: true, occurrence: job.scheduleAt, editId: job.id, editScope: scope, bufferSeconds: job.bufferSeconds, threadTitle: job.threadTitle, projectName: job.projectName, ...automationDraft(job) };
    fitDraft(state.draft);
    state.messageOpen = false; state.returnView = 'home';
    navigate('home', { focus: scope === 'stopPhrase' ? '#stop-phrase' : '#continue' });
    void refreshAvailability(state.draft.harness);
  }

  // ---------- Data ----------
  async function readAllPages(view, limit, status) {
    const jobs = []; let result;
    for (let offset = 0; offset < limit; offset += 500) { result = await api.listJobs({ view, limit: Math.min(500, limit - offset), offset, ...(status ? { status } : {}) }); jobs.push(...result.jobs); if (jobs.length >= result.total) break; }
    return { ...result, jobs };
  }
  const jobsSnapshot = () => JSON.stringify([state.upcoming, state.history, state.upcomingTotal, state.historyTotal, state.unacknowledged, state.jobsError, state.loading, state.selectedJob, state.storageError]);
  async function refreshJobs(shouldRender = true, notifyFailures = false) {
    const request = ++jobRequest;
    const previous = jobsSnapshot();
    try {
      const [upcoming, history_, selectedDetail] = await Promise.all([readAllPages('upcoming', 500), readAllPages('history', state.view === 'history' ? state.historyLimit : 50, state.view === 'history' ? state.historyFilter : ''), state.selected && api.getJob ? api.getJob(state.selected).catch(() => null) : null]);
      if (stopped || request !== jobRequest) return;
      state.storageError = upcoming.storageError || history_.storageError || null; state.upcoming = upcoming.jobs; state.history = history_.jobs; state.upcomingTotal = upcoming.total; state.historyTotal = history_.total; state.unacknowledged = history_.unacknowledgedFailures; state.jobsError = '';
      for (const job of history_.jobs.filter((item) => ['failed', 'unconfirmed'].includes(item.deliveryStatus || item.status) || item.automation?.state === 'paused')) {
        const key = job.id + ':' + (job.automation?.changedAt || '');
        if (failuresKnown && notifyFailures && !knownProblems.has(key) && !job.acknowledgedAt) toast((job.deliveryStatus || job.status) === 'unconfirmed' ? 'A delivery needs confirmation.' : (job.deliveryStatus || job.status) === 'failed' ? 'A message failed.' : 'A continuation paused and needs a look.', job.id);
        knownProblems.add(key);
      }
      failuresKnown = true;
      const selected = selectedDetail || [...upcoming.jobs, ...history_.jobs].find((job) => job.id === state.selected); if (selected) state.selectedJob = selected;
    } catch (error) { if (request === jobRequest) state.jobsError = errorMessage(error); }
    finally {
      if (request === jobRequest) {
        state.loading = false;
        const changed = previous !== jobsSnapshot();
        if (shouldRender && changed && !state.busy && state.view !== 'settings' && state.view !== 'picker' && !editingText()) render(); else updateChrome();
      }
    }
  }
  // A render while someone types in the message or the custom time would swallow their keystrokes.
  const editingText = () => ['message', 'date', 'time', 'timezone', 'turn-limit', 'stop-phrase', 'search', 'picker-search', 'token', 'port', 'buffer'].includes(document.activeElement?.id);
  async function refreshCompatibility() {
    if (!api.getCompatibility) return;
    try { const list = await api.getCompatibility(); if (stopped) return; const before = JSON.stringify(state.compatibility); state.compatibility = Array.isArray(list) ? list : []; if (before !== JSON.stringify(state.compatibility) && !state.busy) updateChrome(); }
    catch { /* The last known state stays visible. */ }
  }
  // Conversations of every visible agent, each read independently so one slow agent never hides the others.
  async function refreshSources(shouldRender = true, only = null) {
    const targets = (only ? only.map(harnessInfo).filter(Boolean) : visibleAgents());
    const previous = JSON.stringify(state.sources);
    await Promise.all(targets.map(async (info) => {
      const request = (sourceRequests.get(info.id) || 0) + 1;
      sourceRequests.set(info.id, request);
      try {
        const result = await api.getThreads({ showSettled: true, harness: info.id });
        if (stopped || sourceRequests.get(info.id) !== request) return;
        const error = result.online ? null : result.errorInfo || (typeof result.error === 'object' ? result.error : { message: result.error });
        state.sources[info.id] = { online: result.online, error, threads: result.online ? result.threads : state.sources[info.id]?.threads || [], loadedAt: Date.now() };
      } catch (error) {
        if (sourceRequests.get(info.id) === request) state.sources[info.id] = { online: false, error: { message: errorMessage(error) }, threads: state.sources[info.id]?.threads || [], loadedAt: Date.now() };
      }
    }));
    lastRefresh = Date.now();
    if (stopped) return;
    // The picker re-renders even while its search box has focus: render() restores the caret.
    if (shouldRender && previous !== JSON.stringify(state.sources) && !state.busy && (state.view === 'picker' || (state.view === 'home' && !editingText()))) render(); else updateChrome();
  }
  // Reads the draft harness's availability; a limited agent moves an untouched draft to "When free".
  async function refreshAvailability(harness = draft().harness, force = false) {
    if (!support(harness).whenAvailable.supported || !api.checkAvailability) return;
    const previous = state.availability[harness];
    if (previous?.loading) return;
    if (!force && previous?.at && Date.now() - previous.at < 20000) return;
    state.availability[harness] = { ...(previous || {}), loading: true };
    try { const result = await api.checkAvailability(harness); state.availability[harness] = result.ok ? { availability: result.availability, at: Date.now() } : { error: result.error?.message || 'Unknown error', at: Date.now() }; }
    catch (error) { state.availability[harness] = { error: errorMessage(error), at: Date.now() }; }
    if (stopped) return;
    const d = state.draft;
    if (d && d.harness === harness && !d.whenTouched && !d.editId && availabilityFor(harness)?.state === 'limited') d.when = 'available';
    if (state.view === 'home' && !state.busy && !editingText()) render(); else updateChrome();
  }
  function route(payload) {
    if (!payload) return;
    if (payload.view === 'composer' || payload.view === 'compose') {
      const harness = payload.harness || draft().harness;
      if (payload.threadId) { state.draft = newDraft(harness); chooseConversation(harness, payload.threadId, payload.threadLabel || '', ''); }
      state.messageOpen = false;
      navigate('home', { focus: '#continue' });
      void refreshSources();
    } else if (payload.jobId) { openDetail(payload.jobId, payload.view === 'history' ? 'history' : 'home'); }
    else if (payload.view === 'settings') navigate('settings', { focus: '[data-section="agents"]' });
    else if (payload.view === 'picker' || payload.view === 'threads') navigate('picker', { focus: '#picker-search' });
    else if (payload.view === 'history') navigate('history', { focus: '#search' });
    else navigate('home', { focus: '#pick' });
  }

  // ---------- Start ----------
  if (!api) { app.innerHTML = '<main class="main"><h1>Open the desktop app</h1><p class="help">This interface needs the Agent Auto-Continue desktop connection.</p></main>'; return; }
  if (api.onNavigate) cleanup.push(api.onNavigate(route));
  if (api.onScheduleInit) cleanup.push(api.onScheduleInit((payload) => route({ ...payload, view: 'composer' })));
  if (api.onJobsChanged) cleanup.push(api.onJobsChanged(() => void refreshJobs(true, true)));
  if (api.onRemoteChanged) cleanup.push(api.onRemoteChanged(() => { if (state.view === 'settings' && !state.busy) void remote?.load(remoteContext()); }));
  if (api.onCompatibilityChanged) cleanup.push(api.onCompatibilityChanged(() => void refreshCompatibility()));
  if (api.onSettingsChanged) cleanup.push(api.onSettingsChanged((settings) => { state.settings = settings; state.agents = settings.agents || []; state.storageError = settings.storageError || state.storageError; if (state.draft && !state.draft.editId) state.draft.bufferSeconds = settings.bufferSeconds; if (!state.busy && state.view !== 'settings') updateChrome(); }));
  if (api.onKeepAwakeChanged) cleanup.push(api.onKeepAwakeChanged((snapshot) => { state.keepAwake = snapshot; if (!state.busy) updateChrome(); }));
  if (api.onUpdateChanged) cleanup.push(api.onUpdateChanged((snapshot) => { state.update = snapshot; if (state.busy) return; if (state.view === 'settings' && !editingText()) render(); else updateChrome(); }));
  if (api.getUpdate) void api.getUpdate().then((snapshot) => { if (stopped) return; state.update = snapshot; if (!state.busy) updateChrome(); }).catch(() => { /* Update status is advisory. */ });
  if (api.getKeepAwake) void api.getKeepAwake().then((snapshot) => { if (stopped) return; state.keepAwake = snapshot; if (state.view === 'settings' && !state.busy) render(); else updateChrome(); }).catch(() => { /* Keep-awake status is advisory. */ });
  const onFocus = () => { if (Date.now() - lastRefresh > 10000) { void refreshSources(); void refreshJobs(); } };
  window.addEventListener('focus', onFocus);
  const onTheme = () => { if (state.theme === 'system') render(); }; mediaTheme.addEventListener('change', onTheme);
  mediaMotion.addEventListener('change', syncStar);
  const starReleases = ['pointerup', 'pointercancel', 'keyup', 'blur']; starReleases.forEach((type) => window.addEventListener(type, letGoStar));
  const onKey = (event) => { if (event.key === 'Escape' && state.view !== 'home') action('back'); }; window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', () => { stopped = true; clearTimeout(timer); clearTimeout(toastTimer); cancelAnimationFrame(starState.frame); cleanup.forEach((unsubscribe) => unsubscribe?.()); window.removeEventListener('focus', onFocus); window.removeEventListener('keydown', onKey); mediaTheme.removeEventListener('change', onTheme); mediaMotion.removeEventListener('change', syncStar); starReleases.forEach((type) => window.removeEventListener(type, letGoStar)); });
  async function poll() {
    if (stopped) return;
    await Promise.allSettled([refreshSources(), refreshJobs(), refreshCompatibility(), state.draft ? refreshAvailability(state.draft.harness) : null]);
    document.querySelectorAll('[data-meta]').forEach((node) => { const job = findJob(node.closest('[data-job]')?.dataset.job); if (job) node.textContent = compose.queueMeta(job, { ...rowContext(), labelled: node.dataset.meta === 'queue' }); });
    const offline = visibleAgents().some((info) => state.sources[info.id]?.online === false);
    timer = setTimeout(poll, offline ? 60000 : 30000);
  }
  render();
  const ready = Promise.all([
    api.getLayout ? api.getLayout().then((result) => { state.layout = result?.layout === 'window' ? 'window' : 'rail'; }).catch(() => {}) : null,
    api.getSettings().then((settings) => { state.settings = settings; state.agents = settings.agents || []; state.storageError = settings.storageError || state.storageError; }).catch((error) => { state.actionError = errorMessage(error); }),
    api.listHarnesses ? api.listHarnesses().then((result) => { state.harnesses = Array.isArray(result?.harnesses) ? result.harnesses : []; }).catch(() => {}) : null
  ]);
  void ready.then(() => {
    if (stopped) return;
    if (!state.draft) state.draft = newDraft();
    else { if (!harnessInfo(state.draft.harness)) state.draft.harness = visibleAgents()[0]?.id || state.draft.harness; fitDraft(state.draft); }
    render();
    void refreshAvailability(state.draft.harness);
    void poll();
  });
})();
