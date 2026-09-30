// Feature prototypes 05-08 for issue #6: harnesses, auto-start, turn limits, continuous mode, keep-awake and phone control.
// Sample data only. Fixed sample clock: 2026-09-30 22:40 BST (an evening, because these features are about work that runs overnight).
// Every URL parameter below can be set directly so screenshots are reproducible, for example ?concept=board&view=compose&theme=dark.
(() => {
  const params = new URLSearchParams(location.search);
  const concept = params.get('concept');
  const CONCEPTS = { board: '05 Board', queue: '06 Queue+', phone: '07 Phone', tray: '08 Menu bar' };
  if (!CONCEPTS[concept]) return;
  window.featureConcept = true;
  document.querySelector('link[rel=stylesheet]').href = 'features.css';

  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pick = (name, fallback, allowed) => { const value = params.get(name); return allowed.includes(value) ? value : fallback; };

  // Agents (issue #2). Square monograms are API or CLI harnesses; round monograms are desktop apps driven through Accessibility.
  const agents = {
    T3: { name: 'T3 Code', kind: 'Local HTTP API', app: false, avail: 'free', availText: 'Free', source: 'T3 Code API, 1 min ago', project: 'agent-auto-continue',
      caps: [['Find threads', 'yes', 'Threads and projects come from the local API.'], ['Send a turn', 'yes', 'Posts a user message with stable IDs.'], ['Read the usage limit', 'no', 'T3 Code does not report provider limits, so "When free" falls back to a time.'], ['Report end of turn', 'yes', 'Turn state is in the thread snapshot.'], ['Report task complete', 'no', '"Until done" needs a no-progress guard.'], ['Works with the screen locked', 'yes', 'No window is needed.']] },
    CC: { name: 'Claude Code', kind: 'CLI, headless', app: false, avail: 'limited', availText: 'Limited, resets 03:00', source: 'read from Claude Code, 2 min ago', project: 'quilla',
      caps: [['Find threads', 'yes', 'Sessions in the project folders you add.'], ['Send a turn', 'yes', 'Resumes the session headlessly.'], ['Read the usage limit', 'yes', 'Reset time is read from the CLI.'], ['Report end of turn', 'yes', 'The process exits with a result.'], ['Report task complete', 'part', 'Only when the agent says so in its result.'], ['Works with the screen locked', 'yes', 'No window is needed.']] },
    CX: { name: 'Codex CLI', kind: 'CLI, headless', app: false, avail: 'free', availText: 'Free', source: 'read from Codex CLI, 4 min ago', project: 'field-notes',
      caps: [['Find threads', 'yes', 'Recent sessions from the Codex CLI.'], ['Send a turn', 'yes', 'Resumes the session headlessly.'], ['Read the usage limit', 'part', 'Reported after a limit is hit, not before.'], ['Report end of turn', 'yes', 'The process exits with a result.'], ['Report task complete', 'part', 'Only when the agent says so in its result.'], ['Works with the screen locked', 'yes', 'No window is needed.']] },
    OC: { name: 'OpenCode', kind: 'Local HTTP server', app: false, avail: 'down', availText: 'Not running', source: 'no answer on port 4096, 1 min ago', project: 'feedworks',
      caps: [['Find threads', 'yes', 'Sessions from the OpenCode server.'], ['Send a turn', 'yes', 'Posts a message to the session.'], ['Read the usage limit', 'no', 'Provider limits are not exposed.'], ['Report end of turn', 'yes', 'Session events report idle.'], ['Report task complete', 'no', 'Inferred from an idle session only.'], ['Works with the screen locked', 'yes', 'No window is needed.']] },
    CL: { name: 'Claude desktop', kind: 'Desktop app, Accessibility', app: true, avail: 'unknown', availText: 'Unknown', source: 'limit message not visible, 6 min ago', project: 'research',
      caps: [['Find threads', 'part', 'Only conversations visible in the sidebar.'], ['Send a turn', 'yes', 'Types into the focused conversation.'], ['Read the usage limit', 'part', 'Read from the on-screen limit message when shown.'], ['Report end of turn', 'part', 'Watches the stop button.'], ['Report task complete', 'no', '"Until done" is not offered.'], ['Works with the screen locked', 'no', 'Needs the screen unlocked and the display on.']] },
    GP: { name: 'ChatGPT desktop', kind: 'Desktop app, Accessibility', app: true, avail: 'stale', availText: 'Free', source: 'last checked 40 min ago', project: 'writing',
      caps: [['Find threads', 'part', 'Only conversations visible in the sidebar.'], ['Send a turn', 'yes', 'Types into the focused conversation.'], ['Read the usage limit', 'part', 'Read from the on-screen limit message when shown.'], ['Report end of turn', 'part', 'Watches the stop button.'], ['Report task complete', 'no', '"Until done" is not offered.'], ['Works with the screen locked', 'no', 'Needs the screen unlocked and the display on.']] },
    CD: { name: 'Codex desktop', kind: 'Desktop app, Accessibility', app: true, avail: 'free', availText: 'Free', source: 'read on screen, 3 min ago', project: 'field-notes',
      caps: [['Find threads', 'part', 'Only tasks visible in the sidebar.'], ['Send a turn', 'yes', 'Types into the focused task.'], ['Read the usage limit', 'part', 'Read from the on-screen limit message when shown.'], ['Report end of turn', 'part', 'Watches the stop button.'], ['Report task complete', 'no', '"Until done" is not offered.'], ['Works with the screen locked', 'no', 'Needs the screen unlocked and the display on.']] }
  };
  const threads = [
    { id: 'th-notes', agent: 'CC', title: 'Write release notes for 2.1', project: 'quilla', ago: '18 min ago' },
    { id: 'th-billing', agent: 'CC', title: 'Migrate billing webhooks to the new signature scheme', project: 'quilla', ago: '9 min ago', has: 'Needs you' },
    { id: 'th-sched', agent: 'T3', title: 'Polish the scheduler experience', project: 'agent-auto-continue', ago: '4 min ago', has: 'Running' },
    { id: 'th-audit', agent: 'T3', title: 'Audit checkout edge cases before the autumn release', project: 'quilla', ago: '2 hours ago', has: '1 waiting' },
    { id: 'th-export', agent: 'CX', title: 'Fix the flaky export integration test', project: 'field-notes', ago: '1 min ago', has: 'Running' },
    { id: 'th-nightly', agent: 'CX', title: 'Investigate why the nightly export job intermittently times out when the warehouse is under heavy load', project: 'field-notes', ago: '3 hours ago' },
    { id: 'th-feeds', agent: 'OC', title: 'Tidy the feed mapping rules', project: 'feedworks', ago: 'Yesterday' },
    { id: 'th-pricing', agent: 'CL', title: 'Summarise the competitor pricing pages', project: 'research', ago: '1 hour ago', has: '1 waiting' },
    { id: 'th-onboard', agent: 'GP', title: 'Draft the onboarding email sequence', project: 'writing', ago: '5 hours ago', has: '1 waiting' }
  ];
  // Tasks: the unit the user creates. `group` drives the Board sections.
  const baseTasks = [
    { id: 'billing', thread: 'th-billing', group: 'needs', message: 'Continue', stateLabel: 'Paused after turn 2 of 5', tone: 'amber', reason: 'Claude Code asked a question: "Should I keep the legacy endpoint alive for 30 days?"', hint: 'Answer in Claude Code, then', actions: [['Resume', 'primary'], ['End', 'ghost']], turns: [2, 5], plan: 'send "Continue" to <em>Migrate billing webhooks to the new signature scheme</em> up to 5 turns.', left: 'Paused 22:31', right: 'Stops if it asks anything' },
    { id: 'audit-failed', thread: 'th-audit', group: 'needs', message: 'Run the integration tests and report back.', stateLabel: 'Failed', tone: 'red', reason: 'T3 Code rejected the token, so nothing was sent.', actions: [['Update token', 'primary'], ['Acknowledge', 'ghost']], plan: 'at 22:22 send "Run the integration tests and report back." to <em>Audit checkout edge cases before the autumn release</em> once.', left: 'Failed 22:22', right: 'Not sent, safe to retry' },
    { id: 'sched', thread: 'th-sched', group: 'running', message: 'Continue. Summarise remaining risks and take the smallest safe next step.', tally: [3, 4], plan: 'send "Continue…" to <em>Polish the scheduler experience</em> up to 4 turns.', left: 'Turn 3 started 22:34', right: 'Stops after 4 turns' },
    { id: 'export', thread: 'th-export', group: 'running', message: 'Continue', tally: [7, 0], plan: 'send "Continue" to <em>Fix the flaky export integration test</em> until Codex says it is done.', left: 'Turn 7 started 22:38', right: 'Pauses after 3 turns with no progress' },
    { id: 'notes', thread: 'th-notes', group: 'waiting', message: 'Continue', stateLabel: 'Limited, resets 03:00', availTone: 'limited', source: 'from Claude Code', plan: 'when Claude Code is free, around <em>03:00</em>, send "Continue" to <em>Write release notes for 2.1</em> and keep going until Claude Code says it is done, at most 10 turns.', left: 'Starts when Claude Code is free, until done (max 10)', right: 'In about 4 hours', needsAwake: true },
    { id: 'pricing', thread: 'th-pricing', group: 'waiting', message: 'Pick up where you left off and finish the comparison table.', stateLabel: '2026-10-01 · 06:30', plan: 'at <em>06:30</em> send "Pick up where you left off…" to <em>Summarise the competitor pricing pages</em> once.', left: 'At a set time, 1 turn', right: 'Needs the screen unlocked at 06:30', warn: true, needsAwake: true },
    { id: 'onboard', thread: 'th-onboard', group: 'waiting', message: 'Continue', stateLabel: 'Free 40 min ago', availTone: 'stale', source: 'last checked 40 min ago', plan: 'when ChatGPT desktop is free, send "Continue" to <em>Draft the onboarding email sequence</em> once.', left: 'Starts when ChatGPT desktop is free, 1 turn', right: 'Checking again at 22:45', needsAwake: true },
    { id: 'audit', thread: 'th-audit', group: 'waiting', message: 'Continue', stateLabel: '2026-10-01 · 09:00', plan: 'at <em>09:00</em> send "Continue" to <em>Audit checkout edge cases before the autumn release</em> once.', left: 'At a set time, 1 turn', right: 'In 10 hours' },
    { id: 'done1', thread: 'th-nightly', group: 'done', message: 'Continue', stateLabel: 'Done, 4 turns', tone: 'green', plan: 'send "Continue" to <em>Investigate why the nightly export job…</em> until done.', left: 'Finished 21:58', right: 'Codex reported the task complete' },
    { id: 'done2', thread: 'th-feeds', group: 'done', message: 'Continue', stateLabel: 'Delivered, 1 turn', tone: 'muted', plan: 'at 20:00 send "Continue" to <em>Tidy the feed mapping rules</em> once.', left: 'Delivered 20:00', right: 'Delivery only, OpenCode does not report completion' }
  ];

  const state = {
    view: pick('view', concept === 'queue' ? 'board' : 'board', ['board', 'compose', 'detail', 'agents', 'history', 'settings', 'picker']),
    theme: pick('theme', 'light', ['light', 'dark']),
    words: pick('words', 'task', ['task', 'handoff', 'schedule']),
    awake: pick('awake', 'session', ['session', 'strip']),
    composer: pick('composer', 'questions', ['questions', 'presets']),
    picker: pick('picker', 'grouped', ['grouped', 'agent']),
    scenario: pick('scenario', 'tonight', ['tonight', 'empty', 'trouble', 'morning']),
    selected: params.get('task') || 'billing',
    expanded: params.get('agent') || 'CC',
    pickerAgent: 'CC', historyFilter: 'all', toast: params.get('toast') || '', pairing: params.get('pairing') === '1',
    draft: { thread: 'th-notes', message: 'Continue', when: pick('when', 'free', ['free', 'time', 'now']), far: pick('far', 'done', ['turns', 'done']), turns: params.get('turns') ?? '1', max: params.get('max') ?? '10', date: '2026-10-01', time: '06:30', preset: '', stops: { noprog: true, slow: false, touched: true } }
  };

  // Vocabulary alternatives: see decision D2 in docs/ui-review.md.
  const W = {
    task: { one: 'task', many: 'tasks', One: 'Task', New: 'New task', home: 'Board', verb: (d) => d.when === 'time' ? `Schedule for ${d.time}` : d.when === 'now' ? 'Start now' : `Start when ${agentOf(d.thread).name} is free` },
    handoff: { one: 'handoff', many: 'handoffs', One: 'Handoff', New: 'New handoff', home: 'Board', verb: () => 'Hand off' },
    schedule: { one: 'schedule', many: 'schedules', One: 'Schedule', New: 'New schedule', home: 'Upcoming', verb: () => 'Schedule' }
  }[state.words];
  const threadOf = (id) => threads.find((t) => t.id === id);
  const agentOf = (threadId) => agents[threadOf(threadId).agent];
  const home = () => concept === 'queue' ? (state.words === 'schedule' ? 'Upcoming' : 'Upcoming') : W.home;

  function tasks() {
    if (state.scenario === 'empty') return [];
    let list = baseTasks.map((t) => ({ ...t }));
    if (state.scenario === 'trouble') {
      list = list.filter((t) => t.id !== 'audit-failed');
      list.unshift({ id: 'missed', thread: 'th-pricing', group: 'needs', message: 'Pick up where you left off and finish the comparison table.', stateLabel: 'Started late', tone: 'amber', reason: 'The Mac slept anyway at 01:12, so this started 4 h 12 m late at 07:12. It ran once and was delivered.', actions: [['Acknowledge', 'primary']], plan: 'at 03:00 send "Pick up…" to <em>Summarise the competitor pricing pages</em> once.', left: 'Delivered 07:12', right: 'Missed its start while the Mac slept' });
      list.push({ id: 'feeds', thread: 'th-feeds', group: 'needs', message: 'Continue', stateLabel: 'Waiting, agent not running', tone: 'amber', reason: 'OpenCode is not running. This will wait rather than fail.', actions: [['How to start OpenCode', 'quiet'], ['End', 'ghost']], plan: 'when OpenCode is free, send "Continue" to <em>Tidy the feed mapping rules</em> once.', left: 'Waiting since 22:10', right: 'No answer on port 4096' });
    }
    if (state.scenario === 'morning') list = list.map((t) => {
      if (t.group !== 'running' && t.id !== 'notes') return t;
      const terminal = { ...t, group: 'done', needsAwake: false, left: 'Finished overnight',
        stateLabel: t.id === 'sched' ? 'Stopped at 4 turns' : t.id === 'export' ? 'Done, 9 turns' : 'Done, 6 turns',
        tone: t.id === 'sched' ? 'muted' : 'green',
        right: t.id === 'sched' ? 'Reached its turn limit; T3 Code cannot report completion' : t.id === 'export' ? 'Codex reported the task complete' : 'Claude Code reported the task complete' };
      delete terminal.tally;
      delete terminal.availTone;
      return terminal;
    }).filter((t) => t.id !== 'pricing');
    return list;
  }
  const counts = () => { const list = tasks(); return { needs: list.filter((t) => t.group === 'needs').length, running: list.filter((t) => t.group === 'running').length, waiting: list.filter((t) => t.group === 'waiting').length, awake: list.filter((t) => t.needsAwake || t.group === 'running').length }; };

  // Components
  const mono = (key, extra = '') => `<span class="mono ${agents[key].app ? 'app' : ''} ${extra}" aria-hidden="true">${key}</span>`;
  const avail = (key, withSource = true) => { const a = agents[key]; return `<span class="avail ${a.avail}"><i class="dot ${a.avail}" aria-hidden="true"></i><span>${esc(a.availText)}</span>${withSource ? `<small class="muted">${esc(a.source)}</small>` : ''}</span>`; };
  const tally = ([done, total]) => total ? `<span class="tally" aria-label="Turn ${done} of ${total}">${Array.from({ length: total }, (_, i) => `<i class="${i < done ? 'on' : ''}"></i>`).join('')}<span aria-hidden="true">${done} of ${total}</span></span>` : `<span class="tally" aria-label="Turn ${done}, until done"><i class="on"></i><i class="on"></i><i class="on"></i><i></i><span aria-hidden="true">turn ${done}, until done</span></span>`;

  function strip() {
    const c = counts();
    const trouble = Object.keys(agents).filter((k) => ['down', 'unknown', 'stale'].includes(agents[k].avail)).length;
    const awakeChip = state.scenario === 'empty' ? '' : state.scenario === 'morning' ? '<button class="chip" data-nav="settings">☾ Shift ended 06:52</button>' : `<button class="chip awake" data-action="awake" aria-label="Keeping the Mac awake for ${c.awake} ${W.many}">☾ Awake · ${c.awake}</button>`;
    return `<div class="strip strip-full">${Object.keys(agents).map((k) => `<button class="strip-agent" data-agent="${k}" title="${esc(agents[k].name)}: ${esc(agents[k].availText)} (${esc(agents[k].source)})" aria-label="${esc(agents[k].name)}: ${esc(agents[k].availText)}">${mono(k)}<i class="dot ${agents[k].avail}"></i></button>`).join('')}<span class="sep"></span>${awakeChip}<span class="chip" title="Paired phone last seen 2 minutes ago">▯ Phone · 2 min</span><button class="ghost" data-action="theme" aria-label="Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme">${state.theme === 'dark' ? '☀' : '☾'}</button></div>
      <div class="strip strip-compact">${trouble ? `<button class="chip warn" data-nav="agents">${trouble} agents need a look</button>` : '<button class="chip" data-nav="agents">7 agents ready</button>'}${awakeChip.replace('☾ Awake · ', '☾ ')}<button class="ghost" data-action="theme" aria-label="Switch theme">${state.theme === 'dark' ? '☀' : '☾'}</button></div>`;
  }
  function nav() {
    const c = counts();
    const items = [['board', home()], ['history', 'History'], ['agents', 'Agents'], ['settings', 'Settings']];
    return `<nav aria-label="Main navigation">${items.map(([view, label]) => {
      const current = state.view === view || (view === 'board' && ['compose', 'detail', 'picker'].includes(state.view));
      const badge = view === 'board' && c.needs ? `<span class="badge" aria-hidden="true">${c.needs}</span><span class="sr-only">, ${c.needs} need you</span>` : '';
      return `<button data-nav="${view}" class="${current ? 'active' : ''}" ${current ? 'aria-current="page"' : ''}>${label}${badge}</button>`;
    }).join('')}</nav>`;
  }
  function studio() {
    const sel = (name, label, options) => `<label>${label}<select data-param="${name}">${options.map(([v, l]) => `<option value="${v}" ${String(state[name]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    return `<div class="studio" role="region" aria-label="Prototype controls"><a href="index.html">← Design studio</a>${Object.entries(CONCEPTS).map(([k, l]) => `<a class="${k === concept ? 'active' : ''}" href="?concept=${k}">${l}</a>`).join('')}<span class="grow"></span>
      ${sel('scenario', 'Scenario', [['tonight', 'Tonight'], ['trouble', 'Something went wrong'], ['morning', 'Next morning'], ['empty', 'Nothing yet']])}
      ${sel('words', 'Words', [['task', 'Task (rec.)'], ['handoff', 'Handoff (Fable)'], ['schedule', 'Schedule (today)']])}
      ${concept === 'board' || concept === 'queue' ? sel('awake', 'Keep awake', [['session', 'Session card (rec.)'], ['strip', 'Status chip only']]) + sel('composer', 'Composer', [['questions', 'Two questions (rec.)'], ['presets', 'Three presets']]) + sel('picker', 'Thread picker', [['grouped', 'Grouped by agent (rec.)'], ['agent', 'Agent first']]) : ''}
      ${sel('theme', 'Theme', [['light', 'Light'], ['dark', 'Bone Outline']])}</div>`;
  }
  function shell(body) {
    return `${studio()}<header class="topbar">${nav()}${strip()}</header><main class="content" id="main">${body}</main>${state.toast ? `<div class="toast" role="status">${esc(state.toast)}<button class="ghost" data-action="toast-close" aria-label="Dismiss">×</button></div>` : ''}`;
  }

  // Keep-awake (issue #5), direction A: one session card that always says why.
  function awakeCard() {
    if (state.awake !== 'session' || state.scenario === 'empty') return '';
    const c = counts();
    if (state.scenario === 'morning') return `<section class="awake-card" aria-label="Keep-awake report"><div class="moon" aria-hidden="true">☀</div><div class="text"><h2>Good morning. The Mac stayed awake until 06:52.</h2><p>Awake for 8 h 12 m. Battery 100% to 81%, on power from 23:10. 3 ${W.many} finished, 19 turns ran, 1 needs you.</p></div><div class="act"><button data-action="ack-report">Dismiss report</button></div></section>`;
    if (state.scenario === 'trouble') return `<section class="awake-card attention" aria-label="Keep-awake status"><div class="moon" aria-hidden="true">☾</div><div class="text"><h2>Awake, but one ${W.one} needs the screen</h2><p>Claude desktop cannot run while the screen is locked. The 06:30 ${W.one} will wait unless you keep the display on.</p><ul class="why"><li>System stays awake</li><li>Display: needed at 06:30</li><li>Ends at 20% battery</li></ul></div><div class="act"><button class="primary" data-action="display">Keep display on from 06:25</button><button class="ghost" data-action="skip">Let it wait</button></div></section>`;
    return `<section class="awake-card" aria-label="Keep-awake status"><div class="moon" aria-hidden="true">☾</div><div class="text"><h2>Keeping this Mac awake until ${c.awake} ${W.many} finish</h2><p>Display can sleep and the screen can lock. Ends about 07:15, or as soon as nothing needs the Mac.</p><ul class="why"><li>2 running</li><li>3 waiting</li><li>Ends at 20% battery</li><li>Lid must stay open</li></ul></div><div class="act"><button data-action="stop-awake">Stop keeping awake</button><button class="ghost" data-nav="settings">Rules</button></div></section>`;
  }

  function row(t) {
    const th = threadOf(t.thread), a = agents[th.agent];
    const right = t.tally ? tally(t.tally) : t.availTone ? `<span class="avail ${t.availTone}"><i class="dot ${t.availTone}" aria-hidden="true"></i><span>${esc(t.stateLabel)}</span></span>` : `<span class="pill ${t.tone || ''}">${esc(t.stateLabel)}</span>`;
    const bar = t.group === 'needs' ? (t.tone === 'red' ? 'bar-red' : 'bar-amber') : t.group === 'running' ? 'bar-accent' : '';
    return `<article class="frow ${bar}" aria-labelledby="t-${t.id}"><div class="frow-top"><span class="who">${mono(th.agent)}<span>${esc(a.name)}</span><span class="muted">/ ${esc(th.project)}</span></span>${right}</div>
      <button class="row-link" id="t-${t.id}" data-task="${t.id}">${esc(th.title)}</button>
      ${t.reason ? `<p class="reason">${esc(t.reason)}</p>` : `<div class="msg">${esc(t.message)}</div>`}
      ${t.actions ? `<div class="row-actions">${t.hint ? `<small>${esc(t.hint)}</small>` : ''}${t.actions.map(([label, cls]) => `<button class="${cls === 'ghost' ? 'ghost' : cls === 'quiet' ? 'quiet' : 'quiet primary'}" data-action="row:${label}">${label}</button>`).join('')}</div>` : ''}
      <div class="meta"><span>${esc(t.left)}</span><span class="${t.warn ? 'avail limited' : ''}">${t.warn ? '⚠ ' : ''}${esc(t.right)}</span></div></article>`;
  }
  function section(title, note, list) {
    if (!list.length) return '';
    return `<section class="section" aria-labelledby="s-${title}"><div class="section-head"><h2 id="s-${title}">${title} <span class="count">${list.length}</span></h2><small>${note}</small></div><div class="card">${list.map(row).join('')}</div></section>`;
  }
  function boardView() {
    const list = tasks();
    const heading = !list.length ? 'Nothing waiting' : state.scenario === 'morning' ? 'This morning' : 'Tonight';
    const by = (g) => list.filter((t) => t.group === g);
    const body = !list.length ? `<div class="card empty"><div class="moon" style="margin:auto" aria-hidden="true">☾</div><h2>Nothing waiting.</h2><p>Pick a thread, say when to continue it and how far to go. The Mac can stay awake until it is done.</p><button class="primary" data-nav="compose">${W.New}</button></div>`
      : `${awakeCard()}${section('Needs you', 'Nothing sends until you decide', by('needs'))}${section('Running', 'Turns in progress now', by('running'))}${section('Waiting', 'Soonest first', by('waiting'))}${section(state.scenario === 'morning' ? 'Done overnight' : 'Done tonight', '<button class="link" data-nav="history">All history</button>', by('done'))}<p class="help">Times are Europe/London (BST). Done means the agent reported the task complete; Delivered only means the message was accepted.</p>`;
    return `<div class="heading"><div><h1 tabindex="-1">${heading}</h1>${list.length ? `<p>${counts().needs ? `${counts().needs} need you · ` : ''}${counts().running} running · ${counts().waiting} waiting</p>` : ''}</div>${list.length ? `<button class="primary" data-nav="compose">＋ ${W.New}</button>` : ''}</div>${body}`;
  }
  // Direction B: today's time-ordered Upcoming list, extended with modes. Smallest change, weaker overnight overview.
  function queueView() {
    const list = tasks();
    const c = counts();
    const upcoming = list.filter((t) => ['running', 'waiting'].includes(t.group));
    const flat = upcoming.map((t) => ({ ...t, group: 'x' }));
    const needs = c.needs ? `<div class="notice amber" role="status"><div><strong>${c.needs} ${c.needs === 1 ? W.one + ' needs' : W.many + ' need'} you</strong><p>${esc(list.find((t) => t.group === 'needs').reason)}</p></div><button data-action="review">Review</button></div>` : '';
    const awakeNote = state.awake === 'session' && list.length ? `<div class="notice" role="status"><div><strong>☾ Keeping this Mac awake for ${c.awake} ${W.many}</strong><p>Display can sleep. Ends about 07:15.</p></div><button class="quiet" data-action="stop-awake">Stop</button></div>` : '';
    return `<div class="heading"><div><h1 tabindex="-1">Upcoming</h1></div><button class="primary" data-nav="compose">＋ ${W.New}</button></div>${needs}${awakeNote}${list.length ? `<div class="card">${flat.map(row).join('')}</div><p class="help">Sorted by next action. Running ${W.many} stay at the top; failures and questions move to History and the notice above.</p>` : `<div class="card empty"><h2>A clear runway.</h2><p>Nothing is scheduled.</p><button class="primary" data-nav="compose">${W.New}</button></div>`}`;
  }

  // Composer (issue #3): which thread, when, how far. Alternative: three presets.
  const reportsCompletion = (a) => ['yes', 'part'].includes(a.caps.find(([name]) => name === 'Report task complete')[1]);
  function syncDraft() {
    const d = state.draft;
    if (agentOf(d.thread).app) d.far = 'turns';
    d.preset = d.when === 'free' && d.far === 'done' ? 'free-done'
      : d.far === 'turns' && Number(d.turns) === 1 ? ({ time: 'time-once', free: 'free-once' }[d.when] || '') : '';
  }
  function planSentence(d) {
    if (turnError(d)) return 'Fix the turn count above to see the plan.';
    const th = threadOf(d.thread), a = agentOf(d.thread);
    const when = d.when === 'free' ? (a.avail === 'limited' ? `When ${a.name} is free, around <em>03:00</em>,` : a.avail === 'free' ? `${a.name} is free now, so right away` : `When ${a.name} is free (availability ${a.availText.toLowerCase()}),`) : d.when === 'time' ? `At <em>${esc(d.date)} ${esc(d.time)}</em>` : 'Right away';
    const far = d.far === 'turns' ? (Number(d.turns) === 1 ? 'once' : `up to ${esc(d.turns)} turns`) : !reportsCompletion(a) ? `and keep going until it stops making progress, at most ${esc(d.max)} turns` : `and keep going until ${a.name} says it is done${d.max ? `, at most ${esc(d.max)} turns` : ', with no turn limit'}`;
    return `${when} send "${esc(d.message)}" to <em>${esc(th.title)}</em> ${far}. Stop and wait for you if it asks anything.`;
  }
  function turnError(d) {
    const requiresLimit = !reportsCompletion(agentOf(d.thread));
    if (d.far === 'done' && requiresLimit && !String(d.max).trim()) return `Set a turn limit: ${agentOf(d.thread).name} cannot report when a task is done`;
    if (d.far === 'turns') {
      if (!/^-?\d+$/.test(String(d.turns).trim())) return 'Enter a whole number of turns.';
      if (Number(d.turns) < 1) return 'Use at least 1 turn. To stop a task, end it instead.';
    } else if (d.max !== '' && (!/^\d+$/.test(String(d.max).trim()) || Number(d.max) < 1)) return requiresLimit ? 'Enter a whole number of at least 1.' : 'Leave empty for no limit, or enter a whole number of at least 1.';
    return '';
  }
  function composeView() {
    const d = state.draft, th = threadOf(d.thread), a = agentOf(d.thread), key = th.agent;
    const err = turnError(d);
    const whenQ = `<fieldset><legend>When</legend><div class="seg" role="radiogroup" aria-label="When">${[['free', `When ${a.name} is free`], ['time', 'At a time'], ['now', 'Right away']].map(([v, l]) => `<label><input type="radio" name="when" value="${v}" ${d.when === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <div class="when-body">${d.when === 'free' ? `<p class="hint">${a.avail === 'limited' ? `Starts as soon as ${a.name} reports it is free. If the reset time cannot be read, this waits and shows "Unknown" instead of guessing.` : a.avail === 'free' ? `${a.name} is free now, so this starts right away.` : `${a.name} availability is ${a.availText.toLowerCase()}. This waits and keeps checking.`}</p>`
        : d.when === 'time' ? `<div class="two"><label class="field"><span>Date · yyyy-mm-dd</span><input id="date" class="input" value="${esc(d.date)}" inputmode="numeric"></label><label class="field"><span>Time · 24-hour</span><input id="time" class="input" value="${esc(d.time)}" inputmode="numeric"></label></div><div class="chips" aria-label="Quick times"><button type="button">+30 min</button><button type="button">+1 hour</button><button type="button">Tomorrow 09:00</button>${a.avail === 'limited' ? '<button type="button">After the 03:00 reset</button>' : ''}</div><p class="hint">Europe/London · BST (UTC+01:00) · <button type="button" class="link">Change timezone</button></p>`
        : '<p class="hint">Starts now. Useful for handing a thread to the Mac before you leave.</p>'}</div></fieldset>`;
    const farQ = `<fieldset><legend>How far</legend><div class="seg" role="radiogroup" aria-label="How far">${[['turns', 'A set number of turns'], ['done', 'Until done']].map(([v, l]) => `<label><input type="radio" name="far" value="${v}" ${d.far === v ? 'checked' : ''} ${v === 'done' && a.app ? 'disabled aria-describedby=done-unavailable' : ''}><span>${l}</span></label>`).join('')}</div>
      ${a.app ? `<p class="hint" id="done-unavailable">Not available: ${a.name} cannot report when a task is done</p>` : ''}
      <div class="far-row">${d.far === 'turns' ? `<label for="turns" class="hint" style="margin:0">Turns</label><span class="stepper ${err ? 'invalid' : ''}"><button type="button" data-step="-1" aria-label="One fewer turn">−</button><input id="turns" inputmode="numeric" value="${esc(d.turns)}" aria-invalid="${Boolean(err)}" aria-describedby="turns-help ${err ? 'turns-error' : ''}"><button type="button" data-step="1" aria-label="One more turn">+</button></span><span class="hint" id="turns-help" style="margin:0">Default 1. Any whole number.</span>`
        : `<label for="max" class="hint" style="margin:0">Turn limit</label><span class="stepper ${err ? 'invalid' : ''}"><button type="button" data-step="-1" aria-label="Lower limit">−</button><input id="max" inputmode="numeric" value="${esc(d.max)}" placeholder="${reportsCompletion(a) ? 'None' : 'Required'}" aria-invalid="${Boolean(err)}" aria-describedby="max-help ${err ? 'turns-error' : ''}"><button type="button" data-step="1" aria-label="Raise limit">+</button></span><span class="hint" id="max-help" style="margin:0">${reportsCompletion(a) ? 'Optional. Leave empty to keep going until done or until you stop it.' : 'Required. Stops at this limit or sooner if it stops making progress.'}</span>`}</div>
      ${err ? `<p class="field-error" id="turns-error">${err}</p>` : ''}
      ${d.far === 'done' && a.caps[4][1] === 'no' ? `<p class="field-error" style="color:var(--amber)">${a.name} cannot report that a task is done, so this stops only at the turn limit, a question or no progress.</p>` : ''}</fieldset>`;
    const presets = `<fieldset><legend>How should it continue?</legend><div class="presets" role="radiogroup">${[['time-once', 'Once, at a time', 'Send one message at the date and time you choose.'], ['free-once', `Once, when ${a.name} is free`, 'Waits for the usage limit to reset, then sends one message.'], ['free-done', 'Keep going until done', a.app ? `Not available: ${a.name} cannot report when a task is done` : reportsCompletion(a) ? 'Starts when free, continues turn by turn, stops when the agent says it is done.' : 'Starts when free, continues until it stops making progress or reaches the required turn limit.']].map(([v, l, s]) => `<label class="preset"><input type="radio" name="preset" value="${v}" ${d.preset === v ? 'checked' : ''} ${v === 'free-done' && a.app ? 'disabled' : ''}><span><strong>${l}</strong><small>${s}</small></span></label>`).join('')}</div><details id="preset-options" style="margin-top:12px" ${err || d.when === 'time' ? 'open' : ''}><summary>Turn limit and time</summary>${whenQ}${farQ}</details></fieldset>`;
    const stops = `<details style="margin-top:22px" ${params.get('stops') === '1' ? 'open' : ''}><summary>Stop and wait for me if</summary><div class="checks">${[['The agent asks a question', true, true], ['The agent asks for permission', true, true], ['Delivery cannot be confirmed', true, true], ['3 turns pass with no visible progress', d.stops.noprog, d.far === 'done'], ['A turn takes longer than 45 minutes', d.stops.slow, false], ['Someone else writes in the thread', d.stops.touched, false]].map(([l, on, locked]) => `<label><input type="checkbox" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${l}${locked ? ' <small>(always)</small>' : ''}</label>`).join('')}</div><p class="hint">The locked rules are why the app never blindly sends again. A turn only counts once delivery is confirmed.</p></details>`;
    const awakeLine = a.caps[5][1] === 'no' ? `Needs the screen unlocked and the display on when it runs. The Mac will keep the display on from 5 minutes before.` : 'The Mac stays awake for this; the screen can lock because it runs without a window.';
    return `<button class="ghost back" data-nav="board">← Back to ${home().toLowerCase()}</button><div class="heading"><h1 tabindex="-1">${W.New}</h1></div>
      <section class="card panel" aria-label="${W.New}"><form onsubmit="return false">
        <div class="label-row"><span class="label" id="thread-label">Thread</span></div>
        <button type="button" class="picker" data-nav="picker" aria-labelledby="thread-label thread-name">${mono(key)}<span><strong id="thread-name">${esc(th.title)}</strong><small class="muted">${esc(a.name)} · ${esc(th.project)} · updated ${esc(th.ago)}</small></span><span class="chev" aria-hidden="true">⌄</span></button>
        <div class="inline-avail">${avail(key)}<button type="button" class="quiet">Check again</button></div>
        <label class="field"><span>Message</span><textarea id="message">${esc(d.message)}</textarea></label>
        ${state.composer === 'questions' ? whenQ + farQ : presets}
        ${stops}
        <div class="plan" id="plan"><span class="overline">The plan</span><p class="sentence">${err ? 'Fix the turn count above to see the plan.' : planSentence(d)}</p><ul><li>${awakeLine}</li><li>Failed or unconfirmed sends never count as turns and are never repeated automatically.</li></ul></div>
        <button class="primary submit" aria-describedby="plan" ${err ? 'aria-disabled="true"' : ''} data-action="submit">${W.verb(d)}</button>
      </form></section>`;
  }
  function pickerView() {
    const byAgent = (k) => threads.filter((t) => t.agent === k);
    const list = (k) => byAgent(k).map((t) => `<button class="thread-row" data-thread="${t.id}" ${agents[k].avail === 'down' ? 'aria-describedby="down-' + k + '"' : ''}><span><strong>${esc(t.title)}</strong><small class="muted">${esc(t.project)} · updated ${esc(t.ago)}</small></span>${t.has ? `<span class="has">${esc(t.has)}</span>` : ''}</button>`).join('');
    const grouped = Object.keys(agents).map((k) => `<div class="agent-group"><div class="agent-group-head">${mono(k)}${esc(agents[k].name)}${avail(k, false)}</div>${agents[k].avail === 'down' ? `<p class="hint" id="down-${k}" style="padding:8px 18px 0;margin:0">OpenCode is not running. You can still pick a thread; it will wait until OpenCode answers.</p>` : ''}${byAgent(k).length ? list(k) : `<p class="hint" style="padding:10px 18px 12px;margin:0">No conversations visible. Open ${esc(agents[k].name)} with its sidebar showing, then refresh.</p>`}</div>`).join('');
    const agentFirst = `<div class="agent-tabs" role="group" aria-label="Agent">${Object.keys(agents).map((k) => `<button aria-pressed="${state.pickerAgent === k}" data-picker-agent="${k}">${mono(k)}${esc(agents[k].name)}<i class="dot ${agents[k].avail}" aria-hidden="true"></i></button>`).join('')}</div><div class="card"><div class="agent-group"><div class="agent-group-head">${mono(state.pickerAgent)}${esc(agents[state.pickerAgent].name)}${avail(state.pickerAgent)}</div>${list(state.pickerAgent)}</div></div>`;
    return `<button class="ghost back" data-nav="compose">← Back to draft</button><div class="heading"><div><h1 tabindex="-1">Choose a thread</h1><p>${state.picker === 'grouped' ? 'Every agent, most recent first. Agents that cannot run right now are listed with the reason, never hidden.' : 'Pick the agent, then its thread. Clearer per agent, one extra step every time.'}</p></div></div><input class="input" type="search" placeholder="Find a thread in any agent…" aria-label="Find a thread" style="margin-bottom:14px">${state.picker === 'grouped' ? `<div class="card">${grouped}</div>` : agentFirst}`;
  }

  function detailView() {
    const t = tasks().find((x) => x.id === state.selected) || baseTasks[0];
    const th = threadOf(t.thread), a = agents[th.agent];
    const box = t.group === 'needs' ? `<div class="state-box ${t.tone === 'red' ? 'red' : 'amber'}" role="status"><h3>${esc(t.stateLabel)}</h3><p>${esc(t.reason)}</p><div class="actions">${(t.actions || []).map(([l, c]) => `<button class="${c === 'ghost' ? 'ghost' : c === 'quiet' ? 'quiet' : 'primary'}">${l}</button>`).join('')}${t.id === 'billing' ? `<button class="quiet">Open in ${a.name}</button>` : ''}</div></div>`
      : t.group === 'running' ? `<div class="state-box" role="status"><h3>${t.tally ? tally(t.tally) : ''}</h3><p>${esc(t.left)}. ${esc(t.right)}.</p><div class="actions"><button class="quiet">Stop after this turn</button><button class="ghost danger">End now</button></div></div>`
      : t.group === 'waiting' ? `<div class="state-box"><h3>${esc(t.left)}</h3><p>${esc(t.right)}.</p><div class="actions"><button class="primary">Edit</button><button class="quiet">Start now</button><button class="ghost danger">Cancel</button></div></div>`
      : `<div class="state-box"><h3>${esc(t.stateLabel)}</h3><p>${esc(t.right)}.</p><div class="actions"><button class="primary">Continue again</button></div></div>`;
    const turns = t.id === 'billing' ? [['1', '22:02:05', '22:14', 'Ended normally'], ['2', '22:14:40', '22:31', 'Asked a question, paused']] : t.id === 'sched' ? [['1', '21:40:05', '21:58', 'Ended normally'], ['2', '21:58:31', '22:15', 'Ended normally'], ...(t.group === 'done' ? [['3', '22:34:02', '22:50', 'Ended normally'], ['4', '22:50:30', '23:06', 'Reached turn limit']] : [['3', '22:34:02', 'Running', '']])] : t.id === 'audit-failed' ? [['-', 'Not sent', '', 'Token rejected before sending (HTTP 401)']] : [];
    return `<button class="ghost back" data-nav="board">← Back to ${home().toLowerCase()}</button><div class="heading"><div><span class="who">${mono(th.agent)}<span>${esc(a.name)}</span><span class="muted">/ ${esc(th.project)}</span></span><h1 tabindex="-1" style="margin-top:10px;font-size:28px">${esc(th.title)}</h1></div></div>
      <section class="card pad"><p class="plan-lead">${t.plan.charAt(0).toUpperCase() + t.plan.slice(1)}</p>${box}
      ${turns.length ? `<h3 style="margin-top:22px">Turns</h3><table><thead><tr><th scope="col">Turn</th><th scope="col">Delivered</th><th scope="col">Turn ended</th><th scope="col">Result</th></tr></thead><tbody>${turns.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''}
      <dl class="kv"><dt>Message</dt><dd>${esc(t.message)}</dd><dt>Agent</dt><dd>${esc(a.name)} · ${esc(a.kind)}</dd><dt>Keeps Mac awake</dt><dd>${t.needsAwake || t.group === 'running' ? 'Yes, until this finishes' : 'No'}</dd><dt>Timezone</dt><dd>Europe/London (BST)</dd></dl></section>`;
  }

  function agentsView() {
    const addFlow = params.get('add') === '1';
    return `<div class="heading"><div><h1 tabindex="-1">Agents</h1><p>Connections the app can continue. Capabilities decide which options the composer offers.</p></div><button class="primary" data-action="add-agent">＋ Add agent</button></div>
      ${addFlow ? `<section class="card pad" style="margin-bottom:18px" aria-label="Add an agent"><h2>Add an agent</h2><div class="radio-list">${[['OpenCode', 'Local HTTP server. Needs "opencode serve" running.'], ['Claude Code', 'CLI. Finds sessions in the project folders you choose.'], ['Codex CLI', 'CLI. Finds recent sessions.'], ['Claude, ChatGPT or Codex desktop', 'Desktop app. Needs Accessibility permission, an unlocked screen and the display on.']].map(([n, s], i) => `<label><input type="radio" name="add" ${i === 3 ? 'checked' : ''}><span><strong>${n}</strong><small class="muted">${s}</small></span></label>`).join('')}</div><div class="state-box amber" style="margin-top:14px"><h3>Accessibility permission needed</h3><p>macOS asks once. The app only reads the conversation list and limit message, and types into the conversation you pick.</p><div class="actions"><button class="primary">Open System Settings</button><button class="quiet">Check again</button></div></div></section>` : ''}
      <div class="card">${Object.keys(agents).map((k) => { const a = agents[k]; const open = state.expanded === k; const n = threads.filter((t) => t.agent === k).length; return `<div class="agent-row"><div class="agent-row-top">${mono(k)}<div><strong>${esc(a.name)}</strong><small class="muted">${esc(a.kind)} · ${n} thread${n === 1 ? '' : 's'}</small></div>${avail(k)}<button class="ghost" data-agent="${k}" aria-expanded="${open}">${open ? 'Hide' : 'Details'}</button></div>
        ${open ? `<div class="expand"><table><caption class="sr-only">${esc(a.name)} capabilities</caption><thead><tr><th scope="col">Capability</th><th scope="col">Status</th><th scope="col">What it means</th></tr></thead><tbody>${a.caps.map(([c, s, m]) => `<tr><td>${c}</td><td class="cap-${s === 'yes' ? 'yes' : s === 'no' ? 'no' : 'part'}">${s === 'yes' ? '✓ Yes' : s === 'no' ? '✕ No' : '◐ Partly'}</td><td>${m}</td></tr>`).join('')}</tbody></table><div class="actions"><button class="quiet">Check connection</button><button class="quiet">Connection settings</button>${k === 'OC' ? '<button class="quiet">How to start OpenCode</button>' : ''}</div></div>` : ''}</div>`; }).join('')}</div>
      <p class="help">Availability always names its source and age. Unknown means the app could not read it; it never guesses a time.</p>`;
  }
  function historyView() {
    const rows = [['Investigate why the nightly export job…', 'CX', 'Done, 4 turns', 'green', '21:58'], ['Tidy the feed mapping rules', 'OC', 'Delivered, 1 turn', 'muted', '20:00'], ['Audit checkout edge cases…', 'T3', 'Failed', 'red', '22:22'], ['Review billing settings', 'T3', 'Ended by you after turn 2', 'muted', '19:40'], ['Draft release notes for 2.0', 'CC', 'Delivery unconfirmed', 'amber', 'Yesterday 03:04']];
    return `<div class="heading"><div><h1 tabindex="-1">History</h1><p>Every ${W.one}, its turns and its outcome. Nothing here sends anything.</p></div></div><div class="chips" role="group" aria-label="Filter history" style="margin:0 0 14px">${['All', 'Done', 'Needs you', 'Ended', 'Failed', 'Unconfirmed'].map((f, i) => `<button aria-pressed="${i === 0}" class="${i === 0 ? 'quiet primary' : 'quiet'}">${f}</button>`).join('')}</div><div class="card">${rows.map(([t, k, s, tone, when]) => `<article class="frow"><div class="frow-top"><span class="who">${mono(k)}<span>${agents[k].name}</span></span><span class="pill ${tone}">${s}</span></div><button class="row-link">${esc(t)}</button><div class="meta"><span>Last turn ${when}</span><span>Open for the turn log</span></div></article>`).join('')}</div>`;
  }
  function settingsView() {
    return `<div class="heading"><h1 tabindex="-1">Settings</h1></div><div class="settings">
      <section class="card pad" aria-labelledby="set-awake"><span class="overline">Power</span><h2 id="set-awake">Keep awake</h2><p>The Mac stays awake only while ${W.many} need it, and always says why.</p>
        <div class="setting"><div><strong>When a ${W.one} needs the Mac</strong><small class="muted">Waiting for a time, waiting for an agent, or running.</small></div><select class="input" aria-label="When a ${W.one} needs the Mac"><option>Keep it awake automatically</option><option>Ask me each time</option><option>Never keep it awake</option></select></div>
        <div class="setting"><div><strong>Display</strong><small class="muted">Desktop-app agents need the screen unlocked and on.</small></div><select class="input" aria-label="Display"><option>On only when an agent needs it</option><option>Let it sleep</option><option>Always on</option></select></div>
        <div class="setting"><div><strong>Stop at battery level</strong><small class="muted">Ends keep-awake on battery below this level.</small></div><span class="stepper"><button type="button" aria-label="Lower">−</button><input value="20%" aria-label="Battery level"><button type="button" aria-label="Raise">+</button></span></div>
        <div class="setting"><div><strong>Closing the lid</strong><small class="muted">macOS sleeps most laptops when the lid closes. It can stay awake only on power with an external display.</small></div><span class="pill amber">Keep the lid open</span></div></section>
      <section class="card pad" aria-labelledby="set-phone"><span class="overline">Remote control</span><h2 id="set-phone">Phone and MCP</h2><p>Control ${W.many} from your phone or a mobile agent. Never exposed to the public internet.</p>
        <fieldset style="margin-top:14px"><legend>Reach</legend><div class="radio-list">${[['Off', 'Only this window and the menu bar.'], ['This Mac only', 'localhost. For agents running on this Mac.'], ['Private network', 'Your Tailscale network. The phone must be signed in to the same tailnet.']].map(([l, s], i) => `<label><input type="radio" name="reach" ${i === 2 ? 'checked' : ''}><span><strong>${l}</strong><small class="muted">${s}</small></span></label>`).join('')}</div></fieldset>
        <h3 style="margin-top:20px">Paired devices</h3><table><thead><tr><th scope="col">Device</th><th scope="col">Can</th><th scope="col">Last used</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody><tr><td>Ryan's iPhone (web board)</td><td>View, pause, resume, end, create</td><td>2 min ago</td><td><button class="ghost danger">Revoke</button></td></tr><tr><td>Claude mobile (MCP)</td><td>View, pause, resume, end</td><td>Yesterday</td><td><button class="ghost danger">Revoke</button></td></tr></tbody></table>
        ${state.pairing ? `<div class="pair"><svg class="qr" viewBox="0 0 21 21" role="img" aria-label="Pairing QR code. Or type the four words.">${qr()}</svg><div><span class="overline">Pair a device · expires in 4:52</span><p class="words">maple · lantern · orbit · seven</p><p class="hint">Scan with the phone camera or type the four words at http://ryans-mac.tailnet:4747. One code pairs one device. Tokens can be revoked here at any time.</p></div></div>` : '<div class="actions"><button class="primary" data-action="pair">Pair a phone</button><button class="quiet" data-action="mcp">Copy MCP connector</button></div>'}
        <details style="margin-top:14px"><summary>MCP connector</summary><div class="code">{ "mcpServers": { "agent-auto-continue": {\n  "url": "http://ryans-mac.tailnet:4747/mcp",\n  "headers": { "Authorization": "Bearer ••••••••" } } } }</div><p class="hint">Tools: list_${W.many}, create_${W.one}, pause, resume, end. Every request carries an ID so a retried request never creates two ${W.many}.</p></details></section>
      <section class="card pad"><span class="overline">Make it yours</span><div class="setting"><div><strong>Appearance</strong></div><select class="input" aria-label="Appearance"><option>Follow system</option><option>Light</option><option>Dark</option></select></div><div class="setting"><div><strong>Launch at login</strong><small class="muted">Today this lives only in the menu bar.</small></div><input type="checkbox" checked aria-label="Launch at login"></div></section>
      <p class="help">Agent tokens, ports and paths move to each agent on the Agents page, so Settings does not grow with every integration. The support card is unchanged and omitted here.</p></div>`;
  }
  function qr() { let s = 0; const cells = []; for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) { const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13); const on = finder ? ((x % 20 === 0 || y % 20 === 0 || x === 6 || y === 6 || x === 14 || y === 14) || (x % 20 >= 2 && x % 20 <= 4 && y % 20 >= 2 && y % 20 <= 4) || (x >= 16 && x <= 18 && y >= 2 && y <= 4) || (x >= 2 && x <= 4 && y >= 16 && y <= 18)) : ((s = (s * 9301 + 49297 + x * 7 + y * 13) % 233280) / 233280 > 0.52); if (on) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`); } return `<g fill="#34303A">${cells.join('')}</g>`; }

  // Phone web board (issue #4): trimmed board on the private network.
  function phoneView() {
    const unreachable = state.scenario === 'trouble';
    const list = tasks();
    const c = counts();
    const needs = list.filter((t) => t.group === 'needs').slice(0, 2), running = list.filter((t) => t.group === 'running'), waiting = list.filter((t) => t.group === 'waiting').slice(0, 2);
    const mini = (t) => { const th = threadOf(t.thread); return `<article class="frow ${t.group === 'needs' ? 'bar-amber' : t.group === 'running' ? 'bar-accent' : ''}"><div class="frow-top"><span class="who">${mono(th.agent)}<span>${agents[th.agent].name}</span></span>${t.tally ? tally(t.tally) : `<span class="pill ${t.tone || (t.availTone === 'limited' ? 'amber' : '')}">${esc(t.stateLabel)}</span>`}</div><button class="row-link">${esc(th.title)}</button>${t.reason ? `<p class="reason">${esc(t.reason)}</p>` : ''}${t.group === 'needs' && !unreachable ? `<div class="row-actions">${(t.actions || []).map(([l, cl]) => `<button class="${cl === 'ghost' ? 'ghost' : 'quiet' + (cl === 'primary' ? ' primary' : '')}">${l}</button>`).join('')}</div>` : ''}<div class="meta"><span>${esc(t.left)}</span></div></article>`; };
    return `${studio()}<div class="phone-stage"><div class="phone ${unreachable ? 'stale' : ''}" role="region" aria-label="Phone web board preview"><div class="phone-top"><span>22:41</span><span>ryans-mac.tailnet</span></div><main class="content"><h1>${list.length ? 'Tonight' : 'Nothing waiting'}</h1><p class="reach"><i class="dot ${unreachable ? 'down' : 'free'}"></i>${unreachable ? 'Mac not reachable. Last seen 02:14. Actions will queue and may be stale.' : 'Mac reachable · seen 12 s ago · awake for ' + c.awake + ' ' + W.many}</p>
      ${list.length ? `${needs.length ? `<div class="section-head" style="margin-top:18px"><h2>Needs you</h2></div><div class="card">${needs.map(mini).join('')}</div>` : ''}${running.length ? `<div class="section-head" style="margin-top:18px"><h2>Running</h2></div><div class="card">${running.map(mini).join('')}</div>` : ''}${waiting.length ? `<div class="section-head" style="margin-top:18px"><h2>Waiting</h2></div><div class="card">${waiting.map(mini).join('')}</div>` : ''}` : '<p class="help">Create one from the Mac or ask your agent through MCP.</p>'}
      </main>${unreachable ? '' : '<div class="toast" role="status">✓ Mac accepted Resume at 22:41</div>'}</div>
      <div class="phone-notes"><h2>Phone board</h2><ul><li>Served by the Mac on the private network only (localhost or Tailscale), with a revocable bearer token per device.</li><li>Same sections and words as the desktop Board, trimmed to what needs a thumb.</li><li>Every tap shows the Mac's receipt. Each action carries a request ID so a retried tap never duplicates a ${W.one}.</li><li>When the Mac is unreachable the board greys out, shows when it was last seen, and actions are clearly queued.</li><li>The same actions are available to a mobile agent through the MCP connector.</li></ul></div></div>`;
  }
  // Menu bar (tray): colour only means "needs you".
  function trayView() {
    const c = counts();
    return `${studio()}<div class="menubar"><span>Wed 30 Sep 22:41</span><span class="tray-icon" aria-label="Agent Auto-Continue, ${c.needs} need you">▤${c.needs ? '<i class="dot limited"></i>' : ''} ☾</span></div><div class="tray-stage"><div class="tray-notes"><h1>Menu bar</h1><ul><li>The icon is a template image. It gains a moon while keeping the Mac awake, and a single amber dot only when something needs you.</li><li>The header answers "is anything wrong?" before listing anything.</li><li>At most six ${W.many}, needs-you first, with the same words as the window.</li><li>Recent threads are capped at eight across all agents, replacing today's 100-item submenu.</li><li>Notifications reuse the same sentences: "Claude Code needs you", "${W.One} done", "Started late".</li></ul></div>
      <div class="menu" role="menu" aria-label="Menu bar menu"><div class="mhead"><strong>${c.needs} need you · ${c.running} running · ${c.waiting} waiting</strong><small>Keeping this Mac awake until about 07:15</small></div><hr>
      ${tasks().filter((t) => t.group !== 'done').slice(0, 6).map((t) => { const th = threadOf(t.thread); return `<div class="mi two-line" role="menuitem"><span>${t.group === 'needs' ? '● ' : t.group === 'running' ? '▸ ' : '◷ '}${esc(th.title.length > 38 ? th.title.slice(0, 37) + '…' : th.title)}<small>${esc(agents[th.agent].name)} · ${esc(t.tally ? (t.tally[1] ? `turn ${t.tally[0]} of ${t.tally[1]}` : `turn ${t.tally[0]}, until done`) : t.stateLabel)}</small></span></div>`; }).join('')}
      <hr><div class="mi" role="menuitem">${W.New}… <small>⌘N</small></div><div class="mi" role="menuitem">Recent threads <small>▸</small></div><div class="mi" role="menuitem">Pause everything</div><div class="mi" role="menuitem">Stop keeping awake</div><hr><div class="mi" role="menuitem">Open ${home()} <small>⌘O</small></div><div class="mi" role="menuitem">Settings… <small>⌘,</small></div><div class="mi" role="menuitem">Quit</div></div></div>`;
  }

  function render() {
    syncDraft();
    document.body.className = `features ${state.theme === 'dark' ? 'dark' : ''}`;
    document.title = `${CONCEPTS[concept]} · Scheduler design studio`;
    const app = $('#app');
    if (concept === 'phone') { app.innerHTML = phoneView(); return bind(); }
    if (concept === 'tray') { app.innerHTML = trayView(); return bind(); }
    const views = { board: concept === 'queue' ? queueView : boardView, compose: composeView, picker: pickerView, detail: detailView, agents: agentsView, history: historyView, settings: settingsView };
    app.innerHTML = shell(views[state.view]());
    bind();
  }
  function go(view) { state.view = view; render(); $('h1')?.focus(); }
  function bind() {
    document.querySelectorAll('[data-param]').forEach((el) => { el.onchange = () => { const next = new URLSearchParams(location.search); next.set(el.dataset.param, el.value); location.search = next.toString(); }; });
    document.querySelectorAll('[data-nav]').forEach((el) => { el.onclick = () => go(el.dataset.nav); });
    document.querySelectorAll('[data-task]').forEach((el) => { el.onclick = () => { state.selected = el.dataset.task; go('detail'); }; });
    document.querySelectorAll('.strip-agent,[data-agent]').forEach((el) => { el.onclick = () => { state.expanded = state.view === 'agents' && state.expanded === el.dataset.agent ? '' : el.dataset.agent; go('agents'); }; });
    document.querySelectorAll('[data-thread]').forEach((el) => { el.onclick = () => { state.draft.thread = el.dataset.thread; go('compose'); }; });
    document.querySelectorAll('[data-picker-agent]').forEach((el) => { el.onclick = () => { state.pickerAgent = el.dataset.pickerAgent; render(); }; });
    document.querySelectorAll('input[name=when],input[name=far],input[name=preset]').forEach((el) => { el.onchange = () => { if (el.name === 'preset') Object.assign(state.draft, { when: el.value === 'time-once' ? 'time' : 'free', far: el.value === 'free-done' ? 'done' : 'turns', ...(el.value === 'free-done' ? {} : { turns: '1' }) }); else state.draft[el.name] = el.value; render(); document.querySelector(`input[name=${el.name}][value=${el.value}]`)?.focus(); }; });
    ['turns', 'max'].forEach((id) => { const el = $('#' + id); if (el) el.oninput = () => { state.draft[id] = el.value; const pos = el.selectionStart; const optionsOpen = $('#preset-options')?.open; render(); if (optionsOpen) $('#preset-options').open = true; const again = $('#' + id); again.focus(); again.setSelectionRange(pos, pos); }; });
    document.querySelectorAll('[data-step]').forEach((el) => { el.onclick = () => { const key = state.draft.far === 'turns' ? 'turns' : 'max'; const n = Number(state.draft[key]) || 0; state.draft[key] = String(Math.max(1, n + Number(el.dataset.step))); render(); }; });
    ['date', 'time'].forEach((id) => { const el = $('#' + id); if (el) el.oninput = () => { state.draft[id] = el.value; $('#plan .sentence').innerHTML = planSentence(state.draft); $('[data-action=submit]').textContent = W.verb(state.draft); }; });
    const msg = $('#message'); if (msg) msg.oninput = () => { state.draft.message = msg.value; $('#plan .sentence').innerHTML = planSentence(state.draft); };
    document.querySelectorAll('[data-action]').forEach((el) => { el.onclick = () => action(el.dataset.action); });
  }
  function action(name) {
    if (name === 'theme') state.theme = state.theme === 'dark' ? 'light' : 'dark';
    else if (name === 'toast-close') state.toast = '';
    else if (name === 'pair') state.pairing = true;
    else if (name === 'awake') { go(state.view === 'board' ? 'settings' : 'board'); return; }
    else if (name === 'review') { state.selected = 'billing'; go('detail'); return; }
    else if (name === 'submit') { if (turnError(state.draft)) { $('#turns,#max')?.focus(); return; } state.toast = `${W.One} saved in this prototype. Nothing is sent.`; go('board'); return; }
    else if (name.startsWith('row:')) state.toast = `${name.slice(4)}: prototype only.`;
    else state.toast = 'Prototype only.';
    render();
  }
  window.addEventListener('DOMContentLoaded', render);
})();
