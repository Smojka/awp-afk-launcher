# ChunkKeeper Research Notes

## Reference README

Local reference: `/Users/aydogan/Desktop/README.md`

The reference product is a multi-account AFK client with a web control panel. Important takeaways:

- Multi-account sessions should be independently startable and stoppable.
- The client should avoid full 3D rendering and stay lightweight.
- AFK behavior should include randomized movement such as look/jump/sneak.
- Operators need live health, hunger, position, inventory, players, chat, and status.
- Auto-respawn and simple portable Windows execution are expected.

## External Sources

- Mineflayer project: https://github.com/PrismarineJS/mineflayer
- Mineflayer API docs: https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md
- Mineflayer FAQ: https://github.com/PrismarineJS/mineflayer/blob/master/docs/FAQ.md
- Electron Builder Windows docs: https://www.electron.build/docs/win/
- Electron Builder NSIS/portable docs: https://www.electron.build/docs/nsis/

## Product Decisions

- Use Electron because the launcher is Windows-first and should bundle its Node runtime.
- Use Mineflayer because it exposes a Java Edition bot API with spawn, chat, health, food, inventory, movement, and protocol-version support.
- Keep Microsoft auth in the main process. Do not ask for or store Microsoft passwords; Mineflayer's Microsoft auth flow and login session folder are used instead.
- Lobby auth passwords are entered in the renderer for server `/login` or `/register` commands, but they are kept in runtime memory only, redacted from events, and stripped from profile JSON.
- Include offline auth only for local or explicitly authorized servers.
- Use a dense command-desk layout instead of a marketing launcher layout.
- Keep the launcher inside AFK scope. Avoid mod browsing, account selling, full game rendering, combat automation, or unrelated client features.

## Stitch Output

- Project: `5761766598444051265`
- Screen: `2a08b6e8b5c7486097e5d936aa474e5e`
- Design system asset: `f5c52c34ac574c00835f770f2fd5c423`
- Direction: graphite desktop shell, grass/glowstone/waterline/redstone signal palette, left account roster, center session controls, right AFK routine composer, bottom runtime strip.
