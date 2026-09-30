# Remote control

Agent Auto-Continue can be controlled from a phone or an AI agent through a REST API and an MCP server that run inside the desktop app.
The Mac stays the source of truth: every remote request reads or changes the same schedule the desktop window shows, using the same validation.
Remote control is off by default.

## Security model

- **Off until you turn it on.** Nothing listens until you enable remote control in Settings.
- **Loopback first.** When enabled, the app always listens on `127.0.0.1` only.
  You may add one private-network address, such as your Tailscale address; the app never binds `0.0.0.0`, `::`, link-local or public addresses.
- **Never on the public internet.** Only loopback, Tailscale (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) and private ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) are accepted, and only if the address is currently on one of the Mac's interfaces.
- **A token for every request.** Every endpoint, including MCP, requires `Authorization: Bearer <token>`.
  Tokens are 256-bit random values shown once at creation; only their SHA-256 digests are stored, and they are compared in constant time.
- **Per-device, revocable tokens.** Each token has a label, such as "Ryan's iPhone", a scope (full control or read only), a creation time and a last-used time.
  Revoking a token takes effect on the next request.
  Tokens can only be created and revoked in the desktop app, never over the network, so a leaked token cannot mint more.
- **Brute-force protection.** Ten failed authentications from one address in ten minutes lock that address out for fifteen minutes; one hundred failures from anywhere trigger a global lockout.
  Each token is also limited to 240 requests per minute.
- **Browser isolation.** Requests carrying an `Origin` header are rejected unless that origin is explicitly allowed, and no CORS headers are sent by default.
  The loopback listener only answers requests addressed to `127.0.0.1` or `localhost`, which blocks DNS rebinding.
- **Bounded requests.** Bodies are limited to 64 KiB, headers must arrive within 10 seconds and whole requests within 30 seconds, and each listener accepts at most 64 concurrent connections.
- **Visible audit trail.** Every remote change, denial, failed authentication and token or settings change is recorded and shown under Settings, Remote activity.
  Retries answered from an idempotency key are marked as repeats that changed nothing.
  Routine reads are not logged, so a polling phone cannot push older entries out of the 500-entry log.

The token travels in plain HTTP.
Over loopback and Tailscale this is protected by the operating system or by WireGuard encryption.
On an ordinary local network it is not encrypted, so the app warns when you choose such an address; prefer Tailscale.

## Turn it on

1. Open **Settings** and find **Remote control**.
2. Tick **Allow remote control**, choose **Network access**, and keep port `3799` unless it is taken.
3. Choose **Save remote settings**; the listener status shows each address and whether it is listening.
4. Under **Device tokens**, name the device, choose **Full control** or **Read only**, then **Create token**.
5. Copy the token or scan its QR code with your phone now; it is never shown again.

If the chosen private address is not available, for example because Tailscale is disconnected, the app keeps serving loopback and retries the address every 30 seconds.

## Reach it from your phone over Tailscale

1. Install [Tailscale](https://tailscale.com/download) on the Mac and on your phone, and sign both into the same tailnet.
2. In **Settings, Remote control, Network access**, choose the entry labelled `Tailscale · 100.x.y.z (utunN)`, then save.
3. On the phone, use `http://100.x.y.z:3799` or the Mac's MagicDNS name, such as `http://my-mac.tailnet-name.ts.net:3799`, as the base URL.
4. Send the token as a bearer token with every request.

Consider a Tailscale access rule that only lets your own devices reach port 3799 on the Mac.
Do not use Tailscale Funnel or any other public tunnel; the app is designed for private networks only.

When the Mac is asleep or offline, requests fail to connect and nothing changes on the Mac.
Retry `POST /v1/jobs` with the same `Idempotency-Key` once it is reachable; the Mac returns the original schedule instead of creating a duplicate.
Scheduled messages still send when the Mac wakes, as described in the [reliability model](../README.md#reliability-model).

A simple phone check:

```sh
curl -s http://100.x.y.z:3799/v1/status -H "Authorization: Bearer $AAC_TOKEN"
```

## Connect an MCP client

The MCP endpoint is `http://127.0.0.1:3799/mcp` on the Mac, or the Tailscale address from another device.
It uses the Streamable HTTP transport and serves both the stateless 2026-07-28 protocol and 2025-era clients that use the `initialize` handshake.
It is stateless: there are no sessions, and standalone `GET` streams are answered with `405`.

Claude Code:

```sh
claude mcp add --transport http auto-continue http://127.0.0.1:3799/mcp --header "Authorization: Bearer aac_..."
```

Other clients that support remote HTTP servers take the same URL and an `Authorization` header.
Clients that only launch stdio servers can use the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge:

```json
{
  "mcpServers": {
    "auto-continue": {
      "command": "npx",
      "args": ["mcp-remote", "http://127.0.0.1:3799/mcp", "--header", "Authorization:${AAC_AUTH}"],
      "env": { "AAC_AUTH": "Bearer aac_..." }
    }
  }
}
```

Hosted connectors, such as those configured on a vendor's website and used from its mobile app, connect from the vendor's servers.
They cannot reach a Tailscale address, and the app deliberately refuses public exposure, so use an MCP client that runs on a device inside your tailnet.

A read-only token only sees the read tools.

| Tool | Operation | Changes data |
| --- | --- | --- |
| `get_status` | Mac, storage and harness reachability, queue counts, capabilities and optional keep-awake status | No |
| `list_harnesses` | Harnesses and their capabilities | No |
| `check_connection` | Live connection check for one harness | No |
| `get_availability` | Usage-limit state and reset time, when the harness reports it | No |
| `list_threads` | Threads (conversations), filterable by harness, project, text and settled state | No |
| `list_projects` | Projects derived from a harness's threads | No |
| `list_jobs` | Schedules and history, filterable by view and status | No |
| `get_job` | One schedule with delivery details | No |
| `schedule_message` | Schedule a message, `Continue` by default | Yes |
| `edit_job` | Change the message or time of a pending schedule | Yes |
| `cancel_job` | Cancel a pending schedule | Yes |
| `acknowledge_job` | Clear the attention badge of a failed or unconfirmed delivery | Yes |
| `reconcile_job` | Check an unconfirmed delivery without resending | Yes |
| `list_runs`, `stop_run` | Continuous runs, when the app provides them | `stop_run` only |

Tool errors are returned as results with `isError: true`, text such as `validation_failed: The scheduled time must be in the future.` and `structuredContent.error`.

## REST API

Base URL: `http://<address>:<port>/v1`.
Every request needs `Authorization: Bearer <token>`.
Request bodies are JSON objects with `Content-Type: application/json`; unknown fields are rejected.
Responses are JSON with `Cache-Control: no-store`.

### Resources

| Method and path | Scope | Input | Success |
| --- | --- | --- | --- |
| `GET /v1/status` | read | none | `200` status object |
| `GET /v1/harnesses` | read | none | `200 { harnesses, defaultHarness }` |
| `GET /v1/harnesses/{harness}/connection` | read | none | `200 { harness, online, error? }` |
| `GET /v1/harnesses/{harness}/availability` | read | none | `200 { harness, availability }` |
| `GET /v1/threads` | read | query `harness`, `projectId`, `query`, `showSettled`, `limit` | `200 { threads, total }` |
| `GET /v1/projects` | read | query `harness` | `200 { projects }` |
| `GET /v1/jobs` | read | query `view` (`all`, `upcoming`, `history`), `status`, `offset`, `limit` | `200 { jobs, total, unacknowledgedFailures }` |
| `POST /v1/jobs` | control | `threadId`, optional `message`, `whenISO` or `delayMinutes`, `timeZone`, `harness`, `idempotencyKey`; or an `Idempotency-Key` header | `201 { job, replayed: false }`, or `200 { job, replayed: true }` with `Idempotent-Replayed: true` |
| `GET /v1/jobs/{id}` | read | none | `200 { job }` |
| `PATCH /v1/jobs/{id}` | control | any of `message`, `whenISO`, `delayMinutes`, `timeZone` | `200 { job }` |
| `POST /v1/jobs/{id}/cancel` | control | none | `200 { job }` |
| `POST /v1/jobs/{id}/acknowledge` | control | none | `200 { job }` |
| `POST /v1/jobs/{id}/reconcile` | control | none | `200 { job }` |
| `GET /v1/runs` | read | none | `200 { runs }`, or `501` when continuous runs are unavailable |
| `POST /v1/runs/{id}/stop` | control | none | `200 { run }`, or `501` |

`whenISO` must include an explicit offset, such as `2026-10-01T09:00:00+01:00`; use either `whenISO` or `delayMinutes`, not both.
Omitted `PATCH` fields keep their saved values.
The same rules as the desktop composer apply: future times only, real calendar dates, 1 to 4,000 characters and a valid IANA timezone.
A job's `deliveryStatus` is `pending`, `dispatching`, `sent`, `failed`, `canceled` or `unconfirmed`; `sent` means the harness accepted the message, not that the agent finished.

Idempotency keys are 1 to 128 characters from `A-Z a-z 0-9 . _ : -`, scoped to the token, and remembered for 24 hours across restarts.
Reusing a key with a different request returns `409 idempotency_conflict`.

### Errors

Errors use one shape:

```json
{ "error": { "code": "validation_failed", "message": "The scheduled time must be in the future." } }
```

| Status | Codes |
| --- | --- |
| `400` | `validation_failed`, `invalid_json`, `invalid_idempotency_key`, `unknown_harness` |
| `401` | `unauthorized`, with `WWW-Authenticate: Bearer realm="agent-auto-continue"` |
| `403` | `insufficient_scope`, `origin_not_allowed`, `host_not_allowed` |
| `404` | `not_found`, `job_not_found`, `thread_not_found` |
| `405` | `method_not_allowed`, with an `Allow` header |
| `409` | `invalid_state`, `idempotency_conflict` |
| `413` | `payload_too_large` |
| `415` | `unsupported_media_type` |
| `429` | `too_many_failures`, `rate_limited`, with `Retry-After` |
| `501` | `not_supported` |
| `502` | `harness_unavailable`, with sanitized `details.upstream` |
| `503` | `storage_unavailable` |

### Examples

```sh
BASE=http://127.0.0.1:3799/v1
AUTH="Authorization: Bearer $AAC_TOKEN"

curl -s "$BASE/threads?query=parser" -H "$AUTH"

curl -s -X POST "$BASE/jobs" -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: phone-2026-10-01-0900' \
  -d '{"threadId":"thread-id","delayMinutes":30}'

curl -s -X PATCH "$BASE/jobs/JOB_ID" -H "$AUTH" -H 'Content-Type: application/json' -d '{"message":"Keep going"}'

curl -s -X POST "$BASE/jobs/JOB_ID/cancel" -H "$AUTH"
```

### Status object

```json
{
  "desktop": { "app": "T3 Code Auto-Continue", "version": "2.0.0", "time": "2026-10-01T08:00:00.000Z", "timeZone": "Europe/London" },
  "storage": { "ok": true },
  "defaultHarness": "t3",
  "harnesses": [{ "id": "t3", "label": "T3 Code", "conversationNoun": "thread", "online": true }],
  "jobs": { "upcoming": 2, "unacknowledgedFailures": 0 },
  "capabilities": { "keepAwake": false, "continuousRuns": false },
  "keepAwake": null,
  "caller": { "label": "Ryan's iPhone", "scope": "control" }
}
```

## Browser clients

A web app that calls the API from a browser needs its exact origin, such as `https://phone.example`, under **Settings, Remote control, Browser access**.
The list is empty by default, wildcards and paths are refused, and requests or preflights from any other origin are rejected with `403`.

## Integration points

The remote layer lives in `lib/remote/` and reaches the rest of the app through `main.js` only.

| Dependency | Contract |
| --- | --- |
| `getService()` | The shared `JobService`; all validation and state rules come from it |
| `harnesses` | A registry with `defaultHarness`, `describe()`, `has(id)` and `get(id)`, whose adapters provide `checkConnection()`, `listConversations({ showSettled })` and optionally `probeAvailability()`; `lib/remote/harnesses.js` provides the T3-only stand-in and the multi-harness registry can replace it directly |
| `keepAwake` | Optional `{ status() }`, reported read-only in `get_status` |
| `automation` | Optional `{ listRuns(), stopRun(id) }` for continuous runs; without it the run resources answer `501` and the MCP run tools are hidden |

Settings, token digests, the audit log and idempotency keys are stored in `remote-control.json` beside `config.json`, with owner-only permissions.
An unreadable file disables remote control and is never overwritten.

## Dependencies

| Package | Why |
| --- | --- |
| `@modelcontextprotocol/server` | The official MCP server SDK; it tracks the protocol, including the 2026-07-28 stateless revision and 2025-era compatibility, so the app does not maintain its own implementation |
| `zod` | Required by the MCP SDK; also describes the tool and request shapes once for both transports |
| `qrcode-generator` | A dependency-free, MIT-licensed QR encoder for the one-time token display |

The official MCP clients (`@modelcontextprotocol/client` and `@modelcontextprotocol/sdk`) are development dependencies used by the end-to-end tests.
