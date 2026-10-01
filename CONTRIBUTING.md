# Contributing

Thanks for your interest in Agent Auto-Continue.
This document covers how to set up a development environment, what a good change looks like, and what happens when you open a pull request.

## Before you start

Check the [open issues](https://github.com/VelvetAcorn/agent-auto-continue/issues) first.
For anything larger than a small fix, open an issue describing the change before writing code so the approach can be agreed on.
That avoids wasted effort on both sides.

## Development setup

You need macOS and Node.js 20 or newer.

```sh
git clone https://github.com/VelvetAcorn/agent-auto-continue.git
cd agent-auto-continue
npm install
npm start
```

See the [README](README.md) for how to obtain an agent token and connect the app.

## Checks to run locally

Every pull request runs these in CI, so run them before pushing.

```sh
npm run lint          # ESLint
npm test              # Unit tests
npm run test:electron # Production window smoke fixture, no real sends
```

If you are running inside a tool that sets `ELECTRON_RUN_AS_NODE`, prefix the Electron commands with `env -u ELECTRON_RUN_AS_NODE`.

## What a good change looks like

- Keep each pull request to one logical change. Separate refactors from behaviour changes.
- Add or update tests for anything that changes behaviour. The scheduler has reliability guarantees that are documented in the README and backed by tests, and those must keep passing.
- Never make the app send a message in a test. The smoke fixture asserts that zero dispatches happen.
- The app opens connections only to the agent's local API on the loopback interface, and remote control listens only on the loopback interface or a private address the user chose. Do not add code that reaches a remote host or widens where the app listens.
- Do not add telemetry, analytics, or crash reporting.
- Prefer quality, simplicity, robustness and long term maintainability over development speed.

## Style

- JavaScript is linted with ESLint using the configuration in `eslint.config.js`. Fix lint errors rather than disabling rules.
- In Markdown files, put each full sentence on its own line. This keeps diffs readable.
- Use a plain dash, never an em dash.
- Do not edit generated files by hand. The app icon and menu bar glyph are regenerated with `npm run icons` from the SVG sources in `assets/`.

## Commit messages

Write a short imperative summary line, for example `Reject schedules inside a daylight-saving gap`.
Add a body when the reason for the change is not obvious from the diff.

## Pull requests

- Fill in the pull request template. It asks what changed, why, and how it was verified.
- CI must be green before review.
- Reviews may ask for changes. That is normal and not a judgement on the contributor.

## Licensing of contributions

This project is licensed under the [MIT License](LICENSE).
By submitting a pull request you agree that your contribution is licensed under the same terms, and that you have the right to submit it.
There is no separate contributor license agreement to sign.

## Reporting security issues

Do not open a public issue for a security problem.
See [SECURITY.md](SECURITY.md) for the private reporting process.
