# Original accessibility helper

These scripts predate the Electron app and are not used by it.
They remain together so the shell script can locate the Swift source without code changes.

From the repository root:

```sh
./legacy/continue-at.sh --help
./legacy/continue-at.sh --dry-run
```

A real run requires macOS, Accessibility permission, an unlocked screen and the intended T3 Code draft in focus.
The helper compiles into `legacy/.build/` on first use; generated build directories are ignored.
See the [current app documentation](../README.md) for the supported scheduling workflow.
