# Arkonas Test Checklist

Use this when testing the launcher against Arkonas or another lobby-auth server.

## Profile

1. Create or select a profile.
2. Set `Host` to `play.arkonas.net`.
3. Set `Port` to the server port, usually `25565`.
4. Set `Version` to `1.20.1` for the current bot smoke path.
5. Set `Auth mode` to `Offline` for an existing cracked/offline test account, or `Microsoft` for a real Java account.
6. Enable `Join flow`.
7. Set `Lobby auth` to `Login` for an existing account or `Register` for a first-time server registration.
8. Set `Login command` to `/login {password}` for an existing account.
9. Set `Register command` to `/register {password} {password}` if using registration mode.
10. Set `Auth password` to the lobby password.
11. Set `Transfer command` to `/smp`.
12. Save profile.

## Expected Runtime

1. Click `Connect`.
2. Status becomes `Running join flow` after spawn.
3. Pulse rail shows `Lobby auth sent` for login mode or `Lobby register sent` for register mode.
4. Pulse rail shows `Server transfer sent`.
5. Status returns to `Online`.
6. `Routine active` appears after the flow completes.
7. Health, hunger, position, dimension, and chat should update from the server.

## Tuning

- Increase `Auth delay ms` if the bot sends `/login` before the lobby has fully loaded.
- Increase `Transfer delay ms` if `/smp` is sent too soon after login.
- Do not use `/server smp`; live testing returned an unknown-command error for that command.
- If the server requires registration and the server policy permits this launcher account, use `Lobby auth: Register`; otherwise register manually first with the real client and then use `Login`.
- `oyna.arkonas.net` is currently a working alias for the same endpoint, but the launcher default uses `play.arkonas.net` because it is the hostname published on the official Arkonas site.

## Live Smoke Findings

- `play.arkonas.net:25565` accepts offline/cracked usernames.
- Arkonas can send a mandatory resource pack before world spawn; the launcher auto-accepts it at protocol level.
- Disposable offline registration was stopped after the server-side IP limit was reached: `Bu IP adresinden en fazla 5 hesap acabilirsin. Su an kayitli: 5.`
- Continue testing only with existing accounts and `/login <password>`.
- `/smp` reached SMP during live old-account testing on `1.20.1`; the smoke observed a second spawn and the Arkonas SMP welcome message.

## Existing Account Smoke

Run this only with an already registered account:

```bash
ARKONAS_USERNAME='<existing_username>' ARKONAS_PASSWORD='<existing_password>' npm run test:arkonas
```

## Security Note

The password field is masked and redacted from timeline events. It is kept only in runtime memory and stripped from the app profile JSON, so enter it again after restarting the launcher. Use a dedicated account and a server-approved AFK policy.
