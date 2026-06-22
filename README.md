# ChunkKeeper

Developed by smojka.

ChunkKeeper is a desktop launcher for authorized Minecraft Java AFK sessions on macOS and Windows. It manages account profiles, Mineflayer connections, lobby login/register flow, SMP transfer commands, AFK-preservation routines, reconnects, auto-respawn, auto-eat, telemetry, and local release packaging.

The app is intentionally narrow: it is not a modpack launcher, hacked client, combat tool, account marketplace, or full Minecraft client replacement. Use it only on servers where you own the account and AFK automation is allowed.

## What Is Included

- Electron desktop shell with a React/Vite renderer and TypeScript main process.
- Separate local browser-dashboard executable for macOS and Windows, served on loopback starting at `http://127.0.0.1:3000`.
- Mineflayer runtime in the Electron main process. The renderer does not mock live bot state.
- Profile storage for Minecraft account/server settings.
- Offline and Microsoft auth modes through Mineflayer.
- Lobby auth flow with Login, Register, Custom command, or No auth command.
- Delayed SMP transfer command after lobby auth.
- AFK routine actions: random look, jump pulse, sneak pulse, swing pulse, chat messages, auto-respawn, auto-eat, and reconnect backoff.
- Turkish default chat messages that are varied and do not identify the session as automated.
- Runtime-only lobby password handling. Lobby auth passwords are masked in the UI and stripped before profile JSON is written.
- Local macOS DMG and Windows EXE/NSIS packaging.
- GitHub Actions release workflow for publishing fresh installers.

## Requirements

- Node.js 22 or newer.
- npm.
- macOS for macOS DMG builds.
- A Windows machine or GitHub Actions runner for Windows installer builds.
- Docker only if you want the local Minecraft smoke server.

## Install

```bash
npm install
```

## Development

```bash
npm run dev
```

This starts Vite on `127.0.0.1` and launches the native Electron desktop app. The desktop window uses the Electron preload bridge and does not start the browser-dashboard server.

To run the separate browser-dashboard app in development:

```bash
npm run dev:web
```

That starts a loopback web server. The default address is:

```text
http://127.0.0.1:3000
```

If that port is already occupied, ChunkKeeper Web tries the next local port. When the Electron bridge is missing, the renderer tries the local web API instead of falling back to fake data. If ChunkKeeper Web is not running, the page shows an explicit local API error.

Useful development commands:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Current release-prep verification for this workspace returned `found 0 vulnerabilities` from `npm audit --omit=dev`.

## Using The Native App

1. Start ChunkKeeper.
2. Select an account profile from the left sidebar or create a new one.
3. Fill in the profile fields:
   - Label: local display name for the profile.
   - Username: Minecraft username.
   - Host and Port: target server.
   - Version: Minecraft protocol version. Use an explicit version when a server has strict protocol routing.
   - Auth mode: `offline` for authorized offline/cracked servers, or `microsoft` for a real Microsoft Java account.
4. Configure Join flow when the server starts in a lobby:
   - Enable Join flow.
   - Choose Login for an existing lobby account.
   - Choose Register for first-time registration.
   - Choose Custom command for a plugin-specific command.
   - Set Auth password if the selected command needs `{password}`.
   - Set Transfer command, for example `/smp`.
   - Tune auth and transfer delays if the lobby is slow.
5. Configure AFK routine controls.
6. Save the profile.
7. Press Connect.

## Using The Browser Dashboard App

1. Start ChunkKeeper Web.
2. Open the browser address it launches, normally `http://127.0.0.1:3000`.
3. Use the same dashboard controls in the browser.

ChunkKeeper and ChunkKeeper Web share the same local profile/auth data directory. Run one of them at a time for the cleanest session ownership.

## Login And Register Flow

ChunkKeeper sends lobby auth commands only after Mineflayer emits `spawn`. That prevents AFK routine actions from starting while the account is still in the authentication lobby.

Supported lobby auth modes:

- Login: sends the configured login command, usually `/login {password}`.
- Register: sends the configured register command, usually `/register {password} {password}`.
- Custom command: sends the exact command you provide.
- None: skips lobby auth and can still run a transfer command if configured.

The `{password}` placeholder is replaced at runtime only. The password is not written to profile JSON.

## AFK Routine

The AFK routine is built from independent switches:

- Random look: rotates the camera lightly.
- Jump pulse: taps jump for a short pulse.
- Sneak pulse: taps sneak for a short pulse.
- Swing pulse: swings the right arm.
- Chat messages: sends one message from the configured list.
- Auto-eat: eats safe registry-backed food before hunger becomes critical.
- Auto-respawn: requests respawn after death.
- Reconnect: retries unexpected disconnects with backoff.

The routine interval and jitter control how often one routine action is chosen. Unsafe interval and jitter values are clamped in code.

## Chat Messages

Default chat messages are Turkish and written to sound like ordinary short player replies, for example quiet status updates, "I am around" style messages, or "I will check in a bit" style messages. The routine avoids sending the same chat message twice in a row when more than one option exists.

You can edit the list in the profile panel. Put one message per line. Empty lines are ignored when the profile is saved.

## Auto-Eat

Auto-eat uses Mineflayer inventory and item registry data. It prefers safe food and skips harmful food. If hunger reaches the critical pause threshold and no safe food is available, the AFK routine pauses until the bot recovers.

Important settings:

- Eat at food: starts eating when food is at or below this value.
- Pause at food: pauses AFK actions if food falls to or below this value and no safe food can be eaten.

## Reconnect

Reconnect settings are per profile and can also be set as defaults for new profiles in Settings.

- Enabled: retry unexpected disconnects.
- Max attempts: stop after this many retries.
- Base delay: first retry delay.
- Max delay: upper bound for retry backoff.

Manual Disconnect and Stop all are treated as intentional stops.

## Settings

The Settings modal contains:

- Auto-start enabled accounts on launch.
- Connect stagger in milliseconds.
- Confirm before Stop all.
- Show chat timestamps.
- Compact density.
- Default reconnect policy for new accounts.
- App/runtime info.
- Open data folder.

At small window sizes the app switches to stacked layouts. The Electron window minimum is `900x640`.

## On-Screen Help

Most action buttons, toggles, and sliders have a small `?` help icon next to them. Hover the mouse over the icon, or focus it with the keyboard, to see what that control does and how it behaves.

Help popups are rendered at the top app layer instead of inside the surrounding panel. They should stay readable above cards, modal bodies, scroll containers, and compact responsive layouts. The popup is also constrained to the current window width so it does not run off-screen on smaller windows.

Examples:

- Connect help explains the profile connection sequence, including lobby auth, transfer command, and AFK routine startup.
- Stop all help explains that running sessions are stopped and that the confirmation setting is respected.
- Auto-eat help explains the hunger threshold and safe-food behavior.
- Base interval and Interval jitter help explain routine timing and randomization.
- Settings help explains which options affect existing profiles and which only affect new profiles.

## Local Smoke Server

The repository includes a Docker Compose smoke server for offline-mode local testing.

```bash
docker compose -f docker-compose.test.yml up -d
npm run smoke:server
```

The smoke script connects a local offline test user to `127.0.0.1:25565`, waits for spawn, prints telemetry, and disconnects.

## Arkonas Flow Notes

Suggested profile shape for Arkonas-style lobby auth:

- Host: `play.arkonas.net`
- Port: `25565`
- Version: `1.20.1` for the current smoke path.
- Auth mode: `offline` for an existing server-approved offline account, or `microsoft` for a real Java account.
- Join flow: enabled.
- Lobby auth: Login for existing accounts, Register for first-time registration.
- Login command: `/login {password}`
- Register command: `/register {password} {password}`
- Transfer command: `/smp`
- Auth delay: start around `2500` ms.
- Transfer delay: start around `3500` ms.

Live smoke for an existing account uses environment variables:

```bash
ARKONAS_USERNAME='<existing_username>' ARKONAS_PASSWORD='<existing_password>' npm run test:arkonas
```

Do not paste real credentials into source files, docs, tests, shell history that will be shared, or commits.

## Packaging

Local package builds:

```bash
npm run package:mac
npm run package:win
npm run package:web:mac
npm run package:web:win
```

`package:mac` and `package:win` build the native desktop app. `package:web:mac` and `package:web:win` build the separate browser-dashboard app. `npm run package:prod` builds both native and browser-dashboard artifacts.

Expected output paths:

- `release/ChunkKeeper-0.1.0-arm64.dmg`
- `release/ChunkKeeper-Setup-0.1.0-x64.exe`
- `release/ChunkKeeper-Web-0.1.0-arm64.dmg`
- `release/ChunkKeeper-Web-Setup-0.1.0-x64.exe`

`release/`, `dist/`, and `dist-electron/` are ignored by git. Upload release binaries to GitHub Releases or your distribution channel. Do not commit generated installers.

GitHub Releases are created by normal version tags, for example:

```bash
git tag v0.1.0
git push origin v0.1.0
```

That workflow builds fresh DMG and EXE artifacts in GitHub Actions and uploads them to the GitHub Release. The app is distributed directly from GitHub, so macOS or Windows may ask for confirmation the first time it is opened.

## Release Checklist

Run this before publishing:

```bash
npm install
npm run typecheck
npm test
npm audit --omit=dev
npm run build
npm run package:prod
```

## Credential Hygiene

Rules for this repository:

- No hardcoded usernames.
- No hardcoded passwords.
- No private keys, `.p12`, `.pfx`, Apple passwords, Azure secrets, API keys, or signing profiles in git.
- No real lobby auth passwords in tests, docs, scripts, packaged app data, or screenshots.
- Use environment variables for live smoke credentials.
- Keep generated release artifacts out of commits.

Credential-sensitive paths to keep in mind:

- `scripts/arkonas-live-test.mjs`
- profile JSON under the app user data folder
- `release/`
- `dist/`
- `dist-electron/`
- local shell history and CI logs

## Project Structure

```text
electron/                  Electron main and preload bridge
src/main/bot/              Mineflayer manager, AFK routine, tests
src/main/storage/          Profile persistence
src/renderer/              React UI
src/shared/                Shared types and default chat messages
scripts/                   Smoke, packaging, and icon generation
build/                     Icons
docs/                      Research and runtime notes
```

## Troubleshooting

- Bridge unavailable: run through Electron with `npm run dev` or a packaged build. The raw renderer page is not the app.
- Microsoft login problems: clear the app login session from the user data folder only when you intentionally want to re-authenticate.
- Lobby login succeeds but SMP transfer fails: verify command spelling, transfer delay, and protocol version.
- Bot starves: enable auto-eat, carry safe food, and check `eatAtFood` and `pauseAtFood`.
- Reconnect loops: check server kicks, auth state, max attempts, and backoff settings.
- Windows reputation warning: download from the GitHub Release page and keep filenames/versioning consistent between releases.
- macOS "damaged" warning: remove the old app, download the latest DMG from GitHub Releases, then copy `ChunkKeeper.app` to Applications again. If macOS keeps the old quarantine flag, run `xattr -dr com.apple.quarantine /Applications/ChunkKeeper.app`.
