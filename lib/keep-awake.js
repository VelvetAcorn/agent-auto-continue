'use strict';

// Keep-awake session lifecycle. See docs/keep-awake-investigation.md for the design record.
//
// The controller holds at most one Electron power save blocker:
// - 'prevent-app-suspension' creates a PreventUserIdleSystemSleep assertion (display may sleep);
// - 'prevent-display-sleep' creates a PreventUserIdleDisplaySleep assertion (system and display stay on).
// macOS releases both when the process exits for any reason, including a crash.
// Neither prevents sleep from closing the lid, choosing Sleep, or a critically low battery.

const SYSTEM_BLOCKER = 'prevent-app-suspension';
const DISPLAY_BLOCKER = 'prevent-display-sleep';
const HOUR = 3_600_000;
const TASK_STATES = new Set(['waiting', 'running', 'unknown']);
const STATES = new Set(['off', 'armed', 'active', 'paused', 'releasing', 'ended']);
const POWER_SOURCES = new Set(['any', 'ac-only']);

const DEFAULT_KEEP_AWAKE = Object.freeze({
  enabled: false,
  keepDisplayOn: false,
  powerSource: 'any',
  batteryFloorPercent: 20,
  maxHours: 12,
  includeRunningAgents: false
});

function inRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function normaliseKeepAwake(value) {
  const input = value && typeof value === 'object' ? value : {};
  const floor = Number(input.batteryFloorPercent);
  const hours = Number(input.maxHours);
  return {
    enabled: input.enabled === true,
    keepDisplayOn: input.keepDisplayOn === true,
    powerSource: POWER_SOURCES.has(input.powerSource) ? input.powerSource : DEFAULT_KEEP_AWAKE.powerSource,
    batteryFloorPercent: inRange(floor, 0, 95) ? floor : DEFAULT_KEEP_AWAKE.batteryFloorPercent,
    maxHours: inRange(hours, 1, 72) ? hours : DEFAULT_KEEP_AWAKE.maxHours,
    includeRunningAgents: input.includeRunningAgents === true
  };
}

function validateKeepAwakeInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid keep-awake settings.');
  for (const key of ['enabled', 'keepDisplayOn', 'includeRunningAgents']) {
    if (typeof input[key] !== 'boolean') throw new Error('Invalid keep-awake settings.');
  }
  if (!POWER_SOURCES.has(input.powerSource)) throw new Error('Choose when to keep the Mac awake on battery.');
  const floor = Number(input.batteryFloorPercent);
  if (!inRange(floor, 0, 95)) throw new Error('Battery floor must be a whole number from 0 to 95 percent.');
  const hours = Number(input.maxHours);
  if (!inRange(hours, 1, 72)) throw new Error('Time limit must be a whole number from 1 to 72 hours.');
  return { enabled: input.enabled, keepDisplayOn: input.keepDisplayOn, includeRunningAgents: input.includeRunningAgents,
    powerSource: input.powerSource, batteryFloorPercent: floor, maxHours: hours };
}

// Parses `pmset -g batt`. Desktop Macs report AC power and no battery percentage.
function parseBatteryStatus(output) {
  const text = typeof output === 'string' ? output : '';
  const source = /Now drawing from '([^']+)'/.exec(text)?.[1] || null;
  const percent = /InternalBattery[^\n]*?\t(\d{1,3})%/.exec(text)?.[1];
  const level = percent === undefined ? null : Number(percent);
  return {
    onBattery: source === null ? null : source === 'Battery Power',
    percent: Number.isInteger(level) && level >= 0 && level <= 100 ? level : null
  };
}

function isTask(value) {
  return Boolean(value && typeof value === 'object' && typeof value.id === 'string' && value.id &&
    typeof value.label === 'string' && TASK_STATES.has(value.state));
}

function deduplicateSupplementary(tasks) {
  const covered = new Set(tasks.filter((task) => !task.supplementary && task.conversation).map((task) => task.conversation));
  return tasks.filter((task) => !task.supplementary || !covered.has(task.conversation));
}

/**
 * A work source reports the tasks that currently need the Mac awake.
 * Harness adapters register one source each; the T3 Code job service is the first.
 *
 * @typedef {object} TrackedTask
 * @property {string} id Stable identifier, unique across sources (prefix it with the source id).
 * @property {string} harness Harness identifier, for example 't3'.
 * @property {string} label Human-readable task name, such as a thread title.
 * @property {'waiting'|'running'|'unknown'} state
 *   waiting: scheduled or waiting for agent availability;
 *   running: an agent or delivery is executing;
 *   unknown: completion cannot be confirmed (bounded by `until`).
 * @property {string} [detail] Short explanation shown to the user.
 * @property {string|null} [until] ISO time: expected start for waiting tasks, expiry for unknown tasks.
 * @property {string} [conversation] `<harness>:<conversation id>`, used to de-duplicate supplementary tasks.
 * @property {boolean} [supplementary] Dropped when another task covers the same conversation.
 * @property {boolean} [requiresUnlockedScreen] Delivery drives a user interface, so the display is kept on.
 *
 * @typedef {object} WorkSource
 * @property {string} id
 * @property {string} label
 * @property {() => TrackedTask[]} tasks Synchronous view of cached state.
 * @property {() => Promise<void>} [refresh] Optional polling hook, called on each controller tick.
 * @property {(listener: () => void) => () => void} [subscribe] Optional change notifications.
 */
class WorkSourceRegistry {
  constructor() {
    this.sources = new Map();
    this.listeners = new Set();
    this.unsubscribers = new Map();
  }
  register(source) {
    if (!source || typeof source.id !== 'string' || !source.id || typeof source.tasks !== 'function') throw new Error('Invalid work source.');
    if (this.sources.has(source.id)) throw new Error(`Work source ${source.id} is already registered.`);
    this.sources.set(source.id, source);
    if (typeof source.subscribe === 'function') this.unsubscribers.set(source.id, source.subscribe(() => this.emit()));
    this.emit();
    return () => this.unregister(source.id);
  }
  unregister(id) {
    if (!this.sources.delete(id)) return;
    this.unsubscribers.get(id)?.();
    this.unsubscribers.delete(id);
    this.emit();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* One listener must not block the others. */ }
    }
  }
  tasks({ includeSupplementary = false } = {}) {
    const tasks = [];
    const errors = [];
    const seen = new Set();
    for (const source of this.sources.values()) {
      let reported;
      try { reported = source.tasks(); } catch (error) { errors.push({ source: source.id, message: String(error?.message || error) }); continue; }
      for (const task of Array.isArray(reported) ? reported : []) {
        if (!isTask(task) || seen.has(task.id)) continue;
        seen.add(task.id);
        tasks.push({ id: task.id, harness: task.harness || source.id, source: source.id, label: task.label, state: task.state,
          detail: typeof task.detail === 'string' ? task.detail : '', until: typeof task.until === 'string' ? task.until : null,
          conversation: typeof task.conversation === 'string' ? task.conversation : null, supplementary: task.supplementary === true,
          requiresUnlockedScreen: task.requiresUnlockedScreen === true });
      }
    }
    return { tasks: includeSupplementary ? tasks : deduplicateSupplementary(tasks), errors };
  }
  async refresh() {
    await Promise.all([...this.sources.values()].map(async (source) => {
      try { await source.refresh?.(); } catch { /* Sources report staleness through their tasks. */ }
    }));
  }
}

const ENDED_TEXT = {
  'user-stop': 'You let the Mac sleep. New scheduled work starts a new keep-awake session.',
  'battery-floor': 'Stopped because the battery reached the floor you set. Connect power to resume.',
  'max-duration': 'Stopped at the time limit you set. Work that reached the limit no longer keeps the Mac awake; new scheduled work starts its own session.'
};

class KeepAwakeController {
  constructor({ power, registry, settings = DEFAULT_KEEP_AWAKE, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
    onChange = () => {}, notify = () => {}, tickMs = 60_000, releaseGraceMs = 120_000 }) {
    if (!power || !registry) throw new Error('Keep-awake needs a power adapter and a work source registry.');
    Object.assign(this, { power, registry, now, setTimer, clearTimer, onChange, notify, tickMs, releaseGraceMs });
    this.settings = normaliseKeepAwake(settings);
    this.state = 'off';
    this.hold = null;
    this.session = null;
    this.suppression = null;
    // Tasks that reached the time limit, by id: { state, conversation, dueAt }. They stay excluded from
    // later sessions until they finish or a waiting task starts, so a stuck task cannot chain sessions.
    // Work deferred at the limit (with dueAt) is held back until it is due, then starts its own session.
    this.capped = new Map();
    this.cappedAt = null;
    this.cappedTasks = [];
    this.releaseAt = null;
    this.lastRelease = null;
    this.lastSleep = null;
    this.sleepingSince = null;
    this.tasks = [];
    this.deferred = [];
    this.eligible = [];
    this.sourceErrors = [];
    this.battery = { onBattery: null, percent: null, checkedAt: null };
    this.timer = null;
    this.disposed = false;
    this.lastPublished = '';
    this.unsubscribe = registry.subscribe(() => this.evaluate());
  }

  start() {
    this.readPowerSource();
    this.evaluate();
    this.scheduleTick();
    return this;
  }

  configure(settings) {
    this.settings = normaliseKeepAwake(settings);
    if (!this.settings.enabled) this.clearEnded();
    if (this.session) this.session.deadline = this.session.startedAt + this.settings.maxHours * HOUR;
    this.evaluate();
    this.scheduleTick();
    return this.snapshot();
  }

  // Explicit user stop: release now and stay released for the current set of tasks.
  stop() {
    if (this.hold || ['armed', 'active', 'paused', 'releasing'].includes(this.state)) this.end('user-stop');
    this.evaluate();
    return this.snapshot();
  }

  // Undo an explicit stop or time-limit end for the current tasks.
  resume() {
    this.clearEnded();
    this.session = null;
    this.evaluate();
    return this.snapshot();
  }

  handleSuspend() {
    if (this.disposed) return;
    this.sleepingSince = this.now();
    this.publish();
  }

  async handleResume() {
    if (this.disposed) return;
    const woke = this.now();
    // macOS slept despite the assertion (lid closed, Sleep chosen, low battery) or before keep-awake held one.
    if (this.sleepingSince !== null) this.lastSleep = { from: new Date(this.sleepingSince).toISOString(), to: new Date(woke).toISOString(), whileHolding: Boolean(this.hold) };
    this.sleepingSince = null;
    await this.tick();
  }

  handlePowerSourceChange() {
    if (this.disposed) return;
    this.readPowerSource();
    void this.tick();
  }

  dispose() {
    this.disposed = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.release('app-quit');
    this.state = 'off';
  }

  scheduleTick() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.disposed || !this.settings.enabled) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.tick().finally(() => this.scheduleTick()); }, this.tickMs);
    this.timer?.unref?.();
  }

  async tick() {
    if (this.disposed) return;
    if (this.settings.enabled) {
      this.readPowerSource();
      await Promise.all([this.readBatteryLevel(), this.registry.refresh()]);
    }
    if (!this.disposed) this.evaluate();
  }

  readPowerSource() {
    try {
      const onBattery = this.power.isOnBattery();
      if (typeof onBattery === 'boolean') {
        // The percentage is only read on battery, so a stale reading is dropped on power.
        if (!onBattery) this.battery.percent = null;
        this.battery.onBattery = onBattery;
      }
    } catch { this.battery.onBattery = null; }
  }

  // The level only matters while a session holds, or is about to hold, an assertion that the floor can end.
  batteryFloorApplies() {
    return this.battery.onBattery === true && this.settings.enabled && this.settings.powerSource === 'any' &&
      this.settings.batteryFloorPercent > 0 && ['armed', 'active', 'releasing'].includes(this.state);
  }

  async readBatteryLevel() {
    if (!this.batteryFloorApplies() || typeof this.power.readBatteryPercent !== 'function') return;
    try {
      const percent = await this.power.readBatteryPercent();
      this.battery.percent = Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : null;
    } catch { this.battery.percent = null; }
    this.battery.checkedAt = new Date(this.now()).toISOString();
  }

  acquire(type) {
    if (this.hold && this.hold.type === type && this.isHeld(this.hold.id)) return;
    // Start the replacement before releasing the old blocker so there is no gap.
    const id = this.power.startBlocker(type);
    if (this.hold) this.stopBlocker(this.hold.id);
    this.hold = { id, type, since: this.hold?.since ?? this.now() };
  }

  isHeld(id) {
    try { return this.power.isBlockerStarted(id) !== false; } catch { return false; }
  }

  stopBlocker(id) {
    try { this.power.stopBlocker(id); } catch { /* Process exit still releases the assertion. */ }
  }

  release(reason) {
    if (!this.hold) return;
    this.stopBlocker(this.hold.id);
    this.lastRelease = { reason, at: new Date(this.now()).toISOString() };
    this.hold = null;
  }

  // Suppression remembers task identities from before supplementary de-duplication, so a hidden
  // running thread that reappears is not mistaken for new work, and it remembers their
  // conversations, so the agent turn a suppressed job starts is not new work either. An explicit
  // stop also covers deferred work, so clearing the session and re-partitioning never re-acquires
  // on its own; a time-limit end does not, so work that starts after the ended session gets its own session.
  // A time-limit end also caps the tasks it covered, and deferred work only counts as new once it is due.
  end(reason) {
    const known = reason === 'user-stop' ? [...this.eligible, ...this.deferred] : this.eligible;
    const at = new Date(this.now()).toISOString();
    this.suppression = { reason, at, taskIds: new Set(known.map((task) => task.id)),
      conversations: new Set(known.map((task) => task.conversation).filter(Boolean)) };
    if (reason === 'max-duration') {
      for (const task of this.eligible) this.capped.set(task.id, { state: task.state, conversation: task.conversation, dueAt: null });
      for (const task of this.deferred) this.capped.set(task.id, { state: task.state, conversation: null, dueAt: Date.parse(task.until) });
      this.cappedAt = at;
    }
    this.session = null;
    this.releaseAt = null;
    this.release(reason);
    this.state = 'ended';
  }

  clearEnded() {
    this.suppression = null;
    this.capped.clear();
    this.cappedAt = null;
    this.cappedTasks = [];
  }

  // Drops capped tasks that finished, that were waiting and have now started, or that were deferred
  // and are now due. Returns the tasks free to join a session and the deferred tasks still held back.
  splitCapped(tasks, now) {
    const reported = new Map(tasks.map((task) => [task.id, task]));
    for (const [id, entry] of this.capped) {
      const task = reported.get(id);
      const started = task && entry.state === 'waiting' && task.state !== 'waiting';
      if (started) this.suppression?.taskIds.delete(id); // New activity, not the work that was stopped.
      if (!task || started || (entry.dueAt !== null && entry.dueAt <= now)) this.capped.delete(id);
    }
    const capped = [...this.capped.values()].filter((entry) => entry.dueAt === null);
    if (!capped.length) this.cappedAt = null;
    const conversations = new Set(capped.map((entry) => entry.conversation).filter(Boolean));
    const isHeld = (task) => { const entry = this.capped.get(task.id); return Boolean(entry && entry.dueAt !== null); };
    const isCapped = (task) => (this.capped.has(task.id) && !isHeld(task)) || (task.supplementary && conversations.has(task.conversation));
    this.cappedTasks = deduplicateSupplementary(tasks.filter(isCapped));
    return { free: tasks.filter((task) => !isCapped(task) && !isHeld(task)), held: tasks.filter(isHeld) };
  }

  hasCapped() {
    return [...this.capped.values()].some((entry) => entry.dueAt === null);
  }

  evaluate() {
    if (this.disposed) return;
    let reported;
    try { reported = this.registry.tasks({ includeSupplementary: true }); } catch (error) { reported = { tasks: [], errors: [{ source: 'registry', message: String(error?.message || error) }] }; }
    const now = this.now();
    const { free, held } = this.splitCapped(reported.tasks, now);
    // Waiting work that starts after the time limit would only end the session before it begins;
    // it is deferred and starts its own session once it comes within the limit.
    const horizon = this.session?.deadline ?? now + this.settings.maxHours * HOUR;
    const later = (task) => task.state === 'waiting' && Number.isFinite(Date.parse(task.until)) && Date.parse(task.until) > horizon;
    const eligible = free.filter((task) => !later(task));
    this.eligible = eligible;
    this.tasks = deduplicateSupplementary(eligible);
    this.deferred = free.filter(later).concat(held);
    this.sourceErrors = reported.errors;
    const wasHolding = Boolean(this.hold);

    if (!this.settings.enabled) {
      this.release('disabled');
      this.clearEnded();
      Object.assign(this, { state: 'off', session: null, releaseAt: null });
      return this.publish();
    }

    if (this.tasks.length && this.suppression) {
      const { taskIds, conversations } = this.suppression;
      const newWork = this.eligible.some((task) => !taskIds.has(task.id) && !(task.supplementary && conversations.has(task.conversation)));
      const powerRestored = this.suppression.reason === 'battery-floor' && this.battery.onBattery === false;
      if (newWork || powerRestored) this.suppression = null;
      else { this.release(this.suppression.reason); this.state = 'ended'; return this.publish(); }
    }

    if (this.session && now >= this.session.deadline) {
      this.end('max-duration');
      if (wasHolding) this.safeNotify('Keep-awake stopped', `The ${this.settings.maxHours}-hour limit was reached. Your Mac can sleep now.`);
      return this.publish();
    }

    const onBattery = this.battery.onBattery === true;
    if ((this.tasks.length || this.hold) && onBattery && this.settings.powerSource === 'ac-only') {
      this.release('on-battery');
      this.releaseAt = null;
      this.state = 'paused';
      return this.publish();
    }
    if ((this.tasks.length || this.hold) && onBattery && this.settings.batteryFloorPercent > 0 && this.battery.percent !== null && this.battery.percent <= this.settings.batteryFloorPercent) {
      this.end('battery-floor');
      if (wasHolding) this.safeNotify('Keep-awake stopped', `Battery is at ${this.battery.percent}%. Connect power to keep scheduled work running.`);
      return this.publish();
    }

    if (!this.tasks.length) {
      this.suppression = null;
      if (this.hold && this.releaseGraceMs > 0) {
        // Brief grace so back-to-back work (delivery, then the agent turn starting) does not flap.
        if (this.state !== 'releasing' || this.releaseAt === null) this.releaseAt = now + this.releaseGraceMs;
        if (now < this.releaseAt) { this.state = 'releasing'; return this.publish(); }
      }
      this.release('complete');
      // Work that reached the time limit is still there, so the session stays ended rather than off.
      Object.assign(this, { state: this.hasCapped() ? 'ended' : 'off', session: null, releaseAt: null });
      return this.publish();
    }
    this.releaseAt = null;

    if (!this.session) this.session = { startedAt: now, deadline: now + this.settings.maxHours * HOUR };
    try {
      // Harnesses that drive a user interface need the display on, because display sleep can lock the screen.
      this.acquire(this.settings.keepDisplayOn || this.needsUnlockedScreen() ? DISPLAY_BLOCKER : SYSTEM_BLOCKER);
    } catch (error) {
      // acquire() only replaces the hold on success, so a blocker that is still held stays tracked and is released later.
      if (this.hold && !this.isHeld(this.hold.id)) this.hold = null;
      this.sourceErrors.push({ source: 'power', message: `Could not keep the Mac awake: ${String(error?.message || error)}` });
    }
    this.state = this.tasks.some((task) => task.state !== 'waiting') ? 'active' : 'armed';
    return this.publish();
  }

  needsUnlockedScreen() {
    return this.tasks.some((task) => task.requiresUnlockedScreen);
  }

  safeNotify(title, body) {
    try { this.notify(title, body); } catch { /* Notifications are advisory. */ }
  }

  reasonText() {
    const waiting = this.tasks.filter((task) => task.state === 'waiting').length;
    const running = this.tasks.length - waiting;
    const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    switch (this.state) {
      case 'off': return !this.settings.enabled ? 'Keep-awake is off.' : this.deferred.length ?
        `Nothing needs the Mac awake yet. ${plural(this.deferred.length, 'scheduled task')} ${this.deferred.length === 1 ? 'starts' : 'start'} after the ${this.settings.maxHours}-hour limit.` :
        'No tracked work needs the Mac awake.';
      case 'armed': return `Waiting for ${plural(waiting, 'scheduled task')}.`;
      case 'active': return `${plural(running, 'task')} running${waiting ? `, ${waiting} waiting` : ''}.`;
      case 'releasing': return 'Tracked work finished. The Mac can sleep again shortly.';
      case 'paused': return 'Paused on battery power. Connect power to keep tracked work running.';
      case 'ended': return ENDED_TEXT[this.endedInfo()?.reason] || 'Keep-awake ended for the current work.';
      default: return '';
    }
  }

  endedInfo() {
    if (this.suppression) return { reason: this.suppression.reason, at: this.suppression.at };
    return this.hasCapped() ? { reason: 'max-duration', at: this.cappedAt } : null;
  }

  snapshot() {
    return {
      enabled: this.settings.enabled,
      state: this.state,
      reason: this.reasonText(),
      holding: this.hold ? (this.hold.type === DISPLAY_BLOCKER ? 'display' : 'system') : null,
      requiresUnlockedScreen: this.needsUnlockedScreen(),
      since: this.session ? new Date(this.session.startedAt).toISOString() : null,
      deadline: this.session ? new Date(this.session.deadline).toISOString() : null,
      releaseAt: this.state === 'releasing' && this.releaseAt !== null ? new Date(this.releaseAt).toISOString() : null,
      ended: this.endedInfo(),
      tasks: this.tasks.map((task) => ({ ...task })),
      capped: this.cappedTasks.map((task) => ({ ...task })),
      deferred: this.deferred.map((task) => ({ ...task })),
      errors: this.sourceErrors.map((error) => ({ ...error })),
      power: { onBattery: this.battery.onBattery, batteryPercent: this.battery.percent },
      lastSleep: this.lastSleep,
      lastRelease: this.lastRelease,
      settings: { ...this.settings }
    };
  }

  publish() {
    const snapshot = this.snapshot();
    const serialised = JSON.stringify(snapshot);
    if (serialised === this.lastPublished) return snapshot;
    this.lastPublished = serialised;
    try { this.onChange(snapshot); } catch { /* A closed window must not affect the power state. */ }
    return snapshot;
  }
}

module.exports = {
  DEFAULT_KEEP_AWAKE, DISPLAY_BLOCKER, KeepAwakeController, STATES, SYSTEM_BLOCKER, WorkSourceRegistry,
  normaliseKeepAwake, parseBatteryStatus, validateKeepAwakeInput
};
