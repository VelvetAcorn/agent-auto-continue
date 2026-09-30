'use strict';
// Settings section for remote control: listener settings, device tokens and the audit log.
// app.js owns rendering and calls bind() after every render; this module then places its
// section before the appearance card and wires its own controls, keeping app.js changes small.
(() => {
  const ACTIONS = {
    createJob: 'Scheduled a message', editJob: 'Edited a schedule', cancelJob: 'Canceled a schedule',
    acknowledgeJob: 'Acknowledged a delivery', reconcileJob: 'Checked a delivery', stopRun: 'Stopped a continuous run',
    authenticate: 'Rejected a sign-in', reject_request: 'Blocked a request', token_created: 'Created a device token', token_revoked: 'Revoked a device token',
    settings_changed: 'Changed remote settings'
  };
  const OUTCOMES = { ok: ['sent', 'Done'], replayed: ['canceled', 'Repeat, no change'], error: ['failed', 'Failed'], denied: ['unconfirmed', 'Denied'] };
  const local = { state: null, draft: null, tokenDraft: { label: '', scope: 'control' }, reveal: null, confirmRevoke: null };

  function draft() {
    if (!local.draft && local.state) local.draft = { enabled: local.state.enabled, port: local.state.port, bindAddress: local.state.bindAddress || '', origins: local.state.allowedOrigins.join('\n') };
    return local.draft;
  }

  function listenerSummary(ctx) {
    const { escape } = ctx;
    const state = local.state;
    if (!state.enabled) return '<p class="help">Remote control is off. Nothing is listening.</p>';
    // Show the network address when there is one, because that is what a phone needs.
    const primary = state.listeners.find((listener) => listener.listening && listener.address !== '127.0.0.1') || state.listeners.find((listener) => listener.listening);
    const rows = state.listeners.map((listener) => `<li><span class="pill ${listener.listening ? 'sent' : 'failed'}">${listener.listening ? 'Listening' : 'Not listening'}</span><code>${escape(listener.url)}</code>${listener.error ? `<small class="error">${escape(listener.error)}${listener.errorCode === 'EADDRNOTAVAIL' ? ' Retrying every 30 seconds.' : ''}</small>` : ''}</li>`).join('');
    return `<ul class="remote-listeners" aria-label="Listening addresses">${rows}</ul>${primary ? `<dl class="key-values remote-endpoints"><dt>REST API</dt><dd><code>${escape(primary.apiUrl)}</code></dd><dt>MCP server</dt><dd><code>${escape(primary.mcpUrl)}</code></dd></dl>` : ''}`;
  }

  function reveal(ctx) {
    if (!local.reveal) return '';
    const { escape } = ctx;
    const qr = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(local.reveal.qrDataUrl) ? local.reveal.qrDataUrl : '';
    return `<div class="token-reveal" role="status"><div class="token-qr">${qr ? `<img src="${qr}" alt="QR code of the new device token" width="164" height="164">` : ''}</div><div><h3>Copy this token now</h3><p>It is shown only once and cannot be recovered. Scan the code with your phone’s camera, or copy it into your client as a bearer token.</p><code id="remote-new-token" class="token-value" tabindex="0">${escape(local.reveal.token)}</code><div class="actions"><button type="button" class="primary" data-action="remote-copy">Copy token</button><button type="button" class="ghost" data-action="remote-dismiss">I’ve saved it</button></div></div></div>`;
  }

  function tokenRows(ctx) {
    const { escape, display } = ctx;
    const tokens = local.state.tokens;
    if (!tokens.length) return '<div class="empty"><p>No devices yet. Create a token for each phone or agent you want to connect.</p></div>';
    return tokens.map((token) => `<div class="row remote-token"><div class="row-top"><span class="row-title">${escape(token.label)}</span><span class="pill">${token.scope === 'read' ? 'Read only' : 'Full control'}</span></div><div class="meta"><span>Created ${escape(display(token.createdAt))} · <code>aac_${escape(token.hint)}…</code></span><span>${token.lastUsedAt ? `Last used ${escape(display(token.lastUsedAt))}` : 'Never used'}</span></div>${local.confirmRevoke === token.id ? `<div class="confirm" role="group" aria-label="Confirm revocation"><p>Revoke ${escape(token.label)}? It stops working immediately.</p><button type="button" class="danger" data-action="remote-revoke-confirm" data-token="${escape(token.id)}">Revoke token</button> <button type="button" class="ghost" data-action="remote-revoke-keep">Keep</button></div>` : `<div class="actions"><button type="button" class="danger" data-action="remote-revoke" data-token="${escape(token.id)}">Revoke</button></div>`}</div>`).join('');
  }

  function auditRows(ctx) {
    const { escape, display } = ctx;
    const entries = local.state.audit.slice(0, 20);
    if (!entries.length) return '<div class="empty"><p>Remote actions will appear here.</p></div>';
    return entries.map((entry) => {
      const [tone, label] = OUTCOMES[entry.outcome] || ['', entry.outcome];
      const desktop = entry.transport === 'desktop';
      const scope = { control: 'Full control', read: 'Read only' }[entry.target];
      const parts = desktop ? ['This Mac', entry.tokenLabel, scope || entry.target] :
        [entry.tokenLabel || entry.remoteAddress || 'Unknown device', { mcp: 'MCP', http: 'API', loopback: 'This Mac', network: 'Network' }[entry.transport], entry.target];
      return `<div class="row remote-audit"><div class="row-top"><span class="row-title">${escape(ACTIONS[entry.action] || entry.action)}</span><span class="pill ${tone}">${escape(label)}</span></div><div class="meta"><span>${parts.filter(Boolean).map(escape).join(' · ')}</span><span>${escape(display(entry.at))}</span></div>${entry.error ? `<p class="help">${escape(entry.error)}</p>` : ''}</div>`;
    }).join('');
  }

  function render(ctx) {
    const { escape } = ctx;
    if (!local.state) return '<section class="card"><span class="overline">Remote control</span><p>Loading remote control…</p></section>';
    const state = local.state;
    if (state.loadError) return `<section class="card"><span class="overline">Remote control</span><h2>Control from your phone</h2><div class="notice" role="alert"><div><strong>Remote control settings need attention</strong><p>${escape(state.loadError)}</p></div></div></section>`;
    const d = draft();
    const selected = state.interfaces.find((item) => item.address === d.bindAddress);
    const options = [`<option value="" ${d.bindAddress ? '' : 'selected'}>This Mac only · 127.0.0.1</option>`, ...state.interfaces.map((item) => `<option value="${escape(item.address)}" ${item.address === d.bindAddress ? 'selected' : ''}>${escape(item.label)}</option>`)].join('');
    return `<section class="card" aria-labelledby="remote-title"><span class="overline">Remote control</span><h2 id="remote-title">Control from your phone</h2><p class="help">A token-protected REST API and MCP server for your phone or an AI agent. Off by default, never on the public internet.</p><form id="remote-form"><div class="setting-row"><label for="remote-enabled">Allow remote control</label><input id="remote-enabled" type="checkbox" ${d.enabled ? 'checked' : ''}></div><div class="two"><label class="field">Network access<select id="remote-bind">${options}</select></label><label class="field">Port<input id="remote-port" type="number" min="1024" max="65535" required value="${escape(d.port)}"></label></div><p class="help">${selected?.kind === 'private' ? '<strong class="warning">Local network traffic is not encrypted.</strong> Prefer Tailscale, which encrypts every connection.' : selected?.kind === 'tailscale' ? 'Reachable from your other Tailscale devices, and always from this Mac.' : state.interfaces.length ? 'Only apps on this Mac can connect. Choose Tailscale to reach it from your phone.' : 'Only apps on this Mac can connect. Install Tailscale to reach it from your phone.'}</p><details class="remote-advanced" ${d.origins ? 'open' : ''}><summary>Browser access</summary><label class="field">Allowed browser origins<textarea id="remote-origins" rows="2" spellcheck="false" placeholder="https://phone.example">${escape(d.origins)}</textarea><small>One origin per line. Leave empty unless a web app must call the API from a browser. Requests from any other website are refused.</small></label></details><p class="error" id="remote-error" role="alert"></p><div class="actions"><button type="submit" class="primary">Save remote settings</button></div></form>${listenerSummary(ctx)}</section><section class="card" aria-labelledby="remote-devices-title"><span class="overline">Devices</span><h2 id="remote-devices-title">Device tokens</h2>${reveal(ctx)}<form id="remote-token-form"><div class="two"><label class="field">Device name<input id="remote-token-label" maxlength="60" autocomplete="off" placeholder="Ryan’s iPhone" value="${escape(local.tokenDraft.label)}"></label><label class="field">Access<select id="remote-token-scope"><option value="control" ${local.tokenDraft.scope === 'control' ? 'selected' : ''}>Full control</option><option value="read" ${local.tokenDraft.scope === 'read' ? 'selected' : ''}>Read only</option></select></label></div><p class="error" id="remote-token-error" role="alert"></p><div class="actions"><button type="submit">Create token</button></div></form><div class="remote-list">${tokenRows(ctx)}</div></section><section class="card" aria-labelledby="remote-activity-title"><span class="overline">Activity</span><div class="remote-heading"><h2 id="remote-activity-title">Remote activity</h2>${state.audit.length ? '<button type="button" class="ghost" data-action="remote-clear-audit">Clear</button>' : ''}</div><div class="remote-list">${auditRows(ctx)}</div></section>`;
  }

  async function load(ctx) {
    try { local.state = await ctx.api.getRemote(); } catch (error) { local.state = { loadError: ctx.errorMessage(error) }; }
    if (ctx.isVisible()) ctx.render();
  }

  function bind(ctx) {
    const { $, api, perform, toast } = ctx;
    const settings = document.querySelector('.settings');
    if (!ctx.isVisible() || !settings || document.getElementById('remote-section')) return;
    const anchor = document.getElementById('theme')?.closest('.card');
    const markup = `<div id="remote-section" class="remote-section">${render(ctx)}</div>`;
    if (anchor) anchor.insertAdjacentHTML('beforebegin', markup); else settings.insertAdjacentHTML('beforeend', markup);
    document.querySelectorAll('#remote-section [data-action^="remote-"]').forEach((button) => { button.onclick = () => action(ctx, button.dataset.action, button); });
    const form = $('#remote-form');
    if (!form) return;
    $('#remote-enabled').onchange = (event) => { draft().enabled = event.target.checked; };
    $('#remote-bind').onchange = (event) => { draft().bindAddress = event.target.value; ctx.render('#remote-bind'); };
    $('#remote-port').oninput = (event) => { draft().port = event.target.value; };
    $('#remote-origins').oninput = (event) => { draft().origins = event.target.value; };
    form.onsubmit = (event) => {
      event.preventDefault();
      const d = draft();
      void perform(() => api.configureRemote({ enabled: d.enabled, port: Number(d.port), bindAddress: d.bindAddress || null, allowedOrigins: d.origins.split(/\s+/).filter(Boolean) }), {
        errorTarget: '#remote-error',
        success: (state) => { local.state = state; local.draft = null; toast(state.enabled ? (state.running ? 'Remote control is on.' : 'Remote control could not start. See the listener status.') : 'Remote control is off.'); }
      });
    };
    $('#remote-token-label').oninput = (event) => { local.tokenDraft.label = event.target.value; };
    $('#remote-token-scope').onchange = (event) => { local.tokenDraft.scope = event.target.value; };
    $('#remote-token-form').onsubmit = (event) => {
      event.preventDefault();
      void perform(() => api.createRemoteToken({ label: local.tokenDraft.label, scope: local.tokenDraft.scope }), {
        errorTarget: '#remote-token-error',
        success: (created) => { local.reveal = { token: created.token, qrDataUrl: created.qrDataUrl }; local.state = created.state; local.tokenDraft = { label: '', scope: 'control' }; }
      });
    };
  }

  function action(ctx, name, button) {
    const { api, perform, toast } = ctx;
    if (name === 'remote-copy') {
      const token = local.reveal?.token;
      if (!token) return;
      navigator.clipboard.writeText(token).then(() => toast('Token copied.'), () => {
        const range = document.createRange(); range.selectNodeContents(document.getElementById('remote-new-token'));
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        toast('Press Command-C to copy the selected token.');
      });
      return;
    }
    if (name === 'remote-dismiss') { local.reveal = null; ctx.render('#remote-token-label'); return; }
    if (name === 'remote-revoke') { local.confirmRevoke = button.dataset.token; ctx.render('[data-action="remote-revoke-confirm"]'); return; }
    if (name === 'remote-revoke-keep') { local.confirmRevoke = null; ctx.render(); return; }
    if (name === 'remote-revoke-confirm') {
      const id = button.dataset.token;
      void perform(() => api.revokeRemoteToken(id), { success: (state) => { local.state = state; local.confirmRevoke = null; toast('Token revoked. It no longer works.'); } });
      return;
    }
    if (name === 'remote-clear-audit') {
      void perform(() => api.clearRemoteAudit(), { success: (state) => { local.state = state; toast('Remote activity cleared.'); } });
    }
  }

  // The plaintext token must not outlive the Settings visit.
  function leave() { local.reveal = null; local.confirmRevoke = null; local.draft = null; }

  window.RemoteSettings = { bind, load, leave };
})();
