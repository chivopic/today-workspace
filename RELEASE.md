# Today Workspace Android Release

Current application version: `0.3.2` (Android versionCode `5`).

## Release outputs

The release workflow builds two signed Android artifacts:

- `Today-Workspace-<version>.apk` — direct Android installation.
- `Today-Workspace-<version>.aab` — Google Play upload format.

It also publishes `SHA256SUMS.txt` for artifact integrity checks.

## Signing key

Android updates must keep using the same release signing key. Never commit the keystore or its passwords to Git.

Use the existing, securely backed-up `today-workspace-upload.jks`, then configure these GitHub Actions repository secrets:

- `ANDROID_KEYSTORE_BASE64` — base64-encoded keystore bytes.
- `ANDROID_KEYSTORE_PASSWORD` — keystore password.
- `ANDROID_KEY_ALIAS` — key alias.
- `ANDROID_KEY_PASSWORD` — key password.

Do not generate a replacement upload/release key. Read the existing Base64 backup and credentials from private local files and pass them to `gh secret set` through stdin; never print them or upload them as build artifacts.

Store the original `.jks` file and its credentials in at least two secure locations. Losing the signing key can prevent future APK updates from installing over previous releases.

After downloading all three release assets into the same directory, run `sha256sum -c SHA256SUMS.txt` in that directory.

## Building a release

Run the GitHub Actions workflow `Today Workspace Release` manually and provide:

- `version_name`: semantic app version, for example `0.3.2`.
- `version_code`: positive integer that must increase for every Play Store release, `5` for this release.

The workflow fails if signing secrets are absent. It never falls back to the Android debug key.

## Release checklist

Before distributing a build:

1. Production web deployment is healthy.
2. Registration, email confirmation, login, logout, password recovery and new-password login are verified.
3. Cross-device note/task sync is verified.
4. Offline local editing and later synchronization are verified.
5. Backup export/import is smoke-tested.
6. Release APK/AAB signatures are verified by CI.
7. Install the Release APK on a physical Android device and run a final smoke test.
8. Record the Git commit SHA and SHA-256 checksums with the release notes.

## Current beta limitation

Today Workspace currently uses Supabase's default Auth email sender. This is acceptable for limited beta testing, but its email rate limits make it unsuitable for a large public launch. Move Auth email to a dedicated SMTP provider before broad distribution.
