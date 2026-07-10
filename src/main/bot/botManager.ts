import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Vec3 } from 'vec3';
import {
  DEFAULT_SETTINGS,
  type AccountProfile,
  type AfkRoutineConfig,
  type AppSettings,
  type BotSessionSnapshot,
  type ChatLine,
  type LauncherState,
  type RuntimeSnapshot,
  type SaveProfileInput,
  type SessionEvent,
  type LobbyAuthMode,
  type StartupFlowConfig,
  type AreaOperationConfig,
  type BotModulesConfig,
  type CactusFarmConfig,
  type CropFarmConfig,
  type DiscordConfig,
  type DiscordRuntimeInput,
  type EquipDestination,
  type GeneratorMineConfig,
  type GeneratorSlot,
  type InventoryActionRequest,
  type InventoryItemSnapshot,
  type InventoryWindowLayout,
  type LiveInventorySnapshot,
  type OperationKind,
  type OperationSnapshot,
  type OperationStartRequest,
  type PositionSnapshot,
  type ProxyConfig,
  type AutoResponseConfig,
  type AutoResponseRule,
  type ScriptConfig,
  type ScriptStep,
  type StorageConfig
} from '../../shared/types.js';
import { AfkRoutine, type RoutineBot } from './afkRoutine.js';
import { createDefaultProfiles, defaultStorage } from './defaultProfiles.js';
import { ProfileStore } from '../storage/profileStore.js';
// Type-only import + the electron-free key helpers keep `electron` (which safeStorage's module
// pulls in) OUT of botManager's static graph; the real vault is loaded via dynamic import.
import type { SecretVault } from '../storage/secretVault.js';
import { authSecretKey, proxySecretKey } from '../storage/secretKeys.js';

const requireFromHere = createRequire(import.meta.url);
const fallbackStableMinecraftVersion = '1.21.11';

type ProfilePersistence = Pick<ProfileStore, 'load' | 'save'>;

/** The subset of SecretVault botManager depends on (injectable for tests). */
export type SecretPersistence = Pick<SecretVault, 'isAvailable' | 'get' | 'set' | 'delete' | 'has' | 'prune'>;

/** No-op vault used when safeStorage is unavailable (e.g. under tests): secrets stay in memory only. */
class NullSecretVault implements SecretPersistence {
  isAvailable(): boolean {
    return false;
  }
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<boolean> {
    return false;
  }
  async delete(): Promise<void> {}
  async has(): Promise<boolean> {
    return false;
  }
  async prune(): Promise<void> {}
}

/** Load the real safeStorage-backed vault, degrading to a no-op if `electron` can't be resolved. */
async function createSecretVault(baseDir: string): Promise<SecretPersistence> {
  try {
    const module = await import('../storage/secretVault.js');
    return new module.SecretVault(baseDir);
  } catch (error) {
    console.warn('[secret] safeStorage vault unavailable; passwords will not persist:', error);
    return new NullSecretVault();
  }
}

type MineflayerOptions = {
  host: string;
  port: number;
  username: string;
  version?: string;
  auth?: 'microsoft' | 'offline';
  profilesFolder?: string;
  connect?: (client: ProxyClientLike) => void;
};

type MinecraftDataModule = {
  (version: string): { version?: unknown } | null | undefined;
  supportedVersions?: {
    pc?: string[];
  };
};

let minecraftDataModule: MinecraftDataModule | null = null;

class UnsupportedMinecraftVersionError extends Error {
  constructor(version: string, detail?: string) {
    const supported = latestSupportedMinecraftVersions();
    const supportedSuffix = supported.length ? ` Bundled versions include ${supported.slice(0, 8).join(', ')}.` : '';
    const detailSuffix = detail ? ` ${detail}` : '';
    super(
      `Minecraft ${version} is not available in the bundled Mineflayer data.${supportedSuffix} ` +
        `Use Auto or ${fallbackStableMinecraftVersion}; Minecraft Java 26.x still needs complete Prismarine protocol/data support before it can run reliably.${detailSuffix}`
    );
    this.name = 'UnsupportedMinecraftVersionError';
  }
}

type ProxyClientLike = {
  setSocket?: (socket: net.Socket) => void;
  emit?: (event: string, ...args: unknown[]) => boolean;
};

type InventoryItemLike = {
  slot?: number;
  type?: number;
  metadata?: number;
  name?: string;
  displayName?: string;
  count?: number;
  foodPoints?: number;
  saturation?: number;
  effectiveQuality?: number;
};

type WindowLike = {
  title?: unknown;
  slots?: Array<InventoryItemLike | null | undefined>;
  items?: () => InventoryItemLike[];
  inventoryStart?: number;
  inventoryEnd?: number;
  hotbarStart?: number;
  craftingResultSlot?: number;
  // Container (chest/barrel) transfer surface — present on the window returned by openContainer.
  deposit?: (itemType: number, metadata: number | null, count: number | null) => Promise<void>;
  withdraw?: (itemType: number, metadata: number | null, count: number | null) => Promise<void>;
  close?: () => void;
  containerItems?: () => InventoryItemLike[];
  containerCount?: (itemType: number, metadata: number | null) => number;
  emptySlotCount?: () => number;
};

type FoodDataLike = {
  id: number;
  name: string;
  displayName?: string;
  foodPoints: number;
  saturation?: number;
  effectiveQuality?: number;
};

type BotRegistryLike = {
  foods?: Record<number, FoodDataLike>;
  foodsByName?: Record<string, FoodDataLike>;
  itemsByName?: Record<string, { id: number }>;
};

type BotLike = RoutineBot &
  EventEmitter & {
    _client?: EventEmitter & {
      write?: (packetName: string, payload: Record<string, unknown>) => void;
      socket?: net.Socket;
    };
    acceptResourcePack?: () => void;
    username?: string;
    health?: number;
    food?: number;
    entity?: {
      position?: { x: number; y: number; z: number };
      yaw?: number;
      pitch?: number;
    };
    game?: { dimension?: string };
    registry?: BotRegistryLike;
    inventory?: WindowLike;
    currentWindow?: WindowLike | null;
    quickBarSlot?: number;
    heldItem?: InventoryItemLike | null;
    players?: Record<string, unknown>;
    player?: { ping?: number };
    equip?: (item: InventoryItemLike | number, destination: EquipDestination | null) => Promise<void> | void;
    unequip?: (destination: EquipDestination | null) => Promise<void> | void;
    tossStack?: (item: InventoryItemLike) => Promise<void> | void;
    toss?: (itemType: number, metadata: number | null, count: number | null) => Promise<void> | void;
    moveSlotItem?: (sourceSlot: number, destSlot: number) => Promise<void> | void;
    clickWindow?: (slot: number, mouseButton: number, mode: number) => Promise<void> | void;
    setQuickBarSlot?: (slot: number) => void;
    deactivateItem?: () => void;
    consume?: () => Promise<void> | void;
    lookAt?: (position: Vec3, force?: boolean) => Promise<void> | void;
    blockAt?: (position: PositionSnapshot | Vec3) => BlockLike | null;
    dig?: (block: BlockLike) => Promise<void> | void;
    placeBlock?: (referenceBlock: BlockLike, faceVector: Vec3) => Promise<void> | void;
    activateBlock?: (block: BlockLike, faceVector?: Vec3, cursor?: Vec3) => Promise<void> | void;
    activateItem?: (offhand?: boolean) => Promise<void> | void;
    pathfinder?: {
      goto?: (goal: unknown) => Promise<void>;
      setMovements?: (movements: unknown) => void;
      setGoal?: (goal: unknown | null) => void;
      stop?: () => void;
    };
    openContainer?: (block: BlockLike, direction?: unknown, cursorPos?: unknown) => Promise<WindowLike>;
    closeWindow?: (window: WindowLike) => void;
    blockAtCursor?: (maxDistance?: number) => BlockLike | null;
    findBlock?: (options: { matching: (block: BlockLike) => boolean; maxDistance?: number }) => BlockLike | null;
    loadPlugin?: (plugin: unknown) => void;
    tabComplete?: (
      partial: string,
      assumeCommand?: boolean,
      sendBlockInSight?: boolean,
      timeout?: number
    ) => Promise<Array<string | { match?: string }>> | Array<string | { match?: string }>;
    quit?: (reason?: string) => void;
    respawn?: () => void;
  };

type BlockLike = {
  name?: string;
  displayName?: string;
  position?: PositionSnapshot;
  boundingBox?: string;
  metadata?: number;
};

export type MineflayerFactory = (options: MineflayerOptions) => Promise<BotLike> | BotLike;

interface ManagedSession {
  profile: AccountProfile;
  bot: BotLike | null;
  routine: AfkRoutine | null;
  operationTimers: Map<OperationKind, NodeJS.Timeout>;
  operationQueues: Map<OperationKind, OperationWorkItem[]>;
  scriptCursor: number;
  autoResponseCooldowns: Map<string, number>;
  discordRuntime: DiscordRuntime;
  discordPollTimer: NodeJS.Timeout | null;
  desiredStop: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  startupTimers: NodeJS.Timeout[];
  /** Teardowns for any pending join-flow signal listeners (chat/spawn), cleared alongside timers. */
  startupCancels: Array<() => void>;
  startupCompleted: boolean;
  foodGuardActive: boolean;
  hungerPaused: boolean;
  lastFoodWarningAt: number;
  /** Anchor used by the crop harvest loop after a build pass so it scans the field it just planted. */
  cropFarmOrigin: PositionSnapshot | null;
  /** Anchor captured at cactus-farm start (walk-back target after a storage trip). */
  cactusFarmOrigin: PositionSnapshot | null;
  /** Anchor captured at generator start (walk-back target after a storage trip). */
  generatorOrigin: PositionSnapshot | null;
  /** Anchor captured at area-op start (walk-back target after a storage trip). */
  areaAnchor: PositionSnapshot | null;
  /** Consecutive place/water failures per op; one bad cell no longer aborts the whole run. */
  operationFailStreak: Map<OperationKind, number>;
  /** Cells that failed in the current pass, re-queued (in plan order) for the next pass. */
  operationRetry: Map<OperationKind, OperationWorkItem[]>;
  /** Pass number, cells completed this pass, and consecutive zero-progress passes. */
  operationPass: Map<OperationKind, { pass: number; progressed: number; zeroStreak: number }>;
  /** Frozen-bot watchdog: consecutive failures without the bot moving, plus escalation count. */
  operationFrozen: Map<OperationKind, { x: number; y: number; z: number; count: number; heals: number }>;
  /** Self-heal reconnects triggered this session per op — hard-capped so a broken world can't loop forever. */
  selfHealCount: Map<OperationKind, number>;
  /** One-shot origin override consumed by the next start of that op: an auto-resume must
   *  rebuild the plan at the ORIGINAL farm origin, not wherever the bot happened to drop. */
  resumeAnchor: Map<OperationKind, PositionSnapshot>;
  /** Per-op timestamp before which the storage gate won't run another trip (prevents thrash/livelock). */
  storageCooldownUntil: Map<OperationKind, number>;
  /** Ops that were running when the bot involuntarily dropped; replayed after reconnect + validation. */
  resumeOps: Map<OperationKind, { config: unknown }>;
  /** True after an involuntary drop/kick (not an operator stop); gates auto-resume. */
  involuntaryDrop: boolean;
  /** Server command graph from the 1.13+ `declare_commands` packet, used for local tab completion. */
  commandNodes: ParsedCommandNode[] | null;
  /** Index of the root node within {@link ManagedSession.commandNodes}. */
  commandRoot: number;
  snapshot: BotSessionSnapshot;
}

/** A normalized Brigadier command node distilled from the `declare_commands` packet. */
interface ParsedCommandNode {
  /** 0 = root, 1 = literal (a typed command word), 2 = argument (a value placeholder). */
  type: number;
  /** Literal/argument name, or null for the root. */
  name: string | null;
  /** Indices of child nodes within the parsed node array. */
  children: number[];
  /** Index of a node this one redirects to (e.g. `/msg` -> `/tell`), or null. */
  redirect: number | null;
}

type OperationWorkItem = {
  action: 'dig' | 'place' | 'till' | 'water' | 'barrier';
  position: PositionSnapshot;
  itemName?: string;
  /** Walk within reach before acting (build steps that may be outside the bot's stationary reach). */
  walk?: boolean;
  /** Clear cell to stand in while placing, so the bot never enters the grid it is building. */
  stance?: PositionSnapshot;
  /** Exact reference cell to click when the face matters (e.g. hoppers must point into this block). */
  against?: PositionSnapshot;
  /** Hold sneak while placing — required when the reference block is interactive (chest, hopper). */
  sneak?: boolean;
  /** For 'barrier': how many times failed work has already been re-run through this barrier. */
  barrierAttempts?: number;
  /** Re-till the block below before placing (crop plants: farmland may have been trampled). */
  tillUnder?: boolean;
};

interface DiscordRuntime {
  enabled: boolean;
  webhookUrl: string;
  botToken: string;
  channelId: string;
  lastMessageId: string | null;
}

const MAX_EVENTS = 32;
const MAX_CHAT = 64;
const FOOD_WARNING_INTERVAL_MS = 30000;
const DEFAULT_OPERATION_DELAY_MS = 550;
// The per-item operation delay is a MINIMUM spacing, not an additive pause: the walk/place/dig
// work already elapsed during a tick counts toward it, so a slow (walking) cell doesn't then also
// sleep the full delay. This floor still yields to the event loop between items.
const MIN_OPERATION_GAP_MS = 40;
const MAX_OPERATION_VOLUME = 4096;
// Largest crop-farm half-extent (33x33 field). Well under MAX_OPERATION_VOLUME.
const MAX_CROP_RADIUS = 16;
// A single failed place/till/water no longer kills the whole operation. After this many
// consecutive hard failures the CURRENT PASS is abandoned (remaining cells roll into the
// retry pass) so the bot restarts from fresh ground instead of grinding a wedged spot.
const MAX_CONSECUTIVE_PLACE_FAILS = 8;
// Frozen-bot watchdog: this many consecutive failures with the feet not moving at all
// triggers recovery (pathfinder reload, then a self-heal reconnect).
const FROZEN_FAILURE_THRESHOLD = 4;
// Self-heal reconnects per op per session before we give up and block honestly.
const MAX_SELF_HEAL_RECONNECTS = 3;
// After a storage trip the gate waits this long before considering another, so a half-empty
// supply chest (or an all-kept full inventory) can't send the bot back and forth every tick.
const STORAGE_COOLDOWN_MS = 5000;
const DISCORD_API_BASE = 'https://discord.com/api/v10';
// LAN place confirmations land in <500ms; a silently-rejected click (Paper's server-side
// raytrace) never confirms at all, so a long wait here just slows every bad cell down.
// Failures roll into the multi-pass retry, so fail fast.
const PLACE_BLOCK_TIMEOUT_MS = 4000;
const CONTAINER_TIMEOUT_MS = 10000;
// Outer hard cap on walks. thinkTimeout (3s) already bounds no-path rejections, so this
// only fires on genuinely long/blocked EXECUTIONS — and hitting it costs a pathfinder
// reload (see gotoWithTimeout), so keep it generous.
const PATHFIND_TIMEOUT_MS = 20000;
const INVENTORY_ACTION_TIMEOUT_MS = 8000;
// Modern/proxy servers usually never answer serverbound tab_complete (they resolve
// command names client-side from declare_commands and only reply for ask_server args),
// so keep the wait short — we fall back to local completions when it lapses.
const TAB_COMPLETE_TIMEOUT_MS = 1500;
const MAX_TAB_COMPLETIONS = 12;

// Populated once by defaultMineflayerFactory after the pathfinder plugin loads.
// Tests inject their own factory, so these stay null there and every pathfinder
// call (walkWithinReach) becomes a no-op — the bot simply acts within reach.
type PathfinderMovementsCtor = new (bot: BotLike) => Record<string, unknown>;
type PathfinderGoals = { GoalNear: new (x: number, y: number, z: number, range: number) => unknown };
let pathfinderMovements: PathfinderMovementsCtor | null = null;
let pathfinderGoals: PathfinderGoals | null = null;
/** Kept so a degraded pathfinder instance can be replaced in place (loadPlugin re-injects). */
let pathfinderPluginRef: unknown = null;

const OPERATION_LABELS: Record<OperationKind, string> = {
  cactusFarm: 'Cactus farm',
  cropFarm: 'Crop farm',
  area: 'Area operation',
  generator: 'Generator mine',
  script: 'Script loop',
  discord: 'Discord bridge'
};

const DEFAULT_PROXY: ProxyConfig = {
  enabled: false,
  type: 'socks5',
  host: '',
  port: 0,
  username: '',
  password: ''
};

const DEFAULT_MODULES: BotModulesConfig = {
  cactusFarm: {
    enabled: false,
    layers: 1,
    radius: 2,
    placementDelayMs: 550,
    build: true,
    breakBlock: 'oak_fence',
    buildCollection: true,
    rowPairs: 1,
    wallBlock: 'glass',
    columns: 1,
    basinLayers: 1
  },
  cropFarm: {
    enabled: false,
    crop: 'wheat',
    radius: 4,
    harvestDelayMs: 750,
    replant: true,
    collectDrops: true,
    build: true,
    autoTill: true,
    waterMode: 'auto'
  },
  area: {
    enabled: false,
    mode: 'mine',
    coords: 'relative',
    from: { x: -2, y: 0, z: -2 },
    to: { x: 2, y: 2, z: 2 },
    fillBlock: 'cobblestone',
    hollow: false,
    walk: true,
    actionDelayMs: 450
  },
  generator: {
    enabled: false,
    slots: [
      { id: 'gen-n', x: 0, y: 0, z: -1 },
      { id: 'gen-s', x: 0, y: 0, z: 1 },
      { id: 'gen-e', x: 1, y: 0, z: 0 },
      { id: 'gen-w', x: -1, y: 0, z: 0 }
    ],
    blockFilter: 'cobblestone',
    walk: false,
    actionDelayMs: 350,
    regenDelayMs: 1500
  },
  script: {
    enabled: false,
    loop: true,
    steps: [
      { id: 'script-1', label: 'Say hello', command: 'merhaba', delayMs: 1500 }
    ],
    quickCommands: [
      { id: 'quick-spawn', label: 'Spawn', command: '/spawn', delayMs: 0 },
      { id: 'quick-home', label: 'Home', command: '/home', delayMs: 0 }
    ]
  },
  discord: {
    enabled: false,
    commandPrefix: '!ck ',
    notifyChat: true,
    notifyEvents: true,
    pollCommands: false,
    pollIntervalMs: 10000,
    channelId: ''
  },
  autoResponse: {
    enabled: false,
    rules: [
      {
        id: 'auto-tpa',
        enabled: true,
        label: 'TPA accept',
        match: 'tpa',
        response: '/tpaccept',
        cooldownMs: 5000
      }
    ]
  }
};

const SAFE_FOOD_FALLBACK_SCORE: Record<string, number> = {
  golden_carrot: 14,
  cooked_beef: 13,
  cooked_porkchop: 13,
  rabbit_stew: 12,
  mushroom_stew: 11,
  beetroot_soup: 10,
  cooked_mutton: 10,
  cooked_salmon: 10,
  baked_potato: 9,
  bread: 8,
  cooked_chicken: 8,
  cooked_cod: 8,
  pumpkin_pie: 8,
  cooked_rabbit: 7,
  apple: 6,
  beetroot: 5,
  carrot: 5,
  melon_slice: 4,
  sweet_berries: 4,
  glow_berries: 4,
  cookie: 3,
  dried_kelp: 2,
  potato: 2,
  beef: 1,
  porkchop: 1,
  chicken: 1,
  mutton: 1,
  cod: 1,
  salmon: 1,
  rabbit: 1,
  golden_apple: 1,
  enchanted_golden_apple: 1
};

const UNSAFE_FOODS = new Set(['pufferfish', 'poisonous_potato', 'rotten_flesh', 'spider_eye']);

export class BotManager extends EventEmitter {
  private profiles: AccountProfile[] = [];
  private sessions = new Map<string, ManagedSession>();
  private selectedProfileId: string | null = null;
  private settings: AppSettings = cloneSettings(DEFAULT_SETTINGS);
  private webDashboardUrl: string | null = null;
  private loaded = false;
  private vault: SecretPersistence = new NullSecretVault();

  constructor(
    private readonly options: {
      userDataDir: string;
      appVersion: string;
      authSessionDir?: string;
      factory?: MineflayerFactory;
      store?: ProfilePersistence;
      secretVault?: SecretPersistence;
    }
  ) {
    super();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const defaultProfiles = createDefaultProfiles();
    const store = this.options.store ?? new ProfileStore(this.options.userDataDir);
    const document = await store.load({
      profiles: defaultProfiles,
      selectedProfileId: defaultProfiles[0]?.id ?? null
    });
    this.profiles = document.profiles.map(normalizeProfile);
    this.selectedProfileId = document.selectedProfileId ?? this.profiles[0]?.id ?? null;
    this.settings = normalizeSettings(document.settings);
    // profiles.json is written secret-free; rehydrate the decrypted passwords into the in-memory
    // profiles (the runtime source of truth used at connect time) from the encrypted vault.
    this.vault = this.options.secretVault ?? (await createSecretVault(this.options.userDataDir));
    await this.rehydrateSecrets();
    this.rebuildSessions();
    this.loaded = true;
    this.emitState();
    if (this.settings.autoStartOnLaunch) {
      void this.startAll();
    }
  }

  /**
   * Warm the heavy `mineflayer` / `mineflayer-pathfinder` dynamic imports ahead of time so the
   * first real connect doesn't pay their module-load latency on the critical path. Safe to call
   * repeatedly (Node caches modules) and to ignore failures — it's a pure optimization.
   */
  async prewarm(): Promise<void> {
    if (this.options.factory) return; // injected factory (tests) doesn't use these modules
    await Promise.allSettled([import('mineflayer'), import('mineflayer-pathfinder')]);
  }

  getState(): LauncherState {
    this.assertLoaded();
    const sessions: Record<string, BotSessionSnapshot> = {};
    for (const session of this.sessions.values()) {
      sessions[session.profile.id] = this.cloneSnapshot(session.snapshot);
    }
    return {
      profiles: this.profiles.map(redactProfileForBroadcast),
      sessions,
      runtime: this.runtimeSnapshot(),
      settings: cloneSettings(this.settings),
      selectedProfileId: this.selectedProfileId
    };
  }

  setWebDashboardUrl(url: string | null): void {
    this.webDashboardUrl = url;
    this.emitState();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<LauncherState> {
    this.assertLoaded();
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    await this.persist();
    this.emitState();
    return this.getState();
  }

  async saveProfile(input: SaveProfileInput): Promise<LauncherState> {
    this.assertLoaded();
    const id = input.id?.trim() || `session-${Date.now().toString(36)}`;
    const profile: AccountProfile = normalizeProfile({
      ...input,
      id,
      label: input.label.trim() || id.toUpperCase(),
      username: input.username.trim(),
      host: input.host.trim(),
      port: Number(input.port) || 25565,
      version: input.version || false,
      startup: normalizeStartup(input.startup),
      routine: normalizeRoutine(input.routine),
      reconnect: {
        ...input.reconnect,
        baseDelayMs: Math.max(1000, Number(input.reconnect.baseDelayMs) || 5000),
        maxDelayMs: Math.max(1000, Number(input.reconnect.maxDelayMs) || 90000),
        maxAttempts: Math.max(0, Number(input.reconnect.maxAttempts) || 0)
      }
    });

    const existing = this.profiles.findIndex((item) => item.id === id);
    const prior = existing >= 0 ? this.profiles[existing] : undefined;
    // The renderer never receives stored plaintext, so when it explicitly signals "unchanged"
    // (`authPasswordChanged === false`) we KEEP the prior secret instead of overwriting it with
    // the redacted '' it echoed back. An unset flag preserves the legacy "use the given value"
    // behaviour so non-renderer callers (and tests) still set passwords directly.
    if (input.authPasswordChanged === false) {
      profile.startup.authPassword = prior?.startup.authPassword ?? '';
    }
    if (profile.proxy && input.proxyPasswordChanged === false) {
      profile.proxy.password = prior?.proxy?.password ?? '';
    }

    if (existing >= 0) {
      this.profiles[existing] = profile;
    } else {
      this.profiles.push(profile);
    }
    this.selectedProfileId = profile.id;
    this.rebuildSessions();
    this.applySavedRoutineToRunningSession(this.sessions.get(profile.id));
    await this.writeProfileSecrets(profile);
    await this.persist();
    this.emitState();
    return this.getState();
  }

  async deleteProfile(profileId: string): Promise<LauncherState> {
    this.assertLoaded();
    await this.disconnect(profileId);
    this.profiles = this.profiles.filter((profile) => profile.id !== profileId);
    this.selectedProfileId = this.selectedProfileId === profileId ? this.profiles[0]?.id ?? null : this.selectedProfileId;
    this.sessions.delete(profileId);
    await this.vault.delete(authSecretKey(profileId));
    await this.vault.delete(proxySecretKey(profileId));
    await this.persist();
    this.emitState();
    return this.getState();
  }

  async selectProfile(profileId: string): Promise<LauncherState> {
    this.assertLoaded();
    if (this.sessions.has(profileId)) {
      this.selectedProfileId = profileId;
      await this.persist();
      this.emitState();
    }
    return this.getState();
  }

  async connect(profileId: string): Promise<LauncherState> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    if (session.bot || session.snapshot.state === 'connecting') return this.getState();
    session.desiredStop = false;
    session.startupCompleted = false;
    this.clearReconnect(session);
    this.clearStartupFlow(session);
    if (!session.profile.username.trim()) {
      const message = 'Username is required before connecting.';
      session.snapshot.lastError = message;
      this.updateStatus(session, 'error', 'Username required');
      this.pushEvent(session, 'error', 'warn', 'Connection blocked', message);
      this.emitState();
      return this.getState();
    }
    this.updateStatus(session, 'connecting', 'Connecting to server');
    this.pushEvent(session, 'system', 'info', 'Connect requested', `${session.profile.host}:${session.profile.port}`);

    try {
      const bot = await this.createBot(session.profile);
      session.bot = bot;
      this.attachBotEvents(session, bot);
      this.updateLiveTelemetry(session);
    } catch (error) {
      const message = formatError(error);
      session.snapshot.lastError = message;
      this.updateStatus(session, 'error', 'Connection failed');
      this.pushEvent(session, 'error', 'danger', 'Connection failed', message);
      if (!(error instanceof UnsupportedMinecraftVersionError)) {
        this.scheduleReconnect(session);
      }
    }
    this.emitState();
    return this.getState();
  }

  async disconnect(profileId: string): Promise<LauncherState> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    session.desiredStop = true;
    this.clearReconnect(session);
    this.clearStartupFlow(session);
    session.startupCompleted = false;
    session.foodGuardActive = false;
    session.hungerPaused = false;
    session.routine?.stop();
    session.routine = null;
    this.stopAllOperations(session);
    // Operator-initiated stop: forget resume state so the reconnect path won't restart anything.
    session.resumeOps.clear();
    session.involuntaryDrop = false;
    this.stopDiscordPolling(session);
    const bot = session.bot;
    if (bot) {
      this.updateStatus(session, 'stopping', 'Stopping session');
      // quit() can fire 'end' synchronously, and that handler nulls session.bot out from
      // under us — hold the instance locally so the teardown below always reaches it.
      bot.quit?.('Stopped from ChunkKeeper');
      abandonBot(bot);
      session.bot = null;
    }
    session.snapshot.routineActive = false;
    session.snapshot.startupActive = false;
    session.snapshot.connectedAt = null;
    session.snapshot.nextReconnectAt = null;
    this.updateStatus(session, 'offline', 'Stopped');
    this.pushEvent(session, 'system', 'muted', 'Disconnected');
    this.emitState();
    return this.getState();
  }

  async startAll(): Promise<LauncherState> {
    this.assertLoaded();
    const enabled = this.profiles.filter((item) => item.enabled);
    const stagger = Math.max(0, this.settings.connectStaggerMs);
    for (let index = 0; index < enabled.length; index += 1) {
      if (index > 0 && stagger > 0) {
        await delay(stagger);
      }
      await this.connect(enabled[index].id);
    }
    return this.getState();
  }

  async stopAll(): Promise<LauncherState> {
    this.assertLoaded();
    for (const profile of this.profiles) {
      await this.disconnect(profile.id);
    }
    return this.getState();
  }

  async sendChat(profileId: string, message: string): Promise<LauncherState> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    const normalized = message.trim();
    if (!normalized) return this.getState();
    if (!session.bot || session.snapshot.state !== 'online') {
      this.pushChat(session, 'system', 'Chat was not sent because this session is offline.');
      this.emitState();
      return this.getState();
    }
    session.bot.chat?.(normalized);
    this.pushChat(session, 'bot', normalized);
    this.pushEvent(session, 'chat', 'info', 'Chat sent', redactSensitiveText(normalized));
    this.emitState();
    return this.getState();
  }

  async startOperation(profileId: string, request: OperationStartRequest): Promise<LauncherState> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    if (!session.bot || session.snapshot.state !== 'online') {
      this.blockOperation(session, request.kind, 'Bot must be online before this operation can start.');
      this.emitState();
      return this.getState();
    }

    const modules = session.profile.modules ?? normalizeModules();
    this.stopOperationTimer(session, request.kind);

    switch (request.kind) {
      case 'cactusFarm': {
        const cfg = normalizeCactusFarm({ ...modules.cactusFarm, ...request.config });
        this.startCactusFarm(session, session.bot, cfg);
        this.rememberResume(session, 'cactusFarm', cfg);
        break;
      }
      case 'cropFarm': {
        const cfg = normalizeCropFarm({ ...modules.cropFarm, ...request.config });
        this.startCropFarm(session, session.bot, cfg);
        this.rememberResume(session, 'cropFarm', cfg);
        break;
      }
      case 'area': {
        const cfg = normalizeAreaOperation({ ...modules.area, ...(request.config as Partial<AreaOperationConfig> | undefined) });
        this.startAreaOperation(session, session.bot, cfg);
        this.rememberResume(session, 'area', cfg);
        break;
      }
      case 'generator': {
        const cfg = normalizeGeneratorMine({ ...modules.generator, ...(request.config as Partial<GeneratorMineConfig> | undefined) });
        this.startGeneratorFarm(session, session.bot, cfg);
        this.rememberResume(session, 'generator', cfg);
        break;
      }
      case 'script':
        this.startScriptLoop(session, session.bot, normalizeScript({ ...modules.script, ...request.config }));
        break;
      case 'discord':
        this.updateOperation(session, 'discord', 'running', 'Discord bridge armed', { total: null });
        break;
      default:
        this.blockOperation(session, request.kind, 'Unsupported operation.');
    }

    this.emitState();
    return this.getState();
  }

  async stopOperation(profileId: string, kind: OperationKind): Promise<LauncherState> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    this.stopOperationTimer(session, kind);
    session.operationQueues.delete(kind);
    session.operationRetry.delete(kind);
    session.operationPass.delete(kind);
    // Operator-initiated stop: forget the resume record so a later reconnect won't restart it.
    session.resumeOps.delete(kind);
    session.storageCooldownUntil.delete(kind);
    this.updateOperation(session, kind, 'idle', 'Stopped by operator', { completed: 0, total: null });
    this.emitState();
    return this.getState();
  }

  async runQuickScript(profileId: string, command: string): Promise<LauncherState> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    const normalized = command.trim();
    if (!normalized) return this.getState();
    if (!session.bot || session.snapshot.state !== 'online') {
      this.blockOperation(session, 'script', 'Quick script command requires an online bot.');
      this.emitState();
      return this.getState();
    }
    session.bot.chat?.(normalized);
    this.pushChat(session, 'bot', normalized);
    this.pushEvent(session, 'script', 'info', 'Quick script sent', redactSensitiveText(normalized));
    void this.notifyDiscord(session, `Quick script: ${redactSensitiveText(normalized)}`, 'event');
    this.emitState();
    return this.getState();
  }

  async inventoryAction(profileId: string, request: InventoryActionRequest): Promise<LauncherState> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    const bot = session.bot;
    if (!bot || session.snapshot.state !== 'online') {
      this.pushEvent(session, 'inventory', 'warn', 'Inventory action skipped', 'Bot must be online.');
      this.emitState();
      return this.getState();
    }

    // The grid sends indices relative to whichever window is open; resolve live items from it.
    const activeWindow = bot.currentWindow ?? bot.inventory;
    const held = bot.heldItem ?? null;
    const slotItem = (slot: number): InventoryItemLike | null => activeWindow?.slots?.[slot] ?? null;

    try {
      switch (request.action) {
        case 'dropOne': {
          const item = slotItem(request.slot);
          if (!item || typeof item.type !== 'number' || typeof bot.toss !== 'function') {
            this.pushEvent(session, 'inventory', 'muted', 'Nothing to drop', `Slot ${request.slot}`);
            break;
          }
          await withTimeout(
            Promise.resolve(bot.toss(item.type, item.metadata ?? null, 1)),
            INVENTORY_ACTION_TIMEOUT_MS,
            'toss'
          );
          this.pushEvent(session, 'inventory', 'info', 'Dropped item', `${itemLabel(item)} x1`);
          break;
        }
        case 'dropStack': {
          const item = slotItem(request.slot);
          if (!item || typeof bot.tossStack !== 'function') {
            this.pushEvent(session, 'inventory', 'muted', 'Nothing to drop', `Slot ${request.slot}`);
            break;
          }
          await withTimeout(Promise.resolve(bot.tossStack(item)), INVENTORY_ACTION_TIMEOUT_MS, 'tossStack');
          this.pushEvent(session, 'inventory', 'info', 'Dropped stack', `${itemLabel(item)} x${Math.max(1, Number(item.count) || 1)}`);
          break;
        }
        case 'move': {
          if (typeof bot.moveSlotItem !== 'function') break;
          await withTimeout(
            Promise.resolve(bot.moveSlotItem(request.from, request.to)),
            INVENTORY_ACTION_TIMEOUT_MS,
            'moveSlotItem'
          );
          this.pushEvent(session, 'inventory', 'muted', 'Moved item', `slot ${request.from} → ${request.to}`);
          break;
        }
        case 'transfer': {
          if (typeof bot.clickWindow !== 'function') break;
          // mode 1 = shift-click quick move between the container and the player inventory.
          await withTimeout(Promise.resolve(bot.clickWindow(request.slot, 0, 1)), INVENTORY_ACTION_TIMEOUT_MS, 'transfer');
          this.pushEvent(session, 'inventory', 'muted', 'Transferred item', `Slot ${request.slot}`);
          break;
        }
        case 'equip': {
          const item = bot.inventory?.slots?.[request.slot] ?? null;
          if (!item || typeof bot.equip !== 'function') {
            this.pushEvent(session, 'inventory', 'muted', 'Nothing to equip', `Slot ${request.slot}`);
            break;
          }
          await withTimeout(
            Promise.resolve(bot.equip(item, request.destination)),
            INVENTORY_ACTION_TIMEOUT_MS,
            'equip'
          );
          this.pushEvent(session, 'inventory', 'ok', 'Equipped item', `${itemLabel(item)} → ${request.destination}`);
          break;
        }
        case 'unequip': {
          if (typeof bot.unequip !== 'function') break;
          await withTimeout(Promise.resolve(bot.unequip(request.destination)), INVENTORY_ACTION_TIMEOUT_MS, 'unequip');
          this.pushEvent(session, 'inventory', 'info', 'Unequipped slot', request.destination);
          break;
        }
        case 'selectHotbar': {
          if (typeof bot.setQuickBarSlot !== 'function') break;
          const hotbar = clamp(Number(request.hotbar), 0, 8, 0);
          bot.setQuickBarSlot(hotbar);
          this.pushEvent(session, 'inventory', 'muted', 'Selected hotbar slot', String(hotbar + 1));
          break;
        }
        case 'useHeld': {
          if (typeof bot.activateItem !== 'function') break;
          await Promise.resolve(bot.activateItem());
          // Release shortly after so right-click style uses (place/throw) complete and don't latch on.
          setTimeout(() => {
            try {
              bot.deactivateItem?.();
            } catch {
              /* best effort */
            }
          }, 200);
          this.pushEvent(session, 'inventory', 'info', 'Used held item', held ? itemLabel(held) : undefined);
          break;
        }
        case 'consume': {
          const item = bot.inventory?.slots?.[request.slot] ?? null;
          if (!item || typeof bot.equip !== 'function' || typeof bot.consume !== 'function') {
            this.pushEvent(session, 'inventory', 'muted', 'Nothing to consume', `Slot ${request.slot}`);
            break;
          }
          await withTimeout(Promise.resolve(bot.equip(item, 'hand')), INVENTORY_ACTION_TIMEOUT_MS, 'equip');
          await withTimeout(Promise.resolve(bot.consume()), INVENTORY_ACTION_TIMEOUT_MS, 'consume');
          this.pushEvent(session, 'inventory', 'ok', 'Consumed item', itemLabel(item));
          break;
        }
        default:
          break;
      }
      this.updateLiveTelemetry(session);
    } catch (error) {
      const message = formatError(error);
      session.snapshot.lastError = message;
      this.pushEvent(session, 'inventory', 'warn', 'Inventory action failed', message);
    }
    this.emitState();
    return this.getState();
  }

  /**
   * Resolve a chest coordinate for the "capture from bot" button: the container the bot is
   * looking at, else the nearest container within reach, else the bot's own standing position.
   * Returns null when the bot is offline. The renderer writes the result into the draft.
   */
  async capturePosition(profileId: string): Promise<PositionSnapshot | null> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    const bot = session.bot;
    if (!bot || session.snapshot.state !== 'online') return null;
    const looked = bot.blockAtCursor?.(5);
    if (looked && isContainerBlock(looked) && looked.position) {
      return { x: looked.position.x, y: looked.position.y, z: looked.position.z };
    }
    const near = bot.findBlock?.({ matching: (block) => isContainerBlock(block), maxDistance: 5 });
    if (near && near.position) {
      return { x: near.position.x, y: near.position.y, z: near.position.z };
    }
    const pos = botPosition(bot);
    return pos ? roundPosition(pos) : null;
  }

  async completeChat(profileId: string, partial: string): Promise<string[]> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    if (session.snapshot.state !== 'online') {
      return this.publishCompletions(session, []);
    }

    const local = this.localCompletions(session, partial);

    // Minecraft 1.13+ servers announce their full command list up front via
    // declare_commands, so the local graph is authoritative: resolve from it and
    // skip the serverbound tab_complete round-trip entirely. That round-trip is the
    // source of the "Server did not respond" failures — modern and proxied servers
    // resolve command names client-side and simply never answer it.
    if (session.commandNodes?.length) {
      return this.publishCompletions(session, local);
    }

    // No command graph (pre-1.13 or a graph-less proxy). Those servers may still
    // answer tab_complete, so ask — but stay silent on the common no-answer case and
    // fall back to whatever we can offer locally instead of spamming the event log.
    if (session.bot && typeof session.bot.tabComplete === 'function') {
      try {
        // assumeCommand=true so the server resolves it as a command (e.g. /s -> /spawn);
        // sendBlockInSight=false skips a needless block raycast.
        const result = await Promise.resolve(
          session.bot.tabComplete(partial, true, false, TAB_COMPLETE_TIMEOUT_MS)
        );
        const server = (Array.isArray(result) ? result : [])
          .map((item) => (typeof item === 'string' ? item : item?.match ?? ''))
          .map((item) => item.trim())
          .filter(Boolean);
        if (server.length > 0) {
          return this.publishCompletions(session, [...server, ...local]);
        }
      } catch {
        // Server never answered; fall through to the local fallback below.
      }
    }
    return this.publishCompletions(session, local);
  }

  private publishCompletions(session: ManagedSession, completions: string[]): string[] {
    const trimmed = dedupeStrings(completions).slice(0, MAX_TAB_COMPLETIONS);
    session.snapshot.tabCompletions = trimmed;
    this.emitState();
    return trimmed;
  }

  /**
   * Build tab-completion candidates from data we already hold locally: the server's
   * command graph, online player names, and the profile's configured commands. The
   * returned strings are drop-in replacements for the last whitespace-delimited token
   * of `partial` (the renderer swaps that token for the chosen suggestion).
   */
  private localCompletions(session: ManagedSession, partial: string): string[] {
    // Trim only the leading whitespace — a trailing space is meaningful (it means the
    // user has moved on to the next token), but a leading one must not shift indices.
    const tokens = partial.replace(/^\s+/, '').split(/\s+/);
    const lastToken = tokens[tokens.length - 1] ?? '';

    if (tokens.length <= 1) {
      // First token: complete the command name itself.
      const prefix = lastToken.replace(/^\//, '').toLowerCase();
      const candidates = new Set<string>();
      for (const name of topLevelCommands(session)) candidates.add(`/${name}`);
      for (const command of knownCommands(session.profile)) candidates.add(command);
      return [...candidates]
        .filter((candidate) => candidate.replace(/^\//, '').toLowerCase().startsWith(prefix))
        .sort(caseInsensitive);
    }

    // Later tokens: complete online player names plus any nested command literals.
    const prefix = lastToken.toLowerCase();
    const candidates = new Set<string>();
    for (const literal of nestedCommandLiterals(session, tokens)) candidates.add(literal);
    for (const name of onlinePlayerNames(session)) candidates.add(name);
    return [...candidates].filter((candidate) => candidate.toLowerCase().startsWith(prefix)).sort(caseInsensitive);
  }

  async configureDiscord(profileId: string, input: DiscordRuntimeInput): Promise<LauncherState> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    session.discordRuntime = {
      enabled: Boolean(input.enabled),
      webhookUrl: input.webhookUrl?.trim() ?? '',
      botToken: input.botToken?.trim() ?? '',
      channelId: input.channelId?.trim() || session.profile.modules?.discord.channelId || '',
      lastMessageId: null
    };
    this.updateDiscordPolling(session);
    this.updateOperation(
      session,
      'discord',
      session.discordRuntime.enabled ? 'running' : 'idle',
      session.discordRuntime.enabled ? 'Discord bridge configured for this runtime session' : 'Discord bridge disabled',
      { total: null }
    );
    this.pushEvent(
      session,
      'discord',
      session.discordRuntime.enabled ? 'ok' : 'muted',
      session.discordRuntime.enabled ? 'Discord bridge enabled' : 'Discord bridge disabled',
      discordRuntimeLabel(session.discordRuntime)
    );
    this.emitState();
    return this.getState();
  }

  private async persist(): Promise<void> {
    const store = this.options.store ?? new ProfileStore(this.options.userDataDir);
    await store.save({
      profiles: this.profiles.map(profileForPersistence),
      selectedProfileId: this.selectedProfileId,
      settings: this.settings
    });
  }

  /** Whether OS-backed secret encryption is available (drives the renderer's warning). */
  secretAvailable(): boolean {
    return this.vault.isAvailable();
  }

  /** Fill the in-memory profiles' blank secret fields from the encrypted vault after load. */
  private async rehydrateSecrets(): Promise<void> {
    for (const profile of this.profiles) {
      const auth = await this.vault.get(authSecretKey(profile.id));
      if (auth) profile.startup.authPassword = auth;
      const proxyPassword = await this.vault.get(proxySecretKey(profile.id));
      if (proxyPassword && profile.proxy) profile.proxy.password = proxyPassword;
    }
    // Drop ciphertext left behind by profiles deleted while the vault was unavailable.
    const liveKeys = this.profiles.flatMap((profile) => [authSecretKey(profile.id), proxySecretKey(profile.id)]);
    await this.vault.prune(liveKeys);
  }

  /** Encrypt+persist a profile's two secrets. Empty clears the stored key. */
  private async writeProfileSecrets(profile: AccountProfile): Promise<void> {
    await this.vault.set(authSecretKey(profile.id), profile.startup.authPassword ?? '');
    await this.vault.set(proxySecretKey(profile.id), profile.proxy?.password ?? '');
  }

  private rebuildSessions(): void {
    for (const profile of this.profiles) {
      const existing = this.sessions.get(profile.id);
      if (existing) {
        existing.profile = profile;
        continue;
      }
      this.sessions.set(profile.id, {
        profile,
        bot: null,
        routine: null,
        operationTimers: new Map(),
        operationQueues: new Map(),
        scriptCursor: 0,
        autoResponseCooldowns: new Map(),
        discordRuntime: {
          enabled: false,
          webhookUrl: '',
          botToken: '',
          channelId: '',
          lastMessageId: null
        },
        discordPollTimer: null,
        desiredStop: true,
        reconnectTimer: null,
        startupTimers: [],
        startupCancels: [],
        startupCompleted: false,
        foodGuardActive: false,
        hungerPaused: false,
        lastFoodWarningAt: 0,
        cropFarmOrigin: null,
        cactusFarmOrigin: null,
        generatorOrigin: null,
        areaAnchor: null,
        operationFailStreak: new Map(),
        operationRetry: new Map(),
        operationPass: new Map(),
        operationFrozen: new Map(),
        selfHealCount: new Map(),
        resumeAnchor: new Map(),
        storageCooldownUntil: new Map(),
        resumeOps: new Map(),
        involuntaryDrop: false,
        commandNodes: null,
        commandRoot: 0,
        snapshot: createSessionSnapshot(profile.id)
      });
    }
    for (const profileId of [...this.sessions.keys()]) {
      if (!this.profiles.some((profile) => profile.id === profileId)) {
        this.sessions.delete(profileId);
      }
    }
  }

  private async createBot(profile: AccountProfile): Promise<BotLike> {
    assertMineflayerDataSupportsVersion(profile.version || undefined);
    const factory = this.options.factory ?? defaultMineflayerFactory;
    const proxyConnector = profile.proxy?.enabled ? createProxyConnector(profile.proxy, profile.host, profile.port) : undefined;
    const bot = await factory({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      version: profile.version || undefined,
      auth: profile.authMode,
      profilesFolder: this.authSessionDir(),
      ...(proxyConnector ? { connect: proxyConnector } : {})
    });
    try {
      installResourcePackAutoAccept(bot);
    } catch (error) {
      // The bot owns a live socket even though connect() will never adopt it.
      abandonBot(bot);
      throw error;
    }
    return bot;
  }

  private attachBotEvents(session: ManagedSession, bot: BotLike): void {
    // Capture the server's command graph (Minecraft 1.13+) so tab completion can
    // resolve command names locally even when the server never answers tab_complete.
    bot._client?.on?.('declare_commands', (packet: unknown) => {
      session.commandNodes = parseCommandNodes(packet);
      session.commandRoot =
        typeof (packet as { rootIndex?: unknown })?.rootIndex === 'number'
          ? (packet as { rootIndex: number }).rootIndex
          : 0;
    });

    bot.on('spawn', () => {
      configurePathfinderMovements(bot);
      const shouldRunStartup = !session.snapshot.startupActive && !session.startupCompleted;
      session.snapshot.connectedAt = new Date().toISOString();
      session.snapshot.reconnectAttempts = 0;
      session.snapshot.nextReconnectAt = null;
      // We're back in the world: the previous drop/kick is resolved, so clear the
      // sticky error. Without this, lastError (set on every kick/connection failure but
      // never reset on success) keeps the footer's System pill stuck on "degraded" and
      // the Status pill showing a stale reason like "Disconnected" even while online.
      session.snapshot.lastError = null;
      if (!session.snapshot.startupActive) {
        this.updateStatus(session, 'online', 'Online');
      }
      this.pushEvent(session, 'system', 'ok', 'Joined server', session.profile.host);
      this.updateLiveTelemetry(session);
      void this.notifyDiscord(session, `${session.profile.label} joined ${session.profile.host}`, 'event');
      void this.handleFoodGuard(session, bot);
      if (shouldRunStartup) {
        this.runStartupFlow(session, bot);
      }
      this.emitState();
    });

    bot.on('health', () => {
      this.updateLiveTelemetry(session);
      if (typeof bot.health === 'number' && bot.health <= 8) {
        void this.notifyDiscord(session, `${session.profile.label} health is ${bot.health}/20`, 'event');
      }
      void this.handleFoodGuard(session, bot);
      this.emitState();
    });

    bot.on('move', () => {
      this.updateLiveTelemetry(session);
    });

    bot.on('windowOpen', () => {
      this.updateLiveTelemetry(session);
      this.pushEvent(session, 'inventory', 'info', 'Window opened', session.snapshot.inventory.openWindowTitle ?? undefined);
      this.emitState();
    });

    bot.on('windowClose', () => {
      this.updateLiveTelemetry(session);
      this.pushEvent(session, 'inventory', 'muted', 'Window closed');
      this.emitState();
    });

    bot.on('heldItemChanged', () => {
      this.updateLiveTelemetry(session);
      this.emitState();
    });

    bot.on('inventoryUpdate', () => {
      this.updateLiveTelemetry(session);
      this.emitState();
    });

    bot.on('messagestr', (message: string) => {
      this.pushChat(session, 'server', message);
      void this.notifyDiscord(session, message, 'chat');
      this.emitState();
    });

    // Player chat is already captured/notified by the 'messagestr' handler above
    // (in the server's native rendering). Here we only drive auto-responses so the
    // same line doesn't appear twice in the chat console.
    bot.on('chat', (username: string, message: string) => {
      this.handleAutoResponse(session, username, message);
    });

    bot.on('death', () => {
      this.pushEvent(session, 'respawn', 'warn', 'Death detected', session.profile.routine.autoRespawn ? 'Auto-respawn queued' : undefined);
      if (session.profile.routine.autoRespawn) {
        setTimeout(() => {
          bot.respawn?.();
          this.pushEvent(session, 'respawn', 'ok', 'Respawn requested');
          this.emitState();
        }, 3000);
      }
      this.emitState();
    });

    bot.on('kicked', (reason: unknown) => {
      const detail = stringifyReason(reason);
      session.snapshot.lastError = detail;
      this.updateStatus(session, 'warning', 'Kicked');
      this.pushEvent(session, 'kick', 'warn', 'Kicked', detail);
      void this.notifyDiscord(session, `${session.profile.label} kicked: ${detail}`, 'event');
      this.emitState();
    });

    bot.on('error', (error: unknown) => {
      const message = formatError(error);
      session.snapshot.lastError = message;
      this.updateStatus(session, 'error', 'Bot error');
      this.pushEvent(session, 'error', 'danger', 'Bot error', message);
      void this.notifyDiscord(session, `${session.profile.label} error: ${message}`, 'event');
      this.emitState();
    });

    bot.on('end', () => {
      session.routine?.stop();
      session.routine = null;
      this.stopAllOperations(session);
      this.stopDiscordPolling(session);
      this.clearStartupFlow(session);
      session.startupCompleted = false;
      session.foodGuardActive = false;
      session.hungerPaused = false;
      session.commandNodes = null;
      session.commandRoot = 0;
      session.bot = null;
      session.snapshot.tabCompletions = [];
      session.snapshot.startupActive = false;
      session.snapshot.routineActive = false;
      session.snapshot.connectedAt = null;
      if (session.desiredStop) {
        this.updateStatus(session, 'offline', 'Offline');
      } else {
        // Involuntary drop: stopAllOperations flipped ops to idle, but resumeOps survives so the
        // farms that were running get re-launched (behind a world-validation gate) after reconnect.
        session.involuntaryDrop = true;
        this.updateStatus(session, 'reconnecting', 'Disconnected');
        this.scheduleReconnect(session);
      }
      void this.notifyDiscord(session, `${session.profile.label} disconnected`, 'event');
      this.emitState();
    });
  }

  /** True while an operation that drives the bot's movement/aim is running. */
  private hasActiveDrivingOperation(session: ManagedSession): boolean {
    const ops = session.snapshot.operations;
    return (
      ops.cactusFarm.state === 'running' ||
      ops.cropFarm.state === 'running' ||
      ops.area.state === 'running' ||
      ops.generator.state === 'running'
    );
  }

  private startRoutine(session: ManagedSession, bot: BotLike): void {
    session.routine?.stop();
    if (this.shouldHoldRoutineForHunger(session, bot)) {
      session.startupCompleted = true;
      session.snapshot.startupActive = false;
      this.pauseRoutineForHunger(session, bot.food ?? session.profile.routine.pauseAtFood);
      return;
    }
    session.routine = new AfkRoutine(session.profile.id, bot, session.profile.routine, {
      emitEvent: (event) => {
        this.pushEvent(session, event.type, event.tone, event.label, event.detail);
        this.emitState();
      },
      // The anti-AFK jiggle exists for IDLE bots. While an operation is walking/placing,
      // a random forced look or a jump pulse lands mid-goto and corrupts the pathfinder
      // (walks time out, builds crawl) — and the operation itself is anti-AFK anyway.
      shouldHold: () => this.hasActiveDrivingOperation(session)
    });
    session.routine.start();
    session.startupCompleted = true;
    session.snapshot.startupActive = false;
    session.snapshot.routineActive = true;
    // Online and join flow complete: re-launch farms that were running before an involuntary drop.
    this.resumeOperationsAfterReconnect(session, bot);
  }

  private applySavedRoutineToRunningSession(session?: ManagedSession): void {
    if (!session?.bot || session.desiredStop || !session.startupCompleted || session.snapshot.startupActive) return;
    if (!session.routine && !session.snapshot.routineActive) return;
    this.startRoutine(session, session.bot);
    this.pushEvent(session, 'system', 'info', 'Routine updated', 'Saved profile settings applied');
  }

  private async handleFoodGuard(session: ManagedSession, bot: BotLike): Promise<void> {
    const routine = session.profile.routine;
    if (session.bot !== bot || session.desiredStop || !routine.autoEat) return;

    const food = typeof bot.food === 'number' ? bot.food : null;
    if (food == null) return;

    const eatAtFood = clamp(Number(routine.eatAtFood), 1, 19, 14);
    const pauseAtFood = Math.min(eatAtFood, clamp(Number(routine.pauseAtFood), 0, 19, 6));
    if (food > eatAtFood) {
      this.resumeAfterHungerRecovery(session, bot);
      return;
    }

    if (session.foodGuardActive) return;

    const foodItem = findBestFoodItem(bot.inventory?.items?.() ?? [], bot.registry);
    if (!foodItem || typeof bot.equip !== 'function' || typeof bot.consume !== 'function') {
      this.warnOrPauseForMissingFood(session, food, pauseAtFood, Boolean(foodItem));
      return;
    }

    session.foodGuardActive = true;
    bot.setControlState?.('jump', false);
    bot.setControlState?.('sneak', false);
    this.pushEvent(session, 'eat', 'info', 'Eating food', `${itemLabel(foodItem)} at ${food}/20 hunger`);
    this.emitState();

    try {
      await Promise.resolve(bot.equip(foodItem, 'hand'));
      await Promise.resolve(bot.consume());
      this.updateLiveTelemetry(session);
      this.pushEvent(session, 'eat', 'ok', 'Food consumed', itemLabel(foodItem));
      this.resumeAfterHungerRecovery(session, bot);
    } catch (error) {
      const message = formatError(error);
      session.snapshot.lastError = message;
      this.pushEvent(session, 'eat', 'warn', 'Auto-eat failed', message);
      if ((bot.food ?? food) <= pauseAtFood) {
        this.pauseRoutineForHunger(session, bot.food ?? food);
      }
    } finally {
      session.foodGuardActive = false;
      this.emitState();
    }
  }

  private shouldHoldRoutineForHunger(session: ManagedSession, bot: BotLike): boolean {
    const routine = session.profile.routine;
    if (!routine.autoEat || typeof bot.food !== 'number') return false;
    const pauseAtFood = Math.min(
      clamp(Number(routine.eatAtFood), 1, 19, 14),
      clamp(Number(routine.pauseAtFood), 0, 19, 6)
    );
    return bot.food <= pauseAtFood && !findBestFoodItem(bot.inventory?.items?.() ?? [], bot.registry);
  }

  private warnOrPauseForMissingFood(
    session: ManagedSession,
    food: number,
    pauseAtFood: number,
    hasFoodItem: boolean
  ): void {
    const now = Date.now();
    const missingCapability = hasFoodItem ? 'Mineflayer eat API unavailable' : 'No edible inventory item found';
    if (food <= pauseAtFood) {
      this.pauseRoutineForHunger(session, food, missingCapability);
      this.emitState();
      return;
    }
    if (now - session.lastFoodWarningAt >= FOOD_WARNING_INTERVAL_MS) {
      session.lastFoodWarningAt = now;
      this.pushEvent(session, 'eat', 'warn', 'Low hunger', `${food}/20 hunger. ${missingCapability}.`);
      this.emitState();
    }
  }

  private pauseRoutineForHunger(session: ManagedSession, food: number, reason = 'No edible inventory item found'): void {
    if (session.hungerPaused) return;
    session.routine?.stop();
    session.routine = null;
    session.hungerPaused = true;
    session.lastFoodWarningAt = Date.now();
    session.snapshot.routineActive = false;
    this.updateStatus(session, 'warning', 'Low hunger - food needed');
    this.pushEvent(session, 'eat', 'danger', 'Food required', `${food}/20 hunger. ${reason}; routine paused.`);
  }

  private resumeAfterHungerRecovery(session: ManagedSession, bot: BotLike): void {
    if (!session.hungerPaused || session.bot !== bot || session.desiredStop) return;
    session.hungerPaused = false;
    this.updateStatus(session, 'online', 'Online');
    this.pushEvent(session, 'eat', 'ok', 'Hunger recovered', `${bot.food ?? 'unknown'}/20 hunger`);
    if (session.startupCompleted && !session.routine) {
      this.startRoutine(session, bot);
    }
  }

  private runStartupFlow(session: ManagedSession, bot: BotLike): void {
    this.clearStartupFlow(session);
    const startup = session.profile.startup;
    if (!startup.enabled) {
      this.startRoutine(session, bot);
      return;
    }

    const authCommand = renderAuthCommand(startup);
    const authLabel = startup.authMode === 'register' ? 'Lobby register sent' : 'Lobby auth sent';
    const transferCommand = startup.transferCommand.trim();
    const flowCommands = startup.flowCommands.map((step) => ({ ...step, command: step.command.trim() })).filter((step) => step.command);
    const hasAuthCommand = Boolean(authCommand);
    const hasTransferCommand = Boolean(transferCommand);
    const hasFlowCommands = flowCommands.length > 0;

    if (!hasAuthCommand && !hasTransferCommand && !hasFlowCommands) {
      this.pushEvent(session, 'system', 'muted', 'Join flow skipped', 'No commands configured');
      this.startRoutine(session, bot);
      return;
    }

    session.snapshot.startupActive = true;
    session.snapshot.routineActive = false;
    this.updateStatus(session, 'online', 'Running join flow');
    this.pushEvent(session, 'system', 'info', 'Join flow started', describeStartupFlow(startup));

    if (!hasAuthCommand && authRequiresPassword(startup) && !startup.authPassword) {
      this.pushEvent(session, 'system', 'warn', 'Lobby auth skipped', 'Password is empty');
    }

    // The flow is a chain of gated steps. Each gate resolves on its configured server signal
    // (readyPatterns / authSuccessPatterns) OR its delay cap, whichever comes first — so with
    // signals configured the join is as fast as the server responds, and with none it falls back
    // to exactly the old fixed-delay cadence (same total wall-clock, same step order). Built
    // back-to-front so every step schedules the next one from its own tail.
    const finish = (): void => {
      this.pushEvent(session, 'system', 'ok', 'Join flow complete');
      this.updateStatus(session, 'online', 'Online');
      this.startRoutine(session, bot);
      this.emitState();
    };

    let next: () => void = () => this.scheduleStartupStep(session, bot, { capMs: 500 }, finish);

    for (let index = flowCommands.length - 1; index >= 0; index--) {
      const step = flowCommands[index];
      const after = next;
      next = () =>
        this.scheduleStartupStep(session, bot, { capMs: step.delayMs }, () => {
          bot.chat?.(step.command);
          this.pushEvent(session, 'chat', 'info', step.label || 'Flow command sent', redactSensitiveText(step.command));
          this.emitState();
          after();
        });
    }

    // Transfer gate — always waited (even with no transfer command) to preserve prior timing;
    // resolves early on an auth-success signal.
    const afterTransfer = next;
    next = () =>
      this.scheduleStartupStep(
        session,
        bot,
        { capMs: startup.transferDelayMs, patterns: startup.authSuccessPatterns },
        () => {
          if (hasTransferCommand) {
            bot.chat?.(transferCommand);
            this.pushEvent(session, 'chat', 'info', 'Server transfer sent', transferCommand);
            this.emitState();
          }
          afterTransfer();
        }
      );

    // Auth gate — resolves early on a lobby-ready signal.
    const afterAuth = next;
    next = () =>
      this.scheduleStartupStep(
        session,
        bot,
        { capMs: startup.authDelayMs, patterns: startup.readyPatterns },
        () => {
          if (hasAuthCommand) {
            bot.chat?.(authCommand);
            this.pushEvent(session, 'chat', 'info', authLabel, redactCommand(authCommand, startup.authPassword));
            this.emitState();
          }
          afterAuth();
        }
      );

    next();
  }

  /**
   * Run one join-flow step after its gate opens: either a matching server chat line (`patterns`)
   * or `capMs` elapses, whichever is first. Registers its timer/listener teardown so
   * {@link clearStartupFlow} can abort a pending step on disconnect/rebind.
   */
  private scheduleStartupStep(
    session: ManagedSession,
    bot: BotLike,
    gate: { capMs: number; patterns?: string[] },
    action: () => void
  ): void {
    if (session.bot !== bot || session.desiredStop) return;
    const patterns = compileStartupPatterns(gate.patterns);
    let settled = false;
    const teardown = (): void => {
      clearTimeout(timer);
      if (patterns.length) bot.off('messagestr', onMessage);
      const index = session.startupCancels.indexOf(teardown);
      if (index >= 0) session.startupCancels.splice(index, 1);
    };
    const fire = (): void => {
      if (settled) return;
      settled = true;
      teardown();
      if (session.bot !== bot || session.desiredStop) return;
      action();
    };
    const onMessage = (text: unknown): void => {
      if (typeof text === 'string' && patterns.some((pattern) => pattern.test(text))) fire();
    };
    const timer = setTimeout(fire, Math.max(0, gate.capMs));
    session.startupTimers.push(timer);
    session.startupCancels.push(teardown);
    if (patterns.length) bot.on('messagestr', onMessage);
  }

  private clearStartupFlow(session: ManagedSession): void {
    for (const cancel of [...session.startupCancels]) {
      cancel();
    }
    session.startupCancels = [];
    for (const timer of session.startupTimers) {
      clearTimeout(timer);
    }
    session.startupTimers = [];
    session.snapshot.startupActive = false;
  }

  private scheduleReconnect(session: ManagedSession): void {
    if (session.desiredStop || !session.profile.reconnect.enabled) return;
    // maxAttempts 0 (the normalizer's default) means UNLIMITED — treating it as a hard
    // limit made every default-configured profile give up on the very first drop.
    const maxAttempts = session.profile.reconnect.maxAttempts;
    if (maxAttempts > 0 && session.snapshot.reconnectAttempts >= maxAttempts) {
      this.updateStatus(session, 'error', 'Reconnect limit reached');
      return;
    }
    session.snapshot.reconnectAttempts += 1;
    const attempt = session.snapshot.reconnectAttempts;
    const delay = Math.min(
      session.profile.reconnect.maxDelayMs,
      session.profile.reconnect.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1))
    );
    const next = new Date(Date.now() + delay);
    session.snapshot.nextReconnectAt = next.toISOString();
    this.updateStatus(session, 'reconnecting', `Reconnect in ${Math.ceil(delay / 1000)}s`);
    this.pushEvent(session, 'reconnect', 'warn', 'Reconnect queued', `attempt ${attempt}/${session.profile.reconnect.maxAttempts}`);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      void this.connect(session.profile.id);
    }, delay);
  }

  private clearReconnect(session: ManagedSession): void {
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
    session.snapshot.nextReconnectAt = null;
  }

  private startCactusFarm(session: ManagedSession, bot: BotLike, config: CactusFarmConfig): void {
    const anchor = session.resumeAnchor.get('cactusFarm');
    session.resumeAnchor.delete('cactusFarm');
    const origin = anchor ?? botPosition(bot);
    if (!origin) {
      this.blockOperation(session, 'cactusFarm', 'Bot position is unavailable.');
      return;
    }
    session.cactusFarmOrigin = origin;
    if (config.build) {
      // Ground pre-flight: the bot works from stance lanes all around the basin(s), and
      // pathfinder wobble reaches one cell further — a missing floor there means a fall
      // (observed live: the bot walked off a platform edge and dropped 60 blocks).
      // Only LOADED air counts as missing; unloaded chunks are unknown-and-allowed.
      const columns = Math.max(1, Math.floor(config.columns ?? 1));
      const ringZMin = -4;
      const ringZMax = 4 * config.rowPairs + 1;
      const xMax = (columns - 1) * CACTUS_COLUMN_SPACING + 12;
      let missing = 0;
      if (typeof bot.blockAt === 'function') {
        for (let x = -6; x <= xMax; x++) {
          for (let z = ringZMin - 2; z <= ringZMax + 2; z++) {
            const block = bot.blockAt(toVec3(addPosition(origin, { x, y: -1, z })));
            if (block && isAirBlock(block)) missing += 1;
          }
        }
      }
      if (missing > 0) {
        this.blockOperation(
          session,
          'cactusFarm',
          `Ground is missing under the farm footprint (${missing} cells). Flatten the area (including ~4 blocks of margin on every side) first.`
        );
        return;
      }
    }
    const plan = cactusFarmPlan(origin, config);
    if (plan.length > MAX_OPERATION_VOLUME) {
      this.blockOperation(
        session,
        'cactusFarm',
        `Plan is too large: ${plan.length}/${MAX_OPERATION_VOLUME} steps. Reduce rowPairs, columns or basinLayers.`
      );
      return;
    }
    const needs = cactusMaterialNeeds(plan);
    const missing = Object.entries(needs)
      .map(([itemName, need]) => ({ itemName, need, have: inventoryItemCount(bot, itemName) }))
      .filter((entry) => entry.have < entry.need);
    if (missing.length > 0) {
      const detail = missing.map((entry) => `${entry.itemName} ${entry.have}/${entry.need}`).join(', ');
      this.blockOperation(session, 'cactusFarm', `Missing materials: ${detail}.`);
      return;
    }
    session.operationQueues.set('cactusFarm', plan);
    this.updateOperation(
      session,
      'cactusFarm',
      'running',
      config.build ? 'Building automatic cactus farm' : 'Planting cactus columns',
      {
        completed: 0,
        total: plan.length,
        stats: needs
      }
    );
    this.scheduleOperationQueue(session, bot, 'cactusFarm', config.placementDelayMs);
  }

  private startCropFarm(session: ManagedSession, bot: BotLike, config: CropFarmConfig): void {
    const anchor = session.resumeAnchor.get('cropFarm');
    session.resumeAnchor.delete('cropFarm');
    session.cropFarmOrigin = anchor ?? null;
    if (!config.build || !isFarmlandCrop(config.crop)) {
      if (config.build && !isFarmlandCrop(config.crop)) {
        this.pushEvent(session, 'farm', 'warn', 'Crop build skipped', `${cropLabel(config.crop)} farmland'e dikilmez, hasat döngüsüne geçiliyor.`);
      }
      this.beginCropHarvest(session, bot, config);
      return;
    }
    const origin = anchor ?? botPosition(bot);
    if (!origin) {
      this.blockOperation(session, 'cropFarm', 'Bot position is unavailable.');
      return;
    }
    const plan = cropBuildPlan(origin, config);
    const seed = cropSeedName(config.crop);

    // Material check: enough seeds for every cell, a hoe when auto-tilling.
    const seedHave = inventoryItemCount(bot, seed);
    const missing: string[] = [];
    if (seedHave < plan.plant.length) missing.push(`${seed} ${seedHave}/${plan.plant.length}`);
    if (config.autoTill && !findHoe(bot)) missing.push('hoe 0/1');

    // Decide on water before tilling. The plan lays water sources on an 8-spaced lattice so
    // every cell stays hydrated even for large radii; auto-water needs one bucket per dry cell.
    const cellIsWet = (cell: PositionSnapshot): boolean =>
      (typeof bot.blockAt === 'function' ? bot.blockAt(toVec3(cell)) : null)?.name === 'water';
    let waterSteps: OperationWorkItem[] = [];
    if (config.waterMode === 'auto') {
      const dryWaterCells = plan.waterCells.filter((cell) => !cellIsWet(cell));
      if (dryWaterCells.length > 0) {
        const buckets = inventoryItemCount(bot, 'water_bucket');
        if (buckets < dryWaterCells.length) missing.push(`water_bucket ${buckets}/${dryWaterCells.length}`);
        waterSteps = dryWaterCells.flatMap((cell) => [
          { action: 'dig', position: cell, walk: true },
          { action: 'water', position: cell }
        ]);
      }
    }

    if (missing.length > 0) {
      this.blockOperation(session, 'cropFarm', `Missing materials: ${missing.join(', ')}.`);
      return;
    }
    if (config.waterMode === 'existing' && !plan.waterCells.some(cellIsWet)) {
      this.pushEvent(session, 'farm', 'warn', 'No water found', 'Tarlaya su kaynağı ekleyin, aksi halde ürünler çok yavaş büyür.');
    }

    const queue = [...plan.prepare, ...waterSteps, ...plan.plant];
    session.cropFarmOrigin = origin;
    session.operationQueues.set('cropFarm', queue);
    this.updateOperation(session, 'cropFarm', 'running', `Building ${cropLabel(config.crop)} farm`, {
      completed: 0,
      total: queue.length,
      stats: { tilled: 0, watered: 0, planted: 0 }
    });
    this.scheduleOperationQueue(session, bot, 'cropFarm', config.harvestDelayMs, () => {
      this.pushEvent(session, 'farm', 'ok', 'Crop farm built', `${plan.plant.length} cell ${cropLabel(config.crop)} tarlası hazır.`);
      this.beginCropHarvest(session, bot, config);
    });
  }

  private beginCropHarvest(session: ManagedSession, bot: BotLike, config: CropFarmConfig): void {
    this.updateOperation(session, 'cropFarm', 'running', `${cropLabel(config.crop)} hasat döngüsü aktif`, {
      completed: 0,
      total: null,
      stats: { harvested: 0, replanted: 0, collected: 0 }
    });
    const tick = () => {
      if (session.bot !== bot || session.snapshot.operations.cropFarm.state !== 'running') return;
      const reschedule = () => {
        if (session.bot === bot && session.snapshot.operations.cropFarm.state === 'running') {
          session.operationTimers.set('cropFarm', setTimeout(tick, config.harvestDelayMs));
        }
      };
      void (async () => {
        // Deposit harvest / restock seeds before harvesting again; skip this tick if it acts or pauses.
        if (!(await this.storageGate(session, bot, 'cropFarm', config))) {
          reschedule();
          return;
        }
        const origin = session.cropFarmOrigin ?? botPosition(bot);
        if (!origin) {
          this.blockOperation(session, 'cropFarm', 'Bot position is unavailable.');
          return;
        }
        await this.runCropFarmTick(session, bot, config, origin);
        reschedule();
      })().catch(() => reschedule());
    };
    tick();
  }

  private async runCropFarmTick(
    session: ManagedSession,
    bot: BotLike,
    config: CropFarmConfig,
    origin: PositionSnapshot
  ): Promise<void> {
    if (typeof bot.blockAt !== 'function' || typeof bot.dig !== 'function') {
      this.blockOperation(session, 'cropFarm', 'Mineflayer block/dig APIs are unavailable.');
      return;
    }
    // Scan for ripe crops first so the UI has a real total to draw a progress bar against,
    // instead of the old "total: null" that left the harvest phase looking stalled.
    const blockAt = bot.blockAt;
    const targets = positionsInBox(
      addPosition(origin, { x: -config.radius, y: -1, z: -config.radius }),
      addPosition(origin, { x: config.radius, y: 2, z: config.radius })
    ).filter((position) => {
      const block = blockAt(toVec3(position));
      return block != null && isMatureCrop(block, config.crop);
    });

    if (targets.length === 0) {
      this.updateOperation(session, 'cropFarm', 'running', `${cropLabel(config.crop)} — ürün olgunlaşıyor`, {
        completed: 0,
        total: 0
      });
      this.emitState();
      return;
    }

    const seed = cropSeedName(config.crop);
    let harvested = 0;
    let replanted = 0;
    for (const position of targets) {
      if (session.bot !== bot || session.snapshot.operations.cropFarm.state !== 'running') break;
      const block = blockAt(toVec3(position));
      if (!block || !isMatureCrop(block, config.crop)) continue;
      await this.walkWithinReach(bot, position);
      await Promise.resolve(bot.dig(block));
      harvested += 1;
      if (config.replant && seed && inventoryItemCount(bot, seed) > 0) {
        const placed = await this.placeItemAt(bot, seed, position);
        if (placed) replanted += 1;
      }
    }

    // completed/total reflect THIS tick (a live bar); stats.harvested keeps the lifetime rolling count.
    this.updateOperation(session, 'cropFarm', 'running', `${cropLabel(config.crop)} hasat (${harvested}/${targets.length})`, {
      completed: harvested,
      total: targets.length,
      stats: mergeStats(session.snapshot.operations.cropFarm.stats, {
        harvested,
        replanted,
        collected: config.collectDrops ? harvested : 0
      })
    });
    if (harvested > 0 || replanted > 0) {
      this.pushEvent(session, 'farm', 'ok', 'Crop farm tick', `${harvested} harvested, ${replanted} replanted`);
      this.updateLiveTelemetry(session);
    }
    this.emitState();
  }

  private startAreaOperation(session: ManagedSession, bot: BotLike, config: AreaOperationConfig): void {
    const anchor = session.resumeAnchor.get('area');
    session.resumeAnchor.delete('area');
    session.areaAnchor = anchor ?? botPosition(bot);
    let from = config.from;
    let to = config.to;
    if (config.coords === 'relative') {
      const origin = anchor ?? botPosition(bot);
      if (!origin) {
        this.blockOperation(session, 'area', 'Bot position is unavailable.');
        return;
      }
      from = addPosition(origin, config.from);
      to = addPosition(origin, config.to);
    } else {
      from = roundPosition(config.from);
      to = roundPosition(config.to);
    }
    const positions = areaPositions(from, to, config.mode, config.hollow);
    if (positions.length === 0) {
      this.blockOperation(session, 'area', 'Selected area is empty.');
      return;
    }
    if (positions.length > MAX_OPERATION_VOLUME) {
      this.blockOperation(session, 'area', `Area is too large: ${positions.length}/${MAX_OPERATION_VOLUME} blocks.`);
      return;
    }
    const work: OperationWorkItem[] = positions.map((position) => ({
      action: config.mode === 'fill' ? 'place' : 'dig',
      position,
      itemName: config.mode === 'fill' ? config.fillBlock : undefined,
      walk: config.walk
    }));
    session.operationQueues.set('area', work);
    const shape = config.hollow ? 'hollow' : 'solid';
    const verb = config.mode === 'fill' ? 'Filling' : 'Mining';
    this.updateOperation(session, 'area', 'running', `${verb} ${shape} area (${work.length} blocks)`, {
      completed: 0,
      total: work.length,
      stats: { blocks: work.length, done: 0, skipped: 0 }
    });
    this.scheduleOperationQueue(session, bot, 'area', config.actionDelayMs);
  }

  // The generator farm is a continuous loop, not a finite queue: it cycles over
  // the configured slots, mining each regenerating block as it reappears and
  // pausing regenDelayMs after every full pass so the blocks can re-form.
  private startGeneratorFarm(session: ManagedSession, bot: BotLike, config: GeneratorMineConfig): void {
    const origin = botPosition(bot);
    if (!origin) {
      this.blockOperation(session, 'generator', 'Bot position is unavailable.');
      return;
    }
    if (config.slots.length === 0) {
      this.blockOperation(session, 'generator', 'No generator slots configured.');
      return;
    }
    session.generatorOrigin = origin;
    const slots = config.slots.map((slot) => addPosition(origin, { x: slot.x, y: slot.y, z: slot.z }));
    this.updateOperation(
      session,
      'generator',
      'running',
      `Farming ${slots.length} generator slot${slots.length > 1 ? 's' : ''}`,
      {
        completed: 0,
        total: null,
        stats: { mined: 0, skipped: 0, passes: 0 }
      }
    );

    let index = 0;
    const tick = () => {
      if (session.bot !== bot || session.snapshot.operations.generator.state !== 'running') return;
      const scheduleNext = (delayMs: number) => {
        if (session.bot === bot && session.snapshot.operations.generator.state === 'running') {
          session.operationTimers.set('generator', setTimeout(tick, delayMs));
        }
      };
      void (async () => {
        // Deposit mined output before the next slot; if it acts/pauses, retry this slot next tick.
        if (!(await this.storageGate(session, bot, 'generator', config))) {
          scheduleNext(config.actionDelayMs);
          return;
        }
        const position = slots[index];
        const lastInPass = index === slots.length - 1;
        await this.runGeneratorSlot(session, bot, config, position);
        if (session.bot !== bot || session.snapshot.operations.generator.state !== 'running') return;
        if (lastInPass) this.addOperationStats(session, 'generator', { passes: 1 });
        index = (index + 1) % slots.length;
        scheduleNext(lastInPass ? config.actionDelayMs + config.regenDelayMs : config.actionDelayMs);
      })().catch(() => scheduleNext(config.actionDelayMs));
    };
    tick();
  }

  private async runGeneratorSlot(
    session: ManagedSession,
    bot: BotLike,
    config: GeneratorMineConfig,
    position: PositionSnapshot
  ): Promise<void> {
    try {
      if (typeof bot.blockAt !== 'function' || typeof bot.dig !== 'function') {
        this.blockOperation(session, 'generator', 'Mineflayer block/dig APIs are unavailable.');
        return;
      }
      if (config.walk) await this.walkWithinReach(bot, position);
      const block = bot.blockAt(toVec3(position));
      // Air or a block that hasn't regenerated into the expected type yet — wait.
      if (!block || isAirBlock(block) || (config.blockFilter && block.name !== config.blockFilter)) {
        this.addOperationStats(session, 'generator', { skipped: 1 });
        return;
      }
      await Promise.resolve(bot.dig(block));
      this.addOperationProgress(session, 'generator', 1, { mined: 1 });
      this.updateLiveTelemetry(session);
      this.emitState();
    } catch (error) {
      this.blockOperation(session, 'generator', formatError(error), 'error');
      this.emitState();
    }
  }

  private startScriptLoop(session: ManagedSession, bot: BotLike, config: ScriptConfig): void {
    if (config.steps.length === 0) {
      this.blockOperation(session, 'script', 'Script has no commands.');
      return;
    }
    session.scriptCursor = 0;
    this.updateOperation(session, 'script', 'running', config.loop ? 'Looping script' : 'Running script once', {
      completed: 0,
      total: config.loop ? null : config.steps.length,
      stats: { sent: 0 }
    });

    const tick = () => {
      if (session.bot !== bot || session.snapshot.operations.script.state !== 'running') return;
      const step = config.steps[session.scriptCursor];
      if (!step) {
        this.stopOperationTimer(session, 'script');
        this.updateOperation(session, 'script', 'complete', 'Script complete', { total: config.steps.length });
        this.emitState();
        return;
      }
      bot.chat?.(step.command);
      this.pushChat(session, 'bot', step.command);
      this.pushEvent(session, 'script', 'info', step.label, redactSensitiveText(step.command));
      this.addOperationStats(session, 'script', { sent: 1 });
      session.scriptCursor += 1;
      if (session.scriptCursor >= config.steps.length) {
        if (config.loop) {
          session.scriptCursor = 0;
        } else {
          this.stopOperationTimer(session, 'script');
          this.updateOperation(session, 'script', 'complete', 'Script complete', { total: config.steps.length });
          this.emitState();
          return;
        }
      }
      const nextStep = config.steps[session.scriptCursor] ?? config.steps[0];
      const timer = setTimeout(tick, Math.max(0, nextStep.delayMs));
      session.operationTimers.set('script', timer);
      this.emitState();
    };

    const firstStep = config.steps[0];
    const timer = setTimeout(tick, Math.max(0, firstStep.delayMs));
    session.operationTimers.set('script', timer);
  }

  private handleAutoResponse(session: ManagedSession, username: string, message: string): void {
    const bot = session.bot;
    const config = normalizeAutoResponse(session.profile.modules?.autoResponse);
    if (!bot || !config.enabled || typeof bot.chat !== 'function') return;
    if (bot.username && username === bot.username) return;

    const normalizedMessage = message.toLocaleLowerCase();
    const now = Date.now();
    for (const rule of config.rules) {
      if (!rule.enabled || !rule.match || !rule.response) continue;
      if (!normalizedMessage.includes(rule.match.toLocaleLowerCase())) continue;
      const lastSentAt = session.autoResponseCooldowns.get(rule.id) ?? 0;
      if (now - lastSentAt < rule.cooldownMs) {
        this.pushEvent(session, 'autoReply', 'muted', 'Auto response cooled down', rule.label);
        return;
      }
      session.autoResponseCooldowns.set(rule.id, now);
      bot.chat(rule.response);
      this.pushChat(session, 'bot', rule.response);
      this.pushEvent(session, 'autoReply', 'ok', 'Auto response sent', `${rule.label}: ${redactSensitiveText(rule.response)}`);
      void this.notifyDiscord(session, `Auto response ${rule.label}: ${redactSensitiveText(rule.response)}`, 'event');
      return;
    }
  }

  private scheduleOperationQueue(
    session: ManagedSession,
    bot: BotLike,
    kind: Extract<OperationKind, 'cactusFarm' | 'cropFarm' | 'area' | 'generator'>,
    delayMs: number,
    onDrained?: () => void
  ): void {
    session.operationRetry.set(kind, []);
    session.operationPass.set(kind, { pass: 1, progressed: 0, zeroStreak: 0 });
    const tick = () => {
      if (session.bot !== bot || session.snapshot.operations[kind].state !== 'running') return;
      const tickStart = Date.now();
      const reschedule = () => {
        if (session.bot === bot && session.snapshot.operations[kind].state === 'running') {
          // Deficit timing: subtract the work already spent this tick so `delayMs` is a minimum
          // inter-action spacing rather than an additive pause on top of walk/place time.
          const wait = Math.max(MIN_OPERATION_GAP_MS, delayMs - (Date.now() - tickStart));
          session.operationTimers.set(kind, setTimeout(tick, wait));
        }
      };
      void (async () => {
        // Storage gate first: restock/deposit before spending a queue item. If it acts (or pauses), skip this tick.
        if (!(await this.storageGate(session, bot, kind, this.resolvedConfig(session, kind)))) {
          reschedule();
          return;
        }
        const queue = session.operationQueues.get(kind) ?? [];
        const work = queue.shift();
        if (!work) {
          // Pass finished. Failed cells retry in a fresh pass (the bot repositions,
          // dependencies placed later in this pass now exist). Two consecutive
          // zero-progress passes mean the remaining cells are genuinely unbuildable.
          const retry = session.operationRetry.get(kind) ?? [];
          if (retry.length > 0) {
            const passState = session.operationPass.get(kind) ?? { pass: 1, progressed: 0, zeroStreak: 0 };
            const zeroStreak = passState.progressed === 0 ? passState.zeroStreak + 1 : 0;
            if (zeroStreak >= 2) {
              this.addOperationProgress(session, kind, retry.length, { skipped: retry.length });
              this.blockOperation(
                session,
                kind,
                `${retry.length} cells still failing after ${passState.pass} passes.`
              );
              return;
            }
            session.operationQueues.set(kind, retry);
            session.operationRetry.set(kind, []);
            session.operationPass.set(kind, { pass: passState.pass + 1, progressed: 0, zeroStreak });
            session.operationFailStreak.set(kind, 0);
            this.updateOperation(session, kind, 'running', `Pass ${passState.pass + 1}: retrying ${retry.length} cells`);
            this.emitState();
            reschedule();
            return;
          }
          this.stopOperationTimer(session, kind);
          if (onDrained) {
            onDrained();
            return;
          }
          this.updateOperation(session, kind, 'complete', `${OPERATION_LABELS[kind]} complete`, {
            total: session.snapshot.operations[kind].total
          });
          this.emitState();
          return;
        }
        await this.runWorkItem(session, bot, kind, work);
        reschedule();
      })().catch(() => reschedule());
    };
    tick();
  }

  /**
   * A failed place/water/dig no longer wedges the operation OR permanently skips the cell.
   * The item is re-queued into the next pass (plan order is preserved: earlier failures land
   * earlier in the retry list, so dependency chains — sand→cactus, fence→fence — rebuild in
   * order). {@link MAX_CONSECUTIVE_PLACE_FAILS} failures in a row abandon the current pass so
   * a wedged bot restarts from fresh ground; the drained-queue logic in
   * {@link scheduleOperationQueue} then either starts the next pass or, if a full pass made
   * zero progress, blocks the run.
   */
  private recordWorkFailure(
    session: ManagedSession,
    kind: OperationKind,
    work: OperationWorkItem,
    detail: string,
    startedAt?: number
  ): void {
    const streak = (session.operationFailStreak.get(kind) ?? 0) + 1;
    session.operationFailStreak.set(kind, streak);
    const retry = session.operationRetry.get(kind) ?? [];
    retry.push(work);
    session.operationRetry.set(kind, retry);
    // Attempt-level stat only — `completed` advances when the cell finally lands (or is
    // permanently abandoned by a zero-progress pass), so each cell counts exactly once.
    this.addOperationStats(session, kind, { failed: 1 });
    if (process.env.AFK_PFDBG) console.log('[PFDBG] retry-queued:', detail);
    // Two failure shapes feed the frozen watchdog: attempts that spent real time walking or
    // placing, and INSTANT failures far away from the item's stance (walking should have
    // happened but didn't — a dead pathfinder fails fast from the wrong spot). Instant
    // failures AT the stance are dependency misses (chain ref not placed yet), not freezes.
    const spentTime = startedAt === undefined || Date.now() - startedAt >= 1500;
    const target = work.stance ?? work.position;
    const here = session.bot ? botPosition(session.bot) : null;
    const farFromStance =
      here != null &&
      Math.max(Math.abs(here.x - target.x), Math.abs(here.z - target.z)) > 3;
    if (spentTime || farFromStance) {
      this.watchFrozenBot(session, kind, detail);
    }
    if (streak >= MAX_CONSECUTIVE_PLACE_FAILS) {
      const queue = session.operationQueues.get(kind);
      if (queue?.length) retry.push(...queue.splice(0));
      session.operationFailStreak.set(kind, 0);
    }
  }

  /** A work item resolved (placed/dug/skipped-as-done): reset the wedge streak, count pass progress. */
  private recordWorkProgress(session: ManagedSession, kind: OperationKind): void {
    session.operationFailStreak.set(kind, 0);
    session.operationFrozen.delete(kind);
    const passState = session.operationPass.get(kind);
    if (passState) passState.progressed += 1;
  }

  /**
   * Failures that pile up while the bot's feet never move mean the CLIENT is wedged (a dead
   * pathfinder / physics desync) — retry passes can't fix that because every walk silently
   * no-ops. Escalate: first a hard pathfinder reset, then a self-heal reconnect (a fresh
   * mineflayer instance) that rides the existing involuntary-drop auto-resume, which skips
   * already-built cells and finishes the run. Capped so a genuinely broken world still ends
   * in an honest block instead of a reconnect loop.
   */
  private watchFrozenBot(session: ManagedSession, kind: OperationKind, detail: string): void {
    const bot = session.bot;
    const pos = bot ? botPosition(bot) : null;
    // No pathfinder (unit tests / bare sessions) → the bot can't walk anyway; "not moving"
    // carries no signal there.
    if (!bot?.pathfinder || !pos) return;
    const frozen = session.operationFrozen.get(kind);
    if (
      frozen &&
      Math.abs(pos.x - frozen.x) < 0.3 &&
      Math.abs(pos.z - frozen.z) < 0.3 &&
      Math.abs(pos.y - frozen.y) < 0.5
    ) {
      frozen.count += 1;
    } else {
      session.operationFrozen.set(kind, { x: pos.x, y: pos.y, z: pos.z, count: 1, heals: frozen?.heals ?? 0 });
      return;
    }
    if (frozen.count < FROZEN_FAILURE_THRESHOLD) return;
    frozen.count = 0;
    frozen.heals += 1;
    if (frozen.heals <= 2) {
      // A pathfinder instance degrades cumulatively after many aborted gotos until it
      // stops producing paths at all (verified live: a FRESH bot pathed the identical
      // goal in 2.7s while the build bot sat frozen). loadPlugin re-injects a brand-new
      // pathfinder in place — the cheapest full revival.
      this.reloadPathfinder(bot);
      this.pushEvent(session, operationEventType(kind), 'warn', 'Pathfinder reloaded', `Bot frozen while failing: ${detail}`);
      return;
    }
    const heals = session.selfHealCount.get(kind) ?? 0;
    if (heals >= MAX_SELF_HEAL_RECONNECTS) {
      this.blockOperation(session, kind, `Bot repeatedly frozen (${heals} reconnects). Last: ${detail}`);
      return;
    }
    session.selfHealCount.set(kind, heals + 1);
    this.selfHealReconnect(session, kind, detail);
  }

  /** Replace a degraded pathfinder with a fresh instance (plugin re-inject + movements). */
  private reloadPathfinder(bot: BotLike): void {
    try {
      bot.pathfinder?.setGoal?.(null);
      bot.setControlState?.('sneak', false);
      bot.setControlState?.('jump', false);
      bot.setControlState?.('forward', false);
      // bot.loadPlugin dedupes on the plugin reference, so re-injecting requires calling
      // the plugin function directly. It overwrites bot.pathfinder wholesale; the old
      // instance's physics listeners stay behind but are inert with their goal cleared.
      if (typeof pathfinderPluginRef === 'function') {
        (pathfinderPluginRef as (bot: BotLike) => void)(bot);
        configurePathfinderMovements(bot);
      }
    } catch {
      // best-effort; the reconnect rung above this one is the real recovery
    }
  }

  /** Tear the wedged connection down and bring a fresh bot back; auto-resume replays the op. */
  private selfHealReconnect(session: ManagedSession, kind: OperationKind, detail: string): void {
    const bot = session.bot;
    if (!bot) return;
    this.pushEvent(
      session,
      operationEventType(kind),
      'warn',
      'Self-heal reconnect',
      `Bot frozen; reconnecting to recover. Last failure: ${detail}`
    );
    session.desiredStop = false;
    try {
      bot.quit?.('ChunkKeeper self-heal reconnect');
    } catch {
      // if quit throws the 'end' handler still fires on socket teardown
    }
    // The 'end' handler marks the drop involuntary and may arm the profile's reconnect
    // backoff; connect directly as a fallback for profiles with reconnect disabled. The
    // teardown ('end') can land late, so probe a few times instead of exactly once.
    for (const delay of [2000, 7000, 15000]) {
      setTimeout(() => {
        if (session.bot || session.desiredStop || session.reconnectTimer) return;
        void this.connect(session.profile.id).catch(() => {});
      }, delay);
    }
  }

  private async runWorkItem(
    session: ManagedSession,
    bot: BotLike,
    kind: OperationKind,
    work: OperationWorkItem
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      if (work.action === 'barrier') {
        // Point-of-no-return checkpoint (e.g. before the cactus basin is flooded and
        // sealed): anything that failed so far must be repaired NOW, while it is still
        // reachable — the end-of-plan retry passes would arrive after the region closes.
        const retry = session.operationRetry.get(kind) ?? [];
        const attempts = work.barrierAttempts ?? 0;
        if (retry.length > 0 && attempts < 3) {
          const queue = session.operationQueues.get(kind) ?? [];
          queue.unshift(...retry.splice(0), { ...work, barrierAttempts: attempts + 1 });
          session.operationFailStreak.set(kind, 0);
          if (process.env.AFK_PFDBG) console.log('[PFDBG] barrier: re-running', queue.length, 'items before sealing (round', attempts + 1, ')');
          return; // the barrier re-queued itself; don't count progress yet
        }
        this.recordWorkProgress(session, kind);
        this.addOperationProgress(session, kind, 1, {});
        return;
      }
      if (work.action === 'dig') {
        if (typeof bot.blockAt !== 'function' || typeof bot.dig !== 'function') {
          this.blockOperation(session, kind, 'Mineflayer block/dig APIs are unavailable.');
          return;
        }
        // Resume fast-path: skip already-dug cells BEFORE walking anywhere, or a
        // resumed dig-heavy plan re-treads the entire excavation at walking pace.
        const preCheck = bot.blockAt(toVec3(work.position));
        if (preCheck && isAirBlock(preCheck)) {
          this.recordWorkProgress(session, kind);
          this.addOperationProgress(session, kind, 1, { skipped: 1 });
          return;
        }
        if (work.walk) await this.walkWithinReach(bot, work.position);
        const block = bot.blockAt(toVec3(work.position));
        if (!block || isAirBlock(block)) {
          this.recordWorkProgress(session, kind);
          this.addOperationProgress(session, kind, 1, { skipped: 1 });
          return;
        }
        if (work.walk && !this.withinActionReach(bot, work.position)) {
          // NEVER dig from out of reach: the server discards the break but the client
          // clears the block locally — phantom air that poisons every later decision.
          this.recordWorkFailure(session, kind, work, `dig at ${formatPosition(work.position)} out of reach`, startedAt);
          return;
        }
        await Promise.resolve(bot.dig(block));
        // mineflayer clears the block CLIENT-side as soon as its own dig timer elapses; if
        // the server rejected the break (reach/line-of-sight validation) it resends the
        // real block a tick later. Trusting the optimistic clear poisons the client world —
        // observed live: a bot "dug" a 789-block room that mostly never existed server-side
        // and then walked down a phantom staircase. Wait for the correction and verify — but
        // resolve as soon as the server (re)sends this block instead of always burning 150ms.
        await waitForBlockChange(bot, work.position, 150);
        const after = bot.blockAt(toVec3(work.position));
        if (after && !isAirBlock(after)) {
          this.recordWorkFailure(session, kind, work, `dig at ${formatPosition(work.position)} rejected by server`, startedAt);
          return;
        }
        this.recordWorkProgress(session, kind);
        this.addOperationProgress(session, kind, 1, { mined: 1 });
      } else if (work.action === 'till') {
        const tilled = await this.tillFarmland(bot, work.position);
        if (!tilled) {
          this.recordWorkProgress(session, kind);
          this.addOperationProgress(session, kind, 1, { skipped: 1 });
          return;
        }
        this.recordWorkProgress(session, kind);
        this.addOperationProgress(session, kind, 1, { tilled: 1 });
      } else if (work.action === 'water') {
        const result = await this.placeWaterSource(bot, work.position, work.stance);
        if (!result.ok) {
          this.recordWorkFailure(session, kind, work, `water at ${formatPosition(work.position)} (${result.reason})`, startedAt);
          return;
        }
        this.recordWorkProgress(session, kind);
        this.addOperationProgress(session, kind, 1, { watered: 1 });
      } else {
        if (work.tillUnder && typeof bot.blockAt === 'function') {
          // Farmland can revert (trampled or dried) between the till pass and this plant —
          // re-till in place instead of failing the cell forever.
          const belowPos = addPosition(work.position, { x: 0, y: -1, z: 0 });
          const below = bot.blockAt(toVec3(belowPos));
          if (below && below.name !== 'farmland' && !isAirBlock(below)) {
            await this.tillFarmland(bot, belowPos);
          }
        }
        const placed = work.walk
          ? await this.placeBlockAgainst(bot, work.itemName ?? 'cobblestone', work.position, {
              walk: true,
              stance: work.stance,
              against: work.against,
              sneak: work.sneak
            })
          : await this.placeItemAt(bot, work.itemName ?? 'cobblestone', work.position);
        if (!placed) {
          this.recordWorkFailure(session, kind, work, `place ${work.itemName ?? 'block'} at ${formatPosition(work.position)}`, startedAt);
          return;
        }
        this.recordWorkProgress(session, kind);
        this.addOperationProgress(session, kind, 1, { placed: 1 });
      }
      this.updateLiveTelemetry(session);
      this.emitState();
    } catch (error) {
      // A transient throw (path timeout, momentary desync) re-queues the cell like any
      // other failure instead of instakilling the run.
      this.recordWorkFailure(session, kind, work, formatError(error), startedAt);
      this.emitState();
    }
  }

  private async placeItemAt(bot: BotLike, itemName: string, position: PositionSnapshot): Promise<boolean> {
    if (typeof bot.blockAt !== 'function' || typeof bot.placeBlock !== 'function' || typeof bot.equip !== 'function') return false;
    const item = findInventoryItem(bot, itemName);
    if (!item) return false;
    const referenceBlock = bot.blockAt(toVec3(addPosition(position, { x: 0, y: -1, z: 0 })));
    if (!referenceBlock || isAirBlock(referenceBlock)) return false;
    await Promise.resolve(bot.equip(item, 'hand'));
    await withTimeout(
      Promise.resolve(bot.placeBlock(referenceBlock, new Vec3(0, 1, 0))),
      PLACE_BLOCK_TIMEOUT_MS,
      `place ${itemName}`
    );
    return true;
  }

  /**
   * Run a goto with a MOVEMENT watchdog and an outer hard cap.
   *
   * mineflayer-pathfinder livelocks on certain goals: it computes a path whose first move
   * is a diagonal squeeze past partial blocks (reproduced deterministically standing in a
   * pocket formed by a placed block + a hopper), then the executor bumps the corner
   * forever — the goto neither reaches the goal nor rejects, and even `thinkTimeout`
   * never fires because computing is done. Waiting the full cap costs 20s per attempt, so
   * detect the livelock directly: if the feet don't move for several consecutive seconds
   * while the goto is pending, cancel the goal (`setGoal(null)`, NEVER `stop()` — see the
   * sticky stopPathing flag) and reject as "stalled" so the caller can nudge to open
   * ground and retry.
   */
  private async gotoWithTimeout(bot: BotLike, goal: unknown, ms: number, label: string): Promise<void> {
    if (typeof bot.pathfinder?.goto !== 'function') return;
    const gotoPromise = Promise.resolve(bot.pathfinder.goto(goal));
    const deadline = Date.now() + ms;
    let last = botPosition(bot);
    // The A* compute phase (bounded by thinkTimeout = 3s) legitimately keeps the bot
    // still, so require more than that before calling it a stall.
    let still = 0;
    for (;;) {
      const winner = await Promise.race([
        gotoPromise.then(
          () => 'done' as const,
          (error) => {
            throw error;
          }
        ),
        new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 1000))
      ]);
      if (winner === 'done') return;
      const now = botPosition(bot);
      if (
        last &&
        now &&
        Math.abs(now.x - last.x) < 0.15 &&
        Math.abs(now.y - last.y) < 0.15 &&
        Math.abs(now.z - last.z) < 0.15
      ) {
        still += 1;
      } else {
        still = 0;
      }
      last = now;
      if (still >= 4 || Date.now() > deadline) {
        gotoPromise.catch(() => {}); // the cancelled goto rejects later; not an unhandled rejection
        // Cancelling a livelocked executor leaves the instance subtly broken — after a few
        // such aborts even a trivial open-ground L-path stalls (observed live), while a
        // fresh instance handles everything. Replace it wholesale on every abort.
        if (process.env.AFK_PFDBG) {
          const p = botPosition(bot);
          console.log('[PFDBG] goto abort:', label, still >= 4 ? 'STALLED' : 'CAP', `at ${p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?'} → reloading pathfinder`);
        }
        this.reloadPathfinder(bot);
        throw new Error(still >= 4 ? `${label} stalled (no movement)` : `${label} timed out after ${ms}ms`);
      }
    }
  }

  // Walk close enough to act on a target. No-op without the pathfinder plugin
  // (e.g. in unit tests), so callers must still tolerate out-of-reach failures.
  private async walkWithinReach(bot: BotLike, position: PositionSnapshot, range = 3): Promise<void> {
    if (!pathfinderGoals || typeof bot.pathfinder?.goto !== 'function') return;
    const inReach = (p: PositionSnapshot | null): boolean =>
      p != null &&
      Math.abs(p.x - position.x) + Math.abs(p.z - position.z) <= range &&
      Math.abs(p.y - position.y) <= 4;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = botPosition(bot);
      if (inReach(before) || !before) return;
      try {
        const goal = new pathfinderGoals.GoalNear(position.x, position.y, position.z, range);
        await this.gotoWithTimeout(bot, goal, PATHFIND_TIMEOUT_MS, 'pathfind');
      } catch {
        // stall/timeout — the nudge below decides whether another attempt is useful
      }
      const now = botPosition(bot);
      if (inReach(now) || !now) return;
      // Same pocket-livelock escape as walkToStance: if the goto produced zero
      // movement, blind-walk to new ground before re-planning.
      if (Math.abs(now.x - before.x) < 0.4 && Math.abs(now.z - before.z) < 0.4) {
        await this.nudgeWalk(bot, position);
      }
    }
  }

  /** True when the bot's eye can plausibly act on the target block server-side. Acting
   *  from further away gets silently discarded by Paper — and for DIGS the mineflayer
   *  client still clears the block locally, poisoning its world view with phantom air. */
  private withinActionReach(bot: BotLike, position: PositionSnapshot): boolean {
    if (!pathfinderGoals || typeof bot.pathfinder?.goto !== 'function') return true; // tests / bare sessions
    const here = botPosition(bot);
    if (!here) return true;
    const dx = here.x - (position.x + 0.5);
    const dy = here.y + 1.62 - (position.y + 0.5);
    const dz = here.z - (position.z + 0.5);
    return Math.hypot(dx, dy, dz) <= 4.8;
  }

  // Stand in an explicit clear cell (a build's odd-x lane) before placing. Build
  // grids wall the bot in if it stands inside them, so callers pass a stance that
  // is guaranteed never to be built on — keeping pathfinding on open ground.
  private async walkToStance(bot: BotLike, stance: PositionSnapshot, exact = false): Promise<void> {
    if (!pathfinderGoals || typeof bot.pathfinder?.goto !== 'function') return;
    const goals = pathfinderGoals;
    // Directed placements (`exact`) need the feet EXACTLY on the stance cell:
    // the stance is chosen along the clicked face's normal, and stopping one
    // cell short parks the eye on the face plane where the server rejects the
    // click. Everything else tolerates the pathfinder's ±1 wiggle.
    const atStance = (p: PositionSnapshot | null): boolean => {
      if (!p) return false;
      const dx = Math.abs(Math.floor(p.x) - stance.x);
      const dz = Math.abs(Math.floor(p.z) - stance.z);
      const dy = Math.abs(p.y - stance.y);
      return exact ? dx === 0 && dz === 0 && dy <= 2 : dx <= 1 && dz <= 1 && dy <= 2;
    };

    // Direct full A* only. A healthy pathfinder routes farm-scale goals (including
    // around/over built structures) in ~1-3s, and thinkTimeout bounds the no-path
    // case — the old short-hop stepper existed to work around what turned out to be
    // wedged-instance symptoms, and its frequent aborted gotos were themselves the
    // thing that wedged the pathfinder. If an attempt produces zero movement, escape
    // with a blind nudge walk (no pathfinder) and try again from new ground.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = botPosition(bot);
      if (atStance(before) || !before) return;
      try {
        await this.gotoWithTimeout(bot, new goals.GoalNear(stance.x, stance.y, stance.z, exact ? 0 : 1), 20000, 'stance goto');
      } catch (error) {
        // no-path rejection (clean) or stall/cap (pathfinder already reloaded)
        if (process.env.AFK_PFDBG) console.log('[PFDBG] stance goto attempt', attempt, '→', formatError(error));
      }
      const now = botPosition(bot);
      if (atStance(now) || !now) return;
      if (Math.abs(now.x - before.x) < 0.4 && Math.abs(now.z - before.z) < 0.4) {
        await this.nudgeWalk(bot, stance);
      }
    }
  }

  /**
   * Pathfinder-free escape hatch: walk+jump blind for a moment so the next goto plans
   * from new ground. Aims at the most target-ward OPEN cardinal, not the target itself —
   * stalls happen in pockets where the target bearing is exactly the blocked direction
   * (pressing into the wall would move the bot nowhere, again).
   */
  private async nudgeWalk(bot: BotLike, toward: PositionSnapshot): Promise<void> {
    if (typeof bot.setControlState !== 'function') return;
    const here = botPosition(bot);
    if (!here) return;
    const feet = { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) };
    const solid = (x: number, y: number, z: number): boolean => {
      const block = typeof bot.blockAt === 'function' ? bot.blockAt(toVec3({ x, y, z })) : null;
      return block != null && !isAirBlock(block);
    };
    // A cardinal is open when the bot can walk (or jump a 1-high lip) into the next cell.
    const isOpen = (dx: number, dz: number): boolean => {
      const x = feet.x + dx;
      const z = feet.z + dz;
      if (solid(x, feet.y + 1, z)) return false; // head-height wall — can't even jump in
      if (solid(x, feet.y, z) && solid(x, feet.y + 2, z)) return false; // 1-high lip but no jump headroom
      return true;
    };
    const dirs = [
      { x: 1, z: 0 },
      { x: -1, z: 0 },
      { x: 0, z: 1 },
      { x: 0, z: -1 }
    ];
    const tx = toward.x + 0.5 - here.x;
    const tz = toward.z + 0.5 - here.z;
    const score = (d: { x: number; z: number }) => d.x * tx + d.z * tz;
    // Geometry alone misjudges partial blocks (a hopper "looks" like a jumpable lip but
    // physics won't mount it from a pocket), so verify each direction BEHAVIOURALLY:
    // walk it briefly and move on to the next direction if the feet didn't actually move.
    const ranked = [...dirs].sort((a, b) => score(b) - score(a)).sort((a, b) => Number(isOpen(b.x, b.z)) - Number(isOpen(a.x, a.z)));
    for (const dir of ranked) {
      const start = botPosition(bot);
      if (!start) return;
      if (process.env.AFK_PFDBG) {
        console.log('[PFDBG] nudge:', `from ${feet.x},${feet.y},${feet.z}`, `dir ${dir.x},${dir.z}`, `toward ${Math.floor(toward.x)},${Math.floor(toward.z)}`);
      }
      try {
        await Promise.resolve(bot.lookAt?.(new Vec3(start.x + dir.x * 4, start.y + 1.62, start.z + dir.z * 4), true));
        // Jump only when there is actually a lip to mount: jump-landing on farmland
        // TRAMPLES it back to dirt (observed live: a crop build's nudges wiped out
        // half the tilled field), and flat ground never needs the hop.
        const lip = solid(feet.x + dir.x, feet.y, feet.z + dir.z);
        if (lip) bot.setControlState('jump', true);
        bot.setControlState('forward', true);
        await new Promise((resolve) => setTimeout(resolve, 900));
      } catch {
        // best-effort
      } finally {
        bot.setControlState?.('forward', false);
        bot.setControlState?.('jump', false);
      }
      const now = botPosition(bot);
      if (now && start && (Math.abs(now.x - start.x) > 0.4 || Math.abs(now.z - start.z) > 0.4)) return;
    }
  }

  // A block can't be placed inside the bot's own body — the server rejects it, so
  // a build cell that lands on the bot (e.g. the cactus farm's support post at the
  // origin column) blocks forever. If the bot's feet or head occupy the target
  // cell, step one block aside first. No-op without the pathfinder plugin.
  private async stepOffTargetCell(bot: BotLike, position: PositionSnapshot): Promise<void> {
    if (!pathfinderGoals || typeof bot.pathfinder?.goto !== 'function') return;
    const here = botPosition(bot);
    if (!here) return;
    const feet = { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) };
    const occupiesColumn = feet.x === position.x && feet.z === position.z;
    const occupiesLevel = position.y === feet.y || position.y === feet.y + 1;
    if (!occupiesColumn || !occupiesLevel) return;
    const offsets = [
      { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 },
      { x: 1, z: 1 }, { x: -1, z: 1 }, { x: 1, z: -1 }, { x: -1, z: -1 }
    ];
    for (const off of offsets) {
      try {
        const goal = new pathfinderGoals.GoalNear(position.x + off.x, feet.y, position.z + off.z, 0);
        await this.gotoWithTimeout(bot, goal, PATHFIND_TIMEOUT_MS, 'step aside');
      } catch {
        continue;
      }
      const now = botPosition(bot);
      if (now && (Math.floor(now.x) !== position.x || Math.floor(now.z) !== position.z)) return;
    }
  }

  // Like placeItemAt but can anchor on any solid neighbour (not just the block
  // below), and optionally walks within reach first. Idempotent: if the target
  // cell is already filled it returns true, so re-running a build resumes cleanly.
  private async placeBlockAgainst(
    bot: BotLike,
    itemName: string,
    position: PositionSnapshot,
    opts: { walk?: boolean; stance?: PositionSnapshot; against?: PositionSnapshot; sneak?: boolean } = {}
  ): Promise<boolean> {
    if (typeof bot.blockAt !== 'function' || typeof bot.placeBlock !== 'function' || typeof bot.equip !== 'function') {
      return false;
    }
    const item = findInventoryItem(bot, itemName);
    if (!item) return false;
    const alreadyFilled = (): boolean => {
      if (typeof bot.blockAt !== 'function') return false;
      const block = bot.blockAt(toVec3(position));
      return block != null && !isAirBlock(block);
    };
    const tryPlace = (): Promise<boolean> =>
      opts.against
        ? this.tryPlaceDirected(bot, itemName, position, opts.against, opts.sneak)
        : this.tryPlaceAgainstFaces(bot, itemName, position);

    // Resume fast-path: a rebuilt plan is full of already-placed cells — skip
    // them before walking anywhere or the bot re-treads the whole build.
    if (alreadyFilled()) return true;

    const dbg = (...args: unknown[]) => {
      if (process.env.AFK_PFDBG) {
        const p = botPosition(bot);
        console.log('[PFDBG]', `bot=${p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?'}`, ...args);
      }
    };
    dbg('target', itemName, formatPosition(position), 'stance', opts.stance ? formatPosition(opts.stance) : '-');

    if (opts.walk) {
      // Prefer an explicit clear-lane stance (keeps the bot out of the build grid it
      // is walling in); fall back to a plain within-reach walk when none is supplied.
      // Directed placements need the exact stance cell — see walkToStance.
      if (opts.stance) await this.walkToStance(bot, opts.stance, Boolean(opts.against));
      else await this.walkWithinReach(bot, position);
    }
    await this.stepOffTargetCell(bot, position);
    if (alreadyFilled()) return true;
    if (await tryPlace()) return true;
    dbg('first attempt failed for', itemName, formatPosition(position));

    // If the stance still left the cell out of reach or at a rejected angle, try
    // once more from DIRECTLY ADJACENT: steep, unoccluded clicks are the ones the
    // server reliably accepts.
    if (opts.walk) {
      await this.walkWithinReach(bot, position, 1);
      await this.stepOffTargetCell(bot, position);
      if (alreadyFilled()) return true;
      if (await tryPlace()) return true;
    }
    dbg('FAILED', itemName, formatPosition(position));
    return false;
  }

  // Place clicking one specific neighbour face. Hoppers point INTO the block they
  // are placed against, so chain steps must not fall back to arbitrary faces — a
  // mis-aimed hopper silently breaks the whole collection line. Interactive
  // references (chest, hopper) need sneak held or the click opens them instead.
  private async tryPlaceDirected(
    bot: BotLike,
    itemName: string,
    position: PositionSnapshot,
    against: PositionSnapshot,
    sneak?: boolean
  ): Promise<boolean> {
    if (typeof bot.blockAt !== 'function' || typeof bot.placeBlock !== 'function' || typeof bot.equip !== 'function') {
      return false;
    }
    const item = findInventoryItem(bot, itemName);
    if (!item) return false;
    const reference = bot.blockAt(toVec3(against));
    if (!reference || isAirBlock(reference)) {
      if (process.env.AFK_PFDBG) console.log('[PFDBG] directed ref missing at', formatPosition(against));
      return false;
    }
    const face = new Vec3(position.x - against.x, position.y - against.y, position.z - against.z);
    if (Math.abs(face.x) + Math.abs(face.y) + Math.abs(face.z) !== 1) return false;
    if (!this.faceClickable(bot, against, face)) {
      if (process.env.AFK_PFDBG) console.log('[PFDBG] directed face not clickable from here for', formatPosition(position));
      return false; // let the caller walk closer and retry instead of a dead 5s timeout
    }
    await Promise.resolve(bot.equip(item, 'hand'));
    if (sneak) bot.setControlState?.('sneak', true);
    try {
      await withTimeout(
        Promise.resolve(bot.placeBlock(reference, face)),
        PLACE_BLOCK_TIMEOUT_MS,
        `place ${itemName}`
      );
      return true;
    } catch (error) {
      if (process.env.AFK_PFDBG) console.log('[PFDBG] directed place ->', formatError(error));
      // Ghost heal: server may have applied it despite the missed confirmation.
      const now = bot.blockAt(toVec3(position));
      return now != null && !isAirBlock(now);
    } finally {
      if (sneak) bot.setControlState?.('sneak', false);
    }
  }

  // Place `itemName` against any solid neighbour of `position` from the bot's
  // current stance. Returns false when no adjacent solid face is reachable.
  private async tryPlaceAgainstFaces(bot: BotLike, itemName: string, position: PositionSnapshot): Promise<boolean> {
    if (typeof bot.blockAt !== 'function' || typeof bot.placeBlock !== 'function' || typeof bot.equip !== 'function') {
      return false;
    }
    const item = findInventoryItem(bot, itemName);
    if (!item) return false;
    // below first (back-compat with placeItemAt), then the 4 sides, then above.
    const faces: Array<{ off: PositionSnapshot; face: Vec3 }> = [
      { off: { x: 0, y: -1, z: 0 }, face: new Vec3(0, 1, 0) },
      { off: { x: -1, y: 0, z: 0 }, face: new Vec3(1, 0, 0) },
      { off: { x: 1, y: 0, z: 0 }, face: new Vec3(-1, 0, 0) },
      { off: { x: 0, y: 0, z: -1 }, face: new Vec3(0, 0, 1) },
      { off: { x: 0, y: 0, z: 1 }, face: new Vec3(0, 0, -1) },
      { off: { x: 0, y: 1, z: 0 }, face: new Vec3(0, -1, 0) }
    ];
    const jumpCandidates: Array<{ off: PositionSnapshot; face: Vec3 }> = [];
    for (const candidate of faces) {
      const reference = bot.blockAt(toVec3(addPosition(position, candidate.off)));
      if (!reference || isAirBlock(reference)) continue;
      // Paper validates the click server-side: the eye must sit on the OUTWARD
      // side of the clicked face with a clean, steep-enough sight line, or the
      // placement is silently dropped (blockUpdate never fires). Skip faces the
      // bot cannot legitimately click from where it stands.
      if (!this.faceClickable(bot, addPosition(position, candidate.off), candidate.face)) {
        // A top face that is only just above eye height becomes clickable at jump
        // apex (~+1.25). This is how any wall row above the second course is placed
        // from the ground — exactly like a vanilla player jump-placing.
        if (candidate.face.y === 1 && this.faceClickable(bot, addPosition(position, candidate.off), candidate.face, 1.1)) {
          jumpCandidates.push(candidate);
        }
        if (process.env.AFK_PFDBG) console.log('[PFDBG] skip face', JSON.stringify(candidate.off), 'not clickable');
        continue;
      }
      await Promise.resolve(bot.equip(item, 'hand'));
      try {
        await withTimeout(
          Promise.resolve(bot.placeBlock(reference, candidate.face)),
          PLACE_BLOCK_TIMEOUT_MS,
          `place ${itemName}`
        );
        return true;
      } catch (error) {
        if (process.env.AFK_PFDBG) {
          console.log('[PFDBG] face', JSON.stringify(candidate.off), 'ref', reference.name, '->', formatError(error));
        }
        // Ghost heal: the server may have applied the placement even though the
        // client-side confirmation timed out.
        const now = bot.blockAt(toVec3(position));
        if (now && !isAirBlock(now)) return true;
        // try the next face
      }
    }
    for (const candidate of jumpCandidates) {
      if (await this.tryJumpPlace(bot, itemName, position, candidate)) return true;
    }
    return false;
  }

  /** Jump and click a top face that sits between standing eye height and jump-apex eye
   *  height. Waits for the feet to actually rise before clicking so the server sees the
   *  elevated eye position. */
  private async tryJumpPlace(
    bot: BotLike,
    itemName: string,
    position: PositionSnapshot,
    candidate: { off: PositionSnapshot; face: Vec3 }
  ): Promise<boolean> {
    if (typeof bot.setControlState !== 'function' || typeof bot.blockAt !== 'function' || typeof bot.placeBlock !== 'function') {
      return false;
    }
    const reference = bot.blockAt(toVec3(addPosition(position, candidate.off)));
    if (!reference || isAirBlock(reference)) return false;
    // Jump-landing on farmland tramples it back to dirt and pops the crop — never
    // worth it (crop placements are all below eye height anyway).
    const here = botPosition(bot);
    if (here) {
      const below = bot.blockAt(toVec3({ x: Math.floor(here.x), y: Math.floor(here.y) - 1, z: Math.floor(here.z) }));
      if (below?.name === 'farmland') return false;
    }
    const item = findInventoryItem(bot, itemName);
    if (!item || typeof bot.equip !== 'function') return false;
    await Promise.resolve(bot.equip(item, 'hand'));
    const startY = botPosition(bot)?.y ?? 0;
    if (process.env.AFK_PFDBG) console.log('[PFDBG] jump-place attempt for', formatPosition(position));
    try {
      bot.setControlState('jump', true);
      // Wait until near apex (feet risen ≥ 0.9) instead of a fixed delay — physics
      // tick timing varies. Bail out if the jump never happens (blocked overhead).
      let risen = false;
      for (let i = 0; i < 12; i++) {
        await new Promise((resolve) => setTimeout(resolve, 45));
        const y = botPosition(bot)?.y ?? startY;
        if (y - startY >= 0.9) {
          risen = true;
          break;
        }
      }
      if (!risen) return false;
      await withTimeout(Promise.resolve(bot.placeBlock(reference, candidate.face)), PLACE_BLOCK_TIMEOUT_MS, `jump-place ${itemName}`);
      return true;
    } catch (error) {
      if (process.env.AFK_PFDBG) console.log('[PFDBG] jump-place ->', formatError(error));
      const now = bot.blockAt(toVec3(position));
      return now != null && !isAirBlock(now);
    } finally {
      bot.setControlState?.('jump', false);
    }
  }

  /** True when the bot's eye is on the outward side of the face it wants to click,
   *  with enough margin that the server-side raytrace hits that face first.
   *  `eyeLift` simulates extra eye height (e.g. +1.1 at jump apex). */
  private faceClickable(bot: BotLike, refCell: PositionSnapshot, face: Vec3, eyeLift = 0): boolean {
    // Without the pathfinder the bot cannot reposition anyway (unit tests / bare
    // clients) — skip the geometry gate and let placeBlock decide.
    if (!pathfinderGoals || typeof bot.pathfinder?.goto !== 'function') return true;
    const here = botPosition(bot);
    if (!here) return true; // no position info — let placeBlock decide
    const eye = { x: here.x, y: here.y + 1.62 + eyeLift, z: here.z };
    const faceCenter = {
      x: refCell.x + 0.5 + face.x * 0.5,
      y: refCell.y + 0.5 + face.y * 0.5,
      z: refCell.z + 0.5 + face.z * 0.5
    };
    const rel = { x: eye.x - faceCenter.x, y: eye.y - faceCenter.y, z: eye.z - faceCenter.z };
    const along = rel.x * face.x + rel.y * face.y + rel.z * face.z;
    if (along < 0.05) return false; // eye behind the face plane — physically unclickable
    const dist = Math.hypot(rel.x, rel.y, rel.z);
    return dist <= 4.2; // beyond dependable interaction range
  }

  // Turn dirt/grass into farmland with a hoe. Returns false (skip) when there is
  // no hoe, the block isn't tillable, or the activate API is unavailable.
  private async tillFarmland(bot: BotLike, position: PositionSnapshot): Promise<boolean> {
    if (typeof bot.blockAt !== 'function' || typeof bot.equip !== 'function' || typeof bot.activateBlock !== 'function') {
      return false;
    }
    const hoe = findHoe(bot);
    if (!hoe) return false;
    await this.walkWithinReach(bot, position);
    const block = bot.blockAt(toVec3(position));
    if (!block) return false;
    if (block.name === 'farmland') return true;
    if (!isTillable(block)) return false;
    await Promise.resolve(bot.equip(hoe, 'hand'));
    await withTimeout(Promise.resolve(bot.activateBlock(block, new Vec3(0, 1, 0))), PLACE_BLOCK_TIMEOUT_MS, 'till');
    return true;
  }

  // Place a water source with a bucket. Bucket support in mineflayer is flaky, so
  // callers must handle { ok:false } gracefully (fall back to existing water).
  private async placeWaterSource(
    bot: BotLike,
    position: PositionSnapshot,
    stance?: PositionSnapshot
  ): Promise<{ ok: boolean; reason: string }> {
    if (typeof bot.blockAt !== 'function') return { ok: false, reason: 'no_api' };
    const existing = bot.blockAt(toVec3(position));
    if (existing && existing.name === 'water') return { ok: true, reason: 'already_water' };
    const bucket = findInventoryItem(bot, 'water_bucket');
    if (!bucket) return { ok: false, reason: 'no_bucket' };
    if (typeof bot.equip !== 'function' || typeof bot.activateItem !== 'function') {
      return { ok: false, reason: 'no_api' };
    }
    if (stance) await this.walkToStance(bot, stance);
    else await this.walkWithinReach(bot, position, 2);
    // The server raytraces the pour along the look vector, so aim at the interior
    // of the TOP FACE of the block under the target cell — aiming at the empty
    // cell's centre lets the ray sail past and the bucket silently does nothing.
    await Promise.resolve(
      bot.lookAt?.(new Vec3(position.x + 0.5, position.y - 0.01, position.z + 0.5), true)
    );
    await Promise.resolve(bot.equip(bucket, 'hand'));
    try {
      await withTimeout(Promise.resolve(bot.activateItem()), PLACE_BLOCK_TIMEOUT_MS, 'place water');
    } catch {
      return { ok: false, reason: 'activate_failed' };
    }
    const after = bot.blockAt(toVec3(position));
    if (after && after.name === 'water') return { ok: true, reason: 'placed' };
    return { ok: false, reason: 'not_water' };
  }

  // ---------- Chest storage engine (deposit / restock / retry ladder) ----------

  /** Cactus output is handled by its own hoppers (the bot never digs cactus); the rest fill the bot. */
  private usesDeposit(kind: OperationKind, config: unknown): boolean {
    if (kind === 'cropFarm' || kind === 'generator') return true;
    if (kind === 'area') return (config as AreaOperationConfig | undefined)?.mode === 'mine';
    return false;
  }

  private usesWithdraw(kind: OperationKind, config: unknown): boolean {
    if (kind === 'cropFarm') return this.restockNeeds(kind, config).length > 0;
    if (kind === 'area') return (config as AreaOperationConfig | undefined)?.mode === 'fill';
    return false;
  }

  private activeSeedId(kind: OperationKind, config: unknown): string | null {
    if (kind !== 'cropFarm') return null;
    const crop = (config as CropFarmConfig | undefined)?.crop;
    return crop ? cropSeedName(crop) : null;
  }

  /** Consumables a running op must keep topped up, with a `low` trigger and `want` target (hysteresis). */
  private restockNeeds(kind: OperationKind, config: unknown): Array<{ name: string; want: number; low: number }> {
    if (kind === 'cropFarm') {
      const seed = cropSeedName((config as CropFarmConfig).crop);
      return seed ? [{ name: seed, want: 64, low: 16 }] : [];
    }
    if (kind === 'area') {
      const cfg = config as AreaOperationConfig;
      return cfg.mode === 'fill' && cfg.fillBlock ? [{ name: cfg.fillBlock, want: 64, low: 16 }] : [];
    }
    return [];
  }

  private needsRestock(bot: BotLike, kind: OperationKind, config: unknown): boolean {
    return this.restockNeeds(kind, config).some((need) => inventoryItemCount(bot, need.name) < need.low);
  }

  private inventoryNearFull(bot: BotLike, storage: StorageConfig): boolean {
    return inventoryFillFraction(bot) >= storage.depositAtPercentFull;
  }

  /** Where to walk back to after a chest trip so a continuous tick resumes at the farm, not the chest. */
  private farmAnchor(session: ManagedSession, kind: OperationKind): PositionSnapshot | null {
    switch (kind) {
      case 'cropFarm':
        return session.cropFarmOrigin;
      case 'cactusFarm':
        return session.cactusFarmOrigin;
      case 'generator':
        return session.generatorOrigin;
      case 'area':
        return session.areaAnchor;
      default:
        return null;
    }
  }

  /**
   * Walk to the output chest and deposit every non-kept stack (see {@link shouldKeepItem}), then
   * the active seed's overflow above the keep cap. Never drops items: a full chest returns
   * 'blocked' so the caller can safe-pause. Always closes the window and walks back to the anchor.
   */
  private async runDepositTrip(
    session: ManagedSession,
    bot: BotLike,
    kind: OperationKind,
    config: unknown,
    storage: StorageConfig
  ): Promise<'ok' | 'blocked'> {
    if (typeof bot.openContainer !== 'function' || typeof bot.blockAt !== 'function') return 'ok';
    const chestPos = storage.depositTo;
    await this.walkWithinReach(bot, chestPos);
    const block = bot.blockAt(toVec3(chestPos));
    if (!isContainerBlock(block)) {
      this.pushEvent(session, operationEventType(kind), 'warn', 'Deposit chest missing', formatPosition(chestPos));
      return 'blocked';
    }
    let win: WindowLike;
    try {
      win = await withTimeout(Promise.resolve(bot.openContainer(block!)), CONTAINER_TIMEOUT_MS, 'openContainer');
    } catch {
      return 'blocked';
    }
    if (typeof win.deposit !== 'function') {
      bot.closeWindow?.(win);
      return 'blocked';
    }
    const seedId = this.activeSeedId(kind, config);
    const edible = edibleNames(bot);
    let chestFull = false;
    try {
      // Deposit each non-kept stack. Refresh items() every pass (slots shift after a transfer);
      // a per-type failure set prevents an infinite loop on a stack the chest keeps rejecting.
      const failedTypes = new Set<number>();
      let guard = 128;
      while (guard-- > 0) {
        if (session.bot !== bot) break;
        const items = bot.inventory?.items?.() ?? [];
        const target = items.find(
          (it) => it.type != null && !failedTypes.has(it.type) && !shouldKeepItem(it, seedId, edible)
        );
        if (!target || target.type == null) break;
        try {
          await withTimeout(
            Promise.resolve(win.deposit(target.type, target.metadata ?? null, null)),
            CONTAINER_TIMEOUT_MS,
            `deposit ${target.name}`
          );
        } catch (error) {
          if (formatError(error).toLowerCase().includes('full')) {
            chestFull = true;
            break;
          }
          failedTypes.add(target.type); // skip this type, keep depositing the rest
        }
      }
      // Seed overflow: keep only keepSeedStacks*64, deposit the surplus (non-fatal if it fails).
      if (!chestFull && seedId) {
        const cap = storage.keepSeedStacks * 64;
        const have = inventoryItemCount(bot, seedId);
        const seedItem = findInventoryItem(bot, seedId);
        if (have > cap && seedItem?.type != null) {
          try {
            await withTimeout(
              Promise.resolve(win.deposit(seedItem.type, seedItem.metadata ?? null, have - cap)),
              CONTAINER_TIMEOUT_MS,
              'deposit seed overflow'
            );
          } catch {
            /* keep the extra seed rather than blocking */
          }
        }
      }
    } finally {
      bot.closeWindow?.(win);
    }
    if (chestFull) {
      this.pushEvent(session, operationEventType(kind), 'warn', 'Deposit chest full', formatPosition(chestPos));
      return 'blocked';
    }
    const anchor = this.farmAnchor(session, kind);
    if (anchor) await this.walkWithinReach(bot, anchor);
    return 'ok';
  }

  /**
   * Walk to the supply chest and top up the op's consumables to their target counts. Returns
   * 'noop' when nothing is short, 'blocked' when the chest is missing or a hard supply is still
   * empty afterwards. Always closes the window and walks back to the anchor.
   */
  private async runRestockTrip(
    session: ManagedSession,
    bot: BotLike,
    kind: OperationKind,
    config: unknown,
    storage: StorageConfig
  ): Promise<'ok' | 'blocked' | 'noop'> {
    const short = this.restockNeeds(kind, config).filter((need) => inventoryItemCount(bot, need.name) < need.want);
    if (short.length === 0) return 'noop';
    if (typeof bot.openContainer !== 'function' || typeof bot.blockAt !== 'function') return 'noop';
    const chestPos = storage.withdrawFrom;
    await this.walkWithinReach(bot, chestPos);
    const block = bot.blockAt(toVec3(chestPos));
    if (!isContainerBlock(block)) {
      this.pushEvent(session, operationEventType(kind), 'warn', 'Supply chest missing', formatPosition(chestPos));
      return 'blocked';
    }
    let win: WindowLike;
    try {
      win = await withTimeout(Promise.resolve(bot.openContainer(block!)), CONTAINER_TIMEOUT_MS, 'openContainer');
    } catch {
      return 'blocked';
    }
    try {
      if (typeof win.withdraw !== 'function') return 'blocked';
      for (const need of short) {
        if ((win.emptySlotCount?.() ?? 1) === 0) break;
        const missing = need.want - inventoryItemCount(bot, need.name);
        if (missing <= 0) continue;
        const id = bot.registry?.itemsByName?.[need.name]?.id;
        if (id == null) continue;
        const available = win.containerCount?.(id, null) ?? 0;
        if (available <= 0) continue;
        try {
          await withTimeout(
            Promise.resolve(win.withdraw(id, null, Math.min(missing, available))),
            CONTAINER_TIMEOUT_MS,
            `withdraw ${need.name}`
          );
        } catch {
          /* per-item failure is non-fatal; the still-empty check below decides */
        }
      }
    } finally {
      bot.closeWindow?.(win);
    }
    const anchor = this.farmAnchor(session, kind);
    if (anchor) await this.walkWithinReach(bot, anchor);
    const stillEmpty = this.restockNeeds(kind, config).some((need) => inventoryItemCount(bot, need.name) < 1);
    return stillEmpty ? 'blocked' : 'ok';
  }

  /**
   * Retry a storage trip a few times, then safe-pause the operation (state 'blocked' + reason +
   * Discord alert) rather than losing yield. Never drops items; progress/config are preserved so
   * the operator can resume with one click.
   */
  private async runStorageTripWithRetry(
    session: ManagedSession,
    bot: BotLike,
    kind: OperationKind,
    trip: () => Promise<'ok' | 'blocked' | 'noop'>,
    storage: StorageConfig,
    label: string
  ): Promise<'ok' | 'blocked' | 'noop'> {
    let lastReason = '';
    for (let attempt = 1; attempt <= storage.retryAttempts; attempt += 1) {
      if (session.bot !== bot || session.snapshot.operations[kind].state !== 'running') return 'blocked';
      let result: 'ok' | 'blocked' | 'noop';
      try {
        result = await trip();
      } catch (error) {
        result = 'blocked';
        lastReason = formatError(error);
      }
      if (result === 'ok' || result === 'noop') return result;
      this.pushEvent(
        session,
        operationEventType(kind),
        'warn',
        `${label} retry`,
        `${attempt}/${storage.retryAttempts}`
      );
      if (attempt < storage.retryAttempts) await delay(750 * attempt);
    }
    const reason = `${label} failed after ${storage.retryAttempts} tries${lastReason ? `: ${lastReason}` : ''}.`;
    this.blockOperation(session, kind, reason);
    void this.notifyDiscord(session, `${session.profile.label}: ${OPERATION_LABELS[kind]} paused — ${reason}`, 'event');
    return 'blocked';
  }

  /**
   * Pre-tick guard woven into every farm loop. Returns false when it consumed the tick doing
   * storage work (restock-if-short, then deposit-if-near-full) or paused the op; true to proceed
   * with normal farming. A no-op (returns true immediately) unless chest storage is enabled.
   */
  private async storageGate(
    session: ManagedSession,
    bot: BotLike,
    kind: OperationKind,
    config: unknown
  ): Promise<boolean> {
    const storage = session.profile.storage;
    if (!storage?.enabled) return true;
    if (Date.now() < (session.storageCooldownUntil.get(kind) ?? 0)) return true;
    const restockDue = this.usesWithdraw(kind, config) && this.needsRestock(bot, kind, config);
    const depositDue = this.usesDeposit(kind, config) && this.inventoryNearFull(bot, storage);
    if (!restockDue && !depositDue) return true;
    // Set the cooldown up front so a long/retrying trip can't be re-entered by the next tick.
    session.storageCooldownUntil.set(kind, Date.now() + STORAGE_COOLDOWN_MS);
    if (restockDue) {
      await this.runStorageTripWithRetry(
        session,
        bot,
        kind,
        () => this.runRestockTrip(session, bot, kind, config, storage),
        storage,
        'Restock'
      );
    } else {
      await this.runStorageTripWithRetry(
        session,
        bot,
        kind,
        () => this.runDepositTrip(session, bot, kind, config, storage),
        storage,
        'Deposit'
      );
    }
    return false;
  }

  /** The config an operation is running with — the one captured at start (resumeOps), else the profile default. */
  private resolvedConfig(session: ManagedSession, kind: OperationKind): unknown {
    const saved = session.resumeOps.get(kind);
    if (saved) return saved.config;
    const modules = session.profile.modules;
    switch (kind) {
      case 'cactusFarm':
        return modules?.cactusFarm;
      case 'cropFarm':
        return modules?.cropFarm;
      case 'area':
        return modules?.area;
      case 'generator':
        return modules?.generator;
      default:
        return undefined;
    }
  }

  /** Remember a running op's resolved config so it can be auto-resumed after an involuntary drop. */
  private rememberResume(session: ManagedSession, kind: OperationKind, config: unknown): void {
    if (session.snapshot.operations[kind].state === 'running') {
      session.resumeOps.set(kind, { config });
    } else {
      session.resumeOps.delete(kind);
    }
  }

  /**
   * Best-effort world check before auto-resuming. Aborts only on POSITIVE evidence of a problem
   * (a loaded block that isn't the expected chest, or a farm origin that is now air); an unloaded
   * chunk right after reconnect returns null and is treated as "unknown, proceed" — the storage
   * trips themselves safe-pause later if a chest really is gone.
   */
  private validateResume(
    session: ManagedSession,
    bot: BotLike,
    kind: OperationKind,
    config: unknown
  ): { ok: true } | { ok: false; reason: string } {
    const storage = session.profile.storage;
    if (storage?.enabled) {
      if (this.usesDeposit(kind, config)) {
        const dep = bot.blockAt?.(toVec3(storage.depositTo));
        if (dep && !isContainerBlock(dep)) return { ok: false, reason: 'deposit chest missing' };
      }
      if (this.usesWithdraw(kind, config)) {
        const sup = bot.blockAt?.(toVec3(storage.withdrawFrom));
        if (sup && !isContainerBlock(sup)) return { ok: false, reason: 'supply chest missing' };
      }
    }
    if (kind === 'cropFarm' && session.cropFarmOrigin) {
      const surface = bot.blockAt?.(toVec3(addPosition(session.cropFarmOrigin, { x: 0, y: -1, z: 0 })));
      if (surface && isAirBlock(surface)) return { ok: false, reason: 'crop field origin is gone' };
    }
    return { ok: true };
  }

  /**
   * After the reconnect policy brings the bot back online and the join flow finishes, re-launch
   * the farms that were running when the bot involuntarily dropped — each behind {@link validateResume}.
   * A no-op unless an involuntary drop actually happened; the flag is consumed so a later
   * settings-save or hunger-recovery re-entry into startRoutine won't re-trigger a resume.
   */
  private resumeOperationsAfterReconnect(session: ManagedSession, bot: BotLike): void {
    if (session.desiredStop || session.bot !== bot) return;
    if (!session.involuntaryDrop || session.resumeOps.size === 0) return;
    session.involuntaryDrop = false;
    for (const [kind, saved] of [...session.resumeOps]) {
      if (session.snapshot.operations[kind].state === 'running') continue; // already back (dedupe)
      const check = this.validateResume(session, bot, kind, saved.config);
      if (!check.ok) {
        this.blockOperation(session, kind, `Resume aborted: ${check.reason}`);
        void this.notifyDiscord(
          session,
          `${session.profile.label}: ${OPERATION_LABELS[kind]} not resumed — ${check.reason}`,
          'event'
        );
        continue;
      }
      // Pin the resumed plan to the ORIGINAL farm origin — the bot rejoins wherever it
      // dropped, and rebuilding the plan from that drifted position would start a second,
      // offset farm instead of repairing the existing one.
      const anchor =
        kind === 'cactusFarm' ? session.cactusFarmOrigin
        : kind === 'cropFarm' ? session.cropFarmOrigin
        : kind === 'area' ? session.areaAnchor
        : null;
      if (anchor) session.resumeAnchor.set(kind, anchor);
      this.pushEvent(session, operationEventType(kind), 'ok', `${OPERATION_LABELS[kind]} resumed`, 'Auto-resume after reconnect');
      void this.startOperation(session.profile.id, { kind, config: saved.config as never }).catch((error) => {
        this.blockOperation(session, kind, `Resume failed: ${formatError(error)}`);
      });
    }
  }

  private stopAllOperations(session: ManagedSession): void {
    for (const kind of Object.keys(session.snapshot.operations) as OperationKind[]) {
      this.stopOperationTimer(session, kind);
      session.operationQueues.delete(kind);
      session.operationRetry.delete(kind);
      session.operationPass.delete(kind);
      if (session.snapshot.operations[kind].state === 'running') {
        this.updateOperation(session, kind, 'idle', 'Stopped');
      }
    }
  }

  private stopOperationTimer(session: ManagedSession, kind: OperationKind): void {
    const timer = session.operationTimers.get(kind);
    if (timer) clearTimeout(timer);
    session.operationTimers.delete(kind);
  }

  private blockOperation(
    session: ManagedSession,
    kind: OperationKind,
    detail: string,
    state: OperationSnapshot['state'] = 'blocked'
  ): void {
    this.stopOperationTimer(session, kind);
    session.operationQueues.delete(kind);
    session.operationRetry.delete(kind);
    session.operationPass.delete(kind);
    this.updateOperation(session, kind, state, detail, { total: session.snapshot.operations[kind].total });
    this.pushEvent(session, operationEventType(kind), state === 'error' ? 'danger' : 'warn', `${OPERATION_LABELS[kind]} blocked`, detail);
  }

  private updateOperation(
    session: ManagedSession,
    kind: OperationKind,
    state: OperationSnapshot['state'],
    detail: string | null,
    patch: Partial<Pick<OperationSnapshot, 'completed' | 'total' | 'stats'>> = {}
  ): void {
    const existing = session.snapshot.operations[kind] ?? createOperationSnapshot(kind);
    const now = new Date().toISOString();
    session.snapshot.operations[kind] = {
      ...existing,
      state,
      detail,
      startedAt: state === 'running' && existing.state !== 'running' ? now : existing.startedAt,
      updatedAt: now,
      completed: patch.completed ?? existing.completed,
      total: patch.total === undefined ? existing.total : patch.total,
      stats: patch.stats ? { ...patch.stats } : existing.stats
    };
  }

  private addOperationProgress(
    session: ManagedSession,
    kind: OperationKind,
    completedDelta: number,
    statsDelta: Record<string, number>
  ): void {
    const existing = session.snapshot.operations[kind];
    this.updateOperation(session, kind, existing.state, existing.detail, {
      completed: existing.completed + completedDelta,
      total: existing.total,
      stats: mergeStats(existing.stats, statsDelta)
    });
  }

  private addOperationStats(session: ManagedSession, kind: OperationKind, statsDelta: Record<string, number>): void {
    const existing = session.snapshot.operations[kind];
    this.updateOperation(session, kind, existing.state, existing.detail, {
      completed: existing.completed,
      total: existing.total,
      stats: mergeStats(existing.stats, statsDelta)
    });
  }

  private updateDiscordPolling(session: ManagedSession): void {
    this.stopDiscordPolling(session);
    const config = session.profile.modules?.discord ?? normalizeDiscord();
    const runtime = session.discordRuntime;
    const shouldPoll = runtime.enabled && config.pollCommands && runtime.botToken && runtime.channelId;
    if (!shouldPoll) return;

    const poll = () => {
      void this.pollDiscordCommands(session).finally(() => {
        if (session.discordRuntime.enabled && config.pollCommands) {
          session.discordPollTimer = setTimeout(poll, config.pollIntervalMs);
        }
      });
    };
    session.discordPollTimer = setTimeout(poll, config.pollIntervalMs);
  }

  private stopDiscordPolling(session: ManagedSession): void {
    if (session.discordPollTimer) {
      clearTimeout(session.discordPollTimer);
      session.discordPollTimer = null;
    }
  }

  private async pollDiscordCommands(session: ManagedSession): Promise<void> {
    const config = session.profile.modules?.discord ?? normalizeDiscord();
    const runtime = session.discordRuntime;
    if (!runtime.enabled || !runtime.botToken || !runtime.channelId || !session.bot) return;
    const url = new URL(`${DISCORD_API_BASE}/channels/${encodeURIComponent(runtime.channelId)}/messages`);
    url.searchParams.set('limit', '10');
    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${runtime.botToken}`,
        Accept: 'application/json'
      }
    });
    if (!response.ok) {
      this.blockOperation(session, 'discord', `Discord command poll failed: HTTP ${response.status}`, 'error');
      return;
    }
    const messages = (await response.json()) as Array<{ id: string; content?: string; author?: { bot?: boolean } }>;
    const sorted = [...messages].sort((a, b) => a.id.localeCompare(b.id));
    for (const message of sorted) {
      if (runtime.lastMessageId && message.id <= runtime.lastMessageId) continue;
      runtime.lastMessageId = message.id;
      const content = message.content?.trim() ?? '';
      if (!content.startsWith(config.commandPrefix) || message.author?.bot) continue;
      const command = content.slice(config.commandPrefix.length).trim();
      if (!command) continue;
      session.bot.chat?.(command);
      this.pushChat(session, 'bot', command);
      this.pushEvent(session, 'discord', 'ok', 'Discord command sent', redactSensitiveText(command));
      this.addOperationStats(session, 'discord', { commands: 1 });
    }
    this.emitState();
  }

  private async notifyDiscord(session: ManagedSession, message: string, source: 'chat' | 'event'): Promise<void> {
    const config = session.profile.modules?.discord ?? normalizeDiscord();
    const runtime = session.discordRuntime;
    if (!runtime.enabled || !runtime.webhookUrl) return;
    if (source === 'chat' && !config.notifyChat) return;
    if (source === 'event' && !config.notifyEvents) return;
    try {
      await fetch(runtime.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'ChunkKeeper',
          content: `[${session.profile.label}] ${redactSensitiveText(message)}`.slice(0, 1900)
        })
      });
      this.addOperationStats(session, 'discord', { notifications: 1 });
    } catch (error) {
      this.pushEvent(session, 'discord', 'warn', 'Discord notify failed', formatError(error));
    }
  }

  private updateLiveTelemetry(session: ManagedSession): void {
    const bot = session.bot;
    if (!bot) return;
    session.snapshot.health = typeof bot.health === 'number' ? bot.health : session.snapshot.health;
    session.snapshot.food = typeof bot.food === 'number' ? bot.food : session.snapshot.food;
    session.snapshot.ping = typeof bot.player?.ping === 'number' ? bot.player.ping : session.snapshot.ping;
    session.snapshot.dimension = bot.game?.dimension ?? session.snapshot.dimension ?? 'unknown';
    session.snapshot.playersOnline = bot.players ? Object.keys(bot.players).length : session.snapshot.playersOnline;
    const position = bot.entity?.position;
    if (position) {
      session.snapshot.position = {
        x: round(position.x),
        y: round(position.y),
        z: round(position.z),
        yaw: bot.entity?.yaw,
        pitch: bot.entity?.pitch
      };
    }
    const used = bot.inventory?.items?.().length ?? null;
    session.snapshot.inventoryUsed = used;
    session.snapshot.inventorySize = bot.inventory?.slots?.length ?? session.snapshot.inventorySize ?? 46;
    session.snapshot.inventory = captureInventory(bot);
  }

  private updateStatus(session: ManagedSession, state: BotSessionSnapshot['state'], statusMessage: string): void {
    session.snapshot.state = state;
    session.snapshot.statusMessage = statusMessage;
  }

  private pushEvent(
    session: ManagedSession,
    type: SessionEvent['type'],
    tone: SessionEvent['tone'],
    label: string,
    detail?: string
  ): void {
    session.snapshot.events = [
      {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        profileId: session.profile.id,
        at: new Date().toISOString(),
        type,
        tone,
        label,
        detail
      },
      ...session.snapshot.events
    ].slice(0, MAX_EVENTS);
  }

  private pushChat(session: ManagedSession, source: ChatLine['source'], message: string): void {
    session.snapshot.chat = [
      ...session.snapshot.chat,
      {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        source,
        message
      }
    ].slice(-MAX_CHAT);
  }

  private requireSession(profileId: string): ManagedSession {
    const session = this.sessions.get(profileId);
    if (!session) throw new Error(`Unknown profile: ${profileId}`);
    return session;
  }

  private runtimeSnapshot(): RuntimeSnapshot {
    const snapshots = [...this.sessions.values()].map((session) => session.snapshot);
    const latestError = snapshots.find((snapshot) => snapshot.lastError)?.lastError ?? null;
    return {
      appVersion: this.options.appVersion,
      systemState: latestError ? 'degraded' : 'online',
      botCount: this.profiles.length,
      onlineCount: snapshots.filter((snapshot) => snapshot.state === 'online').length,
      webDashboardUrl: this.webDashboardUrl,
      authSessionDir: this.authSessionDir(),
      estimatedRamMb: Math.max(180, this.profiles.length * 110),
      latestError
    };
  }

  private authSessionDir(): string {
    return this.options.authSessionDir ?? path.join(this.options.userDataDir, 'minecraft-auth-cache');
  }

  private cloneSnapshot(snapshot: BotSessionSnapshot): BotSessionSnapshot {
    return {
      ...snapshot,
      position: snapshot.position ? { ...snapshot.position } : null,
      inventory: cloneInventorySnapshot(snapshot.inventory),
      operations: cloneOperations(snapshot.operations),
      tabCompletions: [...snapshot.tabCompletions],
      events: snapshot.events.map((event) => ({ ...event })),
      chat: snapshot.chat.map((line) => ({ ...line }))
    };
  }

  private emitState(): void {
    if (this.loaded) {
      this.emit('state', this.getState());
    }
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('BotManager.load() must be called first');
  }
}

/**
 * Mineflayer forwards every socket failure into `bot.emit('error', err)`. A bot with no
 * 'error' listener makes Node rethrow that error, which in Electron surfaces as the fatal
 * "A JavaScript error occurred in the main process" dialog. Two windows used to leave a bot
 * bare: the gap between `createBot()` (which opens the socket at once) and `attachBotEvents()`,
 * and everything after `disconnect()` called `removeAllListeners()`. This listener is attached
 * for the bot's whole life so neither window can crash the launcher.
 */
function ignoreBotError(): void {
  // Real handling lives in attachBotEvents; this is only the "never throw" floor.
}

/**
 * Drop a bot we no longer own. Beyond muting its listeners we have to destroy a socket that
 * is still mid-connect: `client.end()` merely queues a FIN, so an unanswered SYN keeps
 * retransmitting and lands as `connect ETIMEDOUT` ~21s after the session was discarded.
 */
function abandonBot(bot: BotLike): void {
  bot.removeAllListeners?.();
  bot.on?.('error', ignoreBotError);
  const socket = bot._client?.socket;
  if (socket?.connecting && !socket.destroyed) {
    socket.destroy();
  }
}

async function defaultMineflayerFactory(options: MineflayerOptions): Promise<BotLike> {
  const mineflayerModule = await import('mineflayer');
  const createBot = mineflayerModule.createBot ?? mineflayerModule.default?.createBot;
  if (!createBot) {
    throw new Error('mineflayer createBot() was not found');
  }
  const bot = createBot(options) as unknown as BotLike;
  // The socket is already connecting; nothing else listens for 'error' until connect()
  // reaches attachBotEvents(), several awaits from here.
  bot.on('error', ignoreBotError);
  try {
    unifyActionSequences(bot);
    await loadPathfinderPlugin(bot);
  } catch (error) {
    abandonBot(bot);
    throw error;
  }
  return bot;
}

function loadMinecraftDataModule(): MinecraftDataModule {
  if (!minecraftDataModule) {
    minecraftDataModule = requireFromHere('minecraft-data') as MinecraftDataModule;
  }
  return minecraftDataModule;
}

function latestSupportedMinecraftVersions(): string[] {
  try {
    const versions = loadMinecraftDataModule().supportedVersions?.pc ?? [];
    return versions.filter((version) => /^\d/.test(version)).slice(-20).reverse();
  } catch {
    return [];
  }
}

function assertMineflayerDataSupportsVersion(version: string | undefined): void {
  const normalized = version?.trim();
  if (!normalized) return;

  try {
    const data = loadMinecraftDataModule()(normalized);
    if (data?.version) return;
    throw new UnsupportedMinecraftVersionError(normalized);
  } catch (error) {
    if (error instanceof UnsupportedMinecraftVersionError) throw error;
    throw new UnsupportedMinecraftVersionError(normalized, `minecraft-data reported: ${formatError(error)}`);
  }
}

/**
 * Stamp every block-action packet with ONE monotonically increasing sequence id, exactly
 * like the vanilla client. mineflayer keeps SEPARATE per-plugin counters (inventory.js for
 * use_item, generic_place for placements) and sends block_dig with NO sequence at all — on
 * Paper 1.21.11 a single bucket use then makes the server silently DISCARD every following
 * dig (measured live: a bot "dug" a 789-block room that never existed server-side, then
 * walked down the phantom staircase). One injected fresh sequence resynchronises the server
 * and digs land again, so unify all three packets at the client-write boundary.
 */
function unifyActionSequences(bot: BotLike): void {
  const holder = bot as unknown as {
    _client?: { write?: (name: string, params: Record<string, unknown>) => unknown; __afkSeqUnified?: boolean };
  };
  const client = holder._client;
  if (!client || typeof client.write !== 'function' || client.__afkSeqUnified) return;
  client.__afkSeqUnified = true;
  let sequence = 1;
  const originalWrite = client.write.bind(client);
  const supportsSequences = (): boolean => {
    try {
      const support = (bot as unknown as { supportFeature?: (name: string) => boolean }).supportFeature;
      return typeof support === 'function' ? Boolean(support.call(bot, 'useItemWithOwnPacket')) : false;
    } catch {
      return false;
    }
  };
  client.write = (name: string, params: Record<string, unknown>) => {
    // Pre-1.19 protocols have no sequence field — adding one would break serialisation.
    if (params && (name === 'block_dig' || name === 'block_place' || name === 'use_item') && supportsSequences()) {
      params.sequence = sequence++;
    }
    return originalWrite(name, params);
  };
}

async function loadPathfinderPlugin(bot: BotLike): Promise<void> {
  try {
    type PathfinderModule = {
      pathfinder?: unknown;
      Movements?: PathfinderMovementsCtor;
      goals?: PathfinderGoals;
      default?: PathfinderModule;
    };
    const imported = (await import('mineflayer-pathfinder')) as unknown as PathfinderModule;
    // mineflayer-pathfinder is CommonJS, so under ESM interop its named exports
    // may land on `.default` instead of the namespace root.
    // Under ESM interop only some members re-export as named bindings (pathfinder,
    // Movements); `goals` stays on the CJS default. Resolve each from whichever
    // layer actually has it — otherwise pathfinderGoals stays null and every walk
    // silently no-ops (the bot can't step off build cells or reach distant ones).
    const layers = [imported, imported.default].filter(Boolean) as PathfinderModule[];
    const pick = <K extends keyof PathfinderModule>(key: K): PathfinderModule[K] | undefined => {
      for (const layer of layers) {
        if (layer[key] != null) return layer[key];
      }
      return undefined;
    };
    const plugin = pick('pathfinder');
    if (plugin && typeof bot.loadPlugin === 'function') {
      bot.loadPlugin(plugin);
      pathfinderPluginRef = plugin;
    }
    const movements = pick('Movements');
    if (movements) pathfinderMovements = movements;
    const goals = pick('goals');
    if (goals) pathfinderGoals = goals;
  } catch {
    // Pathfinder is optional: without it the bot still operates within its
    // stationary reach, exactly as before. Build ops just won't walk.
  }
}

// Movements need bot.registry, which is only populated after spawn.
function configurePathfinderMovements(bot: BotLike): void {
  if (!pathfinderMovements || typeof bot.pathfinder?.setMovements !== 'function') return;
  try {
    const movements = new pathfinderMovements(bot);
    // Keep motion tame so we don't trip anti-cheat or wreck terrain while building.
    movements.allowSprinting = false;
    movements.canDig = false;
    movements.allow1by1towers = false;
    bot.pathfinder.setMovements(movements);
    // Bound the A* COMPUTE phase so unreachable goals reject cleanly and fast on the
    // pathfinder's own error path — our outer timeout must stay a rare last resort,
    // because aborting a goto mid-execution wedges the instance (see gotoWithTimeout).
    (bot.pathfinder as unknown as Record<string, unknown>).thinkTimeout = 3000;
  } catch {
    // ignore — walking just falls back to no-op
  }
}

function createProxyConnector(proxy: ProxyConfig, destinationHost: string, destinationPort: number): (client: ProxyClientLike) => void {
  return (client) => {
    void connectThroughProxy(proxy, destinationHost, destinationPort)
      .then((socket) => {
        client.setSocket?.(socket);
        client.emit?.('connect');
      })
      .catch((error) => {
        client.emit?.('error', error);
      });
  };
}

async function connectThroughProxy(proxy: ProxyConfig, destinationHost: string, destinationPort: number): Promise<net.Socket> {
  if (proxy.type === 'socks4' || proxy.type === 'socks5') {
    const socksModule = await import('socks');
    const { socket } = await socksModule.SocksClient.createConnection({
      command: 'connect',
      destination: {
        host: destinationHost,
        port: destinationPort
      },
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: proxy.type === 'socks4' ? 4 : 5,
        userId: proxy.username || undefined,
        password: proxy.password || undefined
      }
    });
    return socket;
  }
  return connectHttpProxy(proxy, destinationHost, destinationPort);
}

function connectHttpProxy(proxy: ProxyConfig, destinationHost: string, destinationPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    const chunks: Buffer[] = [];
    let settled = false;

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('connect', onConnect);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };

    const onError = (error: Error) => fail(error);
    const onConnect = () => {
      const auth =
        proxy.username || proxy.password
          ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
          : '';
      socket.write(
        `CONNECT ${destinationHost}:${destinationPort} HTTP/1.1\r\nHost: ${destinationHost}:${destinationPort}\r\n${auth}\r\n`
      );
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const boundary = raw.indexOf('\r\n\r\n');
      if (boundary < 0) return;

      const header = raw.slice(0, boundary).toString('utf8');
      if (!/^HTTP\/\d(?:\.\d)? 2\d\d\b/.test(header)) {
        fail(new Error(`HTTP proxy CONNECT failed: ${header.split('\r\n')[0] ?? 'unknown response'}`));
        return;
      }

      const rest = raw.slice(boundary + 4);
      if (rest.length > 0) socket.unshift(rest);
      settled = true;
      cleanup();
      resolve(socket);
    };

    socket.on('connect', onConnect);
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function installResourcePackAutoAccept(bot: BotLike): void {
  const client = bot._client;
  if (!client) return;

  client.on('add_resource_pack', (packet: { uuid?: string }) => {
    if (!packet.uuid) return;
    setTimeout(() => {
      if (typeof bot.acceptResourcePack === 'function') {
        bot.acceptResourcePack();
        return;
      }
      client.write?.('resource_pack_receive', { uuid: packet.uuid, result: 3 });
      client.write?.('resource_pack_receive', { uuid: packet.uuid, result: 0 });
    }, 0);
  });
}

function createSessionSnapshot(profileId: string): BotSessionSnapshot {
  return {
    profileId,
    state: 'idle',
    statusMessage: 'Ready',
    ping: null,
    health: null,
    food: null,
    position: null,
    dimension: null,
    inventoryUsed: null,
    inventorySize: null,
    inventory: emptyInventorySnapshot(),
    playersOnline: null,
    startupActive: false,
    routineActive: false,
    operations: createOperationSnapshots(),
    tabCompletions: [],
    connectedAt: null,
    nextReconnectAt: null,
    lastError: null,
    reconnectAttempts: 0,
    events: [
      {
        id: `${profileId}-ready`,
        profileId,
        at: new Date().toISOString(),
        type: 'system',
        tone: 'muted',
        label: 'Session ready'
      }
    ],
    chat: [
      {
        id: `${profileId}-system`,
        at: new Date().toISOString(),
        source: 'system',
        message: 'Session is ready. Connect only to servers where AFK bots are permitted.'
      }
    ]
  };
}

const DEFAULT_INVENTORY_WINDOW: InventoryWindowLayout = {
  kind: 'inventory',
  title: null,
  totalSlots: 0,
  inventoryStart: 9,
  hotbarStart: 36,
  craftingResultSlot: 0
};

function emptyInventorySnapshot(): LiveInventorySnapshot {
  return {
    updatedAt: null,
    heldItem: null,
    selectedHotbar: null,
    armor: [],
    crafting: [],
    storage: [],
    slots: [],
    window: { ...DEFAULT_INVENTORY_WINDOW },
    openWindowTitle: null
  };
}

function createOperationSnapshots(): Record<OperationKind, OperationSnapshot> {
  return {
    cactusFarm: createOperationSnapshot('cactusFarm'),
    cropFarm: createOperationSnapshot('cropFarm'),
    area: createOperationSnapshot('area'),
    generator: createOperationSnapshot('generator'),
    script: createOperationSnapshot('script'),
    discord: createOperationSnapshot('discord')
  };
}

function createOperationSnapshot(kind: OperationKind): OperationSnapshot {
  return {
    kind,
    state: 'idle',
    label: OPERATION_LABELS[kind],
    detail: null,
    startedAt: null,
    updatedAt: null,
    completed: 0,
    total: null,
    stats: {}
  };
}

function cloneInventorySnapshot(snapshot: LiveInventorySnapshot): LiveInventorySnapshot {
  return {
    updatedAt: snapshot.updatedAt,
    heldItem: snapshot.heldItem ? { ...snapshot.heldItem } : null,
    selectedHotbar: snapshot.selectedHotbar,
    armor: snapshot.armor.map((item) => ({ ...item })),
    crafting: snapshot.crafting.map((item) => ({ ...item })),
    storage: snapshot.storage.map((item) => ({ ...item })),
    slots: snapshot.slots.map((item) => ({ ...item })),
    window: { ...(snapshot.window ?? DEFAULT_INVENTORY_WINDOW) },
    openWindowTitle: snapshot.openWindowTitle
  };
}

function cloneOperations(operations: Record<OperationKind, OperationSnapshot>): Record<OperationKind, OperationSnapshot> {
  return {
    cactusFarm: cloneOperation(operations.cactusFarm),
    cropFarm: cloneOperation(operations.cropFarm),
    area: cloneOperation(operations.area),
    generator: cloneOperation(operations.generator),
    script: cloneOperation(operations.script),
    discord: cloneOperation(operations.discord)
  };
}

function cloneOperation(operation: OperationSnapshot): OperationSnapshot {
  return {
    ...operation,
    stats: { ...operation.stats }
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve when the server (re)sends a block at `position` (mineflayer's `blockUpdate`) or after
 * `capMs`, whichever comes first. Used after a dig so a server rejection is caught as soon as the
 * corrected block arrives on a responsive server, while a genuine success still waits the cap
 * (there's no positive "confirmed" packet to key off of).
 */
function waitForBlockChange(bot: BotLike, position: PositionSnapshot, capMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bot.off('blockUpdate', onUpdate);
      resolve();
    };
    const onUpdate = (_oldBlock: unknown, newBlock: { position?: { x: number; y: number; z: number } } | null): void => {
      const point = newBlock?.position;
      if (point && point.x === position.x && point.y === position.y && point.z === position.z) finish();
    };
    const timer = setTimeout(finish, capMs);
    bot.on('blockUpdate', onUpdate);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

function cloneSettings(settings: AppSettings): AppSettings {
  return { ...settings, defaultReconnect: { ...settings.defaultReconnect } };
}

function normalizeSettings(settings?: Partial<AppSettings>): AppSettings {
  const reconnect = settings?.defaultReconnect;
  return {
    autoStartOnLaunch: Boolean(settings?.autoStartOnLaunch),
    connectStaggerMs: clamp(Number(settings?.connectStaggerMs), 0, 60000, DEFAULT_SETTINGS.connectStaggerMs),
    confirmStopAll: settings?.confirmStopAll ?? DEFAULT_SETTINGS.confirmStopAll,
    showChatTimestamps: settings?.showChatTimestamps ?? DEFAULT_SETTINGS.showChatTimestamps,
    compactDensity: Boolean(settings?.compactDensity),
    minimizeToTrayOnClose: settings?.minimizeToTrayOnClose ?? DEFAULT_SETTINGS.minimizeToTrayOnClose,
    defaultReconnect: {
      enabled: reconnect?.enabled ?? DEFAULT_SETTINGS.defaultReconnect.enabled,
      maxAttempts: clamp(Number(reconnect?.maxAttempts), 0, 999, DEFAULT_SETTINGS.defaultReconnect.maxAttempts),
      baseDelayMs: clamp(Number(reconnect?.baseDelayMs), 1000, 600000, DEFAULT_SETTINGS.defaultReconnect.baseDelayMs),
      maxDelayMs: clamp(Number(reconnect?.maxDelayMs), 1000, 600000, DEFAULT_SETTINGS.defaultReconnect.maxDelayMs)
    }
  };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function stringifyReason(reason: unknown): string {
  const componentText = stringifyMinecraftText(reason);
  if (componentText) return componentText;
  // Never surface raw JSON or "[object Object]" to the user: when a component carries
  // no readable text, fall back to a plain human-readable description.
  if (typeof reason === 'string') {
    const stripped = stripSectionCodes(reason).trim();
    return stripped || 'Disconnected';
  }
  return 'Disconnected';
}

export function stringifyMinecraftText(reason: unknown): string | null {
  const text = collectMinecraftText(parseMinecraftJson(reason)).replace(/[ \t\r\n]+/g, ' ').trim();
  return text || null;
}

function parseMinecraftJson(reason: unknown): unknown {
  if (typeof reason !== 'string') return reason;
  const trimmed = reason.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return reason;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return reason;
  }
}

// Minecraft formatting uses the section sign (U+00A7) followed by a single code char
// (colors, bold/italic, and the §x§r§r… hex sequences). Strip every §-sequence so raw
// color/format codes never reach the chat console, kick reasons, or window titles.
function stripSectionCodes(value: string): string {
  return value.replace(/§./g, '').replace(/§/g, '');
}

// Friendly text for the disconnect/auth translate keys servers send most often. Without
// the client language table we can't resolve arbitrary keys, so we cover the common ones
// and humanize anything else — the goal is to never show a raw "foo.bar.baz" key.
const KNOWN_TRANSLATIONS: Record<string, string> = {
  'multiplayer.disconnect.server_full': 'Server is full',
  'multiplayer.disconnect.kicked': 'Kicked by an operator',
  'multiplayer.disconnect.banned': 'You are banned from this server',
  'multiplayer.disconnect.banned.reason': 'Banned: %s',
  'multiplayer.disconnect.banned.expiration': 'Banned until %s',
  'multiplayer.disconnect.idling': 'Kicked for idling',
  'multiplayer.disconnect.duplicate_login': 'Logged in from another location',
  'multiplayer.disconnect.server_shutdown': 'Server closed',
  'multiplayer.disconnect.not_whitelisted': 'Not whitelisted on this server',
  'multiplayer.disconnect.outdated_client': 'Outdated client (%s)',
  'multiplayer.disconnect.outdated_server': 'Outdated server (%s)',
  'multiplayer.disconnect.unverified_username': 'Could not verify username',
  'multiplayer.disconnect.authservers_down': 'Authentication servers are down',
  'multiplayer.disconnect.slow_login': 'Took too long to log in',
  'multiplayer.disconnect.flying': 'Flying is not allowed on this server',
  'multiplayer.disconnect.generic': 'Disconnected',
  'disconnect.timeout': 'Connection timed out',
  'disconnect.kicked': 'Kicked',
  'disconnect.spam': 'Kicked for spamming',
  'disconnect.closed': 'Connection closed',
  'disconnect.lost': 'Connection lost',
  'disconnect.genericReason': '%s',
  'chat.type.text': '<%s> %s',
  'chat.type.announcement': '[%s] %s'
};

// Substitute %s (sequential) and %n$s (indexed) placeholders, like Minecraft's templates.
function applyTranslationTemplate(template: string, args: string[]): string {
  let next = 0;
  return template
    .replace(/%(\d+)\$s/g, (_match, index: string) => args[Number(index) - 1] ?? '')
    .replace(/%s/g, () => args[next++] ?? '');
}

// Turn a dotted identifier (translate / keybind id) into readable words: the last
// segment, separators to spaces, first letter capitalized. e.g. server_full -> "Server full".
function humanizeIdentifier(value: string): string {
  const last = value.split('.').pop() ?? value;
  const words = last.replace(/[._-]+/g, ' ').trim();
  if (!words) return value;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function renderTranslate(key: string, args: string[], fallback: unknown): string {
  const template = KNOWN_TRANSLATIONS[key] ?? (typeof fallback === 'string' ? fallback : null);
  if (template) return applyTranslationTemplate(stripSectionCodes(template), args).trim();
  const humanized = humanizeIdentifier(key);
  const extras = args.map((arg) => arg.trim()).filter(Boolean);
  return extras.length ? `${humanized}: ${extras.join(' ')}` : humanized;
}

// Flatten a Minecraft chat component (object, JSON, or string) into plain display text.
// Handles text/extra, translate (+with/fallback), and score/selector/keybind shapes, and
// always strips section-sign color codes.
function collectMinecraftText(value: unknown): string {
  if (typeof value === 'string') return stripSectionCodes(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(collectMinecraftText).join('');
  if (!value || typeof value !== 'object') return '';

  const component = value as Record<string, unknown>;
  let text = '';

  if (typeof component.text === 'string') text += stripSectionCodes(component.text);
  else if (typeof component.text === 'number' || typeof component.text === 'boolean') text += String(component.text);

  if (!text && typeof component.translate === 'string') {
    const args = Array.isArray(component.with) ? component.with.map(collectMinecraftText) : [];
    text += renderTranslate(component.translate, args, component.fallback);
  }

  if (!text && component.score && typeof component.score === 'object') {
    const score = component.score as Record<string, unknown>;
    if (typeof score.value === 'string' || typeof score.value === 'number') text += String(score.value);
    else if (typeof score.name === 'string') text += stripSectionCodes(score.name);
  }

  if (!text && typeof component.selector === 'string') text += stripSectionCodes(component.selector);
  if (!text && typeof component.keybind === 'string') text += humanizeIdentifier(component.keybind);

  if (Array.isArray(component.extra)) text += component.extra.map(collectMinecraftText).join('');

  return text;
}

function cloneProfile(profile: AccountProfile): AccountProfile {
  return {
    ...profile,
    startup: { ...profile.startup, flowCommands: (profile.startup.flowCommands ?? []).map((step) => ({ ...step })) },
    routine: { ...profile.routine, chatMessages: [...profile.routine.chatMessages] },
    reconnect: { ...profile.reconnect },
    proxy: profile.proxy ? { ...profile.proxy } : normalizeProxy(),
    modules: cloneModules(profile.modules ?? normalizeModules()),
    storage: cloneStorage(profile.storage ?? defaultStorage())
  };
}

/**
 * Profile shape sent to the renderer / web dashboard: identical to a clone but with the two
 * secrets blanked and replaced by `has*Password` booleans. This is what closes the cleartext
 * leak in the broadcast state — plaintext passwords only ever live in the in-memory profiles and
 * are read directly at connect time, never round-tripped through `getState()`.
 */
function redactProfileForBroadcast(profile: AccountProfile): AccountProfile {
  const clone = cloneProfile(profile);
  clone.hasAuthPassword = Boolean(profile.startup.authPassword);
  clone.hasProxyPassword = Boolean(profile.proxy?.password);
  clone.startup.authPassword = '';
  if (clone.proxy) clone.proxy.password = '';
  return clone;
}

function cloneStorage(storage: StorageConfig): StorageConfig {
  return { ...storage, withdrawFrom: { ...storage.withdrawFrom }, depositTo: { ...storage.depositTo } };
}

function profileForPersistence(profile: AccountProfile): AccountProfile {
  return {
    ...cloneProfile(profile),
    startup: {
      ...profile.startup,
      flowCommands: (profile.startup.flowCommands ?? []).map((step) => ({ ...step })),
      authPassword: ''
    },
    proxy: profile.proxy ? { ...profile.proxy, password: '' } : normalizeProxy(),
    modules: profile.modules ? stripModuleSecrets(profile.modules) : normalizeModules()
  };
}

function normalizeProfile(profile: AccountProfile): AccountProfile {
  return {
    ...profile,
    startup: normalizeStartup(profile.startup),
    routine: normalizeRoutine(profile.routine),
    reconnect: {
      enabled: profile.reconnect?.enabled ?? true,
      maxAttempts: Math.max(0, Number(profile.reconnect?.maxAttempts) || 0),
      baseDelayMs: Math.max(1000, Number(profile.reconnect?.baseDelayMs) || 5000),
      maxDelayMs: Math.max(1000, Number(profile.reconnect?.maxDelayMs) || 90000)
    },
    proxy: normalizeProxy(profile.proxy),
    modules: normalizeModules(profile.modules),
    storage: normalizeStorage(profile.storage)
  };
}

/**
 * Migration seam: runs on every profile at load. Old `profiles.json` files lacking `storage`
 * get full defaults; malformed values are coerced/clamped. No version bump needed.
 */
export function normalizeStorage(storage?: Partial<StorageConfig>): StorageConfig {
  const d = defaultStorage();
  const coord = (value: unknown, fallback: number): number =>
    Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
  const pos = (p: Partial<PositionSnapshot> | undefined, f: PositionSnapshot): PositionSnapshot => ({
    x: coord(p?.x, f.x),
    y: coord(p?.y, f.y),
    z: coord(p?.z, f.z)
  });
  return {
    enabled: Boolean(storage?.enabled),
    withdrawFrom: pos(storage?.withdrawFrom, d.withdrawFrom),
    depositTo: pos(storage?.depositTo, d.depositTo),
    depositAtPercentFull: clamp(Number(storage?.depositAtPercentFull), 0.5, 0.95, d.depositAtPercentFull),
    keepSeedStacks: clamp(Math.round(Number(storage?.keepSeedStacks)), 0, 5, d.keepSeedStacks),
    retryAttempts: clamp(Math.round(Number(storage?.retryAttempts)), 1, 10, d.retryAttempts)
  };
}

function normalizeProxy(proxy?: Partial<ProxyConfig>): ProxyConfig {
  const type = proxy?.type;
  return {
    enabled: Boolean(proxy?.enabled),
    type: type === 'socks4' || type === 'socks5' || type === 'http' || type === 'https' ? type : DEFAULT_PROXY.type,
    host: proxy?.host?.trim() ?? '',
    port: clamp(Number(proxy?.port), 0, 65535, 0),
    username: proxy?.username?.trim() ?? '',
    password: proxy?.password ?? ''
  };
}

function normalizeModules(modules?: Partial<BotModulesConfig>): BotModulesConfig {
  return {
    cactusFarm: normalizeCactusFarm(modules?.cactusFarm),
    cropFarm: normalizeCropFarm(modules?.cropFarm),
    area: normalizeAreaOperation(modules?.area),
    generator: normalizeGeneratorMine(modules?.generator),
    script: normalizeScript(modules?.script),
    discord: normalizeDiscord(modules?.discord),
    autoResponse: normalizeAutoResponse(modules?.autoResponse)
  };
}

function cloneModules(modules: BotModulesConfig): BotModulesConfig {
  return {
    cactusFarm: { ...modules.cactusFarm },
    cropFarm: { ...modules.cropFarm },
    area: {
      ...modules.area,
      from: { ...modules.area.from },
      to: { ...modules.area.to }
    },
    generator: {
      ...modules.generator,
      slots: modules.generator.slots.map((slot) => ({ ...slot }))
    },
    script: {
      ...modules.script,
      steps: modules.script.steps.map((step) => ({ ...step })),
      quickCommands: modules.script.quickCommands.map((step) => ({ ...step }))
    },
    discord: { ...modules.discord },
    autoResponse: {
      ...modules.autoResponse,
      rules: modules.autoResponse.rules.map((rule) => ({ ...rule }))
    }
  };
}

function stripModuleSecrets(modules: BotModulesConfig): BotModulesConfig {
  return cloneModules(normalizeModules(modules));
}

function normalizeCactusFarm(config?: Partial<CactusFarmConfig>): CactusFarmConfig {
  return {
    enabled: Boolean(config?.enabled),
    layers: clamp(Number(config?.layers), 1, 12, DEFAULT_MODULES.cactusFarm.layers),
    radius: clamp(Number(config?.radius), 1, 8, DEFAULT_MODULES.cactusFarm.radius),
    placementDelayMs: clamp(
      Number(config?.placementDelayMs),
      100,
      10000,
      DEFAULT_MODULES.cactusFarm.placementDelayMs
    ),
    build: config?.build ?? DEFAULT_MODULES.cactusFarm.build,
    breakBlock: config?.breakBlock === 'glass_pane' ? 'glass_pane' : 'oak_fence',
    buildCollection: config?.buildCollection ?? DEFAULT_MODULES.cactusFarm.buildCollection,
    rowPairs: clamp(Number(config?.rowPairs), 1, 8, DEFAULT_MODULES.cactusFarm.rowPairs),
    wallBlock:
      config?.wallBlock === 'cobblestone' || config?.wallBlock === 'smooth_stone'
        ? config.wallBlock
        : 'glass',
    columns: clamp(Number(config?.columns), 1, 4, DEFAULT_MODULES.cactusFarm.columns),
    basinLayers: clamp(Number(config?.basinLayers), 1, 3, DEFAULT_MODULES.cactusFarm.basinLayers)
  };
}

function normalizeCropFarm(config?: Partial<CropFarmConfig>): CropFarmConfig {
  const crop = config?.crop;
  return {
    enabled: Boolean(config?.enabled),
    crop:
      crop === 'wheat' ||
      crop === 'carrot' ||
      crop === 'potato' ||
      crop === 'beetroot' ||
      crop === 'nether_wart' ||
      crop === 'pumpkin' ||
      crop === 'melon'
        ? crop
        : DEFAULT_MODULES.cropFarm.crop,
    radius: clamp(Number(config?.radius), 1, MAX_CROP_RADIUS, DEFAULT_MODULES.cropFarm.radius),
    harvestDelayMs: clamp(Number(config?.harvestDelayMs), 100, 30000, DEFAULT_MODULES.cropFarm.harvestDelayMs),
    replant: config?.replant ?? DEFAULT_MODULES.cropFarm.replant,
    collectDrops: config?.collectDrops ?? DEFAULT_MODULES.cropFarm.collectDrops,
    build: config?.build ?? DEFAULT_MODULES.cropFarm.build,
    autoTill: config?.autoTill ?? DEFAULT_MODULES.cropFarm.autoTill,
    waterMode: config?.waterMode === 'existing' ? 'existing' : 'auto'
  };
}

function normalizeAreaOperation(config?: Partial<AreaOperationConfig>): AreaOperationConfig {
  const mode = config?.mode === 'fill' ? 'fill' : 'mine';
  return {
    enabled: Boolean(config?.enabled),
    mode,
    coords: config?.coords === 'absolute' ? 'absolute' : 'relative',
    from: normalizePosition(config?.from, DEFAULT_MODULES.area.from),
    to: normalizePosition(config?.to, DEFAULT_MODULES.area.to),
    fillBlock: config?.fillBlock?.trim() || DEFAULT_MODULES.area.fillBlock,
    hollow: config?.hollow ?? DEFAULT_MODULES.area.hollow,
    walk: config?.walk ?? DEFAULT_MODULES.area.walk,
    actionDelayMs: clamp(Number(config?.actionDelayMs), 100, 30000, DEFAULT_MODULES.area.actionDelayMs)
  };
}

const MAX_GENERATOR_SLOTS = 16;

function normalizeGeneratorSlots(slots: GeneratorMineConfig['slots'] | undefined): GeneratorSlot[] {
  if (!Array.isArray(slots)) return DEFAULT_MODULES.generator.slots.map((slot) => ({ ...slot }));
  const normalized = slots.slice(0, MAX_GENERATOR_SLOTS).map((slot, index) => ({
    id: typeof slot?.id === 'string' && slot.id ? slot.id : `gen-${index}`,
    x: clamp(Number(slot?.x), -8, 8, 0),
    y: clamp(Number(slot?.y), -8, 8, 0),
    z: clamp(Number(slot?.z), -8, 8, 0)
  }));
  return normalized;
}

function normalizeGeneratorMine(config?: Partial<GeneratorMineConfig>): GeneratorMineConfig {
  return {
    enabled: Boolean(config?.enabled),
    slots: normalizeGeneratorSlots(config?.slots),
    blockFilter: config?.blockFilter?.trim() ?? DEFAULT_MODULES.generator.blockFilter,
    walk: config?.walk ?? DEFAULT_MODULES.generator.walk,
    actionDelayMs: clamp(Number(config?.actionDelayMs), 100, 30000, DEFAULT_MODULES.generator.actionDelayMs),
    regenDelayMs: clamp(Number(config?.regenDelayMs), 0, 120000, DEFAULT_MODULES.generator.regenDelayMs)
  };
}

function normalizeScript(config?: Partial<ScriptConfig>): ScriptConfig {
  return {
    enabled: Boolean(config?.enabled),
    loop: config?.loop ?? DEFAULT_MODULES.script.loop,
    steps: normalizeScriptSteps(config?.steps, DEFAULT_MODULES.script.steps),
    quickCommands: normalizeScriptSteps(config?.quickCommands, DEFAULT_MODULES.script.quickCommands)
  };
}

function normalizeScriptSteps(steps: ScriptStep[] | undefined, fallback: ScriptStep[]): ScriptStep[] {
  const source = Array.isArray(steps) && steps.length > 0 ? steps : fallback;
  return source
    .map((step, index) => ({
      id: step.id?.trim() || `step-${index + 1}`,
      label: step.label?.trim() || `Step ${index + 1}`,
      command: step.command?.trim() ?? '',
      delayMs: clamp(Number(step.delayMs), 0, 600000, index === 0 ? 0 : 1000)
    }))
    .filter((step) => step.command);
}

function normalizeDiscord(config?: Partial<DiscordConfig>): DiscordConfig {
  return {
    enabled: Boolean(config?.enabled),
    commandPrefix: config?.commandPrefix?.trim() || DEFAULT_MODULES.discord.commandPrefix,
    notifyChat: config?.notifyChat ?? DEFAULT_MODULES.discord.notifyChat,
    notifyEvents: config?.notifyEvents ?? DEFAULT_MODULES.discord.notifyEvents,
    pollCommands: Boolean(config?.pollCommands),
    pollIntervalMs: clamp(Number(config?.pollIntervalMs), 5000, 120000, DEFAULT_MODULES.discord.pollIntervalMs),
    channelId: config?.channelId?.trim() ?? ''
  };
}

function normalizeAutoResponse(config?: Partial<AutoResponseConfig>): AutoResponseConfig {
  return {
    enabled: Boolean(config?.enabled),
    rules: normalizeAutoResponseRules(config?.rules)
  };
}

function normalizeAutoResponseRules(rules?: AutoResponseRule[]): AutoResponseRule[] {
  const source = rules?.length ? rules : DEFAULT_MODULES.autoResponse.rules;
  return source
    .map((rule, index) => ({
      id: rule.id?.trim() || `auto-response-${index + 1}`,
      enabled: rule.enabled ?? true,
      label: rule.label?.trim() || `Rule ${index + 1}`,
      match: rule.match?.trim() ?? '',
      response: rule.response?.trim() ?? '',
      cooldownMs: clamp(Number(rule.cooldownMs), 0, 300000, 5000)
    }))
    .filter((rule) => rule.match && rule.response)
    .slice(0, 16);
}

function normalizePosition(value: Partial<PositionSnapshot> | undefined, fallback: PositionSnapshot): PositionSnapshot {
  return {
    x: Number.isFinite(Number(value?.x)) ? Number(value?.x) : fallback.x,
    y: Number.isFinite(Number(value?.y)) ? Number(value?.y) : fallback.y,
    z: Number.isFinite(Number(value?.z)) ? Number(value?.z) : fallback.z
  };
}

function normalizeRoutine(routine?: Partial<AfkRoutineConfig>): AfkRoutineConfig {
  const eatAtFood = clamp(Number(routine?.eatAtFood), 1, 19, 14);
  const pauseAtFood = Math.min(eatAtFood, clamp(Number(routine?.pauseAtFood), 0, 19, 6));
  return {
    randomLook: routine?.randomLook ?? true,
    autoJump: routine?.autoJump ?? true,
    sneakPulse: Boolean(routine?.sneakPulse),
    swingArm: routine?.swingArm ?? true,
    chatHeartbeat: Boolean(routine?.chatHeartbeat),
    autoRespawn: routine?.autoRespawn ?? true,
    autoEat: routine?.autoEat ?? true,
    eatAtFood,
    pauseAtFood,
    intervalMs: Math.max(3000, Number(routine?.intervalMs) || 18000),
    jitterPercent: clamp(Number(routine?.jitterPercent), 0, 80, 0),
    chatMessages: Array.isArray(routine?.chatMessages) ? routine.chatMessages.filter(Boolean) : []
  };
}

function normalizeStartup(startup?: Partial<StartupFlowConfig>): StartupFlowConfig {
  const authMode = normalizeLobbyAuthMode(startup?.authMode);
  return {
    enabled: Boolean(startup?.enabled),
    authMode,
    authCommandTemplate: startup?.authCommandTemplate?.trim() || '/login {password}',
    registerCommandTemplate: startup?.registerCommandTemplate?.trim() || '/register {password} {password}',
    authPassword: startup?.authPassword ?? '',
    authDelayMs: Math.max(0, Number(startup?.authDelayMs) || 2500),
    transferCommand: startup?.transferCommand?.trim() || '/smp',
    transferDelayMs: Math.max(0, Number(startup?.transferDelayMs) || 3500),
    flowCommands: normalizeScriptSteps(startup?.flowCommands, []),
    readyPatterns: normalizeStringList(startup?.readyPatterns),
    authSuccessPatterns: normalizeStringList(startup?.authSuccessPatterns)
  };
}

/** Trim + drop blanks from an optional string list; undefined when nothing remains. */
function normalizeStringList(values?: string[]): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const cleaned = values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

function normalizeLobbyAuthMode(value?: string): LobbyAuthMode {
  if (value === 'none' || value === 'login' || value === 'register' || value === 'custom') return value;
  return 'login';
}

/** Compile optional join-flow signal patterns to case-insensitive regexes, skipping blanks/invalid ones. */
function compileStartupPatterns(patterns?: string[]): RegExp[] {
  if (!patterns?.length) return [];
  const compiled: RegExp[] = [];
  for (const raw of patterns) {
    const source = raw.trim();
    if (!source) continue;
    try {
      compiled.push(new RegExp(source, 'i'));
    } catch {
      // Ignore malformed patterns rather than aborting the whole join flow.
    }
  }
  return compiled;
}

function renderAuthCommand(startup: StartupFlowConfig): string {
  const template = authCommandTemplate(startup);
  if (!template) return '';
  if (template.includes('{password}') && !startup.authPassword) return '';
  return template.replaceAll('{password}', startup.authPassword).trim();
}

function authCommandTemplate(startup: StartupFlowConfig): string {
  switch (startup.authMode) {
    case 'none':
      return '';
    case 'register':
      return startup.registerCommandTemplate.trim();
    case 'login':
    case 'custom':
      return startup.authCommandTemplate.trim();
    default:
      return '';
  }
}

function authRequiresPassword(startup: StartupFlowConfig): boolean {
  return authCommandTemplate(startup).includes('{password}');
}

function redactCommand(command: string, password: string): string {
  if (!password) return command;
  return command.replaceAll(password, '******');
}

function describeStartupFlow(startup: StartupFlowConfig): string {
  const parts = [];
  if (authCommandTemplate(startup)) parts.push(startup.authMode === 'register' ? 'lobby register' : 'lobby auth');
  if (startup.transferCommand.trim()) parts.push(startup.transferCommand.trim());
  if (startup.flowCommands.length > 0) parts.push(`${startup.flowCommands.length} flow command${startup.flowCommands.length === 1 ? '' : 's'}`);
  return parts.join(' -> ') || 'no commands';
}

function findBestFoodItem(items: InventoryItemLike[], registry?: BotRegistryLike): InventoryItemLike | null {
  let best: InventoryItemLike | null = null;
  let bestScore = -1;
  for (const item of items) {
    const score = foodScore(item, registry);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0 ? best : null;
}

function foodScore(item: InventoryItemLike, registry?: BotRegistryLike): number {
  const key = itemKey(item);
  if (key && UNSAFE_FOODS.has(key)) return -1;
  const foodData = findFoodData(item, registry);
  if (foodData) {
    if (UNSAFE_FOODS.has(foodData.name)) return -1;
    return foodData.effectiveQuality ?? foodData.foodPoints + (foodData.saturation ?? 0);
  }
  if (typeof item.effectiveQuality === 'number') return item.effectiveQuality;
  if (typeof item.foodPoints === 'number') return item.foodPoints + (item.saturation ?? 0);
  return key ? SAFE_FOOD_FALLBACK_SCORE[key] ?? -1 : -1;
}

function findFoodData(item: InventoryItemLike, registry?: BotRegistryLike): FoodDataLike | null {
  if (!registry) return null;
  if (typeof item.type === 'number' && registry.foods?.[item.type]) {
    return registry.foods[item.type];
  }
  const key = itemKey(item);
  if (key && registry.foodsByName?.[key]) {
    return registry.foodsByName[key];
  }
  return null;
}

function itemKey(item: InventoryItemLike): string | null {
  const name = item.name ?? item.displayName;
  if (!name) return null;
  return name.toLowerCase().replaceAll(' ', '_');
}

function itemLabel(item: InventoryItemLike): string {
  return item.displayName ?? item.name ?? 'food item';
}

function captureInventory(bot: BotLike): LiveInventorySnapshot {
  const registry = bot.registry;
  // Armor / crafting / held are player-inventory concepts and stay valid even while a container is open.
  const playerSlots = (bot.inventory?.slots ?? [])
    .map((item, slot) => itemSnapshot(item, slot, registry))
    .filter((item): item is InventoryItemSnapshot => Boolean(item));
  const heldSlot = typeof bot.quickBarSlot === 'number' ? 36 + bot.quickBarSlot : null;
  const heldItem = itemSnapshot(
    bot.heldItem ?? (heldSlot == null ? null : bot.inventory?.slots?.[heldSlot]),
    heldSlot ?? -1,
    registry
  );

  // The interactive grid is backed by whichever window is currently open. Slot indices in this
  // array are the real window indices that moveSlotItem / clickWindow operate on.
  const container = bot.currentWindow ?? null;
  const activeWindow: WindowLike = container ?? bot.inventory ?? {};
  const activeSlots = (activeWindow.slots ?? [])
    .map((item, slot) => itemSnapshot(item, slot, registry))
    .filter((item): item is InventoryItemSnapshot => Boolean(item));

  const window: InventoryWindowLayout = {
    kind: container ? 'container' : 'inventory',
    title: stringifyMinecraftText(activeWindow.title ?? null),
    totalSlots: activeWindow.slots?.length ?? (container ? activeSlots.length : 46),
    inventoryStart: typeof activeWindow.inventoryStart === 'number' ? activeWindow.inventoryStart : 9,
    hotbarStart: typeof activeWindow.hotbarStart === 'number' ? activeWindow.hotbarStart : 36,
    craftingResultSlot: typeof activeWindow.craftingResultSlot === 'number' ? activeWindow.craftingResultSlot : 0
  };

  return {
    updatedAt: new Date().toISOString(),
    heldItem,
    selectedHotbar: typeof bot.quickBarSlot === 'number' ? bot.quickBarSlot : null,
    armor: playerSlots.filter((item) => item.slot >= 5 && item.slot <= 8),
    crafting: playerSlots.filter((item) => item.slot >= 1 && item.slot <= 4),
    storage: container ? activeSlots : playerSlots.filter((item) => item.slot >= 9),
    slots: activeSlots,
    window,
    openWindowTitle: stringifyMinecraftText(bot.currentWindow?.title ?? null)
  };
}

function itemSnapshot(
  item: InventoryItemLike | null | undefined,
  fallbackSlot: number | null,
  registry?: BotRegistryLike
): InventoryItemSnapshot | null {
  if (!item || !item.name) return null;
  return {
    slot: typeof item.slot === 'number' ? item.slot : fallbackSlot ?? -1,
    name: item.name,
    displayName: item.displayName ?? item.name,
    count: Math.max(1, Number(item.count) || 1),
    equipDestination: equipDestinationFor(item.name),
    edible: Boolean(findFoodData(item, registry))
  };
}

/** Natural equip target inferred from the item name; everything holdable defaults to the hand. */
function equipDestinationFor(rawName: string): EquipDestination {
  const name = rawName.toLowerCase();
  if (name.endsWith('_helmet') || name === 'carved_pumpkin') return 'head';
  if (name.endsWith('_chestplate') || name === 'elytra') return 'torso';
  if (name.endsWith('_leggings')) return 'legs';
  if (name.endsWith('_boots')) return 'feet';
  if (name === 'shield') return 'off-hand';
  return 'hand';
}

function botPosition(bot: BotLike): PositionSnapshot | null {
  const position = bot.entity?.position;
  if (!position) return null;
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
}

/** Human-friendly comparator so 'alice' and 'Bob' sort together regardless of case. */
function caseInsensitive(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

/** Case-insensitively de-duplicate while preserving first-seen order. */
function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** Distil the raw `declare_commands` packet into a flat node array we can walk. */
function parseCommandNodes(packet: unknown): ParsedCommandNode[] {
  const nodes = (packet as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node) => {
    const flags = (node as { flags?: { command_node_type?: unknown } })?.flags;
    const extra = (node as { extraNodeData?: { name?: unknown } })?.extraNodeData;
    const children = (node as { children?: unknown })?.children;
    const redirect = (node as { redirectNode?: unknown })?.redirectNode;
    return {
      type: typeof flags?.command_node_type === 'number' ? flags.command_node_type : 0,
      name: typeof extra?.name === 'string' ? extra.name : null,
      children: Array.isArray(children) ? children.filter((child): child is number => typeof child === 'number') : [],
      redirect: typeof redirect === 'number' ? redirect : null
    };
  });
}

/** Children of a node, following a redirect when the node defers to another command. */
function commandNodeChildren(nodes: ParsedCommandNode[], node: ParsedCommandNode): number[] {
  const target = node.redirect !== null ? nodes[node.redirect] : node;
  return target?.children ?? [];
}

/** Top-level command names (literals directly under the root), without the leading slash. */
function topLevelCommands(session: ManagedSession): string[] {
  const nodes = session.commandNodes;
  if (!nodes?.length) return [];
  const root = nodes[session.commandRoot] ?? nodes[0];
  if (!root) return [];
  const names: string[] = [];
  for (const index of commandNodeChildren(nodes, root)) {
    const node = nodes[index];
    if (node?.type === 1 && node.name) names.push(node.name);
  }
  return names;
}

/**
 * Literal sub-commands reachable after the already-typed tokens. Walks the command
 * graph token-by-token; bails out the moment a token lands on an argument node (a
 * value we can't enumerate) so we never guess past a free-form placeholder.
 */
function nestedCommandLiterals(session: ManagedSession, tokens: string[]): string[] {
  const nodes = session.commandNodes;
  if (!nodes?.length) return [];
  let current = nodes[session.commandRoot] ?? nodes[0];
  if (!current) return [];
  const completed = tokens.slice(0, -1);
  for (let i = 0; i < completed.length; i++) {
    const token = (i === 0 ? completed[i].replace(/^\//, '') : completed[i]).toLowerCase();
    if (!token) continue;
    let next: ParsedCommandNode | null = null;
    for (const index of commandNodeChildren(nodes, current)) {
      const node = nodes[index];
      if (node?.type === 1 && node.name?.toLowerCase() === token) {
        next = node;
        break;
      }
    }
    if (!next) return [];
    current = next;
  }
  const literals: string[] = [];
  for (const index of commandNodeChildren(nodes, current)) {
    const node = nodes[index];
    if (node?.type === 1 && node.name) literals.push(node.name);
  }
  return literals;
}

/** Online player names (excluding the bot itself), used to complete command arguments. */
function onlinePlayerNames(session: ManagedSession): string[] {
  const players = session.bot?.players;
  if (!players || typeof players !== 'object') return [];
  // Fall back to the profile username for the brief window before mineflayer resolves
  // bot.username, so the bot never suggests its own name.
  const own = (session.bot?.username ?? session.profile.username)?.toLowerCase();
  return Object.keys(players).filter((name) => name && name.toLowerCase() !== own);
}

/** Slash commands the user configured on this profile (quick commands, scripts, startup flow). */
function knownCommands(profile: AccountProfile): string[] {
  const steps: ScriptStep[] = [
    ...(profile.modules?.script?.quickCommands ?? []),
    ...(profile.modules?.script?.steps ?? []),
    ...(profile.startup?.flowCommands ?? [])
  ];
  const commands: string[] = [];
  for (const step of steps) {
    const command = step?.command?.trim();
    if (command && command.startsWith('/')) commands.push(command);
  }
  return commands;
}

/**
 * Build plan for an auto-harvesting cactus farm. Geometry (relative to a cactus
 * column at (cx, 0, cz), sand on the ground block at y = -1):
 *
 *   y+2:            [trigger]        ← snaps the cactus off when it grows into y+2
 *   y+1: [cactus]   [post-top]
 *   y+0: [sand  ]   [post-mid]       (post is 2 blocks away in Z, never adjacent
 *                   [post-base]       to the cactus at its own level)
 *
 * Invariants that keep the farm working:
 *  - The cactus stays 1 tall (its own level y+1 has no solid horizontal neighbour),
 *    otherwise it would break on placement.
 *  - The trigger sits at the GROW cell level (cactus.y + 1), horizontally adjacent,
 *    so the next growth segment snaps off and drops.
 *  - The support post lives in a gap column 2 away in Z, so its mid block never
 *    touches a cactus at the cactus level.
 *
 * Cacti are spaced 2 in X and 4 in Z; one post row between cactus rows carries the
 * trigger for the row in front of it. Item collection (buildCollection) is
 * best-effort: a hopper sits in the +Z gap where the thin trigger makes drops fall.
 */
export function cactusFarmPlan(origin: PositionSnapshot, config: CactusFarmConfig): OperationWorkItem[] {
  if (!config.build) return cactusPlantingPlan(origin, config);
  return cactusBasinPlan(origin, config);
}

// Bare planting mode: sand + cactus columns on a spaced grid, no harvest machinery.
function cactusPlantingPlan(origin: PositionSnapshot, config: CactusFarmConfig): OperationWorkItem[] {
  const sand: OperationWorkItem[] = [];
  const cactus: OperationWorkItem[] = [];
  const place = (bucket: OperationWorkItem[], offset: PositionSnapshot, itemName: string) => {
    bucket.push({
      action: 'place',
      position: addPosition(origin, offset),
      itemName,
      walk: true,
      // Planting columns sit at even x-offsets; the odd-x lane one block over is
      // never built on, so standing there keeps the bot out of the grid (which
      // otherwise walls it in and hangs pathfinding).
      stance: addPosition(origin, { x: offset.x + 1, y: 0, z: offset.z })
    });
  };
  const r = config.radius;
  for (let z = -r; z <= r; z += 4) {
    for (let x = -r; x <= r; x += 2) {
      place(sand, { x, y: 0, z }, 'sand');
      place(cactus, { x, y: 1, z }, 'cactus');
    }
  }
  return [...sand, ...cactus];
}

/**
 * Twin-row basin farm. Interior is 8 cells deep in x (0..7) so a single water
 * source line at x=7 flows exactly to the hopper line at x=0. Rows tile in z per
 * pair p: fence lane at z=4p, cactus rows at 4p±1, open water lanes at 4p±2
 * (shared between neighbouring pairs). A wall ring (dy0..dy4) closes the basin.
 *
 *   dy4  ring                                  (bounce containment)
 *   dy3  ring   fence lattice (z=4p, x=0..7, anchored on the west ring)
 *   dy2  ring   cacti on the sand pillars
 *   dy1  ring   sand (x=2,4,6) + strip filler (odd x) on rows; water on lanes
 *   dy0  ring   floor + hopper line (x=0) feeding the chest at (0,-3)
 *
 * Cactus growth at dy3 touches the fence and pops; drops fall into the dy1 water
 * sheet, float west and land in the hoppers. Ordering rules baked in below:
 * every block's reference exists before it, the bot always has the open east
 * side to leave through (east wall dy1+ goes up last, after the water is poured
 * from outside), and no stance cell is ever a future block position.
 */
// Column pitch for side-by-side basins: the footprint spans x -1..8 and the east water/wall
// stances need x 9..10 open. 12 would satisfy the stances, but it leaves only a 2-wide
// corridor between a finished east wall and the next basin's rising west ring — exactly the
// partial-block pocket geometry the pathfinder livelocks in (observed live). 14 keeps a
// 4-wide corridor the bot navigates cleanly.
const CACTUS_COLUMN_SPACING = 14;
// Vertical pitch for dug-down levels: a 5-high room plus the natural 1-block slab that stays
// in place as the ceiling (level above's floor foundation).
const CACTUS_LAYER_DEPTH = 6;

/**
 * The full farm is a grid of identical basins: `columns` copies tiled east at surface level,
 * and `basinLayers` levels stacked DOWNWARD — each sub-surface level is a room excavated in
 * solid ground (its stance envelope), reached by a 1-wide access stair dug outside the room
 * at x = -4. Downward is the only direction that scales reliably: digging is never rejected
 * by Paper's placement raytrace, while building upward would require mid-air bridging that
 * the server silently drops.
 */
function cactusBasinPlan(origin: PositionSnapshot, config: CactusFarmConfig): OperationWorkItem[] {
  // Profiles saved before these fields existed reach this without normalization.
  const levels = Math.max(1, Math.floor(config.basinLayers ?? 1));
  const columns = Math.max(1, Math.floor(config.columns ?? 1));
  const items: OperationWorkItem[] = [];
  for (let level = 0; level < levels; level++) {
    const yOff = -CACTUS_LAYER_DEPTH * level;
    for (let column = 0; column < columns; column++) {
      const xOff = column * CACTUS_COLUMN_SPACING;
      if (level > 0) appendBasinRoomDig(items, origin, xOff, yOff, config);
      appendCactusBasin(items, origin, xOff, yOff, config);
    }
  }
  return items;
}

/**
 * Excavate one sub-surface level for a basin: a straight 3-high access stair descending along
 * the west side (x = -4, OUTSIDE the room so its supporting blocks are never dug away), then
 * the room itself — the basin's full stance envelope (x -3..10, z ring±2, 5 high). Dig-on-air
 * items skip instantly, so overlap with a neighbouring column's room or a stair from a
 * previous level costs nothing.
 */
function appendBasinRoomDig(
  items: OperationWorkItem[],
  origin: PositionSnapshot,
  xOff: number,
  yOff: number,
  config: CactusFarmConfig
): void {
  const ringZMin = -3;
  const ringZMax = 4 * config.rowPairs - 1;
  const zLo = ringZMin - 2;
  const zHi = ringZMax + 2;
  const dig = (x: number, y: number, z: number) => {
    items.push({ action: 'dig', position: addPosition(origin, { x: x + xOff, y, z }), walk: true });
  };

  // Stair: one step per block of depth, 3-high clearance, feet landing exactly on the room
  // floor slab. The run starts at the level above's feet height (yOff + depth).
  const stairTop = yOff + CACTUS_LAYER_DEPTH;
  for (let s = 1; s <= CACTUS_LAYER_DEPTH; s++) {
    for (let k = 2; k >= 0; k--) dig(-4, stairTop - s + k, zLo + s);
  }
  // Doorway from the stair landing into the room's west corridor.
  dig(-3, yOff + 1, zLo + CACTUS_LAYER_DEPTH);
  dig(-3, yOff, zLo + CACTUS_LAYER_DEPTH);

  // Room: dig in horizontal SLICES from the top down. The access stair passes through
  // every slice, so the bot enters each one at exactly its own foot level and every dig
  // is an adjacent frontier cell — per-column ordering left the edge/ceiling cells only
  // reachable from far away, where the reach gate (rightly) refuses to dig.
  for (let y = yOff + 4; y >= yOff; y--) {
    const entryZ = Math.min(zHi, Math.max(zLo, zLo + (stairTop - y)));
    const zOrder: number[] = [];
    for (let z = zLo; z <= zHi; z++) zOrder.push(z);
    zOrder.sort((a, b) => Math.abs(a - entryZ) - Math.abs(b - entryZ));
    for (const [row, z] of zOrder.entries()) {
      // serpentine within the slice keeps consecutive targets adjacent
      if (row % 2 === 0) {
        for (let x = -3; x <= 10; x++) dig(x, y, z);
      } else {
        for (let x = 10; x >= -3; x--) dig(x, y, z);
      }
    }
  }
}

function appendCactusBasin(
  items: OperationWorkItem[],
  origin: PositionSnapshot,
  xOff: number,
  yOff: number,
  config: CactusFarmConfig
): void {
  const pairs = config.rowPairs;
  const wall = config.wallBlock;
  const withCollection = config.buildCollection;
  const zMin = -2;
  const zMax = 4 * pairs - 2;
  const ringZMin = zMin - 1;
  const ringZMax = zMax + 1;
  const fenceLanes: number[] = [];
  const cactusRows: number[] = [];
  const waterLanes: number[] = [];
  for (let p = 0; p < pairs; p++) {
    fenceLanes.push(4 * p);
    cactusRows.push(4 * p - 1, 4 * p + 1);
    if (p === 0) waterLanes.push(-2);
    waterLanes.push(4 * p + 2);
  }

  const at = (offset: PositionSnapshot) =>
    addPosition(origin, { x: offset.x + xOff, y: offset.y + yOff, z: offset.z });
  const place = (
    offset: PositionSnapshot,
    itemName: string,
    extra: Partial<OperationWorkItem> = {}
  ) => {
    items.push({ action: 'place', position: at(offset), itemName, walk: true, ...extra });
  };

  // 1. Chest + hopper chain. Hoppers must point INTO their downstream neighbour,
  //    so each is clicked onto the previous block's north face with sneak held.
  //    Stance one cell PAST the clicked face plane (z+1): standing in the target's
  //    own z-row can park the eye millimetres from the plane, where the server
  //    rejects the click (along ≈ 0) — one row further is always clearly beyond.
  if (withCollection) {
    place({ x: 0, y: 0, z: ringZMin }, 'chest', { stance: at({ x: 0, y: 0, z: ringZMin - 1 }) });
    for (let z = zMin; z <= zMax; z++) {
      place({ x: 0, y: 0, z }, 'hopper', {
        against: at({ x: 0, y: 0, z: z - 1 }),
        sneak: true,
        stance: at({ x: -2, y: 0, z: z + 1 })
      });
    }
  }

  // 2. Interior floor (x=1..7; x=0 is the hopper line) and the ring base. Floor
  //    cells sit at feet level, so the bot must never wander into the row it is
  //    building: each row is placed while standing ON the previous row (or on
  //    the platform south of the farm for the first one). The hopper column is
  //    never a stance — pathfinding wedges on partial blocks.
  for (let z = zMin; z <= zMax; z++) {
    for (let x = withCollection ? 1 : 0; x <= 7; x++) {
      const stance = z === zMin ? at({ x, y: 0, z: zMin - 2 }) : at({ x, y: 1, z: z - 1 });
      place({ x, y: 0, z }, wall, { stance });
    }
  }
  // Ring base + walls are grouped SIDE BY SIDE (finish one whole side before the
  //    next): interleaving sides makes the bot hike around the full perimeter for
  //    every single block. Side order is WEST → SOUTH → EAST → NORTH so each
  //    transition is a short hop around an open corner — once all four base rows
  //    are down the basin is an enclosed 1-high tub, and A* reliably fails to
  //    route across it (observed live: the bot wedged on the south side with the
  //    north row unreachable until it was teleported).
  for (let z = ringZMax; z >= ringZMin; z--) {
    place({ x: -1, y: 0, z }, wall, { stance: at({ x: -2, y: 0, z }) });
  }
  for (let x = 0; x <= 7; x++) {
    if (withCollection && x === 0) continue; // the chest lives at (0, ringZMin)
    place({ x, y: 0, z: ringZMin }, wall, { stance: at({ x, y: 0, z: ringZMin - 1 }) });
  }
  for (let z = ringZMin; z <= ringZMax; z++) {
    place({ x: 8, y: 0, z }, wall, { stance: at({ x: 9, y: 0, z }) });
  }
  for (let x = 7; x >= 0; x--) {
    place({ x, y: 0, z: ringZMax }, wall, { stance: at({ x, y: 0, z: ringZMax + 1 }) });
  }

  // 3. South/west/north ring wall courses y1 and y2, per side bottom-up, always
  //    placed from OUTSIDE the basin. Stances sit TWO cells out: walkToStance
  //    tolerates ±1, so a one-cell stance lets the bot climb onto the ring base
  //    ledge, where the next wall block is its own head cell and every place
  //    fails. Sides are ordered around the perimeter (south → west → north) so
  //    the bot never has to cross the walled basin to reach the next group.
  //    Placement physics per course: y1 clicks the base's top face normally;
  //    y2's top-face plane (feet+2) is above standing eye height, so the engine
  //    jump-places it; y3 CANNOT be placed from the ground at all (even a jump
  //    apex eye stays below the plane) — course y3 is added later from INSIDE,
  //    standing on the strip rows (feet at +2 ⇒ eye above the +3 plane).
  for (let y = 1; y <= 2; y++) {
    for (let x = 7; x >= 0; x--) {
      // The chest sits directly below (0, 1, ringZMin): an opaque wall block there would
      // lock the lid shut, so that one cell is always glass regardless of wallBlock.
      const itemName = withCollection && x === 0 && y === 1 ? 'glass' : wall;
      place({ x, y, z: ringZMin }, itemName, { stance: at({ x, y: 0, z: ringZMin - 2 }) });
    }
  }
  for (let y = 1; y <= 2; y++) {
    for (let z = ringZMin; z <= ringZMax; z++) {
      place({ x: -1, y, z }, wall, { stance: at({ x: -3, y: 0, z }) });
    }
  }
  for (let y = 1; y <= 2; y++) {
    for (let x = 0; x <= 7; x++) {
      place({ x, y, z: ringZMax }, wall, { stance: at({ x, y: 0, z: ringZMax + 2 }) });
    }
  }

  // 4. Cactus rows at dy1: sand pillars on even x, strip filler on odd x so
  //    stray drops never get trapped in dead-end water pockets between pillars.
  //    All stances live in the pair's SHARED fence corridor: the bot walks one
  //    open lane for the whole interior and never has to hop the row ridges
  //    (crossings are where pathfinding wedged in earlier builds).
  for (const z of cactusRows) {
    const corridorZ = Math.round(z / 4) * 4;
    for (let x = 1; x <= 7; x++) {
      const itemName = x % 2 === 0 ? 'sand' : wall;
      place({ x, y: 1, z }, itemName, { stance: at({ x, y: 1, z: corridorZ }) });
    }
  }

  // 4b. Third wall course (y3) for the south, west and north sides — placed from
  //     INSIDE, standing on the strip rows (feet +2 ⇒ eye 3.62, above the y3
  //     top-face plane at +3, and within reach of every ring column). This runs
  //     BEFORE the cacti are planted so the bot never brushes a cactus while
  //     walking the strips. The east side deliberately stays two courses tall:
  //     water is poured through the open east side and by then the interior is
  //     unreachable; drop physics still can't clear a +2 rim at that distance.
  const stripStanceFor = (x: number, z: number): PositionSnapshot => {
    const sx = Math.max(1, Math.min(7, x));
    let best = cactusRows[0];
    for (const row of cactusRows) {
      if (Math.abs(row - z) < Math.abs(best - z)) best = row;
    }
    return at({ x: sx, y: 2, z: best });
  };
  for (let x = 7; x >= 0; x--) {
    place({ x, y: 3, z: ringZMin }, wall, { stance: stripStanceFor(x, ringZMin) });
  }
  for (let z = ringZMin; z <= ringZMax; z++) {
    place({ x: -1, y: 3, z }, wall, { stance: stripStanceFor(0, z) });
  }
  for (let x = 0; x <= 7; x++) {
    place({ x, y: 3, z: ringZMax }, wall, { stance: stripStanceFor(x, ringZMax) });
  }

  // 5. Fence lattice at dy3: anchored on the west ring (whose y3 course now
  //    exists), chained eastward. One line serves the cactus rows on both of its
  //    sides. Stance one cell EAST of the target: clicking the west neighbour's
  //    east face needs the eye clearly beyond that face plane, and the bot
  //    drifts onto it when it stands in the target's own column.
  // The line stops at x=6: the easternmost cactus column is x=6, so an x=7
  // fence would be pure chain filler — and the only stance for it is the east
  // wall cell, which the bot cannot reliably occupy.
  for (const z of fenceLanes) {
    for (let x = 0; x <= 6; x++) {
      // Stand one cell east of the target so the eye is clearly beyond the west
      // neighbour's east face plane (standing in the target's own column parks
      // the eye ON the plane and the server rejects the click).
      place({ x, y: 3, z }, config.breakBlock, {
        against: at({ x: x - 1, y: 3, z }),
        stance: at({ x: x + 1, y: 1, z })
      });
    }
  }

  // 6. Cacti, east-facing stances so the bot retreats toward the open east side.
  for (const z of cactusRows) {
    for (const x of [2, 4, 6]) {
      place({ x, y: 2, z }, 'cactus', { stance: at({ x: x + 1, y: 2, z }) });
    }
  }

  // 7. Water, poured from OUTSIDE the east wall gap (stance on the platform at
  //    x=9). Sources go on every open lane; cactus-row strips stay dry on top.
  //    The barrier first: once the water is in and the east wall goes up, interior
  //    cells become unreachable, so every failure so far must be repaired NOW.
  if (withCollection) {
    items.push({ action: 'barrier', position: at({ x: 8, y: 0, z: 0 }) });
    for (const z of [...waterLanes, ...fenceLanes].sort((a, b) => a - b)) {
      items.push({
        action: 'water',
        position: at({ x: 7, y: 1, z }),
        walk: true,
        stance: at({ x: 9, y: 0, z })
      });
    }
  }

  // 8. Close the east wall (corner columns included) from outside, sealing the
  //    basin. Stance two cells out for the same ledge reason as the other walls.
  //    Two courses only: y1 places normally, y2 jump-places; y3 would need an
  //    inside stance that no longer exists once the water is in.
  for (let z = ringZMin; z <= ringZMax; z++) {
    for (let y = 1; y <= 2; y++) {
      place({ x: 8, y, z }, wall, { stance: at({ x: 10, y: 0, z }) });
    }
  }
}

function cactusMaterialNeeds(plan: OperationWorkItem[]): Record<string, number> {
  const needs: Record<string, number> = {};
  for (const item of plan) {
    if (item.action === 'water') {
      needs.water_bucket = (needs.water_bucket ?? 0) + 1;
      continue;
    }
    if (item.action !== 'place' || !item.itemName) continue;
    needs[item.itemName] = (needs[item.itemName] ?? 0) + 1;
  }
  return needs;
}

// Walk a 3D box for an area operation. Layers are ordered by mode (mine works
// top-down so falling blocks don't bury the bot and a floor stays underfoot;
// fill works bottom-up so each placed block rests on support) and `hollow`
// keeps only the outer shell so you can carve rooms or build walls.
export function areaPositions(
  a: PositionSnapshot,
  b: PositionSnapshot,
  mode: 'mine' | 'fill',
  hollow: boolean
): PositionSnapshot[] {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const minZ = Math.min(a.z, b.z);
  const maxZ = Math.max(a.z, b.z);
  const ys: number[] = [];
  for (let y = minY; y <= maxY; y += 1) ys.push(y);
  if (mode === 'mine') ys.reverse();
  const positions: PositionSnapshot[] = [];
  for (const y of ys) {
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        if (hollow && x > minX && x < maxX && y > minY && y < maxY && z > minZ && z < maxZ) continue;
        positions.push({ x, y, z });
      }
    }
  }
  return positions;
}

function positionsInBox(a: PositionSnapshot, b: PositionSnapshot): PositionSnapshot[] {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const minZ = Math.min(a.z, b.z);
  const maxZ = Math.max(a.z, b.z);
  const positions: PositionSnapshot[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        positions.push({ x, y, z });
      }
    }
  }
  return positions;
}

function addPosition(a: PositionSnapshot, b: PositionSnapshot): PositionSnapshot {
  return {
    x: Math.round(a.x + b.x),
    y: Math.round(a.y + b.y),
    z: Math.round(a.z + b.z)
  };
}

function roundPosition(position: PositionSnapshot): PositionSnapshot {
  return { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) };
}

function toVec3(position: PositionSnapshot): Vec3 {
  return new Vec3(position.x, position.y, position.z);
}

function formatPosition(position: PositionSnapshot): string {
  return `${position.x},${position.y},${position.z}`;
}

function isAirBlock(block: BlockLike): boolean {
  return !block.name || block.name === 'air' || block.boundingBox === 'empty';
}

function inventoryItemCount(bot: BotLike, itemName: string): number {
  return (bot.inventory?.items?.() ?? [])
    .filter((item) => itemKey(item) === itemName)
    .reduce((total, item) => total + (Math.max(1, Number(item.count) || 1)), 0);
}

function findInventoryItem(bot: BotLike, itemName: string): InventoryItemLike | null {
  return (bot.inventory?.items?.() ?? []).find((item) => itemKey(item) === itemName) ?? null;
}

function findHoe(bot: BotLike): InventoryItemLike | null {
  return (bot.inventory?.items?.() ?? []).find((item) => itemKey(item)?.endsWith('_hoe') ?? false) ?? null;
}

const KEEP_TOOL_SUFFIXES = ['_hoe', '_axe', '_pickaxe', '_shovel', '_sword'];

const SHULKER_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
];

// Blocks the storage engine will open as a chest. Double chests report one larger window
// automatically, so only the single-block names are listed here.
const CONTAINER_BLOCK_NAMES = new Set<string>([
  'chest',
  'trapped_chest',
  'barrel',
  'shulker_box',
  ...SHULKER_COLORS.map((color) => `${color}_shulker_box`)
]);

function isContainerBlock(block: BlockLike | null | undefined): boolean {
  return !!block && typeof block.name === 'string' && CONTAINER_BLOCK_NAMES.has(block.name);
}

/** Every edible item name on this server, read from the bot's registry (never hardcoded). */
function edibleNames(bot: BotLike): Set<string> {
  const foods = bot.registry?.foodsByName ?? {};
  return new Set(Object.keys(foods).map((name) => name.toLowerCase()));
}

/**
 * Keep-list predicate for the deposit trip: true = never deposit this item. Input comes from
 * bot.inventory.items(), which already excludes worn armor, so no armor check is needed. Tools,
 * buckets, edibles and the active replant seed are kept; seed overflow above the configured cap
 * is deposited by a separate step (see runDepositTrip). `seedItemId` is the crop's replant item
 * (e.g. carrots/potatoes are their own seed, wheat uses wheat_seeds) or null for non-crop farms.
 */
export function shouldKeepItem(item: InventoryItemLike, seedItemId: string | null, edible: Set<string>): boolean {
  const name = itemKey(item);
  if (!name) return true;
  if (KEEP_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (name.endsWith('bucket')) return true;
  if (edible.has(name)) return true;
  if (seedItemId && name === seedItemId.toLowerCase()) return true;
  return false;
}

/** Fraction of the 36 main-storage slots (9–44) that are occupied; drives the deposit trigger. */
export function inventoryFillFraction(bot: BotLike): number {
  const count = (bot.inventory?.items?.() ?? []).length; // items() = one entry per occupied storage slot
  return Math.min(1, count / 36);
}

const TILLABLE_BLOCKS = new Set(['dirt', 'grass_block', 'dirt_path', 'rooted_dirt']);

function isTillable(block: BlockLike): boolean {
  return TILLABLE_BLOCKS.has(block.name ?? '');
}

function isMatureCrop(block: BlockLike, crop: CropFarmConfig['crop']): boolean {
  const name = block.name ?? '';
  if (crop === 'pumpkin') return name === 'pumpkin';
  if (crop === 'melon') return name === 'melon';
  const expected = cropBlockName(crop);
  if (name !== expected) return false;
  const age = typeof block.metadata === 'number' ? block.metadata : 7;
  return crop === 'nether_wart' ? age >= 3 : age >= 7;
}

function cropBlockName(crop: CropFarmConfig['crop']): string {
  switch (crop) {
    case 'carrot':
      return 'carrots';
    case 'potato':
      return 'potatoes';
    case 'beetroot':
      return 'beetroots';
    case 'nether_wart':
      return 'nether_wart';
    case 'pumpkin':
      return 'pumpkin';
    case 'melon':
      return 'melon';
    case 'wheat':
    default:
      return 'wheat';
  }
}

function cropSeedName(crop: CropFarmConfig['crop']): string {
  switch (crop) {
    case 'wheat':
      return 'wheat_seeds';
    case 'beetroot':
      return 'beetroot_seeds';
    case 'pumpkin':
      return 'pumpkin_seeds';
    case 'melon':
      return 'melon_seeds';
    case 'carrot':
      return 'carrot';
    case 'potato':
      return 'potato';
    case 'nether_wart':
      return 'nether_wart';
    default:
      return '';
  }
}

function cropLabel(crop: CropFarmConfig['crop']): string {
  return crop.replaceAll('_', ' ');
}

// Only these grow on hoe-tilled, water-hydrated farmland, so only these can be
// auto-built (till + water + plant). Pumpkin/melon use stems and nether_wart
// needs soul sand, so the build pass is skipped for them.
function isFarmlandCrop(crop: CropFarmConfig['crop']): boolean {
  return crop === 'wheat' || crop === 'carrot' || crop === 'potato' || crop === 'beetroot';
}

interface CropBuildPlan {
  /** clear-then-till steps for every planted (non-water) cell (empty when autoTill is off). */
  prepare: OperationWorkItem[];
  /** seed-planting steps for every planted (non-water) cell. */
  plant: OperationWorkItem[];
  /** farmland-level water source cells on an 8-spaced lattice — each hydrates a 9x9 (±4 per axis). */
  waterCells: PositionSnapshot[];
  /** every surface cell (farmland level) — used to detect pre-placed water. */
  footprint: PositionSnapshot[];
}

/**
 * Plan a hydrated crop square centred on the bot. Farmland sits at y-1 (the surface the bot
 * walks on), crops at y0. Water sources sit at farmland level on an 8-spaced lattice so every
 * cell stays within 4 blocks of a source (Minecraft hydrates a 9x9 = ±4 on each axis), which
 * keeps large fields fully wet instead of the old single-centre 9x9 cap.
 */
export function cropBuildPlan(origin: PositionSnapshot, config: CropFarmConfig): CropBuildPlan {
  const half = clamp(Math.round(config.radius), 0, MAX_CROP_RADIUS, DEFAULT_MODULES.cropFarm.radius);
  const seed = cropSeedName(config.crop);
  const prepare: OperationWorkItem[] = [];
  const plant: OperationWorkItem[] = [];
  const footprint: PositionSnapshot[] = [];

  // Water-source cells: cartesian product of the per-axis lattice. Their (dx,dz) keys are
  // skipped when planting so a source block never gets a seed on top of it.
  const axis = waterAxis(half);
  const waterKeys = new Set<string>();
  const waterCells: PositionSnapshot[] = [];
  for (const dx of axis) {
    for (const dz of axis) {
      waterKeys.add(`${dx},${dz}`);
      waterCells.push(addPosition(origin, { x: dx, y: -1, z: dz }));
    }
  }

  for (let dx = -half; dx <= half; dx += 1) {
    for (let dz = -half; dz <= half; dz += 1) {
      const surface = addPosition(origin, { x: dx, y: -1, z: dz });
      footprint.push(surface);
      if (waterKeys.has(`${dx},${dz}`)) continue; // water source cell — not planted
      if (config.autoTill) {
        // clear anything sitting on the dirt (grass, etc.) then till it
        prepare.push({ action: 'dig', position: addPosition(origin, { x: dx, y: 0, z: dz }), walk: true });
        prepare.push({ action: 'till', position: surface, walk: true });
      }
      plant.push({
        action: 'place',
        position: addPosition(origin, { x: dx, y: 0, z: dz }),
        itemName: seed,
        walk: true,
        tillUnder: config.autoTill
      });
    }
  }

  return { prepare, plant, waterCells, footprint };
}

/**
 * Water-source coordinates along one axis so every cell in [-half, half] is within 4 blocks of
 * a source (spacing 8, since a source hydrates ±4). The far edge is always covered explicitly,
 * so no cell is ever left on the dry side of the last source.
 */
export function waterAxis(half: number): number[] {
  if (half <= 4) return [0];
  const first = -half + 4;
  const last = half - 4;
  const coords = new Set<number>();
  for (let c = first; c <= last; c += 8) coords.add(c);
  coords.add(last); // guarantee the +half edge is hydrated even when (last-first) isn't a multiple of 8
  return [...coords].sort((a, b) => a - b);
}

function operationEventType(kind: OperationKind): SessionEvent['type'] {
  switch (kind) {
    case 'cactusFarm':
      return 'cactus';
    case 'cropFarm':
      return 'farm';
    case 'generator':
      return 'generator';
    case 'script':
      return 'script';
    case 'discord':
      return 'discord';
    case 'area':
    default:
      return 'area';
  }
}

function mergeStats(current: Record<string, number>, delta: Record<string, number>): Record<string, number> {
  const next = { ...current };
  for (const [key, value] of Object.entries(delta)) {
    next[key] = (next[key] ?? 0) + value;
  }
  return next;
}

function redactSensitiveText(value: string): string {
  return value
    // Common auth commands and their cracked-server aliases (AuthMe etc.): /login, /l,
    // /register, /reg, /auth, /changepassword … <password> [confirm].
    .replace(
      /(\/(?:login|register|reg|auth|changepassword|changepass|password|passwd|pass|l)\s+)(\S+)(?:\s+\S+)?/gi,
      '$1******'
    )
    .replace(/(password|passwd|token|webhook|secret)=\S+/gi, '$1=******');
}

function discordRuntimeLabel(runtime: DiscordRuntime): string {
  if (!runtime.enabled) return 'disabled';
  const parts = [];
  if (runtime.webhookUrl) parts.push('webhook');
  if (runtime.botToken && runtime.channelId) parts.push('commands');
  return parts.length > 0 ? parts.join(' + ') : 'enabled without credentials';
}
