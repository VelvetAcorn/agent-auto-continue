# Releasing

Releases are built, signed, notarized and published by the [release workflow](../.github/workflows/release.yml) when a tag of the form `v2.1.0` is pushed.
The workflow refuses to publish an unsigned build, so the secrets below must exist first.

## What signing and notarization do

Three things happen to every release build.
It is signed with the maintainer's Developer ID certificate, so macOS can tell who built it and that it has not been altered since.
The disk image is signed with the same certificate (`dmg.sign` in `package.json`).
Both are uploaded to Apple, scanned, and approved, which is what notarization means.
Apple's approval ticket is then stapled to the app and the disk image, so macOS can verify them even while offline.

The practical result is that a download opens without the "unidentified developer" or "damaged" warning that Gatekeeper shows for unsigned apps.
Each release is signed and notarized independently; nothing has to be renewed per release.
The certificate lasts five years and the app-specific password does not expire unless it is revoked.

## One-time setup

1. In the Apple Developer account, create a **Developer ID Application** certificate.
   An **Apple Development** certificate is not enough; Gatekeeper only trusts Developer ID for apps distributed outside the App Store.
   On an individual membership the certificate carries the account holder's legal name, and that name is visible in every signed binary.
2. Install the certificate in the login keychain and confirm it is there:

   ```sh
   security find-identity -v -p codesigning
   ```

   Note the ten characters in parentheses on the **Developer ID Application** line.
   That is the Team ID to use everywhere below.
   It can differ from the team of an Apple Development certificate on the same Mac, so do not copy it from the wrong line.
3. Export that certificate together with its private key from Keychain Access as a `.p12` file with a password.
   Encode it with `base64 -i certificate.p12 | pbcopy`, paste it into the secret, then delete the `.p12` file.
4. Create an app-specific password for the Apple ID at <https://account.apple.com> under Sign-In and Security.
   It has the form `xxxx-xxxx-xxxx-xxxx` and is not the Apple ID password.
5. Add these repository secrets under **Settings, Secrets and variables, Actions**:

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE_P12` | The base64 text from step 3 |
| `MAC_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12` |
| `APPLE_ID` | The Apple ID email used for the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password from step 4 |
| `APPLE_TEAM_ID` | The Team ID from step 2 |

Registering the bundle identifier `com.velvetacorn.agent-auto-continue` as an App ID in the developer portal is optional for Developer ID distribution.
It only becomes necessary for the Mac App Store or for capabilities such as push notifications.

## Rehearse locally before the first release

Do this once after setting up the certificate, and again whenever the certificate or credentials change.
It proves the whole chain works before anything depends on the workflow.

1. Copy [`.env.release.example`](../.env.release.example) to `.env.release` and fill in the three values.
   `.env.release` is gitignored and must stay out of version control.
2. Run the rehearsal:

   ```sh
   npm run build:release:local
   ```

   It loads the file, checks that all three values are present and that the keychain holds a Developer ID certificate for that team, builds the universal app and disk image, signs and notarizes both, staples the disk image, and then verifies them with `codesign`, `spctl` and `stapler`.
   It also checks that the app carries its update feed (`Contents/Resources/app-update.yml`) and that `dist/latest-mac.yml` was written.
3. The first time, macOS asks for your login password so that `codesign` may use the new private key.
   Choose **Always Allow** so the prompt does not return for every file.
4. Expect signing to take three to four minutes with no output, because every component is signed and timestamped separately.
   Notarization then uploads about 230 MB and waits for Apple, usually two to ten minutes and up to an hour for a brand-new team's first submission.
   The disk image is notarized separately afterwards, so there are two such waits.
   The terminal is quiet during them.
5. Success ends with `accepted` and `source=Notarized Developer ID` from `spctl` for both the app and the disk image, and "The validate action worked" from `stapler`.

If the log says `skipped macOS notarization` with `notarize options were unable to be generated`, the credentials were not in the environment of the process that ran the build.
The rehearsal script rules that out by loading `.env.release` itself; if you run `npm run build:release` by hand instead, export all three variables in the same terminal first.
A notarization failure prints a submission ID; read the details with:

```sh
xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"
```

The artifacts a rehearsal leaves in `dist/` are genuinely signed and notarized, but publish through the workflow anyway so that every release is reproducible, checksummed and tied to a tag.

## Cutting a release

1. Update `version` in `package.json` and merge it to `main`.
2. Tag and push:

   ```sh
   git tag v2.1.0
   git push origin v2.1.0
   ```

3. Watch the workflow.
   It runs lint, tests and the smoke fixture, refuses to continue if any secret is missing, checks that the tag matches `package.json`, builds a universal binary, signs it with the hardened runtime, signs the disk image, notarizes the app and the disk image, staples both, verifies them with `codesign`, `spctl` and `stapler`, checks the update information, and publishes a GitHub release.
4. Edit the generated release notes if they need a human touch.

An update is the same three steps with a new version number.
The release must be published, not left as a draft or marked as a pre-release, because installed copies only look at the latest published release.

### What a release contains

| Asset | Purpose |
| --- | --- |
| `Agent-Auto-Continue.dmg` | The disk image people download; its name never changes, so the stable link below always serves the newest release. |
| `agent-auto-continue-<version>-universal.zip` | The app for the updater, with its version in the name. |
| `agent-auto-continue-<version>-universal.zip.blockmap` | Lets the updater download only the parts of the ZIP that changed. |
| `latest-mac.yml` | The update feed: the newest version and the ZIP's name, size and SHA-512 checksum. |
| `SHA256SUMS.txt` | Checksums of all of the above, for anyone verifying a download by hand. |

The disk image stays out of `latest-mac.yml` (`dmg.writeUpdateInfo` is `false`), because stapling changes its bytes after electron-builder writes the feed, and macOS updates are installed from the ZIP anyway.
GitHub replaces spaces in asset names, which is why the disk image is named with dashes.

## How updates reach users

Every released copy carries `Contents/Resources/app-update.yml`, which points electron-updater at this repository's GitHub Releases.
A minute after launch and then every four hours, the app reads the latest release's `latest-mac.yml`.
When it names a newer version, the app downloads the ZIP in the background, checks its SHA-512 checksum, and hands it to Squirrel.Mac, which also checks that it is signed by the same Developer ID before installing it.
The update installs the next time the user quits the app, or at once if they choose Restart.
The app never quits by itself to install, and Restart asks first while a message is being sent, an agent it started is still working, or a schedule is due within five minutes.
Development builds and the smoke fixture never check.
A copy running from the disk image or from macOS's temporary location for downloaded apps cannot replace itself, so it offers to move to Applications instead of checking.
Until the first release is published, a check simply finds nothing; the app records that quietly and shows it only when someone checks by hand.
Both the stable download link and update checks need the repository to be public.
While it is private, GitHub answers both with 404 to anyone who is not signed in, so installed copies find nothing to install and say "No published release was found on GitHub" when someone checks by hand.

## Distributing

Point users at <https://github.com/VelvetAcorn/agent-auto-continue/releases/latest/download/Agent-Auto-Continue.dmg>, which always serves the newest disk image, or at the [releases page](https://github.com/VelvetAcorn/agent-auto-continue/releases).
They open the disk image and drag Agent Auto-Continue onto the Applications folder beside it.
Because the app is notarized, macOS only shows its usual one-time question about an app downloaded from the Internet.
A copy opened from the disk image or from Downloads offers to move itself into Applications, replacing an older version there if there is one.
After that, it updates itself.
Users of the earlier T3 Code Auto-Continue build install the new one the same way; on first launch it copies their settings and schedules across and leaves the old copy untouched.
A Homebrew cask pointing at the release DMG is a possible later step, and signing is a prerequisite for it.

## Building locally without credentials

`npm run build` makes an unsigned ZIP for the current architecture.
`npm run build:dmg` makes a disk image with the drag-to-Applications layout; its background is generated by `npm run dmg-background`.
`npm run build:release` makes the universal DMG and ZIP; it signs when a certificate is in the keychain and notarizes only when the three Apple variables are exported.
Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing on a machine that has a certificate in its keychain.
