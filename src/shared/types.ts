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

export type AfkActionType = 'look' | 'jump' | 'sneak' | 'swing' | 'chat' | 'eat' | 'respawn' | 'reconnect';

export interface StartupFlowConfig {
  enabled: boolean;
  authMode: LobbyAuthMode;
  authCommandTemplate: string;
  registerCommandTemplate: string;
  authPassword: string;
  authDelayMs: number;
  transferCommand: string;
  transferDelayMs: number;
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
  playersOnline: number | null;
  startupActive: boolean;
  routineActive: boolean;
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
  updateSettings: (patch: Partial<AppSettings>) => Promise<LauncherState>;
  openUserData: () => Promise<void>;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  onWindowMaximizedChange: (listener: (isMaximized: boolean) => void) => () => void;
  onState: (listener: (state: LauncherState) => void) => () => void;
}
