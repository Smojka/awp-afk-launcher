# 50 ChunkKeeper Improvement Loops

Each loop asks: "How should a Minecraft Java AFK launcher behave while staying inside AFK scope?"

1. It should start from account sessions, not modpacks. Implemented account roster.
2. It should make current connection state visible. Implemented state pills and roster pips.
3. It should not render Minecraft graphics. Implemented lightweight Mineflayer runtime only.
4. It should support multiple accounts. Implemented persisted profile list.
5. It should start sessions independently. Implemented per-profile Connect.
6. It should stop sessions independently. Implemented per-profile Disconnect.
7. It should support bulk operation. Implemented Start all and Stop all.
8. It should support Microsoft Java accounts without storing passwords. Implemented `auth: "microsoft"` with a Microsoft login session folder.
9. It should support local smoke testing. Implemented offline auth and Docker test server.
10. It should keep auth outside the renderer. Implemented Electron preload IPC boundary.
11. It should expose server host and port clearly. Implemented server profile form.
12. It should allow protocol auto-detect. Implemented `version: false` profile model and `undefined` Mineflayer option.
13. It should avoid hidden fallback movement. Implemented explicit routine toggles only.
14. It should randomize timing. Implemented interval jitter.
15. It should randomize view direction. Implemented random look pulse.
16. It should support jump AFK pulses. Implemented jump control pulse.
17. It should support sneak AFK pulses. Implemented sneak control pulse.
18. It should support arm swing AFK pulses. Implemented swing pulse.
19. It should support optional chat heartbeat. Implemented heartbeat message list.
20. It should not spam by default. Chat messages default disabled.
21. It should recover from death. Implemented auto-respawn queue.
22. It should recover from disconnects. Implemented reconnect backoff.
23. It should cap reconnect attempts. Implemented max attempts.
24. It should show the next reconnect time. Implemented `nextReconnectAt` snapshot.
25. It should surface kicks. Implemented kick event and warning state.
26. It should surface bot errors. Implemented error event and degraded runtime.
27. It should show health. Implemented health metric.
28. It should show hunger. Implemented food metric.
29. It should show position. Implemented X/Y/Z metrics.
30. It should show dimension. Implemented dimension metric.
31. It should show inventory usage. Implemented inventory metric.
32. It should show online player count when available. Implemented players metric.
33. It should show ping. Implemented ping metric.
34. It should keep chat readable. Implemented monospaced chat console.
35. It should allow manual chat. Implemented Send chat.
36. It should reject empty chat messages. Implemented trim guard.
37. It should log routine actions. Implemented pulse rail events.
38. It should keep event history bounded. Implemented max event/chat buffers.
39. It should stay dense but legible. Implemented fixed 1280x760 command grid.
40. It should have professional Windows styling. Implemented graphite shell and compact controls.
41. It should avoid one-note color. Implemented green, amber, blue, red signal palette.
42. It should use icons where useful. Implemented Lucide icons for core controls.
43. It should avoid layout shifts. Implemented fixed toolbar, roster, metric, and bottom-strip dimensions.
44. It should support profile edits. Implemented Save profile.
45. It should support profile creation. Implemented New account draft.
46. It should support profile deletion. Implemented delete action.
47. It should persist profiles. Implemented JSON profile store.
48. It should have unit tests for AFK logic. Implemented Vitest routine tests.
49. It should have simulated-runtime tests for Mineflayer integration. Implemented BotManager tests.
50. It should have UI smoke coverage. Implemented React command desk tests.
