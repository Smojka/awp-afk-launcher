# Release Signing

Production builds must be signed. Do not ship the unsigned artifacts produced by the local `package:*` scripts.

## Commands

```bash
npm run package:mac:signed
npm run package:win:signed
npm run package:prod
npm run verify:release-signing
```

The signed package scripts call `scripts/require-prod-signing.mjs` first. If the certificate or notarization environment is missing, the build stops before producing a release artifact.

## macOS

Requirements:

- Apple Developer Program membership.
- Developer ID Application certificate.
- Xcode command line tools on macOS.
- Apple notarization credentials.

Supported certificate inputs:

```bash
export CSC_LINK='<base64-or-path-to-developer-id-p12>'
export CSC_KEY_PASSWORD='<certificate-password>'
```

or an installed keychain identity:

```bash
export CSC_NAME='Developer ID Application: Your Company (TEAMID)'
```

Supported notarization inputs:

```bash
export APPLE_API_KEY='<app-store-connect-api-key>'
export APPLE_API_KEY_ID='<key-id>'
export APPLE_API_ISSUER='<issuer-id>'
```

or:

```bash
export APPLE_ID='<apple-id-email>'
export APPLE_APP_SPECIFIC_PASSWORD='<app-specific-password>'
export APPLE_TEAM_ID='<team-id>'
```

or:

```bash
export APPLE_KEYCHAIN_PROFILE='<notarytool-profile>'
```

The macOS build uses hardened runtime, Electron entitlements, notarization, and stapling.

## Windows

Preferred options:

- Microsoft Azure Trusted Signing / Artifact Signing for CI.
- A public OV code signing certificate supplied through `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.
- A hardware-token certificate on Windows selected with `WIN_CSC_SUBJECT_NAME` or `WIN_CSC_SHA1`.

PFX input:

```bash
export WIN_CSC_LINK='<base64-or-path-to-pfx>'
export WIN_CSC_KEY_PASSWORD='<certificate-password>'
```

Azure Trusted Signing input:

```bash
export AZURE_TENANT_ID='<tenant-id>'
export AZURE_CLIENT_ID='<client-id>'
export AZURE_CLIENT_SECRET='<client-secret>'
export AZURE_TRUSTED_SIGNING_ENDPOINT='<endpoint>'
export AZURE_CODE_SIGNING_ACCOUNT_NAME='<account-name>'
export AZURE_CERTIFICATE_PROFILE_NAME='<certificate-profile>'
export AZURE_PUBLISHER_NAME='<publisher-name>'
```

Hardware-token input on Windows:

```bash
export WIN_CSC_SUBJECT_NAME='Your certificate subject'
export WIN_PUBLISHER_NAME='Your exact publisher name'
```

## Verification

After a signed production build:

```bash
npm run verify:release-signing
```

On macOS this checks `codesign`, Gatekeeper assessment, and notarization stapling. If the unpacked app bundle has already been cleaned up, the script mounts the DMG and verifies the app inside it. On Windows it uses Authenticode through PowerShell. On macOS/Linux it can verify the Windows installer only when `osslsigncode` is installed.

## Rules

- Never commit certificates, private keys, `.p12`, `.pfx`, API keys, Apple passwords, Azure secrets, or signing profiles.
- Do not modify release artifacts after signing.
- Keep the same publisher identity across releases so Windows reputation can accumulate.
- Code signing reduces OS and antivirus warnings, but it does not guarantee that SmartScreen or antivirus products will never warn on a new file.
