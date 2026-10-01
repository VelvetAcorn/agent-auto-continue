# Security policy

Agent Auto-Continue stores an agent bearer token on disk and sends messages into coding agent sessions on your behalf.
Reports about how that could be abused are welcome and taken seriously.

## Supported versions

Only the latest release on the [releases page](https://github.com/VelvetAcorn/agent-auto-continue/releases) receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**.
That creates a private advisory that only the maintainer can see.

Include what you can of the following:

- The version of the app and of macOS.
- Which agent harness was connected.
- Steps to reproduce, or a proof of concept.
- What an attacker could gain.

You should hear back within seven days.
Once a fix is available, the advisory is published with credit to the reporter unless you ask otherwise.

## What is in scope

- Anything that lets another local user or process read the stored token.
- Anything that lets a web page, a thread, or a message sent through the app reach the Electron main process or escape the renderer sandbox.
- Anything that makes the app send a message that the user did not schedule, or send it to a different thread.
- Anything that lets the app be pointed at a remote host when it is documented to speak only to the loopback interface.
- Anything that makes remote control listen on an address other than the loopback interface or the private address the user chose, or that lets a remote client act without a valid token.

## What is out of scope

- Vulnerabilities in the connected agent harness itself. Report those to the harness vendor.
- Attacks that require an already compromised user account or root on the machine.
- Denial of service against the local scheduler by the same user who runs it.
