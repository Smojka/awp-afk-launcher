export type AuthMode = 'microsoft' | 'offline';

export type LobbyAuthMode = 'none' | 'login' | 'register' | 'custom';

export type BotConnectionState =
  | 'idle'
  | 'connecting'
  | 'online'
  | 'warning'
  | 'reconnecting'
  | 'offline'
  | 'stopping'
  | 'error';

export type AfkActionType =
  | 'look'
  | 'jump'
  | 'sneak'
  | 'swing'
  | 'chat'
  | 'eat'
  | 'respawn'
  | 'reconnect'
  | 'inventory'
  | 'script'
  | 'discord'
  | 'autoReply'
  | 'cactus'
  | 'farm'
  | 'area'
  | 'generator';

export interface StartupFlowConfig {
  enabled: boolean;
  authMode: LobbyAuthMode;
  authCommandTemplate: string;
  registerCommandTemplate: string;
  authPassword: string;
  authDelayMs: number;
  transferCommand: string;
  transferDelayMs: number;
  flowCommands: ScriptStep[];
}

export interface AfkRoutineConfig {
  randomLook: boolean;
  autoJump: boolean;
  sneakPulse: boolean;
  swingArm: boolean;
  chatHeartbeat: boolean;
  autoRespawn: boolean;
  autoEat: boolean;
  eatAtFood: number;
  pauseAtFood: number;
  intervalMs: number;
  jitterPercent: number;
  chatMessages: string[];
}

export interface ReconnectPolicy {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type ProxyType = 'socks4' | 'socks5' | 'http' | 'https';

export interface ProxyConfig {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
}

export type CropType = 'wheat' | 'carrot' | 'potato' | 'beetroot' | 'nether_wart' | 'pumpkin' | 'melon';

export type CactusBreakBlock = 'oak_fence' | 'glass_pane';

export interface CactusFarmConfig {
  enabled: boolean;
  layers: number;
  radius: number;
  placementDelayMs: number;
  /** Build a real auto-harvesting farm (break-trigger blocks + collection) instead of bare cactus columns. */
  build: boolean;
  /** Thin block placed at the cactus grow cell so growth snaps off and drops. */
  breakBlock: CactusBreakBlock;
  /** Also place a hopper line under the drop cells to collect the harvest. */
  buildCollection: boolean;
}

export type CropWaterMode = 'auto' | 'existing';

export interface CropFarmConfig {
  enabled: boolean;
  crop: CropType;
  radius: number;
  harvestDelayMs: number;
  replant: boolean;
  collectDrops: boolean;
  /** Run a till + water + plant build pass before entering the harvest loop. */
  build: boolean;
  /** Convert plain dirt/grass into farmland with a hoe during the build pass. */
  autoTill: boolean;
  /** 'auto' tries to place a center water source with a bucket; 'existing' assumes water is already there. */
  waterMode: CropWaterMode;
}

export interface AreaOperationConfig {
  enabled: boolean;
  mode: 'mine' | 'fill';
  from: PositionSnapshot;
  to: PositionSnapshot;
  fillBlock: string;
  actionDelayMs: number;
}

export interface GeneratorMineConfig {
  enabled: boolean;
  mode: 'forward' | 'four_way';
  direction: 'north' | 'south' | 'east' | 'west';
  depth: number;
  actionDelayMs: number;
}

export interface ScriptStep {
  id: string;
  label: string;
  command: string;
  delayMs: number;
}

export interface ScriptConfig {
  enabled: boolean;
  loop: boolean;
  steps: ScriptStep[];
  quickCommands: ScriptStep[];
}

export interface DiscordConfig {
  enabled: boolean;
  commandPrefix: string;
  notifyChat: boolean;
  notifyEvents: boolean;
  pollCommands: boolean;
  pollIntervalMs: number;
  channelId: string;
}

export interface AutoResponseRule {
  id: string;
  enabled: boolean;
  label: string;
  match: string;
  response: string;
  cooldownMs: number;
}

export interface AutoResponseConfig {
  enabled: boolean;
  rules: AutoResponseRule[];
}

export interface BotModulesConfig {
  cactusFarm: CactusFarmConfig;
  cropFarm: CropFarmConfig;
  area: AreaOperationConfig;
  generator: GeneratorMineConfig;
  script: ScriptConfig;
  discord: DiscordConfig;
  autoResponse: AutoResponseConfig;
}

export interface AccountProfile {
  id: string;
  label: string;
  username: string;
  host: string;
  port: number;
  version: string | false;
  authMode: AuthMode;
  enabled: boolean;
  startup: StartupFlowConfig;
  routine: AfkRoutineConfig;
  reconnect: ReconnectPolicy;
  proxy?: ProxyConfig;
  modules?: BotModulesConfig;
}

export interface PositionSnapshot {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
}

export interface SessionEvent {
  id: string;
  profileId: string;
  at: string;
  type: AfkActionType | 'system' | 'chat' | 'kick' | 'error';
  tone: 'ok' | 'info' | 'warn' | 'danger' | 'muted';
  label: string;
  detail?: string;
}

export interface ChatLine {
  id: string;
  at: string;
  source: 'system' | 'server' | 'bot';
  message: string;
}

export interface InventoryItemSnapshot {
  slot: number;
  name: string;
  displayName: string;
  count: number;
}

export interface LiveInventorySnapshot {
  updatedAt: string | null;
  heldItem: InventoryItemSnapshot | null;
  armor: InventoryItemSnapshot[];
  crafting: InventoryItemSnapshot[];
  storage: InventoryItemSnapshot[];
  slots: InventoryItemSnapshot[];
  openWindowTitle: string | null;
}

export type OperationKind = 'cactusFarm' | 'cropFarm' | 'area' | 'generator' | 'script' | 'discord';

export type OperationState = 'idle' | 'running' | 'blocked' | 'complete' | 'error';

export interface OperationSnapshot {
  kind: OperationKind;
  state: OperationState;
  label: string;
  detail: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completed: number;
  total: number | null;
  stats: Record<string, number>;
}

export interface BotSessionSnapshot {
  profileId: string;
  state: BotConnectionState;
  statusMessage: string;
  ping: number | null;
  health: number | null;
  food: number | null;
  position: PositionSnapshot | null;
  dimension: string | null;
  inventoryUsed: number | null;
  inventorySize: number | null;
  inventory: LiveInventorySnapshot;
  playersOnline: number | null;
  startupActive: boolean;
  routineActive: boolean;
  operations: Record<OperationKind, OperationSnapshot>;
  tabCompletions: string[];
  connectedAt: string | null;
  nextReconnectAt: string | null;
  lastError: string | null;
  reconnectAttempts: number;
  events: SessionEvent[];
  chat: ChatLine[];
}

export interface RuntimeSnapshot {
  appVersion: string;
  systemState: 'online' | 'degraded';
  botCount: number;
  onlineCount: number;
  webDashboardUrl: string | null;
  authSessionDir: string;
  estimatedRamMb: number;
  latestError: string | null;
}

export interface AppSettings {
  /** Connect every enabled account automatically when the launcher starts. */
  autoStartOnLaunch: boolean;
  /** Delay inserted between each connection when starting accounts in bulk. */
  connectStaggerMs: number;
  /** Ask for confirmation before the "Stop all" action. */
  confirmStopAll: boolean;
  /** Show the time column in the chat console. */
  showChatTimestamps: boolean;
  /** Use a denser, tighter layout. */
  compactDensity: boolean;
  /** Reconnect policy pre-filled into newly created accounts. */
  defaultReconnect: ReconnectPolicy;
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoStartOnLaunch: false,
  connectStaggerMs: 1500,
  confirmStopAll: true,
  showChatTimestamps: true,
  compactDensity: false,
  defaultReconnect: {
    enabled: true,
    maxAttempts: 8,
    baseDelayMs: 5000,
    maxDelayMs: 90000
  }
};

export interface LauncherState {
  profiles: AccountProfile[];
  sessions: Record<string, BotSessionSnapshot>;
  runtime: RuntimeSnapshot;
  settings: AppSettings;
  selectedProfileId: string | null;
}

export interface SaveProfileInput extends Omit<AccountProfile, 'id'> {
  id?: string;
}

export interface OperationStartRequest {
  kind: OperationKind;
  config?: Partial<CactusFarmConfig | CropFarmConfig | AreaOperationConfig | GeneratorMineConfig | ScriptConfig | DiscordConfig>;
}

export interface DiscordRuntimeInput {
  enabled: boolean;
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
}

export interface LauncherApi {
  platform: string;
  getState: () => Promise<LauncherState>;
  saveProfile: (profile: SaveProfileInput) => Promise<LauncherState>;
  deleteProfile: (profileId: string) => Promise<LauncherState>;
  selectProfile: (profileId: string) => Promise<LauncherState>;
  connect: (profileId: string) => Promise<LauncherState>;
  disconnect: (profileId: string) => Promise<LauncherState>;
  startAll: () => Promise<LauncherState>;
  stopAll: () => Promise<LauncherState>;
  sendChat: (profileId: string, message: string) => Promise<LauncherState>;
  startOperation: (profileId: string, request: OperationStartRequest) => Promise<LauncherState>;
  stopOperation: (profileId: string, kind: OperationKind) => Promise<LauncherState>;
  runQuickScript: (profileId: string, command: string) => Promise<LauncherState>;
  completeChat: (profileId: string, partial: string) => Promise<string[]>;
  configureDiscord: (profileId: string, input: DiscordRuntimeInput) => Promise<LauncherState>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<LauncherState>;
  openUserData: () => Promise<void>;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  onWindowMaximizedChange: (listener: (isMaximized: boolean) => void) => () => void;
  onState: (listener: (state: LauncherState) => void) => () => void;
}
