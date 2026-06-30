import itemTextures from './assets/itemTextures.json';

/**
 * Bundled Minecraft item/block textures keyed by registry name (e.g. `diamond_sword`,
 * `cobblestone`). Each value is a 16×16 PNG data URI. Merged across 1.20.2 → 1.21.x so
 * renamed/added items across versions are all covered. See scripts note in the commit.
 */
const TEXTURES = itemTextures as Record<string, string>;

/**
 * Resolve a Minecraft item id to a bundled texture data URI, or `null` when we have no
 * artwork for it (caller should fall back to a text label). Accepts ids with or without
 * the `minecraft:` namespace.
 */
export function itemIconUri(name: string | null | undefined): string | null {
  if (!name) return null;
  const id = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  return TEXTURES[id] ?? null;
}
