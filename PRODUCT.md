# Product

## Register

product

## Users

ChunkKeeper is for Minecraft Java server operators and account owners who are allowed to run AFK automation on the target server. They use it while administering or maintaining long-running sessions, farms, lobby-auth flows, and bot routines across one or more accounts.

## Product Purpose

ChunkKeeper is a focused desktop and local web client for authorized Minecraft Java AFK sessions. It manages bot profiles, server/version/proxy settings, Mineflayer connections, lobby login/register transfer flow, AFK preservation routines, reconnects, live telemetry, inventory, scripts, auto-response rules, Discord bridge behavior, and automation modules such as cactus farming, crop farming, area operations, and generator mining.

Success means an operator can configure and monitor multiple bots from one command desk, understand exactly what each bot is doing, and recover from routine Minecraft/server edge cases without storing sensitive credentials or hiding failure states.

## Brand Personality

Technical, operator-grade, compact.

The interface should feel like a control surface for repeat use: dense enough for scanning, restrained enough to trust, and explicit about runtime state. It can have a Minecraft/terminal atmosphere, but the task must remain primary.

## Anti-references

- Not a hacked-client, combat-client, modpack-launcher, or account marketplace aesthetic.
- Not a marketing landing page with oversized hero sections, decorative cards, or sales copy.
- Not a fake-friendly dashboard that invents bot state when data is missing.
- Not a one-note purple sci-fi skin where every control has the same visual weight.
- Not a credential-heavy workflow that persists passwords, webhook URLs, bot tokens, or proxy secrets in profile JSON.

## Design Principles

- Truth first: show real bot/runtime state and fail closed when data or capability is missing.
- Operator density: keep the primary command surface visible, compact, and scannable for repeat use.
- Runtime secrets stay runtime-only: sensitive values can be entered for the session but must not become durable profile data.
- Module controls should be direct: every automation has visible start/stop state, configuration, and progress/stat feedback.
- Familiar controls over novelty: use standard inputs, toggles, segmented choices, and icon buttons where operators expect them.

## Accessibility & Inclusion

Target WCAG AA contrast for text and controls. Preserve keyboard focus indicators, reduced-motion behavior, readable compact labels, and responsive layouts down to mobile-width browser dashboards. Avoid color-only state communication; status text and counts must accompany tone.
