import { EventEmitter } from 'node:events';
import path from 'node:path';
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
  type StartupFlowConfig
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
};

type InventoryItemLike = {
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
    inventory?: { slots?: unknown[]; items?: () => InventoryItemLike[] };
    players?: Record<string, unknown>;
    player?: { ping?: number };
    equip?: (item: InventoryItemLike, destination: 'hand') => Promise<void> | void;
    consume?: () => Promise<void> | void;
    quit?: (reason?: string) => void;
    respawn?: () => void;
  };

export type MineflayerFactory = (options: MineflayerOptions) => Promise<BotLike> | BotLike;

interface ManagedSession {
  profile: AccountProfile;
  bot: BotLike | null;
  routine: AfkRoutine | null;
  desiredStop: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  startupTimers: NodeJS.Timeout[];
  startupCompleted: boolean;
  foodGuardActive: boolean;
  hungerPaused: boolean;
  lastFoodWarningAt: number;
  snapshot: BotSessionSnapshot;
}

const MAX_EVENTS = 32;
const MAX_CHAT = 64;
const FOOD_WARNING_INTERVAL_MS = 30000;

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
        desiredStop: true,
        reconnectTimer: null,
        startupTimers: [],
        startupCompleted: false,
        foodGuardActive: false,
        hungerPaused: false,
        lastFoodWarningAt: 0,
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
    const bot = await factory({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      version: profile.version || undefined,
      auth: profile.authMode,
      profilesFolder: this.authSessionDir()
    });
    installResourcePackAutoAccept(bot);
    return bot;
  }

  private attachBotEvents(session: ManagedSession, bot: BotLike): void {
    bot.on('spawn', () => {
      const shouldRunStartup = !session.snapshot.startupActive && !session.startupCompleted;
      session.snapshot.connectedAt = new Date().toISOString();
      session.snapshot.reconnectAttempts = 0;
      session.snapshot.nextReconnectAt = null;
      if (!session.snapshot.startupActive) {
        this.updateStatus(session, 'online', 'Online');
      }
      this.pushEvent(session, 'system', 'ok', 'Joined server', session.profile.host);
      this.updateLiveTelemetry(session);
      void this.handleFoodGuard(session, bot);
      if (shouldRunStartup) {
        this.runStartupFlow(session, bot);
      }
      this.emitState();
    });

    bot.on('health', () => {
      this.updateLiveTelemetry(session);
      void this.handleFoodGuard(session, bot);
      this.emitState();
    });

    bot.on('move', () => {
      this.updateLiveTelemetry(session);
    });

    bot.on('messagestr', (message: string) => {
      this.pushChat(session, 'server', message);
      this.emitState();
    });

    bot.on('chat', (username: string, message: string) => {
      this.pushChat(session, 'server', `<${username}> ${message}`);
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
      this.emitState();
    });

    bot.on('error', (error: unknown) => {
      const message = formatError(error);
      session.snapshot.lastError = message;
      this.updateStatus(session, 'error', 'Bot error');
      this.pushEvent(session, 'error', 'danger', 'Bot error', message);
      this.emitState();
    });

    bot.on('end', () => {
      session.routine?.stop();
      session.routine = null;
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
    const hasAuthCommand = Boolean(authCommand);
    const hasTransferCommand = Boolean(transferCommand);

    if (!hasAuthCommand && !hasTransferCommand) {
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
  return createBot(options) as unknown as BotLike;
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
    playersOnline: null,
    startupActive: false,
    routineActive: false,
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

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function cloneProfile(profile: AccountProfile): AccountProfile {
  return {
    ...profile,
    startup: { ...profile.startup },
    routine: { ...profile.routine, chatMessages: [...profile.routine.chatMessages] },
    reconnect: { ...profile.reconnect }
  };
}

function profileForPersistence(profile: AccountProfile): AccountProfile {
  return {
    ...cloneProfile(profile),
    startup: {
      ...profile.startup,
      authPassword: ''
    }
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
    }
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
    transferDelayMs: Math.max(0, Number(startup?.transferDelayMs) || 3500)
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
