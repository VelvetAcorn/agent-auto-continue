'use strict';
(() => {
  const api = window.autoContinue;
  const time = window.SchedulerTime;
  const sticker = window.SupportStar;
  const remote = window.RemoteSettings;
  const app = document.getElementById('app');
  const $ = (selector) => document.querySelector(selector);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  function preference(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
  const state = {
    view: 'upcoming', returnView: 'upcoming', threads: [], upcoming: [], history: [], upcomingTotal: 0, historyTotal: 0,
    limit: 50, historyLimit: 50, historyFilter: '', search: '', showSettled: false, online: null, connectionError: null,
    settings: null, storageError: null, jobsError: '', actionError: '', unacknowledged: 0, selected: null, draftKey: 'new', drafts: new Map(),
    picking: false, loading: true, busy: false, confirmCancel: false, calendarMonth: '', calendarOpen: false,
    theme: preference('scheduler-theme', 'system'), reduceMotion: preference('scheduler-motion', 'system') === 'reduce',
    settingsDraft: null, harnesses: [], harness: preference('scheduler-harness', 't3'), harnessDraft: null, availability: {}, keepAwake: null, keepAwakeDraft: null, compatibility: []
  };
  let jobRequest = 0, threadRequest = 0, timer, toastTimer, lastRefresh = 0, stopped = false, failuresKnown = false;
  const knownProblems = new Set();
  const listContexts = new Map();
  function saveListContext(){if(['upcoming','history','threads'].includes(state.view)&&!state.picking)listContexts.set(state.view,{search:state.search,scroll:window.scrollY});}
  const mediaTheme = matchMedia('(prefers-color-scheme: dark)');
  const mediaMotion = matchMedia('(prefers-reduced-motion: reduce)');
  // The sticker's phrase and spin live outside the DOM so re-renders never reset or stutter it.
  const starState = { phrase: '', spin: sticker.idle(performance.now()), frame: 0, paintedAt: 0, held: false, layouts: new Map() };
  let measureContext;
  const cleanup = [];
  const draft = () => state.drafts.get(state.draftKey);
  function newDraft(threadId = '', message = 'Continue', zone = localZone, harness = state.harness) {
    const when = time.quickTime(5, zone);
    return { harness, threadId, message, date: when.date, time: when.time, timeZone: zone, occurrence: '', bufferSeconds: state.settings?.bufferSeconds ?? 5, threadTitle: '', projectName: '',
      trigger: 'time', waitIfLimited: false, turnLimit: '1', continuous: false };
  }
  // Automation fields of a job or scheduleAgain payload, in draft form.
  function automationDraft(source) {
    const trigger = source.trigger || source.automation?.trigger || 'time';
    const limit = source.automation ? source.automation.limit : source.turnLimit;
    const continuous = source.automation ? source.automation.unlimited : source.continuous === true;
    return { trigger: trigger === 'available' ? 'available' : 'time', waitIfLimited: trigger === 'time-then-available', turnLimit: String(continuous ? 1 : limit || 1), continuous };
  }
  const harnessInfo = (id = state.harness) => state.harnesses.find(item => item.id === id);
  const harnessLabel = (id = state.harness) => harnessInfo(id)?.label || (id === 't3' ? 'T3 Code' : id);
  const noun = (id = state.harness) => harnessInfo(id)?.conversationNoun || 'thread';
  function harnessOptions(selected) {
    const list = state.harnesses.length ? state.harnesses : [{ id: 't3', label: 'T3 Code' }];
    return list.map(item => `<option value="${escape(item.id)}" ${item.id === selected ? 'selected' : ''}>${escape(item.label)}</option>`).join('');
  }
  function useHarness(id) {
    if (!id || id === state.harness) return;
    state.harness = id; state.threads = []; state.online = null; state.connectionError = null;
    try { localStorage.setItem('scheduler-harness', id); } catch { /* Preference can remain session-only. */ }
  }
  // What a harness supports automatically; until metadata loads, nothing automatic is offered.
  function support(id) {
    const label = harnessLabel(id);
    const loading = { supported: false, reason: `Checking what ${label} supports…` };
    return harnessInfo(id)?.automation || { whenAvailable: loading, multipleTurns: loading };
  }
  // Keeps a draft within what its harness supports, for example after choosing another harness.
  function fitDraft(d) {
    if (!d) return;
    const can = support(d.harness);
    if (!can.whenAvailable.supported) { d.trigger = 'time'; d.waitIfLimited = false; }
    if (!can.multipleTurns.supported) { d.continuous = false; d.turnLimit = '1'; }
  }
  function errorMessage(error) {
    return String(error?.message || 'Something went wrong. Please try again.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
  function display(iso, zone = localZone, seconds = false) {
    if (!iso) return 'Time unavailable';
    try { const f = time.formatInstant(iso, zone); return `${f.date} · ${f.time}${seconds ? ':' + f.seconds : ''} ${f.offset}`; } catch { return 'Time unavailable'; }
  }
  function relative(iso) {
    const diff = Date.parse(iso) - Date.now();
    if (!Number.isFinite(diff)) return 'Time unavailable';
    const absolute = Math.abs(diff);
    if (absolute < 60000) return diff > 0 ? 'In less than a minute' : 'Just now';
    const unit = absolute < 3600000 ? 'min' : absolute < 86400000 ? 'hour' : 'day';
    const value = Math.floor(absolute / (unit === 'min' ? 60000 : unit === 'hour' ? 3600000 : 86400000));
    return diff > 0 ? `In ${value} ${unit}${value !== 1 && unit !== 'min' ? 's' : ''}` : `${value} ${unit}${value !== 1 && unit !== 'min' ? 's' : ''} ago`;
  }
  const labels = { pending: 'Scheduled', dispatching: 'Sending', sent: 'Sent', failed: 'Failed', canceled: 'Canceled', unconfirmed: 'Delivery unconfirmed', running: 'Agent working', paused: 'Paused', stopped: 'Stopped', finished: 'Finished' };
  const stateLabels = { working: 'Working', idle: 'Idle', waiting: 'Waiting', open: 'Open elsewhere', 'in-use': 'In use', retrying: 'Retrying', error: 'Error' };
  const pill = (status, text) => `<span class="pill ${escape(status)}">${escape(text || labels[status] || stateLabels[status] || status)}</span>`;
  const jobPill = (job) => pill(job.displayStatus || job.deliveryStatus || job.status, job.deliveryLabel);
  function nav() {
    return `<nav aria-label="Main navigation">${[['upcoming','Upcoming'],['history','History'],['threads','Threads'],['settings','Settings']].map(([view,label]) => `<button type="button" data-nav="${view}" class="${state.view === view ? 'active' : ''}" ${state.view === view ? 'aria-current="page"' : ''}>${label}<span class="nav-count" data-count="${view}">${view === 'upcoming' ? state.upcomingTotal : view === 'history' && state.unacknowledged ? state.unacknowledged : ''}</span></button>`).join('')}</nav>`;
  }
  function connection() {
    return `<span class="connection ${state.online === false ? 'offline' : ''}" id="connection-state">${state.online === null ? 'Connecting…' : state.online ? escape(harnessLabel()) + ' connected' : 'Offline · queue saved'}</span>`;
  }
  // Short names for the contact points in lib/harnesses/errors.js, shown beside the ID for bug reports.
  const CONTACT_POINT_NAMES = { app_path: 'App files', deep_link: 'Conversation links', content_match: 'Open conversation title', composer_label: 'Message box label', send_label: 'Send button label', stop_label: 'Stop button label', label_catalogue: 'Translated labels', session_store: 'Session store', live_registry: 'Working status', transcript: 'Transcript format', originator: 'Conversation owner', app_server: 'Codex server replies' };
  const contactPointName = (id) => CONTACT_POINT_NAMES[id] ? `${CONTACT_POINT_NAMES[id]} (${id})` : id;
  // One notice per desktop app whose installed version changed in a way this version does not understand.
  function compatibilityNotices() {
    return state.compatibility.filter(item => item.problems?.length).map(item => {
      const name = `${item.label}${item.appVersion ? ' ' + item.appVersion : ''}`;
      const atRisk = state.upcoming.filter(job => job.harness === item.harness && job.risk).length;
      const facts = [item.verifiedVersion ? `Verified with ${item.verifiedVersion}` : '', `Changed: ${item.problems.map(problem => contactPointName(problem.contactPoint)).join(', ')}`, item.checkedAt ? `Last checked ${relative(item.checkedAt).toLocaleLowerCase()}` : ''].filter(Boolean);
      return `<div class="notice" role="status"><div><strong>${escape(name)} isn’t supported yet</strong><p>${escape(item.problems[0].message)}</p>${atRisk ? `<p>${atRisk === 1 ? 'One scheduled message is' : `${atRisk} scheduled messages are`} at risk. ${atRisk === 1 ? 'It stays' : 'They stay'} scheduled, and if the problem remains when ${atRisk === 1 ? 'it is' : 'one is'} due, nothing is sent.</p>` : ''}<details><summary>Technical details</summary><p>${facts.map(escape).join(' · ')}</p></details></div><button type="button" data-action="copy-diagnostics">Copy diagnostics</button><button type="button" class="ghost" data-action="recheck-compatibility" data-harness="${escape(item.harness)}">Check again</button></div>`;
    }).join('');
  }
  function notice() {
    const storage = state.storageError ? `<div class="notice" role="alert"><div><strong>Local schedule storage needs attention</strong><p>${escape(state.storageError.message)}</p></div></div>` : '';
    return storage + keepAwakeNotice() + (state.online === false ? `<div class="notice"><div><strong>${escape(harnessLabel())} is unavailable</strong><p>${escape(state.connectionError?.message || `Check that ${harnessLabel()} is available and review your connection settings. Your local queue and history remain available.`)}</p>${technical(state.connectionError)}</div>${state.connectionError?.code === 'permission_required' ? '<button type="button" data-action="open-permission-settings">Open System Settings</button>' : ''}<button type="button" data-action="check">Check connection</button><button type="button" class="ghost" data-nav="settings">Settings</button></div>` : '') + compatibilityNotices();
  }
  function keepAwakeNotice() {
    const k = state.keepAwake;
    if (!k?.enabled || !['armed','active','releasing','paused','ended'].includes(k.state)) return '';
    const holding = Boolean(k.holding);
    const title = holding ? (k.state === 'releasing' ? 'Letting your Mac sleep soon' : `Keeping your Mac awake${k.holding === 'display' ? ' with the display on' : ''}`) : k.state === 'paused' ? 'Keep-awake paused' : 'Your Mac can sleep';
    const limit = holding && k.deadline && k.state !== 'releasing' ? ` Stops by ${escape(display(k.deadline))} at the latest.` : '';
    const capped = k.capped || [];
    const listed = k.tasks.concat(capped);
    const item = (task, over) => `<li><span>${escape(task.label)}</span> · ${escape(task.detail || task.state)}${task.until ? ` · ${task.state === 'waiting' ? 'starts' : 'until'} ${escape(display(task.until))}` : ''}${over ? ' · reached the time limit' : ''}</li>`;
    const tasks = k.tasks.map(task => item(task, false)).concat(capped.map(task => item(task, true))).join('');
    const count = (n) => `${n} ${n === 1 ? 'task' : 'tasks'}`;
    const summary = [k.tasks.length ? `${count(k.tasks.length)} ${holding ? (k.tasks.length === 1 ? 'needs it' : 'need it') : 'still tracked'}` : '', capped.length ? `${count(capped.length)} reached the time limit` : ''].filter(Boolean).join(' · ');
    const slept = k.lastSleep?.whileHolding && k.since && k.lastSleep.from >= k.since ? `<p>macOS slept anyway from ${escape(display(k.lastSleep.from))} to ${escape(display(k.lastSleep.to))}. Missed schedules catch up after waking.</p>` : '';
    const overLimit = holding && capped.length ? `<p>${capped.length} ${capped.length === 1 ? 'task' : 'tasks'} reached the time limit and no longer ${capped.length === 1 ? 'keeps' : 'keep'} the Mac awake.</p>` : '';
    const unlocked = holding && k.requiresUnlockedScreen ? '<p>A scheduled task drives an app’s interface, so the display stays on. Keep the screen unlocked until it finishes.</p>' : '';
    const button = holding ? '<button type="button" data-action="keep-awake-stop">Let Mac sleep</button>' : k.state === 'ended' && k.ended?.reason !== 'battery-floor' && listed.length ? '<button type="button" data-action="keep-awake-resume">Keep awake again</button>' : '';
    return `<div class="notice awake${holding ? ' holding' : ''}" role="status"><div><strong>${title}</strong><p>${escape(k.reason)}${limit}</p>${unlocked}${overLimit}${slept}${tasks ? `<details><summary>${summary}</summary><ul class="awake-tasks">${tasks}</ul></details>` : ''}</div>${button}</div>`;
  }
  function keepAwakeSettings() {
    const k = state.keepAwake;
    if (!k) return '<section class="card"><span class="overline">Keep awake</span><p>Loading keep-awake settings…</p></section>';
    if (!state.keepAwakeDraft) state.keepAwakeDraft = { ...k.settings };
    const d = state.keepAwakeDraft;
    const box = (id, key, label) => `<div class="setting-row"><label for="${id}">${label}</label><input id="${id}" type="checkbox" ${d[key] ? 'checked' : ''}></div>`;
    return `<section class="card"><span class="overline">Keep awake</span><h2>Stay awake for tracked work</h2><form id="keep-awake-form">${box('ka-enabled','enabled','Keep this Mac awake while scheduled work waits or runs')}${box('ka-display','keepDisplayOn','Keep the display on too')}${box('ka-agents','includeRunningAgents','Also stay awake while any T3 Code agent turn runs')}<label class="field">On battery<select id="ka-power">${[['any','Keep awake on battery too'],['ac-only','Only when connected to power']].map(([value,label]) => `<option value="${value}" ${d.powerSource === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="two"><label class="field">Stop at battery · %<input id="ka-floor" type="number" min="0" max="95" required value="${escape(d.batteryFloorPercent)}" ${d.powerSource === 'ac-only' ? 'disabled' : ''}><small>0 keeps going until macOS sleeps for low battery.</small></label><label class="field">Time limit · hours<input id="ka-hours" type="number" min="1" max="72" required value="${escape(d.maxHours)}"><small>Each session ends after this, even if work remains.</small></label></div><p class="help" id="ka-status">${escape(keepAwakeStatus())}</p><details class="help"><summary>Lid, lock screen and sleep</summary><p>Locking the screen or letting the display sleep does not stop scheduled work, except for agents that drive a desktop app (Claude Desktop, ChatGPT Codex threads), which need the Mac unlocked to send. Closing a laptop lid sleeps the Mac unless it is in closed-display mode, with power, an external display and a keyboard or mouse connected. Choosing Sleep or a critically low battery also sleeps the Mac; missed schedules catch up after waking.</p></details><p class="error" id="keep-awake-error" role="alert"></p><div class="actions"><button type="submit" class="primary">Save keep-awake settings</button></div></form></section>`;
  }
  function keepAwakeStatus() {
    const k = state.keepAwake;
    if (!k) return '';
    return `Status: ${k.enabled ? k.reason : 'Off. Your Mac sleeps on its usual schedule.'}`;
  }
  function technical(info) {
    if (!info?.details && !info?.code) return '';
    const details = info.details || {};
    const app = details.appVersion ? `${details.app || 'App'} ${details.appVersion}${details.verifiedVersion && details.verifiedVersion !== details.appVersion ? ` (verified with ${details.verifiedVersion})` : ''}` : '';
    return `<details><summary>Technical details</summary><p>${[info.code, details.status ? 'HTTP ' + details.status : '', details.endpoint, details.contentType, app, details.contactPoint && contactPointName(details.contactPoint), details.hint].filter(Boolean).map(escape).join(' · ')}</p></details>`;
  }
  function render(focusSelector) {
    const active = document.activeElement;
    const activeId = active?.id;
    const activeData = active?.dataset ? Object.entries(active.dataset).find(([key])=>['nav','action','job','thread','filter','month','day','quick','harnessKey','trigger'].includes(key)) : null;
    const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    document.body.className = `${state.theme === 'dark' || state.theme === 'system' && mediaTheme.matches ? 'dark' : ''} ${state.reduceMotion ? 'motion-off' : ''}`;
    const titles = { upcoming: 'Upcoming', history: 'History', threads: state.picking ? `Choose a ${noun()}` : 'Threads', settings: 'Settings', composer: draft()?.editId ? 'Edit schedule' : 'New schedule', detail: 'Message details' };
    app.innerHTML = `<header class="topbar">${nav()}<div class="top-actions">${connection()}<button type="button" class="ghost" data-action="theme" aria-label="Switch to ${document.body.classList.contains('dark') ? 'light' : 'dark'} theme">${document.body.classList.contains('dark') ? '☀' : '☾'}</button></div></header><main class="content" id="main-content">${['composer','detail'].includes(state.view) || state.picking ? `<button type="button" class="ghost back" data-action="back">← ${state.picking ? 'Back to draft' : 'Back to ' + state.returnView}</button>` : ''}<div class="heading"><h1 tabindex="-1">${titles[state.view]}</h1>${['upcoming','history','threads'].includes(state.view) && !state.picking ? '<button type="button" class="primary" data-action="new">＋ New schedule</button>' : ''}</div><div id="notices">${notice()}</div>${state.actionError ? `<p class="error" role="alert">${escape(state.actionError)}</p>` : ''}${state.view === 'composer' ? composer() : state.view === 'detail' ? detail() : state.view === 'settings' ? settings() : state.view === 'threads' ? threadList() : jobList()}</main>`;
    bind();
    if (state.busy) app.querySelectorAll('button, input, textarea, select').forEach(control => { control.disabled = true; });
    if (focusSelector) $(focusSelector)?.focus();
    else if (activeId && document.getElementById(activeId)) {
      const replacement = document.getElementById(activeId); replacement.focus();
      if (selection && replacement.setSelectionRange && !['number','checkbox'].includes(replacement.type)) replacement.setSelectionRange(...selection);
    } else if(activeData) app.querySelector('[data-'+activeData[0]+'="'+CSS.escape(activeData[1])+'"]')?.focus();
    syncStar();
  }
  function jobList() {
    const history = state.view === 'history';
    const all = history ? state.history : state.upcoming;
    const total = history ? state.historyTotal : state.upcomingTotal;
    if(state.storageError) return '<p class="help">Your saved records have not been replaced. Scheduling is paused until local storage is repaired.</p>';
    const query = state.search.trim().toLocaleLowerCase();
    const rows = all.filter(job => !query || `${job.threadTitle || job.threadId} ${job.projectName || ''} ${job.harnessLabel || ''} ${job.message}`.toLocaleLowerCase().includes(query));
    return `${state.jobsError ? `<div class="notice"><div><strong>Could not read schedules</strong><p>${escape(state.jobsError)}</p></div><button data-action="refresh">Try again</button></div>` : ''}${history && state.unacknowledged ? `<div class="notice"><div><strong>${state.unacknowledged} ${state.unacknowledged === 1 ? 'delivery needs' : 'deliveries need'} a look</strong><p>Acknowledge an outcome to clear its attention badge. The record stays here.</p></div></div>` : ''}${history ? '' : continuingNotice()}<div class="filters"><label class="sr-only" for="search">Search ${all.length < total ? 'loaded ' : ''}messages</label><input id="search" class="search" type="search" placeholder="Search ${all.length < total ? 'loaded ' : ''}messages…" value="${escape(state.search)}"></div>${history ? `<div class="chips" aria-label="History filters">${[['','All'],['sent','Sent'],['failed','Failed'],['unconfirmed','Unconfirmed'],['canceled','Canceled']].map(([value,label]) => `<button type="button" data-filter="${value}" class="${state.historyFilter === value ? 'active' : ''}" aria-pressed="${state.historyFilter === value}">${label}</button>`).join('')}</div>` : ''}<section class="card" aria-label="${history ? 'Delivery history' : 'Scheduled messages'}"><div class="list-head"><span>${history ? 'DELIVERY LOG' : 'YOUR QUEUE'} · ${total}</span><span>${history ? 'Newest first' : 'Soonest first'} ↓</span></div>${state.loading && !all.length ? '<div class="empty"><p>Loading schedules…</p></div>' : rows.length ? rows.map(jobRow).join('') : `<div class="empty"><div class="empty-icon" aria-hidden="true">◷</div><h2>${query ? 'No matching messages' : history ? 'No history yet' : 'A clear runway.'}</h2><p>${query ? 'Try another search' + (all.length < total ? ' or load more records.' : '.') : history ? 'Your delivery outcomes will appear here.' : 'Schedule a message for when you’re ready to pick things up.'}</p>${!history && !query ? '<button type="button" data-action="new" class="primary">New schedule</button>' : ''}</div>`}</section>${all.length < total ? `<div class="load-more"><button data-action="more">Load more (${all.length} of ${total})</button></div>` : ''}<p class="help">${history ? '“Sent” confirms delivery, not completion of agent work.' : 'Each schedule shows its saved timezone. A saved send time stays fixed when you travel.'}</p>`;
  }
  // One visible, one-click way to stop every automatic continuation.
  function continuingNotice() {
    const active = state.upcoming.filter(job => job.automation?.state === 'active');
    if (!active.length) return '';
    return `<div class="notice continuing"><div><strong>${active.length} automatic ${active.length === 1 ? 'continuation is' : 'continuations are'} running</strong><p>${active.some(job => job.automation.unlimited) ? 'Continuous mode keeps sending until you stop it.' : 'Each stops at its turn limit.'} Stopping never interrupts a turn already in progress.</p></div><button type="button" class="danger" data-action="stop-all">Stop all</button></div>`;
  }
  function jobRow(job) {
    const history = state.view === 'history';
    const status = job.displayStatus || job.deliveryStatus || job.status;
    const running = !history && status === 'running';
    const when = history ? job.updatedAt || job.scheduleAt : running ? job.dispatchedAt || job.updatedAt : job.effectiveAt || job.scheduleAt;
    const zone = job.timeZone || localZone;
    const prefix = running ? 'Sent ' : !history && status === 'waiting' ? 'Next check ' : '';
    const progress = job.automation ? `<span class="progress">${escape(job.automation.progressLabel)}</span>` : '';
    return `<button type="button" class="row" data-job="${escape(job.id)}"><div class="row-top"><span class="overline">${escape(jobSource(job))}</span><span class="pills">${job.risk ? '<span class="pill risk">At risk</span>' : ''}${jobPill(job)}</span></div><div class="row-title">${escape(job.threadTitle || job.threadId)}</div><div class="row-preview">${escape(job.message)}</div><div class="meta"><span>${escape(prefix + display(when, zone))}${progress}</span><span data-relative="${escape(when)}">${relative(when)}</span></div></button>`;
  }
  function jobSource(job) { return [job.harnessLabel || harnessLabel(job.harness || 't3'), job.projectName || job.projectId].filter(Boolean).join(' · '); }
  const turnLabels = { running: 'Running', completed: 'Finished', failed: 'Stopped with an error', interrupted: 'Interrupted', unknown: 'Unknown' };
  function turnSummary(job) {
    if (!job.turn) return '';
    const reset = job.turn.usageLimit?.resetsAt ? ` · limit resets ${display(job.turn.usageLimit.resetsAt, job.timeZone || localZone)}` : '';
    return `<dt>Agent turn</dt><dd>${escape((turnLabels[job.turn.state] || job.turn.state) + reset)}</dd>`;
  }
  function threadList() {
    const query = state.search.trim().toLocaleLowerCase();
    const rows = state.threads.filter(thread => (state.showSettled || thread.settled !== true) && (!query || `${thread.title} ${thread.projectName || thread.projectId}`.toLocaleLowerCase().includes(query)));
    return `<div class="filters"><label class="sr-only" for="threads-harness">Agent harness</label><select id="threads-harness" class="harness-select">${harnessOptions(state.harness)}</select><input class="search" id="search" type="search" aria-label="Search ${escape(noun())}s" placeholder="Find a ${escape(noun())}…" value="${escape(state.search)}"><label><input id="show-settled" type="checkbox" ${state.showSettled ? 'checked' : ''}> Show settled</label><button type="button" class="ghost" data-action="refresh">Refresh</button></div><section class="card" aria-label="Threads"><div class="list-head"><span>${state.showSettled ? `NON-ARCHIVED ${escape(noun().toUpperCase())}S` : 'SETTLED HIDDEN'}</span><span>Recent activity ↓</span></div>${rows.length ? rows.map(thread => `<button type="button" class="row" data-thread="${escape(thread.id)}"><div class="row-top"><span class="overline">${escape([thread.projectName || thread.projectId || harnessLabel(), thread.source].filter(Boolean).join(' · '))}</span>${pill(thread.state)}</div><div class="row-title">${escape(thread.title)}</div><div class="meta"><span>${thread.updatedAt ? `<span class="thread-time-short" aria-hidden="true">${escape(display(thread.updatedAt))}</span><time class="thread-time-exact" datetime="${escape(thread.updatedAt)}">${escape(thread.updatedAt)}</time>` : 'Last update unavailable'}</span><span data-relative="${escape(thread.updatedAt || '')}">${thread.updatedAt ? relative(thread.updatedAt) : ''}</span></div></button>`).join('') : `<div class="empty"><h2>${state.online === false ? `${escape(noun()).replace(/^./, c => c.toUpperCase())}s are unavailable` : `No matching ${escape(noun())}s`}</h2><p>${state.online === false ? `Reconnect to ${escape(harnessLabel())} to choose a ${escape(noun())}.` : `Clear your search or include settled ${escape(noun())}s.`}</p>${state.online !== false ? `<button type="button" data-action="clear-thread-filter">Show all non-archived ${escape(noun())}s</button>` : ''}</div>`}</section><p class="help">Unknown states stay visible. Settled filtering never hides existing scheduled messages.</p>`;
  }
  function composer() {
    const d = draft();
    if (!d) return '<p>Preparing your draft…</p>';
    const thread = d.harness === state.harness ? state.threads.find(item => item.id === d.threadId) : null;
    const kind = noun(d.harness);
    const title = thread?.title || d.threadTitle || (d.threadId ? `${kind.replace(/^./, c => c.toUpperCase())} ${d.threadId}` : `Choose a ${kind}`);
    const timed = d.trigger !== 'available';
    const timeFields = `<div class="chips" aria-label="Quick times"><button type="button" data-quick="5">+5 min</button><button type="button" data-quick="30">+30 min</button><button type="button" data-quick="60">+1 hour</button><button type="button" data-quick="tomorrow">Tomorrow, 09:00</button></div><div class="two"><label class="field">Date · yyyy-mm-dd<input id="date" inputmode="numeric" value="${escape(d.date)}" placeholder="yyyy-mm-dd" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" required aria-describedby="schedule-error"></label><label class="field">Time · 24-hour<input id="time" inputmode="numeric" value="${escape(d.time)}" placeholder="HH:mm" pattern="[0-2][0-9]:[0-5][0-9]" required aria-describedby="schedule-error"></label></div><button type="button" class="ghost" data-action="calendar" aria-expanded="${state.calendarOpen}" aria-controls="calendar">▦ ${state.calendarOpen ? 'Hide' : 'Open'} calendar</button>${state.calendarOpen ? calendar() : ''}<label class="field">Timezone<input id="timezone" list="timezones" value="${escape(d.timeZone)}" required autocomplete="off"><datalist id="timezones">${zones().map(zone => `<option value="${escape(zone)}"></option>`).join('')}</datalist></label>`;
    return `<section class="card panel" aria-label="Schedule composer"><form id="schedule-form"><label class="field" for="harness">Agent harness</label><select id="harness" class="harness-select" ${d.editId ? 'disabled' : ''}>${harnessOptions(d.harness)}</select><label class="field">Send to ${escape(kind)}</label><button type="button" class="thread-picker" data-action="pick" ${d.editId ? 'disabled' : ''}>${escape(title)}${d.editId ? '' : ' ⌄'}<small>${escape(thread?.projectName || d.projectName || (d.threadId ? harnessLabel(d.harness) : 'Most recently active first'))}</small></button><label class="field" for="message">Message</label><textarea id="message" name="message" maxlength="4000" required>${escape(d.message)}</textarea>${startControls(d)}${timed ? timeFields : ''}${turnControls(d)}<div id="schedule-preview">${schedulePreview()}</div><p class="error" id="schedule-error" role="alert"></p><button type="submit" class="primary full">${d.editId ? 'Save changes' : timed ? 'Schedule message' : 'Start when available'} ↗</button></form></section>`;
  }
  // Trigger choice. Modes the harness cannot support stay visible, disabled, with the reason.
  function startControls(d) {
    const can = support(d.harness).whenAvailable;
    const label = harnessLabel(d.harness);
    const option = (value, text) => `<button type="button" data-trigger="${value}" class="${d.trigger === value ? 'active' : ''}" aria-pressed="${d.trigger === value}" ${value === 'available' && !can.supported ? 'disabled aria-describedby="trigger-help"' : ''}>${text}</button>`;
    const wait = d.trigger === 'time' ? `<label class="check"><input id="wait-if-limited" type="checkbox" ${d.waitIfLimited && can.supported ? 'checked' : ''} ${can.supported ? '' : 'disabled'} aria-describedby="trigger-help"> If ${escape(label)} is at a usage limit then, wait until it is available</label>` : '';
    return `<label class="field" id="start-label">Start</label><div class="chips" role="group" aria-labelledby="start-label">${option('time', 'At a time')}${option('available', 'When available')}</div>${wait}<p class="help" id="trigger-help">${escape(can.reason)}</p>`;
  }
  function turnControls(d) {
    const can = support(d.harness).multipleTurns;
    const off = !can.supported;
    return `<div class="turns"><label class="field">Turn limit<input id="turn-limit" type="number" min="1" step="1" inputmode="numeric" required value="${escape(d.continuous ? '' : d.turnLimit)}" placeholder="${d.continuous ? 'No limit' : '1'}" ${d.continuous || off ? 'disabled' : ''} aria-describedby="turn-help"><small>Messages to send in total. Each one waits for the previous turn to finish.</small></label><label class="check"><input id="continuous" type="checkbox" ${d.continuous && !off ? 'checked' : ''} ${off ? 'disabled' : ''} aria-describedby="turn-help"> Keep continuing until I stop it</label></div><p class="help" id="turn-help">${escape(can.reason)}${can.supported ? ' A finished turn does not mean the task is done, so set a limit or stop it yourself.' : ''}</p>`;
  }
  function zones() { try { return [localZone, 'UTC', ...Intl.supportedValuesOf('timeZone')].filter((value, index, list) => list.indexOf(value) === index); } catch { return [localZone, 'UTC', 'Europe/London', 'America/New_York', 'Asia/Tokyo']; } }
  function availabilityText(harness) {
    const entry = state.availability[harness || 't3'];
    if (!entry || (!entry.availability && !entry.error)) return 'Checking availability…';
    if (entry.error) return `Availability could not be read: ${entry.error}`;
    const value = entry.availability;
    const source = value.source === 'reported' ? 'reported by the agent' : value.source === 'inferred' ? 'inferred from local records' : 'no source';
    const now = { available: 'Available now', limited: value.resetsAt ? `At a usage limit until ${display(value.resetsAt)}` : 'At a usage limit, reset time unknown', unavailable: value.reason === 'screen_locked' ? 'Waiting for the Mac to be unlocked' : 'Unavailable', unknown: 'Availability unknown' }[value.state] || 'Availability unknown';
    return `${now} · ${source} · checked ${relative(value.checkedAt).toLocaleLowerCase()}`;
  }
  function turnPlan(d) {
    if (d.continuous) return 'Keeps sending after each finished turn until you stop it.';
    const limit = Number(d.turnLimit);
    if (!Number.isInteger(limit) || limit < 1) return 'Enter a turn limit of 1 or more.';
    return limit === 1 ? 'Sends one message.' : `Sends up to ${limit} messages, each after the previous turn finishes.`;
  }
  const rules = '<details><summary>Scheduling rules</summary><p>New user activity after schedule creation cancels a single message and pauses an automatic continuation. Continuations also pause when a turn fails, is interrupted, ends unclear, or the agent asks you something, and never resend when delivery is uncertain. Saved send times stay fixed when your system timezone changes. Missed schedules catch up when the app resumes.</p></details>';
  function schedulePreview() {
    const d = draft();
    const plan = `<span>${escape(turnPlan(d))}</span>`;
    if (d.trigger === 'available') {
      return `<div class="summary"><span class="overline">Send preview</span><strong>As soon as ${escape(harnessLabel(d.harness))} is available</strong><span>${escape(availabilityText(d.harness))}</span><br>${plan}<br>${d.bufferSeconds ? `Waits the ${d.bufferSeconds}-second safety buffer after a limit resets.` : 'No safety buffer.'}${rules}</div>`;
    }
    let candidates;
    try { candidates = time.wallTimeCandidates(d.date, d.time, d.timeZone); } catch (error) { return `<p class="help">${escape(errorMessage(error))}</p>`; }
    if (!candidates.length) return '<p class="error">That time does not exist when the clocks move forward. Choose another time.</p>';
    const selected = candidates.length === 1 ? candidates[0] : candidates.find(candidate => candidate.iso === d.occurrence);
    const waiting = d.waitIfLimited && support(d.harness).whenAvailable.supported ? `<br><span>If ${escape(harnessLabel(d.harness))} is at a usage limit then, it waits until the limit resets.</span>` : '';
    return `${candidates.length > 1 ? `<label class="field">This time occurs twice. Choose an offset<select id="occurrence" required><option value="">Choose an occurrence</option>${candidates.map((candidate,index) => `<option value="${candidate.iso}" ${d.occurrence === candidate.iso ? 'selected' : ''}>${index === 0 ? 'First' : 'Second'} · ${time.offsetLabel(candidate.offsetMinutes)}</option>`).join('')}</select></label>` : ''}<div class="summary"><span class="overline">Send preview</span><strong>${selected ? escape(display(new Date(Date.parse(selected.iso) + d.bufferSeconds * 1000).toISOString(), d.timeZone, true)) : 'Choose which occurrence to use'}</strong>${d.bufferSeconds ? `Includes the ${d.bufferSeconds}-second safety buffer.` : 'No safety buffer.'}<br>${plan}${waiting}${rules}</div>`;
  }
  // Reads the harness's current availability for the composer preview.
  async function refreshAvailability(harness = draft()?.harness || 't3') {
    if (!support(harness).whenAvailable.supported || !api.checkAvailability) return;
    // One read at a time per harness; the previous reading stays visible until the new one arrives.
    const previous = state.availability[harness];
    if (previous?.loading) return;
    state.availability[harness] = { ...(previous || {}), loading: true };
    try { const result = await api.checkAvailability(harness); state.availability[harness] = result.ok ? { availability: result.availability, at: Date.now() } : { error: result.error?.message || 'Unknown error', at: Date.now() }; }
    catch (error) { state.availability[harness] = { error: errorMessage(error), at: Date.now() }; }
    if (state.view === 'composer') updatePreview();
  }
  function updatePreview() {
    const target = $('#schedule-preview');
    if (target) { target.innerHTML = schedulePreview(); bindOccurrence(); }
  }
  function calendar() {
    const d = draft();
    const month = /^\d{4}-\d{2}$/.test(state.calendarMonth) ? state.calendarMonth : d.date.slice(0,7);
    const [year, numericMonth] = month.split('-').map(Number);
    const safeYear = year >= 1000 && year <= 9999 ? year : new Date().getFullYear();
    const safeMonth = numericMonth >= 1 && numericMonth <= 12 ? numericMonth : new Date().getMonth() + 1;
    state.calendarMonth = `${safeYear}-${String(safeMonth).padStart(2,'0')}`;
    const count = new Date(Date.UTC(safeYear, safeMonth, 0)).getUTCDate();
    const offset = (new Date(Date.UTC(safeYear, safeMonth - 1, 1)).getUTCDay() + 6) % 7;
    return `<section id="calendar" class="calendar" aria-label="Choose a calendar date"><div class="calendar-top"><button type="button" data-month="-1" aria-label="Previous month">←</button><strong aria-live="polite">${state.calendarMonth}</strong><button type="button" data-month="1" aria-label="Next month">→</button></div><div class="calendar-grid">${['Mo','Tu','We','Th','Fr','Sa','Su'].map(day => `<small aria-hidden="true">${day}</small>`).join('')}${'<span aria-hidden="true"></span>'.repeat(offset)}${Array.from({length:count},(_,index) => { const date = state.calendarMonth + '-' + String(index+1).padStart(2,'0'); return `<button type="button" data-day="${date}" aria-label="${date}" aria-pressed="${d.date === date}" class="${d.date === date ? 'chosen' : ''}">${index+1}</button>`; }).join('')}</div></section>`;
  }
  function findJob(id = state.selected) { return [...state.upcoming, ...state.history].find(job => job.id === id) || (state.selectedJob?.id === id ? state.selectedJob : null); }
  function detail() {
    const job = findJob();
    if (!job) return '<div class="empty"><h2>Schedule unavailable</h2><p>Return to the list and refresh.</p></div>';
    const zone = job.timeZone || localZone;
    const status = job.deliveryStatus || job.status;
    const auto = job.automation;
    const label = job.harnessLabel || harnessLabel(job.harness || 't3');
    const timed = !auto || auto.trigger !== 'available' || auto.currentTurn > 1;
    const problem = ['failed','unconfirmed'].includes(status) ? `<div class="error-detail"><h3>${status === 'unconfirmed' ? 'Check delivery before trying again' : 'This message could not be delivered'}</h3><p>${escape(job.error?.message || job.note)}</p>${technical(job.error)}${job.lastReconciledAt ? `<p>Last checked: ${escape(display(job.lastReconciledAt, zone))}. ${status === 'unconfirmed' ? 'Delivery is still unconfirmed. No resend was attempted.' : ''}</p>` : ''}<div class="actions"><button type="button" data-action="ack" ${job.acknowledgedAt ? 'disabled' : ''}>${job.acknowledgedAt ? 'Acknowledged ✓' : 'Acknowledge'}</button><button type="button" class="ghost" data-nav="settings">Connection settings</button></div></div>` : '';
    const info = problem || (auto ? (['waiting','pending'].includes(job.displayStatus) && job.note ? `<p class="help">${escape(job.note)}</p>` : '') : status === 'sent' ? `<p class="help">${escape(label)} accepted the message.${job.turn ? '' : ' This does not confirm that the agent completed its work.'}</p>` : job.note ? `<p class="help">${escape(job.note)}</p>` : '');
    // A running continuation's next turn is at risk too, even while its current turn shows as sent.
    const risky = Boolean(job.risk) && (status === 'pending' || auto?.state === 'active');
    const risk = risky ? `<div class="risk-detail"><h3>${auto ? 'The next turn may not be sent' : 'This message may not be sent'}</h3><p>${escape(job.risk.message)}</p><p>${auto ? 'The continuation keeps going. If the problem remains when its next turn is due, nothing is sent and it pauses.' : 'It stays scheduled. If the problem remains when it is due, it fails without sending anything.'}</p></div>` : '';
    const actions = auto ? automationActions(job, status) : status === 'pending' ? '<button type="button" class="primary" data-action="edit">Edit schedule</button><button type="button" class="ghost danger" data-action="cancel">Cancel schedule</button>' : status === 'unconfirmed' ? '<button type="button" class="primary" data-action="reconcile">Check delivery</button>' : status !== 'dispatching' ? '<button type="button" class="primary" data-action="again">Schedule again</button>' : '<p class="help">Sending has started. This message can no longer be changed or canceled.</p>';
    return `<section class="card panel"><div class="detail-header"><span class="overline">${escape(jobSource(job))}</span><span class="pills">${risky ? '<span class="pill risk">At risk</span>' : ''}${jobPill(job)}</span></div><h2>${escape(job.threadTitle || job.threadId)}</h2><p class="message">${escape(job.message)}</p>${auto ? `<div class="actions">${actions}</div>${risk}${info}${automationDetail(job, zone)}` : ''}<dl class="key-values"><dt>Agent harness</dt><dd>${escape(label)}</dd>${auto ? '' : turnSummary(job)}${timed ? `<dt>Requested time</dt><dd>${escape(display(job.scheduleAt, zone))}</dd>` : `<dt>Start</dt><dd>When ${escape(label)} is available</dd>`}${auto && !['pending','dispatching'].includes(status) ? '' : `<dt>${job.displayStatus === 'waiting' ? 'Next check' : 'Effective send time'}</dt><dd>${escape(display(job.effectiveAt, zone, true))}</dd>`}<dt>Timezone</dt><dd>${escape(zone)}${job.timeZone ? '' : ' (legacy record)'}</dd><dt>Safety buffer</dt><dd>${job.bufferSeconds} seconds</dd><dt>Last updated</dt><dd>${escape(display(job.updatedAt || job.createdAt || job.scheduleAt, zone))}</dd>${job.lateBySeconds > 0 ? `<dt>Catch-up delay</dt><dd>${job.lateBySeconds} seconds</dd>` : ''}</dl>${auto ? '' : `${risk}${info}<div class="actions">${actions}</div>`}${state.confirmCancel ? '<div class="confirm" role="group" aria-label="Confirm cancellation"><p>Cancel this scheduled message? The record will remain in History.</p><button type="button" class="danger" data-action="confirm-cancel">Cancel message</button> <button type="button" class="ghost" data-action="keep">Keep schedule</button></div>' : ''}</section>`;
  }
  const turnStates = { completed: 'Finished', failed: 'Failed', interrupted: 'Interrupted', unknown: 'Ended unclear', running: 'Agent working', delivered: 'Delivered' };
  const chainStates = { active: 'Running', paused: 'Paused', stopped: 'Stopped', finished: 'Finished' };
  const triggers = { time: 'At a time', available: 'When available', 'time-then-available': 'At a time, then when available' };
  // Chain settings, state and full turn history for a continuation.
  function automationDetail(job, zone) {
    const auto = job.automation;
    const availability = job.waiting?.availability || (job.displayStatus === 'waiting' ? job.availability : null);
    const turns = auto.turns.length ? `<ol class="turn-list">${auto.turns.map(turn => `<li><strong>Turn ${turn.number}</strong><span>${escape(turn.usageLimit ? 'Stopped at a usage limit' : turnStates[turn.state] || turn.state)}${turn.error?.message ? ` · ${escape(turn.error.message)}` : ''}</span><small>${turn.sentAt ? `Sent ${escape(display(turn.sentAt, zone))}` : 'Send time unknown'}${turn.completedAt ? ` · ended ${escape(display(turn.completedAt, zone))}` : ''}</small></li>`).join('')}</ol>` : '<p class="help">No turns sent yet.</p>';
    const omitted = auto.earlierTurnsOmitted ? `<p class="help">${auto.earlierTurnsOmitted} earlier ${auto.earlierTurnsOmitted === 1 ? 'turn is' : 'turns are'} not shown.</p>` : '';
    const reason = auto.reason ? `<div class="chain-reason ${escape(auto.state)}"><p>${escape(auto.reason)}</p>${auto.state === 'paused' && !job.acknowledgedAt && !['failed','unconfirmed'].includes(job.deliveryStatus) ? '<button type="button" class="ghost" data-action="ack">Acknowledge</button>' : ''}</div>` : '';
    return `<section class="chain" aria-label="Automatic continuation"><div class="chain-head"><span class="overline">Automatic continuation</span><strong>${escape(auto.progressLabel)}</strong></div><dl class="key-values"><dt>Start</dt><dd>${escape(triggers[auto.trigger] || auto.trigger)}</dd><dt>Turn limit</dt><dd>${auto.unlimited ? 'None · continuous until you stop it' : auto.limit}</dd><dt>Turns sent</dt><dd>${auto.sentTurns}${auto.unlimited ? '' : ` of ${auto.limit}`}</dd><dt>State</dt><dd>${escape(chainStates[auto.state] || auto.state)}</dd>${availability ? `<dt>Availability</dt><dd>${escape(availabilityLine(availability))}</dd>` : ''}</dl>${reason}<h3>Turns</h3>${turns}${omitted}</section>`;
  }
  function availabilityLine(value) {
    const what = { available: 'Available', limited: value.resetsAt ? `Limited until ${display(value.resetsAt)}` : 'Limited, reset time unknown', unavailable: value.reason === 'screen_locked' ? 'Mac locked' : value.reason === 'conversation_busy' ? 'Agent still working in this conversation' : 'Unavailable', unknown: 'Unknown' }[value.state] || 'Unknown';
    return `${what} · ${value.source === 'none' ? 'no source' : value.source} · checked ${display(value.checkedAt)}`;
  }
  function automationActions(job, status) {
    const auto = job.automation;
    const actions = [];
    if (job.canResume) actions.push('<button type="button" class="primary" data-action="resume">Resume continuation</button>');
    if (status === 'unconfirmed') actions.push('<button type="button" class="primary" data-action="reconcile">Check delivery</button>');
    if (status === 'pending' && auto.state === 'active' && auto.currentTurn === 1) actions.push('<button type="button" data-action="edit">Edit schedule</button>');
    if (job.canStop) actions.push('<button type="button" class="danger" data-action="stop">Stop continuing</button>');
    if (!job.canStop && !['pending','dispatching','unconfirmed'].includes(status)) actions.push('<button type="button" class="primary" data-action="again">Schedule again</button>');
    if (job.canStop) actions.push(`<p class="help stop-help">Stopping takes effect at once and never sends. ${status === 'sent' && auto.state === 'active' ? 'The turn in progress keeps running in the agent.' : ''}</p>`);
    return actions.join('');
  }
  function star() {
    if (!starState.phrase) starState.phrase = sticker.pickPhrase(sticker.STICKER_PHRASES);
    const points = Array.from({length:32},(_,index) => { const angle=index*Math.PI/16, radius=index%2 ? 39.5 : 50; return `${50+radius*Math.sin(angle)},${50-radius*Math.cos(angle)}`; }).join(' ');
    return `<button type="button" class="star" id="support-star" aria-label="Shuffle sticker phrase" aria-describedby="star-phrase"><svg viewBox="-3 -3 106 106" aria-hidden="true"><polygon points="${points}" fill="#D3A065" stroke="var(--outline)" stroke-width="2.5"/></svg><span class="star-text" aria-hidden="true">${starLines()}</span><span id="star-phrase" hidden>${escape(starState.phrase)}</span></button><span id="star-status" class="sr-only" role="status"></span>`;
  }
  function starLayout(phrase) {
    if (!starState.layouts.has(phrase)) {
      if (!measureContext) { measureContext = document.createElement('canvas').getContext('2d'); measureContext.font = '900 100px Georgia, serif'; }
      starState.layouts.set(phrase, sticker.layoutPhrase(phrase, text => measureContext.measureText(text).width / 100));
    }
    return starState.layouts.get(phrase);
  }
  const starLines = () => starLayout(starState.phrase).lines.map(line => `<span>${escape(line)}</span>`).join('');
  const starMoves = () => !state.reduceMotion && !mediaMotion.matches;
  function paintStar(now) {
    const shape = document.querySelector('#support-star polygon');
    // Frame timestamps can trail a performance.now() paint made during a render or click; never paint an earlier time.
    starState.paintedAt = Math.max(now, starState.paintedAt);
    if (shape) shape.style.transform = `rotate(${sticker.sample(starState.spin, starState.paintedAt).angle.toFixed(3)}deg)`;
    return Boolean(shape);
  }
  function starFrame(now) { starState.frame = 0; if (!starMoves()) syncStar(); else if (paintStar(now)) starState.frame = requestAnimationFrame(starFrame); }
  // Runs after every render and motion change: sizes the text, keeps the angle continuous and owns the frame loop.
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
  // A press that ends without a click (dragged away, cancelled, window blurred) eases back to the idle spin.
  function letGoStar() { setTimeout(() => { if (!starState.held) return; starState.held = false; starState.spin = sticker.release(starState.spin, performance.now(), false); }); }
  function remoteContext() {
    return { api, escape, display, $, perform, toast, render, errorMessage, isVisible: () => state.view === 'settings' };
  }
  function settings() {
    if (!state.settings) return '<p>Loading settings…</p>';
    if (!state.settingsDraft) state.settingsDraft = { t3Token: '', httpPort: state.settings.httpPort, bufferSeconds: state.settings.bufferSeconds };
    const d=state.settingsDraft;
    return `<div class="settings"><section class="card"><span class="overline">Connection</span><h2>Your local T3 Code</h2><form id="settings-form"><label class="field">T3 bearer token<input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="Leave blank to keep the saved token" value="${escape(d.t3Token)}"><small>${state.settings.usingEnvironmentToken ? 'Using T3_TOKEN from the environment for this launch.' : state.settings.hasStoredToken ? 'A token is stored locally. Leave blank to keep it.' : 'No token has been saved yet.'}</small></label><div class="two"><label class="field">Local HTTP port<input id="port" type="number" min="1" max="65535" required value="${d.httpPort}"></label><label class="field">Safety buffer · seconds<input id="buffer" type="number" min="0" max="300" required value="${d.bufferSeconds}"></label></div><p class="help">Connects only to 127.0.0.1. Buffer changes apply to new schedules.</p><p class="error" id="settings-error" role="alert"></p><div class="actions"><button type="submit" class="primary">Save settings</button><button type="button" data-action="check-t3">Check connection</button></div></form></section>${harnessSettings()}${keepAwakeSettings()}<section class="card"><span class="overline">Make it yours</span><div class="setting-row"><label for="theme">Appearance</label><select id="theme">${[['system','Follow system'],['light','Light'],['dark','Bone Outline']].map(([value,label]) => `<option value="${value}" ${state.theme === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="setting-row"><label for="motion">Reduce motion</label><input id="motion" type="checkbox" ${state.reduceMotion ? 'checked' : ''}></div><p class="help">Your system’s reduced-motion preference is always respected.</p></section><section class="card support">${star()}<div><span class="overline">Support this app</span><h2>Buy me a coffee</h2><button type="button" data-action="support" aria-describedby="support-note">Support on Ko-fi</button><p id="support-note" class="help">Opens ko-fi.com/velvetacorn in your browser.</p></div></section></div>`;
  }
  const capabilityText = { requiresUnlockedScreen: ['Needs an unlocked screen', 'Works while locked'], canConfirmDelivery: ['Confirms delivery'], canDetectCompletion: ['Reports when the agent finishes'], canDetectUsageLimit: ['Detects usage limits'], requiresAccessibilityPermission: ['Needs Accessibility permission'] };
  function capabilities(item) {
    const caps = item.capabilities || {};
    return Object.entries(capabilityText).map(([key, [yes, no]]) => caps[key] ? yes : no).filter(Boolean).join(' · ');
  }
  // The last compatibility check of a desktop app, from the monitor; Settings never runs one.
  function compatibilityLine(item) {
    if (item.kind !== 'desktop-app') return '';
    const checked = state.compatibility.find(entry => entry.harness === item.id);
    const text = !checked?.checkedAt ? 'Not checked yet' : `${checked.appVersion ? `Version ${checked.appVersion} · ` : ''}${checked.ok ? 'Supported' : 'Not supported yet'} · checked ${relative(checked.checkedAt).toLocaleLowerCase()}`;
    return `<small class="harness-caps${checked?.checkedAt && !checked.ok ? ' risk' : ''}">${escape(text)}</small>`;
  }
  function harnessSettings() {
    if (!state.harnesses.length) return '';
    if (!state.harnessDraft) state.harnessDraft = {};
    const stored = state.settings?.harnesses || {};
    const rows = state.harnesses.map(item => `<div class="harness-row"><div class="harness-name"><strong>${escape(item.label)}</strong><small>${escape(item.description)}</small><small class="harness-caps">${escape(capabilities(item))}</small>${compatibilityLine(item)}</div>${item.settings.map(setting => {
      const id = `harness-${item.id}-${setting.key}`;
      const saved = stored[item.id]?.[setting.key] || {};
      const value = state.harnessDraft[item.id]?.[setting.key] ?? (setting.type === 'secret' ? '' : saved.value ?? '');
      const note = setting.type === 'secret' ? (saved.usingEnvironment ? `Using ${setting.env} from the environment for this launch.` : saved.hasStoredValue ? 'Stored locally. Leave blank to keep it.' : setting.help) : setting.help;
      return `<label class="field" for="${escape(id)}">${escape(setting.label)}<input id="${escape(id)}" data-harness-key="${escape(item.id + ':' + setting.key)}" ${setting.type === 'port' ? 'type="number" min="1" max="65535"' : setting.type === 'secret' ? 'type="password" autocomplete="off"' : 'type="text"'} spellcheck="false" value="${escape(value)}" placeholder="${escape(setting.type === 'port' ? String(setting.default ?? '') : setting.type === 'secret' ? 'Leave blank to keep the saved value' : 'Found automatically')}"><small>${escape(note || '')}</small></label>`;
    }).join('')}</div>`).join('');
    return `<section class="card"><span class="overline">Agents</span><h2>Agent harnesses</h2>${state.harnesses.some(item => item.kind === 'desktop-app') ? '<p class="help">Desktop apps are checked read-only at launch, when something is scheduled for them and while it waits, so an app update shows on the dashboard before a message is due. Checks never send, type or change focus.</p>' : ''}<form id="harness-form">${rows}<p class="error" id="harness-error" role="alert"></p><div class="actions"><button type="submit" class="primary">Save agent settings</button></div></form></section>`;
  }
  function navigate(view, restore = false) {
    saveListContext();
    if (state.view === 'settings' && view !== 'settings') remote?.leave();
    const context = restore ? listContexts.get(view) : null;
    if (view === 'settings' && state.view !== 'settings') starState.phrase = sticker.pickPhrase(sticker.STICKER_PHRASES, starState.phrase);
    state.picking = false; state.actionError = ''; state.confirmCancel = false; state.search = context?.search || ''; state.view = view;
    render('h1');
    window.scrollTo(0,context?.scroll || 0);
    if (view === 'threads') void refreshThreads();
    if (['upcoming','history'].includes(view)) void refreshJobs();
    if (view === 'settings') void remote?.load(remoteContext());
  }
  function openComposer(threadId, harness) {
    saveListContext();
    state.returnView = ['upcoming','history','threads'].includes(state.view) ? state.view : 'upcoming';
    state.draftKey = 'new';
    if (harness && harness !== state.harness) { useHarness(harness); void refreshThreads(); }
    if (!draft()) state.drafts.set('new', newDraft(threadId));
    if (threadId) { draft().threadId = threadId; draft().harness = state.harness; draft().threadTitle = ''; draft().projectName = ''; }
    // A draft without a chosen conversation follows the current harness; one with a conversation keeps its own.
    if (!draft().threadId) draft().harness = state.harness;
    else if (draft().harness !== state.harness) { useHarness(draft().harness); void refreshThreads(); }
    fitDraft(draft());
    state.view='composer'; state.actionError=''; state.picking=false; state.calendarOpen=false; render('h1');
    void refreshAvailability();
  }
  function toast(message, jobId) {
    clearTimeout(toastTimer);
    const target=$('#toast'); target.hidden=false;
    target.innerHTML=`${escape(message)}${jobId ? '<button type="button" id="toast-view">View</button>' : ''}<button type="button" class="ghost" id="toast-dismiss" aria-label="Dismiss notification">×</button>`;
    $('#toast-dismiss').onclick=()=>{target.hidden=true;};
    if(jobId) $('#toast-view').onclick=()=>{target.hidden=true;state.returnView='history';state.selected=jobId;state.view='detail';render('h1');};
    toastTimer=setTimeout(()=>{target.hidden=true;},jobId?10000:5000);
  }
  async function perform(operation, { errorTarget, success } = {}) {
    if(state.busy)return;
    state.busy=true;state.actionError='';
    const disabledBefore = new Map([...app.querySelectorAll('button')].map(button=>[button,button.disabled]));
    disabledBefore.forEach((_disabled,button)=>{button.disabled=true;});
    try { const value=await operation(); if(success)await success(value); }
    catch(error){if(errorTarget && $(errorTarget))$(errorTarget).textContent=errorMessage(error);else state.actionError=errorMessage(error);}
    finally {state.busy=false; if(errorTarget && $(errorTarget)?.textContent){disabledBefore.forEach((disabled,button)=>{if(button.isConnected)button.disabled=disabled;}); if(draft()?.editId && state.view==='composer')$('.thread-picker').disabled=true;}else render();}
  }
  function bindOccurrence() { if($('#occurrence')) $('#occurrence').onchange=event=>{draft().occurrence=event.target.value;updatePreview();}; }
  function bind() {
    document.querySelectorAll('[data-nav]').forEach(button=>{button.onclick=()=>navigate(button.dataset.nav);});
    document.querySelectorAll('[data-action]').forEach(button=>{button.onclick=()=>action(button.dataset.action,button.dataset);});
    remote?.bind(remoteContext());
    document.querySelectorAll('[data-job]').forEach(button=>{button.onclick=()=>{saveListContext();state.returnView=state.view;state.selected=button.dataset.job;state.selectedJob=findJob(state.selected);state.view='detail';state.actionError='';state.confirmCancel=false;render('h1');};});
    document.querySelectorAll('[data-thread]').forEach(button=>{button.onclick=()=>{const thread=state.threads.find(item=>item.id===button.dataset.thread);if(state.picking){draft().threadId=thread.id;fitDraft(draft());state.view='composer';state.picking=false;state.search='';render('h1');}else openComposer(thread.id);};});
    document.querySelectorAll('[data-filter]').forEach(button=>{button.onclick=()=>{state.historyFilter=button.dataset.filter;state.historyLimit=50;state.history=[];state.search='';render();void refreshJobs();};});
    if($('#search')) $('#search').oninput=event=>{state.search=event.target.value;render();};
    if($('#show-settled')) $('#show-settled').onchange=event=>{state.showSettled=event.target.checked;render();};
    if($('#threads-harness')) $('#threads-harness').onchange=event=>{useHarness(event.target.value);if(state.picking&&draft()){Object.assign(draft(),{harness:state.harness,threadId:'',threadTitle:'',projectName:''});}render('#threads-harness');void refreshThreads();};
    if($('#harness')) $('#harness').onchange=event=>{useHarness(event.target.value);Object.assign(draft(),{harness:state.harness,threadId:'',threadTitle:'',projectName:''});fitDraft(draft());render('#harness');void refreshThreads();void refreshAvailability();};
    document.querySelectorAll('[data-trigger]').forEach(button=>{button.onclick=()=>{draft().trigger=button.dataset.trigger;if(button.dataset.trigger==='available')draft().waitIfLimited=false;render('[data-trigger="'+button.dataset.trigger+'"]');void refreshAvailability();};});
    if($('#wait-if-limited'))$('#wait-if-limited').onchange=event=>{draft().waitIfLimited=event.target.checked;updatePreview();if(event.target.checked)void refreshAvailability();};
    if($('#turn-limit'))$('#turn-limit').oninput=event=>{draft().turnLimit=event.target.value;updatePreview();if($('#schedule-error'))$('#schedule-error').textContent='';};
    if($('#continuous'))$('#continuous').onchange=event=>{draft().continuous=event.target.checked;render('#continuous');};
    document.querySelectorAll('[data-harness-key]').forEach(input=>{input.oninput=event=>{const [id,key]=input.dataset.harnessKey.split(':');state.harnessDraft[id]={...state.harnessDraft[id],[key]:event.target.value};};});
    if($('#harness-form'))$('#harness-form').onsubmit=event=>{event.preventDefault();const values={};for(const [id,fields] of Object.entries(state.harnessDraft||{})){const item=harnessInfo(id);if(!item)continue;values[id]={};for(const [key,value] of Object.entries(fields)){const setting=item.settings.find(entry=>entry.key===key);if(setting)values[id][key]=setting.type==='port'?Number(value):value;}}void perform(()=>api.saveSettings({httpPort:state.settings.httpPort,bufferSeconds:state.settings.bufferSeconds,harnesses:values}),{errorTarget:'#harness-error',success:async()=>{state.settings=await api.getSettings();state.harnessDraft=null;toast('Agent settings saved.');void refreshThreads();}});};
    ['message','date','time','timezone'].forEach(id=>{if($('#'+id))$('#'+id).oninput=event=>{draft()[id==='timezone'?'timeZone':id]=event.target.value;if(id!=='message'){draft().occurrence='';updatePreview();}if($('#schedule-error'))$('#schedule-error').textContent='';};});
    bindOccurrence();
    document.querySelectorAll('[data-quick]').forEach(button=>{button.onclick=()=>{try{Object.assign(draft(),time.quickTime(button.dataset.quick,draft().timeZone),{occurrence:''});render('#date');}catch(error){$('#schedule-error').textContent=errorMessage(error);}};});
    document.querySelectorAll('[data-month]').forEach(button=>{button.onclick=()=>{const [year,month]=state.calendarMonth.split('-').map(Number);const next=new Date(Date.UTC(year,month-1+Number(button.dataset.month),1));state.calendarMonth=next.toISOString().slice(0,7);render('[data-month="'+button.dataset.month+'"]');};});
    document.querySelectorAll('[data-day]').forEach(button=>{button.onclick=()=>{draft().date=button.dataset.day;draft().occurrence='';state.calendarOpen=false;render('#date');};button.onkeydown=event=>{const shifts={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};if(shifts[event.key]){event.preventDefault();const date=new Date(button.dataset.day+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+shifts[event.key]);const next=date.toISOString().slice(0,10);state.calendarMonth=next.slice(0,7);render('[data-day="'+next+'"]');}};});
    if($('#schedule-form')) $('#schedule-form').onsubmit=event=>{
      event.preventDefault();
      const d=draft(); let selected;
      const timed=d.trigger!=='available';
      try{if(!d.threadId)throw new Error(`Choose a ${noun(d.harness)} before scheduling.`);if(!d.message.trim())throw new Error('Enter a message.');if(!d.continuous&&!/^\d+$/.test(String(d.turnLimit).trim()))throw new Error('Turn limit must be a whole number of 1 or more.');if(timed)selected=time.resolveWallTime(d.date,d.time,d.timeZone,d.occurrence);}catch(error){$('#schedule-error').textContent=errorMessage(error);return;}
      const key=state.draftKey,input={harness:d.harness,threadId:d.threadId,message:d.message,timeZone:d.timeZone,trigger:timed?(d.waitIfLimited?'time-then-available':'time'):'available',continuous:d.continuous,...(d.continuous?{}:{turnLimit:Number(d.turnLimit)}),...(timed?{whenISO:selected.iso}:{})};
      void perform(()=>d.editId?api.editJob(d.editId,input):api.createSchedule(input),{errorTarget:'#schedule-error',success:async()=>{state.drafts.delete(key);state.view='upcoming';state.search='';state.returnView='upcoming';await refreshJobs(false);toast(d.editId?'Schedule updated.':timed?'Message scheduled.':'Waiting for the agent to be available.');}});
    };
    ['token','port','buffer'].forEach(id=>{if($('#'+id))$('#'+id).oninput=event=>{state.settingsDraft[id==='token'?'t3Token':id==='port'?'httpPort':'bufferSeconds']=id==='token'?event.target.value:Number(event.target.value);};});
    if($('#settings-form'))$('#settings-form').onsubmit=event=>{event.preventDefault();void perform(()=>api.saveSettings({...state.settingsDraft}),{errorTarget:'#settings-error',success:async()=>{state.settings=await api.getSettings();state.settingsDraft=null;toast('Settings saved.');void refreshThreads();}});};
    const keepAwakeFields={'ka-enabled':['enabled','checked'],'ka-display':['keepDisplayOn','checked'],'ka-agents':['includeRunningAgents','checked'],'ka-power':['powerSource','value'],'ka-floor':['batteryFloorPercent','value'],'ka-hours':['maxHours','value']};
    Object.entries(keepAwakeFields).forEach(([id,[key,property]])=>{if($('#'+id))$('#'+id)[property==='checked'||id==='ka-power'?'onchange':'oninput']=event=>{state.keepAwakeDraft[key]=property==='checked'?event.target.checked:id==='ka-power'?event.target.value:Number(event.target.value);if(id==='ka-power')$('#ka-floor').disabled=event.target.value==='ac-only';if($('#keep-awake-error'))$('#keep-awake-error').textContent='';};});
    if($('#keep-awake-form'))$('#keep-awake-form').onsubmit=event=>{event.preventDefault();void perform(()=>api.configureKeepAwake({...state.keepAwakeDraft}),{errorTarget:'#keep-awake-error',success:snapshot=>{state.keepAwake=snapshot;state.keepAwakeDraft=null;toast(snapshot.enabled?'Keep-awake is on.':'Keep-awake is off.');}});};
    if($('#theme'))$('#theme').onchange=event=>{state.theme=event.target.value;savePreferences();render('#theme');};
    if($('#motion'))$('#motion').onchange=event=>{state.reduceMotion=event.target.checked;savePreferences();render('#motion');};
    const starButton=$('#support-star');
    if(starButton){starButton.onpointerdown=event=>{if(event.isPrimary&&event.button===0)holdStar();};starButton.onkeydown=event=>{if(event.key==='Enter'&&event.repeat)event.preventDefault();if(event.key===' '&&!event.repeat)holdStar();};starButton.onclick=spinStar;}
  }
  function savePreferences(){try{localStorage.setItem('scheduler-theme',state.theme);localStorage.setItem('scheduler-motion',state.reduceMotion?'reduce':'system');}catch{/* Cosmetic preferences can remain session-only. */}}
  function action(name, data = {}) {
    if(name==='support'){void perform(()=>api.openSupport());return;}
    if(name==='keep-awake-stop'){void perform(()=>api.stopKeepAwake(),{success:snapshot=>{state.keepAwake=snapshot;toast('Your Mac can sleep now.');}});return;}
    if(name==='keep-awake-resume'){void perform(()=>api.resumeKeepAwake(),{success:snapshot=>{state.keepAwake=snapshot;toast('Keeping your Mac awake again.');}});return;}
    if(name==='copy-diagnostics'){void perform(()=>api.copyDiagnostics(),{success:()=>toast('Diagnostics copied. Paste them into your bug report.')});return;}
    if(name==='recheck-compatibility'){void perform(()=>api.checkCompatibility(data.harness),{success:async list=>{state.compatibility=Array.isArray(list)?list:[];await refreshJobs(false);const item=state.compatibility.find(entry=>entry.harness===data.harness);toast(item?.ok?`${item.label} looks supported again.`:`${item?.label||harnessLabel(data.harness)} still needs an update of Agent Auto-Continue.`);}});return;}
    if(name==='new')return openComposer();
    if(name==='theme'){state.theme=document.body.classList.contains('dark')?'light':'dark';savePreferences();render();return;}
    if(name==='back'){if(state.picking){state.picking=false;state.view='composer';state.search='';render('h1');}else navigate(state.returnView,true);return;}
    if(name==='pick'){state.picking=true;state.view='threads';state.search='';render('#search');void refreshThreads();return;}
    if(name==='clear-thread-filter'){state.search='';state.showSettled=true;render('#search');return;}
    if(name==='calendar'){state.calendarOpen=!state.calendarOpen;state.calendarMonth=draft().date.slice(0,7);render(state.calendarOpen?'[data-day="'+draft().date+'"]':'#date');return;}
    if(name==='refresh'){void refreshJobs();void refreshThreads();return;}
    if(name==='stop-all'){void perform(()=>api.stopAllContinuations(),{success:async result=>{await refreshJobs(false);toast(`Stopped ${result.stopped.length} ${result.stopped.length===1?'continuation':'continuations'}. Nothing more will be sent.`);}});return;}
    if(name==='more'){if(state.view==='history')state.historyLimit+=50;else state.limit+=50;void refreshJobs();return;}
    if(name==='check-t3'){void perform(()=>api.checkConnection('t3'),{errorTarget:'#settings-error',success:async result=>{if(!result.online)throw new Error(result.errorInfo?.message||(typeof result.error==='object'?result.error?.message:result.error)||'Cannot connect to T3 Code.');toast('Connected to T3 Code.');if(state.harness==='t3')await refreshThreads(false);}});return;}
    if(name==='open-permission-settings'){void perform(()=>api.openPermissionSettings());return;}
    if(name==='check'){void perform(()=>api.checkConnection(state.harness),{success:async result=>{if(result.online){state.online=true;state.connectionError=null;toast(`Connected to ${harnessLabel()}.`);}else{state.online=false;state.connectionError=result.errorInfo||(typeof result.error==='object'?result.error:{message:result.error});}await refreshThreads(false);}});return;}
    const job=findJob();
    if(!job)return;
    if(name==='edit'){state.draftKey='edit:'+job.id;if(!draft()){const wall=time.formatInstant(job.scheduleAt,job.timeZone||localZone);state.drafts.set(state.draftKey,{...newDraft(job.threadId,job.message,job.timeZone||localZone,job.harness||'t3'),...wall,occurrence:job.scheduleAt,editId:job.id,bufferSeconds:job.bufferSeconds,threadTitle:job.threadTitle,projectName:job.projectName,...automationDraft(job)});}state.view='composer';state.actionError='';state.calendarOpen=false;render('h1');void refreshAvailability();return;}
    if(name==='stop'){void perform(()=>api.stopJob(job.id),{success:async updated=>{state.selectedJob=updated;await refreshJobs(false);toast('Stopped. Nothing more will be sent.');}});return;}
    if(name==='resume'){void perform(()=>api.resumeJob(job.id),{success:async updated=>{state.selectedJob=updated;await refreshJobs(false);toast('Continuation resumed.');}});return;}
    if(name==='cancel'){state.confirmCancel=true;render('[data-action="confirm-cancel"]');return;}
    if(name==='keep'){state.confirmCancel=false;render('[data-action="cancel"]');return;}
    if(name==='confirm-cancel'){void perform(()=>api.cancelJob(job.id),{success:async updated=>{state.selectedJob=updated;state.confirmCancel=false;await refreshJobs(false);toast('Schedule canceled. The record remains in History.');}});return;}
    if(name==='ack'){void perform(()=>api.acknowledgeJob(job.id),{success:async updated=>{state.selectedJob=updated;await refreshJobs(false);toast('Acknowledged. The record remains in History.');}});return;}
    if(name==='reconcile'){void perform(()=>api.reconcileJob(job.id),{success:async result=>{if(!result.ok)throw new Error(result.error?.message||'Could not check delivery.');state.selectedJob=result.job;await refreshJobs(false);toast((result.job.deliveryStatus || result.job.status)==='sent'?'Delivery confirmed.':'Delivery remains unconfirmed. No resend was attempted.');}});return;}
    if(name==='again'){void perform(()=>api.scheduleAgain(job.id),{success:payload=>{state.draftKey='again:'+job.id;state.drafts.set(state.draftKey,{...newDraft(payload.threadId,payload.message,payload.timeZone||localZone,payload.harness||job.harness||'t3'),threadTitle:job.threadTitle,projectName:job.projectName,...automationDraft(payload)});useHarness(payload.harness||job.harness||'t3');fitDraft(draft());void refreshAvailability();void refreshThreads();state.returnView='history';state.view='composer';state.actionError='';}});}
  }
  async function readAllPages(view, limit, status) {
    const jobs=[];let result;
    for(let offset=0;offset<limit;offset+=500){result=await api.listJobs({view,limit:Math.min(500,limit-offset),offset,...(status?{status}:{})});jobs.push(...result.jobs);if(jobs.length>=result.total)break;}
    return {...result,jobs};
  }
  async function refreshJobs(shouldRender=true, notifyFailures=false) {
    const request=++jobRequest;
    const previous=JSON.stringify([state.upcoming,state.history,state.upcomingTotal,state.historyTotal,state.unacknowledged,state.jobsError,state.loading,state.selectedJob,state.storageError]);
    try {
      const [upcoming,history,selectedDetail]=await Promise.all([readAllPages('upcoming',state.limit),readAllPages('history',state.historyLimit,state.historyFilter),state.selected&&api.getJob?api.getJob(state.selected).catch(()=>null):null]);
      if(stopped||request!==jobRequest)return;
      state.storageError=upcoming.storageError||history.storageError||null;state.upcoming=upcoming.jobs;state.history=history.jobs;state.upcomingTotal=upcoming.total;state.historyTotal=history.total;state.unacknowledged=history.unacknowledgedFailures;state.jobsError='';
      for(const job of history.jobs.filter(item=>['failed','unconfirmed'].includes(item.deliveryStatus || item.status)||item.automation?.state==='paused')){const key=job.id+':'+(job.automation?.changedAt||'');if(failuresKnown&&notifyFailures&&!knownProblems.has(key)&&!job.acknowledgedAt)toast((job.deliveryStatus || job.status)==='unconfirmed'?'A delivery needs confirmation.':(job.deliveryStatus || job.status)==='failed'?'A scheduled message failed.':'A continuation paused and needs a look.',job.id);knownProblems.add(key);}
      failuresKnown=true;
      const selected=selectedDetail||[...upcoming.jobs,...history.jobs].find(job=>job.id===state.selected);if(selected)state.selectedJob=selected;
    }catch(error){if(request===jobRequest)state.jobsError=errorMessage(error);}
    finally {if(request===jobRequest){state.loading=false;const changed=previous!==JSON.stringify([state.upcoming,state.history,state.upcomingTotal,state.historyTotal,state.unacknowledged,state.jobsError,state.loading,state.selectedJob,state.storageError]);if(shouldRender&&changed&&!state.busy&&!['composer','settings'].includes(state.view)&&!state.picking)render();else updateChrome();}}
  }
  function updateChrome(){const notices=$('#notices');if(notices){notices.innerHTML=notice();notices.querySelectorAll('[data-action]').forEach(button=>{button.onclick=()=>action(button.dataset.action,button.dataset);});notices.querySelectorAll('[data-nav]').forEach(button=>{button.onclick=()=>navigate(button.dataset.nav);});}document.querySelectorAll('[data-count="upcoming"]').forEach(node=>{node.textContent=state.upcomingTotal;});document.querySelectorAll('[data-count="history"]').forEach(node=>{node.textContent=state.unacknowledged||'';});if($('#ka-status'))$('#ka-status').textContent=keepAwakeStatus();const status=$('#connection-state');if(status){status.textContent=state.online===null?'Connecting…':state.online?harnessLabel()+' connected':'Offline · queue saved';status.classList.toggle('offline',state.online===false);}}
  async function refreshCompatibility() {
    if(!api.getCompatibility)return;
    try{const list=await api.getCompatibility();if(stopped)return;const before=JSON.stringify(state.compatibility);state.compatibility=Array.isArray(list)?list:[];if(before!==JSON.stringify(state.compatibility)&&!state.busy)updateChrome();}
    catch{/* The last known state stays visible. */}
  }
  async function refreshThreads(shouldRender=true) {
    const request=++threadRequest;
    const previous=JSON.stringify([state.threads,state.online]);
    const harness=state.harness;
    try{const result=await api.getThreads({showSettled:true,harness});if(stopped||request!==threadRequest||harness!==state.harness)return;state.online=result.online;state.connectionError=result.errorInfo||(typeof result.error==='object'?result.error:{message:result.error});if(result.online)state.threads=result.threads;}
    catch(error){if(request===threadRequest){state.online=false;state.connectionError={message:errorMessage(error)};}}
    finally{if(request===threadRequest){lastRefresh=Date.now();if(shouldRender&&previous!==JSON.stringify([state.threads,state.online])&&!state.busy&&state.view==='threads')render();else updateChrome();}}
  }
  function route(payload) {
    if(!payload)return;
    if(payload.view==='composer'||payload.view==='compose'){openComposer(payload.threadId,payload.harness);if(payload.threadLabel&&draft())draft().threadTitle=payload.threadLabel;render('h1');}
    else if(payload.jobId){state.selected=payload.jobId;state.returnView=payload.view==='upcoming'?'upcoming':'history';state.view='detail';state.search='';render('h1');void refreshJobs();}
    else if(['upcoming','history','threads','settings'].includes(payload.view))navigate(payload.view);
  }
  if(!api){app.innerHTML='<main class="content"><h1>Open the desktop app</h1><p>This interface needs the Agent Auto-Continue desktop connection.</p></main>';return;}
  if(api.onNavigate)cleanup.push(api.onNavigate(route));
  if(api.onScheduleInit)cleanup.push(api.onScheduleInit(payload=>route({...payload,view:'composer'})));
  if(api.onJobsChanged)cleanup.push(api.onJobsChanged(()=>void refreshJobs(true,true)));
  if(api.onRemoteChanged)cleanup.push(api.onRemoteChanged(()=>{if(state.view==='settings'&&!state.busy)void remote?.load(remoteContext());}));
  if(api.onCompatibilityChanged)cleanup.push(api.onCompatibilityChanged(()=>void refreshCompatibility()));
  if(api.onSettingsChanged)cleanup.push(api.onSettingsChanged(settings=>{state.settings=settings;state.storageError=settings.storageError||state.storageError;for(const item of state.drafts.values())if(!item.editId)item.bufferSeconds=settings.bufferSeconds;}));
  if(api.onKeepAwakeChanged)cleanup.push(api.onKeepAwakeChanged(snapshot=>{state.keepAwake=snapshot;updateChrome();}));
  if(api.getKeepAwake)void api.getKeepAwake().then(snapshot=>{if(stopped)return;state.keepAwake=snapshot;if(state.view==='settings'&&!state.busy)render();else updateChrome();}).catch(()=>{/* Keep-awake status is advisory; Settings shows loading until it arrives. */});
  const onFocus=()=>{if(Date.now()-lastRefresh>10000){void refreshThreads();void refreshJobs();}};
  window.addEventListener('focus',onFocus);
  const onTheme=()=>{if(state.theme==='system')render();};mediaTheme.addEventListener('change',onTheme);
  mediaMotion.addEventListener('change',syncStar);
  const starReleases=['pointerup','pointercancel','keyup','blur'];starReleases.forEach(type=>window.addEventListener(type,letGoStar));
  window.addEventListener('beforeunload',()=>{stopped=true;clearTimeout(timer);clearTimeout(toastTimer);cancelAnimationFrame(starState.frame);cleanup.forEach(unsubscribe=>unsubscribe?.());window.removeEventListener('focus',onFocus);mediaTheme.removeEventListener('change',onTheme);mediaMotion.removeEventListener('change',syncStar);starReleases.forEach(type=>window.removeEventListener(type,letGoStar));});
  async function poll(){if(stopped)return;await Promise.allSettled([refreshThreads(),refreshJobs(),refreshCompatibility()]);document.querySelectorAll('[data-relative]').forEach(node=>{node.textContent=node.dataset.relative?relative(node.dataset.relative):'';});timer=setTimeout(poll,state.online===false?60000:30000);}
  render();
  void api.getSettings().then(settings=>{state.settings=settings;state.storageError=settings.storageError||state.storageError;for(const item of state.drafts.values())if(!item.editId)item.bufferSeconds=settings.bufferSeconds;if(!state.drafts.has('new'))state.drafts.set('new',newDraft());if(state.view==='settings'||state.view==='composer')render();}).catch(error=>{state.actionError=errorMessage(error);render();});
  if(api.listHarnesses)void api.listHarnesses().then(result=>{state.harnesses=Array.isArray(result?.harnesses)?result.harnesses:[];if(!harnessInfo(state.harness)){useHarness(result?.defaultHarness||'t3');void refreshThreads();}for(const item of state.drafts.values()){if(!harnessInfo(item.harness))item.harness=state.harness;if(!item.editId)fitDraft(item);}render();if(state.view==='composer')void refreshAvailability();}).catch(()=>{});
  void poll();
})();
