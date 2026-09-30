'use strict';

// Claude Code CLI sessions through the documented headless mode:
//   claude -p --resume <session> --input-format stream-json --output-format stream-json
//          --verbose --replay-user-messages [--permission-mode <mode>]
// The prompt travels on stdin as a stream-json user message whose `uuid` is the
// job's stable message ID. Claude Code records that uuid in the transcript and
// replays it on stdout, which is the delivery acknowledgement. Verified with 2.1.286.
// Sessions created by Claude Desktop belong to the Claude Desktop harness.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { conversation, conversationState, defineHarness } = require('./contract');
const { HarnessError, redact } = require('./errors');
const { childEnv, findExecutable, firstLine, runProcess, spawnJsonLines } = require('./process');
const sessions = require('./claude-sessions');
const { matchUsageLimit, parseResetTime } = require('./usage-limits');

// Values accepted by --permission-mode. Transcripts record "default" for the CLI's manual mode.
const PERMISSION_MODES = new Map([['acceptEdits', 'acceptEdits'], ['auto', 'auto'], ['bypassPermissions', 'bypassPermissions'], ['default', 'manual'], ['manual', 'manual'], ['dontAsk', 'dontAsk'], ['plan', 'plan']]);
const LIMIT_WINDOW_MS = 5 * 3_600_000;
const PLAN_SAMPLE_MAX_AGE_MS = 20 * 60_000;

function createClaudeCodeHarness({ getSettings = () => ({}), env = process.env, home = os.homedir(), now = () => Date.now(), ackTimeoutMs = 120_000, maxTurnMs = 12 * 3_600_000, isAlive } = {}) {
  const runs = new Map();
  const options = { home, env, isAlive };

  function executable() {
    const override = getSettings('claude-code')?.executable || '';
    const file = findExecutable('claude', { home, env, override });
    if (!file) throw new HarnessError('harness_not_installed', override ? 'The Claude Code executable in Settings was not found or is not executable.' : 'Claude Code was not found. Install it, or set its executable path in Settings.');
    return file;
  }
  async function live() {
    const open = await sessions.readLiveSessions(options);
    // Processes this app started are not "open elsewhere".
    for (const run of runs.values()) for (const [id, session] of open) if (run.pid && session.pid === run.pid) open.delete(id);
    return open;
  }
  const activeRun = (sessionId) => [...runs.values()].find((run) => run.sessionId === sessionId && !run.outcome);
  async function transcript(id) {
    const file = await sessions.findTranscriptPath(id, options);
    if (!file) throw new HarnessError('conversation_not_found', 'Claude Code could not find that session on this Mac.');
    return file;
  }

  // Interprets the stream-json events of a finished headless run.
  function outcomeFromRun(run, exit) {
    const result = run.result;
    const at = new Date(now()).toISOString();
    if (result && result.is_error !== true) return { state: 'completed', completedAt: at };
    if (run.interrupted) return { state: 'interrupted', completedAt: at };
    const text = typeof result?.result === 'string' ? result.result : '';
    if (result) {
      const limit = run.limitSeen || matchUsageLimit(text, now()) ? { message: redact(text || 'Usage limit reached').slice(0, 240), resetsAt: parseResetTime(text, now()) } : null;
      return { state: 'failed', completedAt: at, error: { code: limit ? 'usage_limited' : 'agent_error', message: redact(text || 'Claude Code reported an error.').slice(0, 240) }, usageLimit: limit };
    }
    if (exit.signal === 'SIGINT' || exit.code === 130) return { state: 'interrupted', completedAt: at };
    return { state: 'failed', completedAt: at, error: { code: 'process_failed', message: 'Claude Code stopped before finishing the turn.' } };
  }

  function failure(run, exit) {
    const text = typeof run.result?.result === 'string' ? run.result.result : firstLine(run.handle.stderr);
    const clean = redact(text).slice(0, 240);
    if (exit.error?.code === 'ENOENT') return new HarnessError('harness_not_installed', 'Claude Code could not be started. Check its installation or the executable path in Settings.');
    if (matchUsageLimit(text, now())) return new HarnessError('usage_limited', clean || 'Claude Code reported a usage limit.', { resetsAt: parseResetTime(text, now()) });
    if (/not (?:logged|signed) in|log ?in|authenticat|api key/i.test(text)) return new HarnessError('missing_credentials', 'Claude Code is not signed in. Run “claude auth login” in Terminal.', { hint: clean });
    if (/no conversation found|session .*not found/i.test(text)) return new HarnessError('conversation_not_found', 'Claude Code could not find that session.', { hint: clean });
    return new HarnessError('process_failed', 'Claude Code exited before accepting the message.', { exitCode: exit.code, signal: exit.signal, hint: clean });
  }

  return defineHarness({
    id: 'claude-code', label: 'Claude Code', kind: 'cli', conversationNoun: 'session',
    description: 'Resumes Claude Code CLI sessions with claude -p --resume. Works while the screen is locked.',
    capabilities: {
      canDiscoverConversations: true, canConfirmDelivery: true, canDetectUserActivity: true,
      canDetectCompletion: true, canDetectUsageLimit: true, canReportResetTime: true,
      requiresRunningApp: false, requiresUnlockedScreen: false, requiresAccessibilityPermission: false
    },
    settings: [{ key: 'executable', type: 'text', label: 'Claude Code executable', help: 'Optional absolute path. Leave blank to find claude automatically.' }],
    async checkConnection() {
      const file = executable();
      const result = await runProcess(file, ['auth', 'status', '--json'], { cwd: home, env: childEnv(env, { executable: file, home }), timeoutMs: 20_000 });
      if (result.error) throw new HarnessError('harness_not_installed', 'Claude Code could not be started. Check its installation.');
      if (result.timedOut) throw new HarnessError('timeout', 'Claude Code did not respond in time.');
      let status;
      try { status = JSON.parse(result.stdout); } catch { throw new HarnessError('unexpected_response_format', 'Claude Code returned an unexpected sign-in status. Check that it is up to date.', { hint: redact(firstLine(result.stderr)) }); }
      if (status?.loggedIn !== true) throw new HarnessError('missing_credentials', 'Claude Code is not signed in. Run “claude auth login” in Terminal.');
      return { ok: true };
    },
    async listConversations() {
      const [entries, open, desktop] = await Promise.all([sessions.listTranscripts(options), live(), sessions.desktopOwnedCliSessionIds(options)]);
      const summaries = await Promise.all(entries.filter((entry) => !desktop.has(entry.id)).map((entry) => sessions.summariseTranscript(entry).catch(() => null)));
      return summaries.filter((item) => item?.conversational).map((item) => {
        const running = open.get(item.id);
        return conversation('claude-code', {
          id: item.id, title: item.title || running?.name || 'Untitled session', projectId: item.cwd, projectName: item.cwd ? path.basename(item.cwd) : '',
          updatedAt: item.updatedAt, settled: false,
          state: activeRun(item.id) ? 'working' : running ? (['waiting', 'blocked'].includes(running.status) ? 'waiting' : running.status === 'busy' ? 'working' : 'open') : 'idle'
        });
      }).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id));
    },
    async inspectConversation(ref) {
      const file = await transcript(ref.conversationId);
      const [scan, open, desktop] = await Promise.all([sessions.scanTranscript(file, ref.deliveryKey), live(), sessions.desktopOwnedCliSessionIds(options)]);
      const id = ref.conversationId.toLowerCase();
      const running = open.get(id) || null;
      return conversationState({
        id: ref.conversationId, title: scan.title || running?.name || 'Untitled session', projectId: scan.cwd, projectName: scan.cwd ? path.basename(scan.cwd) : '',
        archived: false, latestUserActivityAt: scan.latestUserActivityAt, delivered: scan.delivered,
        busy: Boolean(activeRun(ref.conversationId)) || (running ? running.status === 'busy' : false),
        awaitingInput: running ? ['waiting', 'blocked'].includes(running.status) : null,
        context: { cwd: scan.cwd, permissionMode: scan.permissionMode, open: running, desktopOwned: desktop.has(id) }
      });
    },
    prepareTurn(turn, state) {
      const { cwd, permissionMode, open, desktopOwned } = state.context || {};
      if (desktopOwned) throw new HarnessError('owned_by_other_harness', 'This session belongs to Claude Desktop. Schedule it with the Claude Desktop harness instead.', { harness: 'claude-desktop' });
      if (open) throw new HarnessError('conversation_busy', `This session is open in another Claude process (pid ${open.pid}). Exit that session so the scheduled turn can resume it.`, { pid: open.pid, entrypoint: open.entrypoint });
      if (activeRun(turn.conversationId)) throw new HarnessError('conversation_busy', 'A scheduled turn is already running in this session.');
      let directory = false;
      try { directory = Boolean(cwd) && fs.statSync(cwd).isDirectory(); } catch { directory = false; }
      if (!directory) throw new HarnessError('conversation_not_found', 'The project folder for this Claude Code session no longer exists.', { cwd: cwd ? path.basename(cwd) : '' });
      const file = executable();
      const mode = PERMISSION_MODES.get(permissionMode);
      const args = ['-p', '--resume', turn.conversationId, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', ...(mode ? ['--permission-mode', mode] : [])];
      const input = { type: 'user', uuid: turn.messageId, session_id: turn.conversationId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: turn.message }] } };
      return { deliveryKey: turn.messageId, plan: { file, args, cwd, input } };
    },
    async submitTurn(turn, plan) {
      const run = { sessionId: turn.conversationId, deliveryKey: turn.deliveryKey, result: null, limitSeen: false, acknowledged: false, interrupted: false, outcome: null, pid: null };
      let acknowledge;
      const acknowledged = new Promise((resolve) => { acknowledge = resolve; });
      run.handle = spawnJsonLines(plan.file, plan.args, {
        cwd: plan.cwd, env: childEnv(env, { executable: plan.file, home }),
        onMessage(message) {
          if (message.type === 'user' && message.uuid === turn.deliveryKey) { run.acknowledged = true; acknowledge(); }
          else if (message.type === 'assistant' && message.error === 'rate_limit') run.limitSeen = true;
          else if (message.type === 'result') run.result = message;
        }
      });
      run.pid = run.handle.child.pid || null;
      runs.set(turn.deliveryKey, run);
      run.handle.write(plan.input);
      run.handle.end();
      const deadline = setTimeout(() => { run.interrupted = true; run.handle.interrupt(); setTimeout(() => run.handle.terminate(), 10_000).unref?.(); }, maxTurnMs);
      deadline.unref?.();
      run.completion = run.handle.exited.then((exit) => {
        clearTimeout(deadline);
        run.outcome = outcomeFromRun(run, exit);
        return run.outcome;
      });
      const inTranscript = async () => (await sessions.scanTranscript(await transcript(turn.conversationId), turn.deliveryKey)).delivered;
      let timer;
      const first = await Promise.race([
        acknowledged.then(() => 'ack'), run.handle.exited.then(() => 'exit'),
        new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ackTimeoutMs); timer.unref?.(); })
      ]);
      clearTimeout(timer);
      if (first === 'ack') return { turnId: null, completion: run.completion };
      if (first === 'timeout') {
        // Startup can be slow; the transcript is the authority before giving up.
        if (await inTranscript().catch(() => false)) return { turnId: null, completion: run.completion };
        run.handle.terminate();
      }
      const exit = await run.handle.exited;
      await run.completion;
      let delivered;
      try { delivered = run.acknowledged || await inTranscript(); } catch {
        runs.delete(turn.deliveryKey);
        throw new HarnessError('process_failed', 'Claude Code stopped and the session could not be read to confirm delivery.', {}, true);
      }
      if (delivered) return { turnId: null, completion: run.completion };
      runs.delete(turn.deliveryKey);
      if (first === 'timeout') throw new HarnessError('timeout', 'Claude Code did not accept the message in time. Nothing was sent.');
      throw failure(run, exit);
    },
    async findDelivery(turn) {
      const file = await sessions.findTranscriptPath(turn.conversationId, options);
      if (!file) return { delivered: false };
      return { delivered: (await sessions.scanTranscript(file, turn.deliveryKey)).delivered };
    },
    async checkTurn(turn) {
      const run = runs.get(turn.deliveryKey);
      if (run) return run.outcome || { state: 'running' };
      const file = await sessions.findTranscriptPath(turn.conversationId, options);
      if (!file) return { state: 'unknown' };
      const open = await live();
      return sessions.turnOutcomeAfter(file, turn.deliveryKey, { running: open.has(turn.conversationId.toLowerCase()), now: now() });
    },
    async probeAvailability() {
      const checkedAt = new Date(now()).toISOString();
      const [plan, { limit, lastSuccessAt }] = await Promise.all([sessions.readClaudePlanUsage(options), sessions.recentLimitSignal(options)]);
      const limitResetsAt = limit ? parseResetTime(limit.text, Date.parse(limit.at) || now()) : null;
      // Claude Desktop samples account-wide plan usage about every 15 minutes.
      if (plan && now() - Date.parse(plan.sampledAt) <= PLAN_SAMPLE_MAX_AGE_MS) {
        if (plan.fiveHourPct >= 100 || plan.sevenDayPct >= 100) {
          const resetsAt = limitResetsAt && Date.parse(limitResetsAt) > now() ? limitResetsAt : null;
          return { state: 'limited', resetsAt, reason: `Claude plan usage is at ${Math.max(plan.fiveHourPct, plan.sevenDayPct)}% (${plan.sevenDayPct >= 100 ? 'weekly' : 'five-hour'} limit).`, source: 'inferred', checkedAt };
        }
        return { state: 'available', reason: `Claude plan usage is at ${plan.fiveHourPct}% of the five-hour limit.`, source: 'inferred', checkedAt };
      }
      if (!limit) return { state: 'unknown', reason: 'No recent usage-limit message in Claude Code sessions.', source: 'none', checkedAt };
      if (lastSuccessAt && lastSuccessAt > limit.at) return { state: 'available', reason: 'Claude Code replied normally after the last usage-limit message.', source: 'inferred', checkedAt };
      if (limitResetsAt && Date.parse(limitResetsAt) <= now()) return { state: 'available', resetsAt: limitResetsAt, reason: 'The last usage limit has reset.', source: 'inferred', checkedAt };
      if (!limitResetsAt && Date.parse(limit.at) < now() - LIMIT_WINDOW_MS) return { state: 'unknown', reason: 'The last usage-limit message is too old to rely on.', source: 'none', checkedAt };
      return { state: 'limited', resetsAt: limitResetsAt, reason: redact(limit.text.replace(/\s+/g, ' ')).slice(0, 240) || 'Usage limit reached', source: 'inferred', checkedAt };
    },
    async shutdown() {
      const active = [...runs.values()].filter((run) => !run.outcome);
      for (const run of active) { run.interrupted = true; run.handle.interrupt(); }
      await Promise.race([Promise.all(active.map((run) => run.handle.exited)), new Promise((resolve) => setTimeout(resolve, 5000).unref?.())]);
      for (const run of active) run.handle.terminate(1000);
    }
  });
}

module.exports = { PERMISSION_MODES, createClaudeCodeHarness };
