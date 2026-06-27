import { EventEmitter } from 'node:events';
import net from 'node:net';
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
  type GeneratorMineConfig,
  type InventoryItemSnapshot,
  type LiveInventorySnapshot,
  type OperationKind,
  type OperationSnapshot,
  type OperationStartRequest,
  type PositionSnapshot,
  type ProxyConfig,
  type AutoResponseConfig,
  type AutoResponseRule,
  type ScriptConfig,
  type ScriptStep
} from '../../shared/types.js';
import { AfkRoutine, type RoutineBot } from './afkRoutine.js';
import { createDefaultProfiles } from './defaultProfiles.js';
import { ProfileStore } from '../storage/profileStore.js';

type ProfilePersistence = Pick<ProfileStore, 'load' | 'save'>;

type MineflayerOptions = {
  host: string;
  port: number;
  username: string;
  version?: string;
  auth?: 'microsoft' | 'offline';
  profilesFolder?: string;
  connect?: (client: ProxyClientLike) => void;
};

type ProxyClientLike = {
  setSocket?: (socket: net.Socket) => void;
  emit?: (event: string, ...args: unknown[]) => boolean;
};

type InventoryItemLike = {
  slot?: number;
  type?: number;
  name?: string;
  displayName?: string;
  count?: number;
  foodPoints?: number;
  saturation?: number;
  effectiveQuality?: number;
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
};

type BotLike = RoutineBot &
  EventEmitter & {
    _client?: EventEmitter & {
      write?: (packetName: string, payload: Record<string, unknown>) => void;
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
    inventory?: {
      slots?: Array<InventoryItemLike | null | undefined>;
      items?: () => InventoryItemLike[];
    };
    currentWindow?: {
      title?: unknown;
      slots?: Array<InventoryItemLike | null | undefined>;
    } | null;
    quickBarSlot?: number;
    heldItem?: InventoryItemLike | null;
    players?: Record<string, unknown>;
    player?: { ping?: number };
    equip?: (item: InventoryItemLike, destination: 'hand') => Promise<void> | void;
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
    };
    loadPlugin?: (plugin: unknown) => void;
    tabComplete?: (partial: string) => Promise<Array<string | { match?: string }>> | Array<string | { match?: string }>;
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
  startupCompleted: boolean;
  foodGuardActive: boolean;
  hungerPaused: boolean;
  lastFoodWarningAt: number;
  /** Anchor used by the crop harvest loop after a build pass so it scans the field it just planted. */
  cropFarmOrigin: PositionSnapshot | null;
  snapshot: BotSessionSnapshot;
}

type OperationWorkItem = {
  action: 'dig' | 'place' | 'till' | 'water';
  position: PositionSnapshot;
  itemName?: string;
  /** Walk within reach before acting (build steps that may be outside the bot's stationary reach). */
  walk?: boolean;
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
const MAX_OPERATION_VOLUME = 4096;
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const PLACE_BLOCK_TIMEOUT_MS = 10000;
const PATHFIND_TIMEOUT_MS = 15000;

// Populated once by defaultMineflayerFactory after the pathfinder plugin loads.
// Tests inject their own factory, so these stay null there and every pathfinder
// call (walkWithinReach) becomes a no-op — the bot simply acts within reach.
type PathfinderMovementsCtor = new (bot: BotLike) => Record<string, unknown>;
type PathfinderGoals = { GoalNear: new (x: number, y: number, z: number, range: number) => unknown };
let pathfinderMovements: PathfinderMovementsCtor | null = null;
let pathfinderGoals: PathfinderGoals | null = null;

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
    buildCollection: true
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
    from: { x: -2, y: 0, z: -2 },
    to: { x: 2, y: 2, z: 2 },
    fillBlock: 'cobblestone',
    actionDelayMs: 450
  },
  generator: {
    enabled: false,
    mode: 'forward',
    direction: 'north',
    depth: 4,
    actionDelayMs: 350
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

  constructor(
    private readonly options: {
      userDataDir: string;
      appVersion: string;
      authSessionDir?: string;
      factory?: MineflayerFactory;
      store?: ProfilePersistence;
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
    this.rebuildSessions();
    this.loaded = true;
    this.emitState();
    if (this.settings.autoStartOnLaunch) {
      void this.startAll();
    }
  }

  getState(): LauncherState {
    this.assertLoaded();
    const sessions: Record<string, BotSessionSnapshot> = {};
    for (const session of this.sessions.values()) {
      sessions[session.profile.id] = this.cloneSnapshot(session.snapshot);
    }
    return {
      profiles: this.profiles.map(cloneProfile),
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
    if (existing >= 0) {
      this.profiles[existing] = profile;
    } else {
      this.profiles.push(profile);
    }
    this.selectedProfileId = profile.id;
    this.rebuildSessions();
    this.applySavedRoutineToRunningSession(this.sessions.get(profile.id));
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
      this.scheduleReconnect(session);
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
    this.stopDiscordPolling(session);
    if (session.bot) {
      this.updateStatus(session, 'stopping', 'Stopping session');
      session.bot.quit?.('Stopped from ChunkKeeper');
      session.bot.removeAllListeners();
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
    this.pushEvent(session, 'chat', 'info', 'Chat sent', normalized);
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
      case 'cactusFarm':
        this.startCactusFarm(session, session.bot, normalizeCactusFarm({ ...modules.cactusFarm, ...request.config }));
        break;
      case 'cropFarm':
        this.startCropFarm(session, session.bot, normalizeCropFarm({ ...modules.cropFarm, ...request.config }));
        break;
      case 'area':
        this.startAreaOperation(
          session,
          session.bot,
          normalizeAreaOperation({ ...modules.area, ...(request.config as Partial<AreaOperationConfig> | undefined) })
        );
        break;
      case 'generator':
        this.startGeneratorMine(
          session,
          session.bot,
          normalizeGeneratorMine({ ...modules.generator, ...(request.config as Partial<GeneratorMineConfig> | undefined) })
        );
        break;
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
    this.pushEvent(session, 'script', 'info', 'Quick script sent', normalized);
    void this.notifyDiscord(session, `Quick script: ${redactSensitiveText(normalized)}`, 'event');
    this.emitState();
    return this.getState();
  }

  async completeChat(profileId: string, partial: string): Promise<string[]> {
    this.assertLoaded();
    const session = this.requireSession(profileId);
    if (!session.bot || typeof session.bot.tabComplete !== 'function') {
      session.snapshot.tabCompletions = [];
      this.emitState();
      return [];
    }
    try {
      const result = await Promise.resolve(session.bot.tabComplete(partial));
      const completions = result
        .map((item) => (typeof item === 'string' ? item : item.match ?? ''))
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 12);
      session.snapshot.tabCompletions = completions;
      this.emitState();
      return completions;
    } catch (error) {
      this.pushEvent(session, 'script', 'warn', 'Tab completion failed', formatError(error));
      session.snapshot.tabCompletions = [];
      this.emitState();
      return [];
    }
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
        startupCompleted: false,
        foodGuardActive: false,
        hungerPaused: false,
        lastFoodWarningAt: 0,
        cropFarmOrigin: null,
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
    installResourcePackAutoAccept(bot);
    return bot;
  }

  private attachBotEvents(session: ManagedSession, bot: BotLike): void {
    bot.on('spawn', () => {
      configurePathfinderMovements(bot);
      const shouldRunStartup = !session.snapshot.startupActive && !session.startupCompleted;
      session.snapshot.connectedAt = new Date().toISOString();
      session.snapshot.reconnectAttempts = 0;
      session.snapshot.nextReconnectAt = null;
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

    bot.on('chat', (username: string, message: string) => {
      this.pushChat(session, 'server', `<${username}> ${message}`);
      void this.notifyDiscord(session, `<${username}> ${message}`, 'chat');
      this.handleAutoResponse(session, username, message);
      this.emitState();
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
      session.bot = null;
      session.snapshot.startupActive = false;
      session.snapshot.routineActive = false;
      session.snapshot.connectedAt = null;
      if (session.desiredStop) {
        this.updateStatus(session, 'offline', 'Offline');
      } else {
        this.updateStatus(session, 'reconnecting', 'Disconnected');
        this.scheduleReconnect(session);
      }
      void this.notifyDiscord(session, `${session.profile.label} disconnected`, 'event');
      this.emitState();
    });
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
      }
    });
    session.routine.start();
    session.startupCompleted = true;
    session.snapshot.startupActive = false;
    session.snapshot.routineActive = true;
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

    let elapsed = Math.max(0, startup.authDelayMs);
    if (hasAuthCommand) {
      session.startupTimers.push(
        setTimeout(() => {
          if (session.bot !== bot || session.desiredStop) return;
          bot.chat?.(authCommand);
          this.pushEvent(session, 'chat', 'info', authLabel, redactCommand(authCommand, startup.authPassword));
          this.emitState();
        }, elapsed)
      );
    } else if (authRequiresPassword(startup) && !startup.authPassword) {
      this.pushEvent(session, 'system', 'warn', 'Lobby auth skipped', 'Password is empty');
    }

    elapsed += Math.max(0, startup.transferDelayMs);
    if (hasTransferCommand) {
      session.startupTimers.push(
        setTimeout(() => {
          if (session.bot !== bot || session.desiredStop) return;
          bot.chat?.(transferCommand);
          this.pushEvent(session, 'chat', 'info', 'Server transfer sent', transferCommand);
          this.emitState();
        }, elapsed)
      );
    }

    for (const step of flowCommands) {
      elapsed += Math.max(0, step.delayMs);
      session.startupTimers.push(
        setTimeout(() => {
          if (session.bot !== bot || session.desiredStop) return;
          bot.chat?.(step.command);
          this.pushEvent(session, 'chat', 'info', step.label || 'Flow command sent', redactSensitiveText(step.command));
          this.emitState();
        }, elapsed)
      );
    }

    session.startupTimers.push(
      setTimeout(() => {
        if (session.bot !== bot || session.desiredStop) return;
        this.pushEvent(session, 'system', 'ok', 'Join flow complete');
        this.updateStatus(session, 'online', 'Online');
        this.startRoutine(session, bot);
        this.emitState();
      }, elapsed + 500)
    );
  }

  private clearStartupFlow(session: ManagedSession): void {
    for (const timer of session.startupTimers) {
      clearTimeout(timer);
    }
    session.startupTimers = [];
    session.snapshot.startupActive = false;
  }

  private scheduleReconnect(session: ManagedSession): void {
    if (session.desiredStop || !session.profile.reconnect.enabled) return;
    if (session.snapshot.reconnectAttempts >= session.profile.reconnect.maxAttempts) {
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
    const origin = botPosition(bot);
    if (!origin) {
      this.blockOperation(session, 'cactusFarm', 'Bot position is unavailable.');
      return;
    }
    const plan = cactusFarmPlan(origin, config);
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
    session.cropFarmOrigin = null;
    if (!config.build || !isFarmlandCrop(config.crop)) {
      if (config.build && !isFarmlandCrop(config.crop)) {
        this.pushEvent(session, 'farm', 'warn', 'Crop build skipped', `${cropLabel(config.crop)} farmland'e dikilmez, hasat döngüsüne geçiliyor.`);
      }
      this.beginCropHarvest(session, bot, config);
      return;
    }
    const origin = botPosition(bot);
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

    // Decide on water before tilling: skip if the field is already wet; with
    // auto-water and no existing source we need a bucket and dig the centre.
    const hasWater = plan.footprint.some((position) => {
      const block = typeof bot.blockAt === 'function' ? bot.blockAt(toVec3(position)) : null;
      return block?.name === 'water';
    });
    let waterSteps: OperationWorkItem[] = [];
    if (!hasWater && config.waterMode === 'auto') {
      if (inventoryItemCount(bot, 'water_bucket') < 1) missing.push('water_bucket 0/1');
      waterSteps = [plan.centerDig, { action: 'water', position: plan.waterPos }];
    }

    if (missing.length > 0) {
      this.blockOperation(session, 'cropFarm', `Missing materials: ${missing.join(', ')}.`);
      return;
    }
    if (!hasWater && config.waterMode === 'existing') {
      this.pushEvent(session, 'farm', 'warn', 'No water found', 'Tarlanın merkezine su koyun, aksi halde ürünler çok yavaş büyür.');
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
      const origin = session.cropFarmOrigin ?? botPosition(bot);
      if (!origin) {
        this.blockOperation(session, 'cropFarm', 'Bot position is unavailable.');
        return;
      }
      void this.runCropFarmTick(session, bot, config, origin).finally(() => {
        if (session.snapshot.operations.cropFarm.state === 'running') {
          const timer = setTimeout(tick, config.harvestDelayMs);
          session.operationTimers.set('cropFarm', timer);
        }
      });
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
    let harvested = 0;
    let replanted = 0;
    for (const position of positionsInBox(
      addPosition(origin, { x: -config.radius, y: -1, z: -config.radius }),
      addPosition(origin, { x: config.radius, y: 2, z: config.radius })
    )) {
      const block = bot.blockAt(toVec3(position));
      if (!block || !isMatureCrop(block, config.crop)) continue;
      await this.walkWithinReach(bot, position);
      await Promise.resolve(bot.dig(block));
      harvested += 1;
      if (config.replant && cropSeedName(config.crop) && inventoryItemCount(bot, cropSeedName(config.crop)) > 0) {
        const placed = await this.placeItemAt(bot, cropSeedName(config.crop), position);
        if (placed) replanted += 1;
      }
    }
    if (harvested > 0 || replanted > 0) {
      this.addOperationStats(session, 'cropFarm', { harvested, replanted, collected: config.collectDrops ? harvested : 0 });
      this.pushEvent(session, 'farm', 'ok', 'Crop farm tick', `${harvested} harvested, ${replanted} replanted`);
      this.updateLiveTelemetry(session);
      this.emitState();
    }
  }

  private startAreaOperation(session: ManagedSession, bot: BotLike, config: AreaOperationConfig): void {
    const origin = botPosition(bot);
    if (!origin) {
      this.blockOperation(session, 'area', 'Bot position is unavailable.');
      return;
    }
    const from = addPosition(origin, config.from);
    const to = addPosition(origin, config.to);
    const positions = positionsInBox(from, to);
    if (positions.length > MAX_OPERATION_VOLUME) {
      this.blockOperation(session, 'area', `Area is too large: ${positions.length}/${MAX_OPERATION_VOLUME} blocks.`);
      return;
    }
    const work: OperationWorkItem[] = positions.map((position) => ({
      action: config.mode === 'fill' ? 'place' : 'dig',
      position,
      itemName: config.mode === 'fill' ? config.fillBlock : undefined
    }));
    session.operationQueues.set('area', work);
    this.updateOperation(session, 'area', 'running', `${config.mode === 'fill' ? 'Filling' : 'Mining'} selected 3D area`, {
      completed: 0,
      total: work.length,
      stats: { blocks: work.length }
    });
    this.scheduleOperationQueue(session, bot, 'area', config.actionDelayMs);
  }

  private startGeneratorMine(session: ManagedSession, bot: BotLike, config: GeneratorMineConfig): void {
    const origin = botPosition(bot);
    if (!origin) {
      this.blockOperation(session, 'generator', 'Bot position is unavailable.');
      return;
    }
    const directions = config.mode === 'four_way' ? (['north', 'south', 'east', 'west'] as const) : [config.direction];
    const work: OperationWorkItem[] = directions.flatMap((direction) => {
      const vector = directionVector(direction);
      return Array.from({ length: config.depth }, (_, index) => ({
        action: 'dig' as const,
        position: addPosition(origin, scalePosition(vector, index + 1))
      }));
    });
    session.operationQueues.set('generator', work);
    this.updateOperation(session, 'generator', 'running', `${config.mode === 'four_way' ? '4-way' : config.direction} generator mining`, {
      completed: 0,
      total: work.length,
      stats: { targets: work.length }
    });
    this.scheduleOperationQueue(session, bot, 'generator', config.actionDelayMs);
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
    const tick = () => {
      if (session.bot !== bot || session.snapshot.operations[kind].state !== 'running') return;
      const queue = session.operationQueues.get(kind) ?? [];
      const work = queue.shift();
      if (!work) {
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
      void this.runWorkItem(session, bot, kind, work).finally(() => {
        if (session.snapshot.operations[kind].state === 'running') {
          const timer = setTimeout(tick, delayMs);
          session.operationTimers.set(kind, timer);
        }
      });
    };
    tick();
  }

  private async runWorkItem(
    session: ManagedSession,
    bot: BotLike,
    kind: OperationKind,
    work: OperationWorkItem
  ): Promise<void> {
    try {
      if (work.action === 'dig') {
        if (typeof bot.blockAt !== 'function' || typeof bot.dig !== 'function') {
          this.blockOperation(session, kind, 'Mineflayer block/dig APIs are unavailable.');
          return;
        }
        if (work.walk) await this.walkWithinReach(bot, work.position);
        const block = bot.blockAt(toVec3(work.position));
        if (!block || isAirBlock(block)) {
          this.addOperationProgress(session, kind, 1, { skipped: 1 });
          return;
        }
        await Promise.resolve(bot.dig(block));
        this.addOperationProgress(session, kind, 1, { mined: 1 });
      } else if (work.action === 'till') {
        const tilled = await this.tillFarmland(bot, work.position);
        if (!tilled) {
          this.addOperationProgress(session, kind, 1, { skipped: 1 });
          return;
        }
        this.addOperationProgress(session, kind, 1, { tilled: 1 });
      } else if (work.action === 'water') {
        const result = await this.placeWaterSource(bot, work.position);
        if (!result.ok) {
          this.blockOperation(session, kind, `Cannot place water at ${formatPosition(work.position)} (${result.reason}).`);
          return;
        }
        this.addOperationProgress(session, kind, 1, { watered: 1 });
      } else {
        const placed = work.walk
          ? await this.placeBlockAgainst(bot, work.itemName ?? 'cobblestone', work.position, { walk: true })
          : await this.placeItemAt(bot, work.itemName ?? 'cobblestone', work.position);
        if (!placed) {
          this.blockOperation(session, kind, `Cannot place ${work.itemName ?? 'block'} at ${formatPosition(work.position)}.`);
          return;
        }
        this.addOperationProgress(session, kind, 1, { placed: 1 });
      }
      this.updateLiveTelemetry(session);
      this.emitState();
    } catch (error) {
      this.blockOperation(session, kind, formatError(error), 'error');
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

  // Walk close enough to act on a target. No-op without the pathfinder plugin
  // (e.g. in unit tests), so callers must still tolerate out-of-reach failures.
  private async walkWithinReach(bot: BotLike, position: PositionSnapshot, range = 3): Promise<void> {
    if (!pathfinderGoals || typeof bot.pathfinder?.goto !== 'function') return;
    const here = botPosition(bot);
    if (here && Math.abs(here.x - position.x) + Math.abs(here.z - position.z) <= range && Math.abs(here.y - position.y) <= 4) {
      return;
    }
    try {
      const goal = new pathfinderGoals.GoalNear(position.x, position.y, position.z, range);
      await withTimeout(Promise.resolve(bot.pathfinder.goto(goal)), PATHFIND_TIMEOUT_MS, 'pathfind');
    } catch {
      // A failed walk just means the subsequent place/dig will fail with a clear
      // blocked message — no need to surface the pathfinding error itself.
    }
  }

  // Like placeItemAt but can anchor on any solid neighbour (not just the block
  // below), and optionally walks within reach first. Idempotent: if the target
  // cell is already filled it returns true, so re-running a build resumes cleanly.
  private async placeBlockAgainst(
    bot: BotLike,
    itemName: string,
    position: PositionSnapshot,
    opts: { walk?: boolean } = {}
  ): Promise<boolean> {
    if (typeof bot.blockAt !== 'function' || typeof bot.placeBlock !== 'function' || typeof bot.equip !== 'function') {
      return false;
    }
    const item = findInventoryItem(bot, itemName);
    if (!item) return false;
    if (opts.walk) await this.walkWithinReach(bot, position);
    const target = bot.blockAt(toVec3(position));
    if (target && !isAirBlock(target)) return true;

    // below first (back-compat with placeItemAt), then the 4 sides, then above.
    const faces: Array<{ off: PositionSnapshot; face: Vec3 }> = [
      { off: { x: 0, y: -1, z: 0 }, face: new Vec3(0, 1, 0) },
      { off: { x: -1, y: 0, z: 0 }, face: new Vec3(1, 0, 0) },
      { off: { x: 1, y: 0, z: 0 }, face: new Vec3(-1, 0, 0) },
      { off: { x: 0, y: 0, z: -1 }, face: new Vec3(0, 0, 1) },
      { off: { x: 0, y: 0, z: 1 }, face: new Vec3(0, 0, -1) },
      { off: { x: 0, y: 1, z: 0 }, face: new Vec3(0, -1, 0) }
    ];
    for (const candidate of faces) {
      const reference = bot.blockAt(toVec3(addPosition(position, candidate.off)));
      if (!reference || isAirBlock(reference)) continue;
      await Promise.resolve(bot.equip(item, 'hand'));
      try {
        await withTimeout(
          Promise.resolve(bot.placeBlock(reference, candidate.face)),
          PLACE_BLOCK_TIMEOUT_MS,
          `place ${itemName}`
        );
        return true;
      } catch {
        // try the next face
      }
    }
    return false;
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
    position: PositionSnapshot
  ): Promise<{ ok: boolean; reason: string }> {
    if (typeof bot.blockAt !== 'function') return { ok: false, reason: 'no_api' };
    const existing = bot.blockAt(toVec3(position));
    if (existing && existing.name === 'water') return { ok: true, reason: 'already_water' };
    const bucket = findInventoryItem(bot, 'water_bucket');
    if (!bucket) return { ok: false, reason: 'no_bucket' };
    if (typeof bot.equip !== 'function' || typeof bot.activateItem !== 'function') {
      return { ok: false, reason: 'no_api' };
    }
    await this.walkWithinReach(bot, position, 2);
    await Promise.resolve(bot.lookAt?.(toVec3({ x: position.x, y: position.y, z: position.z }), true));
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

  private stopAllOperations(session: ManagedSession): void {
    for (const kind of Object.keys(session.snapshot.operations) as OperationKind[]) {
      this.stopOperationTimer(session, kind);
      session.operationQueues.delete(kind);
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

async function defaultMineflayerFactory(options: MineflayerOptions): Promise<BotLike> {
  const mineflayerModule = await import('mineflayer');
  const createBot = mineflayerModule.createBot ?? mineflayerModule.default?.createBot;
  if (!createBot) {
    throw new Error('mineflayer createBot() was not found');
  }
  const bot = createBot(options) as unknown as BotLike;
  await loadPathfinderPlugin(bot);
  return bot;
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
    const mod: PathfinderModule = imported.pathfinder ? imported : imported.default ?? imported;
    if (mod.pathfinder && typeof bot.loadPlugin === 'function') {
      bot.loadPlugin(mod.pathfinder);
    }
    if (mod.Movements) pathfinderMovements = mod.Movements;
    if (mod.goals) pathfinderGoals = mod.goals;
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

function emptyInventorySnapshot(): LiveInventorySnapshot {
  return {
    updatedAt: null,
    heldItem: null,
    armor: [],
    crafting: [],
    storage: [],
    slots: [],
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
    armor: snapshot.armor.map((item) => ({ ...item })),
    crafting: snapshot.crafting.map((item) => ({ ...item })),
    storage: snapshot.storage.map((item) => ({ ...item })),
    slots: snapshot.slots.map((item) => ({ ...item })),
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

function stringifyReason(reason: unknown): string {
  const componentText = stringifyMinecraftText(reason);
  if (componentText) return componentText;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function stringifyMinecraftText(reason: unknown): string | null {
  const text = collectMinecraftText(parseMinecraftJson(reason)).trim();
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

function collectMinecraftText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(collectMinecraftText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';

  const component = value as Record<string, unknown>;
  const parts: string[] = [];
  if (
    typeof component.text === 'string' ||
    typeof component.text === 'number' ||
    typeof component.text === 'boolean'
  ) {
    parts.push(String(component.text));
  }
  if (Array.isArray(component.extra)) {
    parts.push(...component.extra.map(collectMinecraftText));
  }

  const plainText = parts.join('').trim();
  if (plainText) return parts.join('');

  if (Array.isArray(component.with)) {
    const args = component.with.map(collectMinecraftText).filter(Boolean);
    if (args.length > 0) return args.join(' ');
  }

  if (typeof component.fallback === 'string' && component.fallback.trim()) return component.fallback;
  if (typeof component.translate === 'string' && component.translate.trim()) return component.translate;
  return '';
}

function cloneProfile(profile: AccountProfile): AccountProfile {
  return {
    ...profile,
    startup: { ...profile.startup, flowCommands: (profile.startup.flowCommands ?? []).map((step) => ({ ...step })) },
    routine: { ...profile.routine, chatMessages: [...profile.routine.chatMessages] },
    reconnect: { ...profile.reconnect },
    proxy: profile.proxy ? { ...profile.proxy } : normalizeProxy(),
    modules: cloneModules(profile.modules ?? normalizeModules())
  };
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
    modules: normalizeModules(profile.modules)
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
    generator: { ...modules.generator },
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
    buildCollection: config?.buildCollection ?? DEFAULT_MODULES.cactusFarm.buildCollection
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
    radius: clamp(Number(config?.radius), 1, 12, DEFAULT_MODULES.cropFarm.radius),
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
    from: normalizePosition(config?.from, DEFAULT_MODULES.area.from),
    to: normalizePosition(config?.to, DEFAULT_MODULES.area.to),
    fillBlock: config?.fillBlock?.trim() || DEFAULT_MODULES.area.fillBlock,
    actionDelayMs: clamp(Number(config?.actionDelayMs), 100, 30000, DEFAULT_MODULES.area.actionDelayMs)
  };
}

function normalizeGeneratorMine(config?: Partial<GeneratorMineConfig>): GeneratorMineConfig {
  const direction = config?.direction;
  return {
    enabled: Boolean(config?.enabled),
    mode: config?.mode === 'four_way' ? 'four_way' : 'forward',
    direction:
      direction === 'north' || direction === 'south' || direction === 'east' || direction === 'west'
        ? direction
        : DEFAULT_MODULES.generator.direction,
    depth: clamp(Number(config?.depth), 1, 64, DEFAULT_MODULES.generator.depth),
    actionDelayMs: clamp(Number(config?.actionDelayMs), 100, 30000, DEFAULT_MODULES.generator.actionDelayMs)
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
    flowCommands: normalizeScriptSteps(startup?.flowCommands, [])
  };
}

function normalizeLobbyAuthMode(value?: string): LobbyAuthMode {
  if (value === 'none' || value === 'login' || value === 'register' || value === 'custom') return value;
  return 'login';
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
  const slots = (bot.inventory?.slots ?? [])
    .map((item, slot) => itemSnapshot(item, slot))
    .filter((item): item is InventoryItemSnapshot => Boolean(item));
  const heldSlot = typeof bot.quickBarSlot === 'number' ? 36 + bot.quickBarSlot : null;
  const heldItem = itemSnapshot(bot.heldItem ?? (heldSlot == null ? null : bot.inventory?.slots?.[heldSlot]), heldSlot ?? -1);
  const windowSlots = (bot.currentWindow?.slots ?? [])
    .map((item, slot) => itemSnapshot(item, slot))
    .filter((item): item is InventoryItemSnapshot => Boolean(item));
  return {
    updatedAt: new Date().toISOString(),
    heldItem,
    armor: slots.filter((item) => item.slot >= 5 && item.slot <= 8),
    crafting: slots.filter((item) => item.slot >= 1 && item.slot <= 4),
    storage: windowSlots.length > 0 ? windowSlots : slots.filter((item) => item.slot >= 9),
    slots,
    openWindowTitle: stringifyMinecraftText(bot.currentWindow?.title ?? null)
  };
}

function itemSnapshot(
  item: InventoryItemLike | null | undefined,
  fallbackSlot: number | null
): InventoryItemSnapshot | null {
  if (!item || !item.name) return null;
  return {
    slot: typeof item.slot === 'number' ? item.slot : fallbackSlot ?? -1,
    name: item.name,
    displayName: item.displayName ?? item.name,
    count: Math.max(1, Number(item.count) || 1)
  };
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
  const sand: OperationWorkItem[] = [];
  const postBase: OperationWorkItem[] = [];
  const postMid: OperationWorkItem[] = [];
  const postTop: OperationWorkItem[] = [];
  const triggers: OperationWorkItem[] = [];
  const cactus: OperationWorkItem[] = [];
  const collection: OperationWorkItem[] = [];

  const place = (bucket: OperationWorkItem[], offset: PositionSnapshot, itemName: string) => {
    bucket.push({ action: 'place', position: addPosition(origin, offset), itemName, walk: true });
  };

  const r = config.radius;
  for (let z = -r; z <= r; z += 4) {
    for (let x = -r; x <= r; x += 2) {
      place(sand, { x, y: 0, z }, 'sand');
      place(cactus, { x, y: 1, z }, 'cactus');
      if (!config.build) continue;
      // support post in the gap column two blocks behind (+Z) the cactus
      place(postBase, { x, y: 0, z: z + 2 }, config.breakBlock);
      place(postMid, { x, y: 1, z: z + 2 }, config.breakBlock);
      place(postTop, { x, y: 2, z: z + 2 }, config.breakBlock);
      // trigger at the grow cell's +Z neighbour, leaning on the post top
      place(triggers, { x, y: 2, z: z + 1 }, config.breakBlock);
      if (config.buildCollection) {
        // hopper in the +Z gap at ground level, where the thin trigger drops cactus
        place(collection, { x, y: 0, z: z + 1 }, 'hopper');
      }
    }
  }

  // Ordering matters: every block must have its reference placed first. Floor and
  // post pillar go bottom-up, triggers lean on the finished post tops, cacti last.
  return [...sand, ...postBase, ...collection, ...postMid, ...postTop, ...triggers, ...cactus];
}

function cactusMaterialNeeds(plan: OperationWorkItem[]): Record<string, number> {
  const needs: Record<string, number> = {};
  for (const item of plan) {
    if (item.action !== 'place' || !item.itemName) continue;
    needs[item.itemName] = (needs[item.itemName] ?? 0) + 1;
  }
  return needs;
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

function toVec3(position: PositionSnapshot): Vec3 {
  return new Vec3(position.x, position.y, position.z);
}

function scalePosition(position: PositionSnapshot, scale: number): PositionSnapshot {
  return {
    x: position.x * scale,
    y: position.y * scale,
    z: position.z * scale
  };
}

function directionVector(direction: GeneratorMineConfig['direction']): PositionSnapshot {
  switch (direction) {
    case 'south':
      return { x: 0, y: 0, z: 1 };
    case 'east':
      return { x: 1, y: 0, z: 0 };
    case 'west':
      return { x: -1, y: 0, z: 0 };
    case 'north':
    default:
      return { x: 0, y: 0, z: -1 };
  }
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
  /** clear-then-till steps for every non-centre cell (empty when autoTill is off). */
  prepare: OperationWorkItem[];
  /** seed-planting steps for every non-centre cell. */
  plant: OperationWorkItem[];
  /** dig the centre block down one so a water source can sit at farmland level. */
  centerDig: OperationWorkItem;
  /** where the water source goes (farmland level, hydrates the whole square). */
  waterPos: PositionSnapshot;
  /** every surface cell (farmland level) — used to detect pre-placed water. */
  footprint: PositionSnapshot[];
}

/**
 * Plan a hydrated crop square centred on the bot. Farmland sits at y-1 (the
 * surface the bot walks on), crops at y0, a single water source at the centre
 * (y-1) hydrates the surrounding cells (4-block range, so a 9x9 is fully wet).
 */
export function cropBuildPlan(origin: PositionSnapshot, config: CropFarmConfig): CropBuildPlan {
  const half = config.radius >= 4 ? 4 : config.radius;
  const seed = cropSeedName(config.crop);
  const prepare: OperationWorkItem[] = [];
  const plant: OperationWorkItem[] = [];
  const footprint: PositionSnapshot[] = [];

  for (let dx = -half; dx <= half; dx += 1) {
    for (let dz = -half; dz <= half; dz += 1) {
      const surface = addPosition(origin, { x: dx, y: -1, z: dz });
      footprint.push(surface);
      if (dx === 0 && dz === 0) continue; // centre is the water source
      if (config.autoTill) {
        // clear anything sitting on the dirt (grass, etc.) then till it
        prepare.push({ action: 'dig', position: addPosition(origin, { x: dx, y: 0, z: dz }), walk: true });
        prepare.push({ action: 'till', position: surface, walk: true });
      }
      plant.push({ action: 'place', position: addPosition(origin, { x: dx, y: 0, z: dz }), itemName: seed, walk: true });
    }
  }

  return {
    prepare,
    plant,
    centerDig: { action: 'dig', position: addPosition(origin, { x: 0, y: -1, z: 0 }), walk: true },
    waterPos: addPosition(origin, { x: 0, y: -1, z: 0 }),
    footprint
  };
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
    .replace(/(\/(?:login|register)\s+)(\S+)(?:\s+\S+)?/gi, '$1******')
    .replace(/(password|token|webhook)=\S+/gi, '$1=******');
}

function discordRuntimeLabel(runtime: DiscordRuntime): string {
  if (!runtime.enabled) return 'disabled';
  const parts = [];
  if (runtime.webhookUrl) parts.push('webhook');
  if (runtime.botToken && runtime.channelId) parts.push('commands');
  return parts.length > 0 ? parts.join(' + ') : 'enabled without credentials';
}
