# Releasing

Releases are built, signed, notarized and published by the [release workflow](../.github/workflows/release.yml) when a tag of the form `v2.1.0` is pushed.
The workflow refuses to publish an unsigned build, so the secrets below must exist first.

## What signing and notarization do

Three things happen to every release build.
It is signed with the maintainer's Developer ID certificate, so macOS can tell who built it and that it has not been altered since.
It is uploaded to Apple, scanned, and approved, which is what notarization means.
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

   It loads the file, checks that all three values are present and that the keychain holds a Developer ID certificate for that team, builds the universal app, signs it, notarizes it, and then verifies it with `codesign`, `spctl` and `stapler`.
3. The first time, macOS asks for your login password so that `codesign` may use the new private key.
   Choose **Always Allow** so the prompt does not return for every file.
4. Expect signing to take three to four minutes with no output, because every component is signed and timestamped separately.
   Notarization then uploads about 230 MB and waits for Apple, usually two to ten minutes and up to an hour for a brand-new team's first submission.
   The terminal is quiet during that wait.
5. Success ends with `accepted` and `source=Notarized Developer ID` from `spctl`, and "The validate action worked" from `stapler`.

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

3. Watch the workflow. It runs lint, tests and the smoke fixture, refuses to continue if any secret is missing, checks that the tag matches `package.json`, builds a universal binary, signs it with the hardened runtime, notarizes the app and the disk image, staples both, verifies them with `codesign`, `spctl` and `stapler`, and publishes a GitHub release with the DMG, ZIP and a `SHA256SUMS.txt`.
4. Edit the generated release notes if they need a human touch.

An update is the same three steps with a new version number.

## Distributing

Point users at the [releases page](https://github.com/VelvetAcorn/agent-auto-continue/releases).
They download the DMG, open it, and drag Agent Auto-Continue into Applications.
Because the app is notarized it opens without extra steps.
Users of the earlier T3 Code Auto-Continue build install the new one the same way; on first launch it copies their settings and schedules across and leaves the old copy untouched.
A Homebrew cask pointing at the release DMG is a possible later step, and signing is a prerequisite for it.

## Building locally without credentials

`npm run build` makes an unsigned ZIP for the current architecture.
`npm run build:release` makes the universal DMG and ZIP; it signs when a certificate is in the keychain and notarizes only when the three Apple variables are exported.
Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing on a machine that has a certificate in its keychain.
