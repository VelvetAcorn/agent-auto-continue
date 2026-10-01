# Releasing

Releases are built, signed, notarized and published by the [release workflow](../.github/workflows/release.yml) when a tag of the form `v2.1.0` is pushed.
The workflow refuses to publish an unsigned build, so the secrets below must exist first.

## One-time setup

1. In the Apple Developer account, create a **Developer ID Application** certificate.
   An **Apple Development** certificate is not enough; Gatekeeper only trusts Developer ID for apps distributed outside the App Store.
2. Export that certificate and its private key from Keychain Access as a `.p12` file with a password.
3. Create an app-specific password for the Apple ID at <https://account.apple.com>.
4. Add these repository secrets under **Settings, Secrets and variables, Actions**:

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE_P12` | The `.p12` file, base64 encoded: `base64 -i certificate.p12 \| pbcopy` |
| `MAC_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12` |
| `APPLE_ID` | The Apple ID email used for the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password from step 3 |
| `APPLE_TEAM_ID` | The ten-character team identifier shown in the developer account |

Registering the bundle identifier `com.velvetacorn.agent-auto-continue` as an App ID in the developer portal is optional for Developer ID distribution.
It only becomes necessary for the Mac App Store or for capabilities such as push notifications.

## Cutting a release

1. Update `version` in `package.json` and commit it to `main`.
2. Tag and push:

   ```sh
   git tag v2.1.0
   git push origin v2.1.0
   ```

3. Watch the workflow. It runs lint, tests and the smoke fixture, builds a universal binary, signs it with the hardened runtime, notarizes the app and the disk image, staples both, verifies them with `codesign`, `spctl` and `stapler`, and publishes a GitHub release with the DMG, ZIP and a `SHA256SUMS.txt`.
4. Edit the generated release notes if they need a human touch.

## Building locally

`npm run build` makes an unsigned ZIP for the current architecture.
`npm run build:release` makes the universal DMG and ZIP; it signs and notarizes only when the same environment variables as in CI are set.
Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing on a machine that has a certificate in its keychain.
