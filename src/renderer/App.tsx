import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  Apple,
  ArrowRightLeft,
  Boxes,
  Bot,
  Check,
  ChevronUp,
  ChevronDown,
  CircleAlert,
  Crosshair,
  CircleHelp,
  Download,
  FolderOpen,
  Gauge,
  Globe2,
  Hammer,
  Hand,
  MessageSquare,
  Maximize2,
  Minimize2,
  Minus,
  Pickaxe,
  Pencil,
  Play,
  Plus,
  PackageOpen,
  RotateCcw,
  Save,
  Send,
  Settings,
  Shirt,
  Square,
  Terminal,
  Trash2,
  Wheat,
  Wifi,
  X
} from 'lucide-react';
import { getLauncherApi } from './api';
import { itemIconUri } from './itemIcon';
import { DEFAULT_SETTINGS } from '../shared/types';
import type {
  AccountProfile,
  AppSettings,
  AutoResponseRule,
  BotModulesConfig,
  BotSessionSnapshot,
  DiscordRuntimeInput,
  EquipDestination,
  GeneratorSlot,
  InventoryActionRequest,
  InventoryItemSnapshot,
  LauncherApi,
  LauncherState,
  OperationKind,
  PositionSnapshot,
  ProxyConfig,
  SaveProfileInput,
  ScriptStep,
  StorageConfig,
  UpdateCheckResult,
  UpdateDownloadedInfo,
  UpdatePhase,
  UpdateProgress
} from '../shared/types';

type DraftProfile = AccountProfile;

const APP_NAME = 'ChunkKeeper';
const APP_TAGLINE = 'Minecraft AFK command desk';
const DEVELOPER_CREDIT = 'Developed by smojka';
// Quick-pick Minecraft versions surfaced in the profile editor. A profile may carry
// any other version string (e.g. an older save or a build outside this list); the
// editor renders that value as an extra option so editing never silently drops it.
const PRESET_VERSIONS = ['1.21.1', '1.20.6', '1.20.1', '1.19.4'];

const STATE_LABEL: Record<BotSessionSnapshot['state'], string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  online: 'Online',
  warning: 'Warning',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  stopping: 'Stopping',
  error: 'Error'
};

const OPERATION_KINDS: OperationKind[] = ['cactusFarm', 'cropFarm', 'area', 'generator', 'script', 'discord'];

const OPERATION_TITLES: Record<OperationKind, string> = {
  cactusFarm: 'Cactus',
  cropFarm: 'Crops',
  area: 'Area',
  generator: 'Generator',
  script: 'Script',
  discord: 'Discord'
};

const DEFAULT_STORAGE_UI: StorageConfig = {
  enabled: false,
  withdrawFrom: { x: 0, y: 0, z: 0 },
  depositTo: { x: 0, y: 0, z: 0 },
  depositAtPercentFull: 0.8,
  keepSeedStacks: 1,
  retryAttempts: 3
};

const DEFAULT_MODULES_UI: BotModulesConfig = {
  cactusFarm: { enabled: false, layers: 1, radius: 2, placementDelayMs: 550, build: true, breakBlock: 'oak_fence', buildCollection: true, rowPairs: 1, wallBlock: 'glass' },
  cropFarm: { enabled: false, crop: 'wheat', radius: 4, harvestDelayMs: 750, replant: true, collectDrops: true, build: true, autoTill: true, waterMode: 'auto' },
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
    steps: [{ id: 'script-1', label: 'Step 1', command: '/spawn', delayMs: 1000 }],
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

const DEFAULT_PROXY_UI: ProxyConfig = {
  enabled: false,
  type: 'socks5',
  host: '',
  port: 0,
  username: '',
  password: ''
};

type TabKey = 'overview' | 'operations' | 'inventory' | 'routine' | 'activity';

const TABS: { key: TabKey; label: string; Icon: typeof Activity }[] = [
  { key: 'overview', label: 'Overview', Icon: Gauge },
  { key: 'operations', label: 'Operations', Icon: Pickaxe },
  { key: 'inventory', label: 'Inventory', Icon: Boxes },
  { key: 'routine', label: 'Routine', Icon: RotateCcw },
  { key: 'activity', label: 'Activity', Icon: Activity }
];

function UpdateBanner({
  phase,
  info,
  progress,
  downloaded,
  errorMessage,
  onDownload,
  onDismiss
}: {
  phase: UpdatePhase;
  info: UpdateCheckResult | null;
  progress: UpdateProgress | null;
  downloaded: UpdateDownloadedInfo | null;
  errorMessage: string | null;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  if (phase === 'idle' || !info) return null;

  const percent = progress ? Math.min(100, Math.max(0, Math.round(progress.percent))) : 0;
  const speed =
    progress && progress.bytesPerSecond > 0 ? `${(progress.bytesPerSecond / 1_000_000).toFixed(1)} MB/s` : null;
  const installMode = downloaded?.installMode ?? info.installMode;
  const modifier =
    phase === 'error'
      ? ' update-banner--error'
      : phase === 'downloaded'
        ? ' update-banner--done'
        : phase === 'downloading'
          ? ' update-banner--busy'
          : '';

  return (
    <div className={`update-banner glass${modifier}`} role="status" aria-live="polite">
      <span className="update-banner__icon">{phase === 'error' ? <CircleAlert size={18} /> : <Download size={18} />}</span>
      <div className="update-banner__body">
        {phase === 'available' ? (
          <>
            <strong className="update-banner__title">{APP_NAME} {info.latestVersion} is available</strong>
            <a className="update-banner__link" href={info.htmlUrl} target="_blank" rel="noreferrer">
              Release notes
            </a>
          </>
        ) : null}
        {phase === 'downloading' ? (
          <>
            <strong className="update-banner__title">
              Downloading update… {percent}%{speed ? ` · ${speed}` : ''}
            </strong>
            <div className="update-banner__bar" aria-hidden="true">
              <span className="update-banner__bar-fill" style={{ width: `${percent}%` }} />
            </div>
          </>
        ) : null}
        {phase === 'downloaded' ? (
          <strong className="update-banner__title">
            {installMode === 'auto'
              ? `Update downloaded — restarting ${APP_NAME}…`
              : `Installer opened — drag ${APP_NAME} to your Applications folder to finish.`}
          </strong>
        ) : null}
        {phase === 'error' ? (
          <strong className="update-banner__title">Update failed{errorMessage ? `: ${errorMessage}` : ''}</strong>
        ) : null}
      </div>
      <div className="update-banner__actions">
        {phase === 'available' ? (
          <button className="btn btn--primary btn--sm" onClick={onDownload}>
            <Download size={15} />
            Download
          </button>
        ) : null}
        {phase === 'error' ? (
          <button className="btn btn--primary btn--sm" onClick={onDownload}>
            <RotateCcw size={15} />
            Retry
          </button>
        ) : null}
        {phase !== 'downloading' && phase !== 'downloaded' ? (
          <button className="icon-btn icon-btn--sm" title="Dismiss" onClick={onDismiss}>
            <X size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function App({ api }: { api?: LauncherApi } = {}) {
  const [apiClient] = useState<LauncherApi | null>(() => {
    if (api) return api;
    try {
      return getLauncherApi();
    } catch {
      return null;
    }
  });
  const [state, setState] = useState<LauncherState | null>(null);
  const [draft, setDraft] = useState<DraftProfile | null>(null);
  const [chatMessage, setChatMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [discordDraft, setDiscordDraft] = useState<DiscordRuntimeInput>({ enabled: false });
  const [chatCompletions, setChatCompletions] = useState<string[]>([]);
  // Monotonic id so out-of-order completion responses can't clobber newer suggestions.
  const completionSeqRef = useRef(0);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateDownloaded, setUpdateDownloaded] = useState<UpdateDownloadedInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (!apiClient) {
      setError('Launcher bridge is unavailable. Start the Electron app instead of the raw renderer.');
      return undefined;
    }
    let mounted = true;
    apiClient
      .getState()
      .then((nextState) => {
        if (mounted) setState(nextState);
      })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
    const unsubscribe = apiClient.onState(setState);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [apiClient]);

  useEffect(() => {
    if (!apiClient) return undefined;
    let mounted = true;
    apiClient
      .isWindowMaximized()
      .then((isMaximized) => {
        if (mounted) setWindowMaximized(isMaximized);
      })
      .catch(() => undefined);
    const unsubscribe = apiClient.onWindowMaximizedChange(setWindowMaximized);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [apiClient]);

  useEffect(() => {
    if (!apiClient) return undefined;
    const unsubAvailable = apiClient.onUpdateAvailable((info) => {
      setUpdateInfo(info);
      setUpdateProgress(null);
      setUpdateDownloaded(null);
      setUpdateError(null);
      setUpdatePhase('available');
    });
    const unsubProgress = apiClient.onUpdateProgress((progress) => {
      setUpdateProgress(progress);
      setUpdatePhase('downloading');
    });
    const unsubDownloaded = apiClient.onUpdateDownloaded((info) => {
      setUpdateDownloaded(info);
      setUpdatePhase('downloaded');
    });
    const unsubError = apiClient.onUpdateError((message) => {
      setUpdateError(message);
      setUpdatePhase('error');
    });
    return () => {
      unsubAvailable();
      unsubProgress();
      unsubDownloaded();
      unsubError();
    };
  }, [apiClient]);

  async function downloadUpdate() {
    if (!apiClient) return;
    setUpdateError(null);
    setUpdateProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    setUpdatePhase('downloading');
    try {
      await apiClient.downloadUpdate();
    } catch (downloadError) {
      setUpdateError(downloadError instanceof Error ? downloadError.message : String(downloadError));
      setUpdatePhase('error');
    }
  }

  const selectedProfile = useMemo(() => {
    if (!state) return null;
    return state.profiles.find((profile) => profile.id === state.selectedProfileId) ?? state.profiles[0] ?? null;
  }, [state]);

  const selectedSession = state && draft?.id ? state.sessions[draft.id] ?? null : null;

  useEffect(() => {
    if (selectedProfile) {
      setDraft(structuredClone(selectedProfile));
    }
    // Suggestions belong to the previous profile's command bar — drop them on switch.
    setChatCompletions([]);
    // Discord webhook/token are per-account, write-only runtime secrets; never carry
    // one account's credentials over to the next when the selection changes.
    setDiscordDraft({ enabled: false });
  }, [selectedProfile?.id]);

  async function run(action: () => Promise<LauncherState | void>) {
    if (!apiClient) {
      setError('Launcher bridge is unavailable. Start the Electron app instead of the raw renderer.');
      return;
    }
    try {
      setError(null);
      const nextState = await action();
      if (nextState) setState(nextState);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }

  async function saveProfileDraft(profile = draft) {
    if (!profile) return;
    setDraft(profile);
    await run(() => apiClient!.saveProfile(normalizeDraft(profile)));
  }

  async function stopAll() {
    if (state?.settings.confirmStopAll && !window.confirm('Stop all running sessions?')) return;
    await run(() => apiClient!.stopAll());
  }

  async function sendChat() {
    if (!draft?.id || !chatMessage.trim()) return;
    const profileId = draft.id;
    const message = chatMessage.trim();
    setChatMessage('');
    setChatCompletions([]);
    await run(() => apiClient!.sendChat(profileId, message));
  }

  // Typing (or applying a suggestion) invalidates the current chips; drop them so the
  // command bar never shows suggestions for text the user has already moved past.
  function handleChatInput(value: string) {
    setChatMessage(value);
    setChatCompletions((prev) => (prev.length ? [] : prev));
  }

  async function startOperation(kind: OperationKind, config?: BotModulesConfig[OperationKind]) {
    if (!draft?.id) return;
    await run(() => apiClient!.startOperation(draft.id, { kind, config }));
  }

  async function stopOperation(kind: OperationKind) {
    if (!draft?.id) return;
    await run(() => apiClient!.stopOperation(draft.id, kind));
  }

  async function captureChestPosition(profileId: string): Promise<PositionSnapshot | null> {
    if (!apiClient) return null;
    return apiClient.capturePosition(profileId);
  }

  async function runQuickScript(command: string) {
    if (!draft?.id) return;
    await run(() => apiClient!.runQuickScript(draft.id, command));
  }

  async function inventoryAction(request: InventoryActionRequest) {
    if (!draft?.id) return;
    await run(() => apiClient!.inventoryAction(draft.id, request));
  }

  async function completeChat(partial: string) {
    if (!draft?.id) return;
    const seq = ++completionSeqRef.current;
    try {
      const completions = await apiClient!.completeChat(draft.id, partial);
      // Ignore a slow response superseded by a newer request (rapid Tab + edits).
      if (seq === completionSeqRef.current) setChatCompletions(completions);
    } catch {
      // Tab completion is best-effort: a failed round-trip just yields no suggestions
      // and must never bubble up as an unhandled promise rejection.
      if (seq === completionSeqRef.current) setChatCompletions([]);
    }
  }

  async function applyDiscordRuntime(input: DiscordRuntimeInput) {
    if (!draft?.id) return;
    setDiscordDraft(input);
    await run(() => apiClient!.configureDiscord(draft.id, input));
  }

  if (!state || !draft || !apiClient) {
    return (
      <main className={`boot${error ? ' is-error' : ''}`} role="status" aria-live="polite" aria-busy={!error}>
        <div className="boot__mark">
          <BrandMark className="boot__glyph" />
          <span>{APP_NAME}</span>
          <small className="boot__credit">{DEVELOPER_CREDIT}</small>
          {error ? null : <div className="boot__bar" aria-hidden="true" />}
          {error ? null : <span className="sr-only">{`Starting ${APP_NAME}…`}</span>}
          {error ? <small className="boot__error">{error}</small> : null}
        </div>
      </main>
    );
  }

  const liveState = selectedSession?.state ?? 'idle';
  const isLive = liveState === 'online' || liveState === 'connecting' || liveState === 'reconnecting';
  const isOnline = liveState === 'online';
  const modules = profileModules(draft);
  const position = selectedSession?.position ?? null;
  const showWindowControls = apiClient.platform === 'win32' || apiClient.platform === 'linux';
  const appClassName = [
    'app',
    state.settings.compactDensity ? 'is-compact' : '',
    settingsOpen || profileEditorOpen ? 'has-modal' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={appClassName}>
      <header className="topbar">
        <div className="brand">
          <BrandMark className="brand__mark" />
          <div>
            <h1 className="brand__name">{APP_NAME}</h1>
            <div className="brand__sub">{APP_TAGLINE}</div>
          </div>
        </div>

        <div className="topbar__pulse" title="Sessions online">
          <i className={`dot ${state.runtime.onlineCount > 0 ? 'dot--online' : 'dot--idle'}`} />
          <span className="mono">
            {state.runtime.onlineCount} / {state.runtime.botCount}
          </span>
          <span>online</span>
        </div>

        <div className="topbar__actions">
          <ActionWithHelp help="Enabled olan tüm hesapları sırayla bağlar. Settings içindeki connect stagger değeri iki bağlantı arasına bekleme koyar.">
            <button className="btn btn--primary" onClick={() => run(() => apiClient!.startAll())}>
              <Play size={15} />
              Start all
            </button>
          </ActionWithHelp>
          <ActionWithHelp help="Çalışan tüm oturumları kapatır ve rutinleri durdurur. Onay ayarı açıksa önce senden onay ister.">
            <button className="btn btn--danger" onClick={stopAll}>
              <Square size={15} />
              Stop all
            </button>
          </ActionWithHelp>
          <span className="topbar__divider" />
          <ActionWithHelp help="ChunkKeeper'ın profil ve oturum dosyalarını tuttuğu yerel veri klasörünü açar.">
            <button className="icon-btn" title="Open data folder" onClick={() => run(() => apiClient!.openUserData())}>
              <FolderOpen size={16} />
            </button>
          </ActionWithHelp>
          <ActionWithHelp help="Başlangıç, görünüm ve yeni hesap varsayılanlarını değiştirdiğin ayar penceresini açar.">
            <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
              <Settings size={16} />
            </button>
          </ActionWithHelp>
        </div>

        {showWindowControls ? (
          <WindowControls
            api={apiClient}
            isMaximized={windowMaximized}
            onMaximizedChange={setWindowMaximized}
            onError={setError}
          />
        ) : null}
      </header>

      <UpdateBanner
        phase={updatePhase}
        info={updateInfo}
        progress={updateProgress}
        downloaded={updateDownloaded}
        errorMessage={updateError}
        onDownload={downloadUpdate}
        onDismiss={() => setUpdatePhase('idle')}
      />

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar__head">
            <span className="overline">Accounts</span>
            <span className="badge">
              {state.runtime.onlineCount}/{state.runtime.botCount}
            </span>
          </div>
          <div className="sidebar__list">
            {state.profiles.map((profile) => (
              <AccountRow
                key={profile.id}
                profile={profile}
                session={state.sessions[profile.id]}
                selected={profile.id === draft.id}
                onSelect={() => {
                  setDraft(structuredClone(profile));
                  void run(() => apiClient!.selectProfile(profile.id));
                }}
              />
            ))}
            {state.profiles.length === 0 ? <p className="sidebar__empty">No accounts yet.</p> : null}
          </div>
          <div className="sidebar__foot">
            <ActionWithHelp block help="Seçili profilden güvenli ayarları kopyalayıp yeni bir hesap taslağı açar. Şifre alanı özellikle boş bırakılır.">
              <button
                className="btn btn--block"
                onClick={() => {
                  setDraft(createNewAccountDraft(draft, state.settings, state.profiles.length + 1));
                  setProfileEditorOpen(true);
                }}
              >
                <Plus size={15} />
                New account
              </button>
            </ActionWithHelp>
          </div>
        </aside>

        <main className="content">
          <section className="panel panel--bar">
            <div className="toolbar">
              <div className="toolbar__id">
                <span className="avatar avatar--lg">{(draft.label || '??').slice(0, 2).toUpperCase()}</span>
                <div className="toolbar__copy">
                  <strong>
                    {draft.label || 'New account'}
                    {!draft.id ? <span className="tag toolbar__new">New</span> : null}
                  </strong>
                  <span className="toolbar__addr">
                    {draft.host || 'host'}:{draft.port}
                    <em>·</em>
                    {draft.authMode}
                    <em>·</em>
                    {draft.version || 'auto'}
                  </span>
                </div>
              </div>
              <div className="toolbar__actions">
                <StatusPill state={liveState} label={selectedSession?.statusMessage ?? STATE_LABEL[liveState]} />
                <ActionWithHelp help="Seçili hesabı bağlar. Join flow açıksa önce lobby auth/register komutunu, sonra transfer komutunu çalıştırır; AFK rutini en son başlar.">
                  <button
                    className="btn btn--primary"
                    disabled={!draft.id || isLive}
                    onClick={() => draft.id && run(() => apiClient!.connect(draft.id))}
                  >
                    <Play size={15} />
                    Connect
                  </button>
                </ActionWithHelp>
                <ActionWithHelp help="Seçili oturumu bilinçli olarak kapatır. Bu işlem reconnect sayılmaz, bu yüzden otomatik yeniden bağlanma tetiklenmez.">
                  <button
                    className="btn"
                    disabled={!draft.id || liveState === 'offline' || liveState === 'idle'}
                    onClick={() => draft.id && run(() => apiClient!.disconnect(draft.id))}
                  >
                    <Square size={15} />
                    Disconnect
                  </button>
                </ActionWithHelp>
                <ActionWithHelp help="Seçili profili yerel listeden siler. Çalışan oturum varsa önce kapatman daha temiz olur.">
                  <button
                    className="icon-btn icon-btn--danger"
                    title="Delete selected profile"
                    disabled={!draft.id}
                    onClick={() => draft.id && run(() => apiClient!.deleteProfile(draft.id))}
                  >
                    <Trash2 size={15} />
                  </button>
                </ActionWithHelp>
              </div>
            </div>
          </section>

          <CommandBar
            quickCommands={modules.script.quickCommands}
            online={isOnline}
            value={chatMessage}
            completions={chatCompletions}
            onChange={handleChatInput}
            onSend={sendChat}
            onQuickScript={runQuickScript}
            onComplete={completeChat}
          />

          <nav className="tabnav" role="tablist" aria-label="Workspace sections">
            {TABS.map((tab) => {
              const TabIcon = tab.Icon;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  id={`tab-${tab.key}`}
                  aria-controls={`tabpanel-${tab.key}`}
                  aria-selected={activeTab === tab.key}
                  className={`tabnav__tab ${activeTab === tab.key ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <TabIcon size={15} />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          <section
            className="tabpane tabpane--overview"
            role="tabpanel"
            id="tabpanel-overview"
            aria-labelledby="tab-overview"
            hidden={activeTab !== 'overview'}
          >
            <div className="kpis">
              <Kpi label="Health" value={selectedSession?.health ?? '—'} max={20} tone="ok" />
              <Kpi label="Hunger" value={selectedSession?.food ?? '—'} max={20} tone="warn" />
              <Kpi label="Ping" value={selectedSession?.ping ?? '—'} unit={selectedSession?.ping ? 'ms' : undefined} />
              <Kpi label="Players" value={selectedSession?.playersOnline ?? '—'} />
            </div>

            <div className="coords">
              <Coord k="Pos X" v={position?.x ?? '—'} />
              <Coord k="Pos Y" v={position?.y ?? '—'} />
              <Coord k="Pos Z" v={position?.z ?? '—'} />
              <Coord k="Dim" v={formatDimension(selectedSession?.dimension)} />
              <Coord
                k="Inv"
                v={selectedSession?.inventoryUsed == null ? '—' : `${selectedSession.inventoryUsed}/${selectedSession.inventorySize ?? 46}`}
              />
            </div>

            <div className="overview-grid">
              <ServerProfileSummary
                draft={draft}
                onEdit={() => setProfileEditorOpen(true)}
                onSave={() => saveProfileDraft(draft)}
              />
              <ConnectionPanel session={selectedSession} stateLabel={STATE_LABEL[liveState]} />
            </div>
          </section>

          <section
            className="tabpane"
            role="tabpanel"
            id="tabpanel-operations"
            aria-labelledby="tab-operations"
            hidden={activeTab !== 'operations'}
          >
            <OperationsPanel
              draft={draft}
              session={selectedSession}
              discordDraft={discordDraft}
              onChange={setDraft}
              onSave={() => saveProfileDraft(draft)}
              onStart={startOperation}
              onStop={stopOperation}
              onApplyDiscord={applyDiscordRuntime}
              onCaptureChest={captureChestPosition}
            />
          </section>

          <section
            className="tabpane"
            role="tabpanel"
            id="tabpanel-inventory"
            aria-labelledby="tab-inventory"
            hidden={activeTab !== 'inventory'}
          >
            <InventoryPanel session={selectedSession} online={liveState === 'online'} onAction={inventoryAction} />
          </section>

          <section
            className="tabpane"
            role="tabpanel"
            id="tabpanel-routine"
            aria-labelledby="tab-routine"
            hidden={activeTab !== 'routine'}
          >
            <RoutinePanel draft={draft} onChange={setDraft} onSave={() => saveProfileDraft(draft)} />
          </section>

          <section
            className="tabpane"
            role="tabpanel"
            id="tabpanel-activity"
            aria-labelledby="tab-activity"
            hidden={activeTab !== 'activity'}
          >
            <div className="tables">
              <ChatConsole
                session={selectedSession}
                showTimestamps={state.settings.showChatTimestamps}
              />
              <PulseRail session={selectedSession} />
            </div>
          </section>
        </main>
      </div>

      <footer className="statusbar">
        <StatusItem
          icon={<Activity size={13} />}
          label="System"
          value={state.runtime.systemState}
          tone={state.runtime.systemState === 'online' ? 'ok' : 'warn'}
        />
        {state.runtime.webDashboardUrl ? (
          <StatusItem
            icon={<Globe2 size={13} />}
            label="Web"
            value={compactUrl(state.runtime.webDashboardUrl)}
            tone="ok"
          />
        ) : null}
        <StatusItem icon={<Gauge size={13} />} label="RAM" value={`${state.runtime.estimatedRamMb} MB est.`} />
        <StatusItem icon={<Wifi size={13} />} label="Bots" value={`${state.runtime.onlineCount}/${state.runtime.botCount} online`} />
        <StatusItem
          icon={error || state.runtime.latestError ? <CircleAlert size={13} /> : <Check size={13} />}
          label="Status"
          value={error ?? state.runtime.latestError ?? 'All clear'}
          tone={error || state.runtime.latestError ? 'danger' : 'ok'}
        />
        <div className="statusbar__credit">
          <span>Developed by</span>
          <strong>smojka</strong>
        </div>
      </footer>

      {settingsOpen ? (
        <SettingsModal
          settings={state.settings}
          runtime={state.runtime}
          showTrayToggle={showWindowControls}
          onChange={(patch) => run(() => apiClient!.updateSettings(patch))}
          onOpenData={() => run(() => apiClient!.openUserData())}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {profileEditorOpen ? (
        <ProfileEditorModal
          draft={draft}
          onClose={() => setProfileEditorOpen(false)}
          onSave={async (profile) => {
            await saveProfileDraft(profile);
            setProfileEditorOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function BrandMark({ className }: { className: string }) {
  return (
    <span className={className} aria-hidden="true">
      <span className="brand-cube">
        <i className="brand-cube__top" />
        <i className="brand-cube__soil" />
        <i className="brand-cube__pulse" />
        <i className="brand-cube__key brand-cube__key--stem" />
        <i className="brand-cube__key brand-cube__key--upper" />
        <i className="brand-cube__key brand-cube__key--lower" />
      </span>
    </span>
  );
}

function WindowControls({
  api,
  isMaximized,
  onMaximizedChange,
  onError
}: {
  api: LauncherApi;
  isMaximized: boolean;
  onMaximizedChange: (isMaximized: boolean) => void;
  onError: (message: string) => void;
}) {
  const runWindowAction = (action: () => Promise<void | boolean>) => {
    void action()
      .then((result) => {
        if (typeof result === 'boolean') onMaximizedChange(result);
      })
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  };

  return (
    <div className="window-controls" aria-label="Window controls">
      <ActionWithHelp help="Pencereyi küçültür. Uygulama arka planda açık kalır.">
        <button className="window-control" title="Minimize" onClick={() => runWindowAction(api.minimizeWindow)}>
          <Minus size={15} />
        </button>
      </ActionWithHelp>
      <ActionWithHelp help="Pencereyi büyütür veya eski boyutuna döndürür. Oturumları etkilemez.">
        <button
          className="window-control"
          title={isMaximized ? 'Restore' : 'Maximize'}
          onClick={() => runWindowAction(api.toggleMaximizeWindow)}
        >
          {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </ActionWithHelp>
      <ActionWithHelp help="Pencereyi sistem tepsisine küçültür; uygulama ve oturumlar arka planda çalışmaya devam eder. Tamamen kapatmak için tepsi simgesine sağ tıklayıp Çıkış’ı seçin.">
        <button className="window-control window-control--close" title="Close" onClick={() => runWindowAction(api.closeWindow)}>
          <X size={15} />
        </button>
      </ActionWithHelp>
    </div>
  );
}

function ActionWithHelp({
  children,
  help,
  block = false
}: {
  children: React.ReactNode;
  help: string;
  block?: boolean;
}) {
  return (
    <span className={`control-with-help ${block ? 'control-with-help--block' : ''}`}>
      {children}
      <HelpTip text={help} />
    </span>
  );
}

function HelpTip({ text }: { text: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null);

  const updatePosition = () => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;

    const rect = anchor.getBoundingClientRect();
    const maxWidth = Math.min(280, Math.max(180, window.innerWidth - 24));
    const left = Math.min(Math.max(rect.left + rect.width / 2, 12 + maxWidth / 2), window.innerWidth - 12 - maxWidth / 2);
    const placement = rect.top > 124 ? 'top' : 'bottom';
    const top = placement === 'top' ? rect.top - 10 : rect.bottom + 10;
    setPosition({ left, top, placement });
  };

  const open = () => {
    updatePosition();
    setIsOpen(true);
  };

  const close = () => setIsOpen(false);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, text]);

  return (
    <span
      ref={anchorRef}
      className="help-tip"
      tabIndex={0}
      aria-label={text}
      aria-describedby={isOpen ? tooltipId : undefined}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
    >
      <CircleHelp size={13} aria-hidden="true" />
      {isOpen && position && typeof document !== 'undefined'
        ? createPortal(
            <span
              id={tooltipId}
              className={`help-tip__bubble help-tip__bubble--${position.placement}`}
              role="tooltip"
              style={{ left: `${position.left}px`, top: `${position.top}px` }}
            >
              {text}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

// A single command-palette-style launcher for quick commands. Replaces the old
// row of inline buttons that grew unbounded and wrapped the command bar onto
// extra lines. Opens a searchable, keyboard-navigable popover (portaled to body,
// positioned like HelpTip) so the bar stays one line regardless of command count.
function QuickCommandMenu({
  commands,
  online,
  onRun
}: {
  commands: ScriptStep[];
  online: boolean;
  onRun: (command: string) => void | Promise<void>;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter(
      (step) => step.label.toLowerCase().includes(needle) || step.command.toLowerCase().includes(needle)
    );
  }, [commands, query]);
  const safeActive = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  const updatePosition = () => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;
    const rect = anchor.getBoundingClientRect();
    const panelWidth = Math.min(300, window.innerWidth - 24);
    const left = Math.min(Math.max(rect.left, 12), Math.max(12, window.innerWidth - 12 - panelWidth));
    const placement = window.innerHeight - rect.bottom < 300 ? 'top' : 'bottom';
    const top = placement === 'bottom' ? rect.bottom + 6 : rect.top - 6;
    setPosition({ left, top, placement });
  };

  const open = () => {
    setQuery('');
    setActiveIndex(0);
    updatePosition();
    setIsOpen(true);
  };
  const close = () => setIsOpen(false);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    updatePosition();
    searchRef.current?.focus();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  const runCommand = (command: string) => {
    if (!online) return;
    void onRun(command);
    close();
  };

  return (
    <>
      <ActionWithHelp help="Hızlı komutlar — listeyi aç, ara ve tek tıkla seçili çevrimiçi bota gönder. Operations → Command script'ten düzenlenir.">
        <button
          ref={anchorRef}
          type="button"
          className="btn btn--sm quick-menu__trigger"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-controls={isOpen ? menuId : undefined}
          onClick={() => (isOpen ? close() : open())}
        >
          <Send size={13} />
          Quick
          <span className="quick-menu__count">{commands.length}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </ActionWithHelp>
      {isOpen && position && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              id={menuId}
              className={`quick-menu__panel quick-menu__panel--${position.placement}`}
              role="dialog"
              aria-label="Quick commands"
              style={{ left: `${position.left}px`, top: `${position.top}px` }}
            >
              <div className="quick-menu__search">
                <input
                  ref={searchRef}
                  className="mono"
                  value={query}
                  placeholder="Komut ara…"
                  aria-label="Quick command search"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setActiveIndex((index) => Math.max(index - 1, 0));
                    } else if (event.key === 'Enter') {
                      event.preventDefault();
                      const target = filtered[safeActive];
                      if (target) runCommand(target.command);
                    }
                  }}
                />
              </div>
              <div className="quick-menu__list" role="menu">
                {filtered.length === 0 ? (
                  <p className="quick-menu__empty">Eşleşen komut yok</p>
                ) : (
                  filtered.map((step, index) => (
                    <button
                      key={step.id}
                      type="button"
                      role="menuitem"
                      className={`quick-menu__item ${index === safeActive ? 'quick-menu__item--active' : ''}`}
                      disabled={!online}
                      title={online ? `${step.command} komutunu gönderir` : 'Bot çevrimdışı'}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => runCommand(step.command)}
                    >
                      <span className="quick-menu__label">{step.label}</span>
                      <span className="quick-menu__cmd mono">{step.command}</span>
                    </button>
                  ))
                )}
              </div>
              {!online ? <p className="quick-menu__offline">Bot çevrimdışı — göndermek için bağlan.</p> : null}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function ServerProfileSummary({
  draft,
  onEdit,
  onSave
}: {
  draft: DraftProfile;
  onEdit: () => void;
  onSave: () => void;
}) {
  const flowCommandCount = (draft.startup.flowCommands ?? []).filter((step) => step.command.trim()).length;
  return (
    <section className="panel profile-summary">
      <div className="panel__head">
        <span className="panel__title">Server profile</span>
        <div className="panel__actions">
          <ActionWithHelp help="Seçili hesabın kullanıcı adı, sunucu, auth ve reconnect ayarlarını düzenleme penceresinde açar.">
            <button className="btn btn--sm" onClick={onEdit}>
              <Pencil size={14} />
              Edit profile
            </button>
          </ActionWithHelp>
          <ActionWithHelp help="Ekrandaki profil değişikliklerini yerel profile kaydeder. Lobby auth şifresi profil dosyasına yazılmaz.">
            <button className="btn btn--sm" onClick={onSave}>
              <Save size={14} />
              Save profile
            </button>
          </ActionWithHelp>
        </div>
      </div>
      <div className="panel__body profile-summary__body">
        <SummaryItem label="Label" value={draft.label || 'New account'} />
        <SummaryItem label="Username" value={draft.username || 'Not set'} empty={!draft.username} />
        <SummaryItem label="Host" value={`${draft.host || 'host'}:${draft.port || 25565}`} mono />
        <SummaryItem label="Version" value={draft.version || 'Auto detect'} />
        <SummaryItem label="Auth mode" value={draft.authMode} />
        <SummaryItem label="Proxy" value={profileProxy(draft).enabled ? `${profileProxy(draft).type} ${profileProxy(draft).host}` : 'Off'} empty={!profileProxy(draft).enabled} />
        <SummaryItem label="Lobby auth" value={draft.startup.enabled ? lobbyAuthLabel(draft.startup.authMode) : 'Off'} />
        <SummaryItem label="Transfer" value={draft.startup.transferCommand || 'None'} mono empty={!draft.startup.transferCommand} />
        <SummaryItem label="Flow cmds" value={String(flowCommandCount)} empty={flowCommandCount === 0} />
        <SummaryItem label="Reconnect" value={draft.reconnect.enabled ? `${draft.reconnect.maxAttempts} attempts` : 'Off'} />
      </div>
    </section>
  );
}

function SummaryItem({
  label,
  value,
  mono,
  empty
}: {
  label: string;
  value: string;
  mono?: boolean;
  empty?: boolean;
}) {
  return (
    <div className="profile-summary__item">
      <span className="profile-summary__label">{label}</span>
      <strong className={`profile-summary__value ${mono ? 'mono' : ''} ${empty ? 'is-empty' : ''}`}>{value}</strong>
    </div>
  );
}

function lobbyAuthLabel(mode: DraftProfile['startup']['authMode']): string {
  switch (mode) {
    case 'login':
      return 'Login';
    case 'register':
      return 'Register';
    case 'custom':
      return 'Custom command';
    case 'none':
      return 'No auth command';
    default:
      return 'Login';
  }
}

function ProfileEditorModal({
  draft,
  onSave,
  onClose
}: {
  draft: DraftProfile;
  onSave: (profile: DraftProfile) => Promise<void> | void;
  onClose: () => void;
}) {
  const [workingDraft, setWorkingDraft] = useState<DraftProfile>(() => structuredClone(draft));
  // Edit the port as raw text so it can be cleared mid-edit; it is coerced to a number
  // in the draft (0 when blank) and normalized to the default port at save time.
  const [portText, setPortText] = useState<string>(() => String(draft.port));

  useEffect(() => {
    setWorkingDraft(structuredClone(draft));
    setPortText(String(draft.port));
  }, [draft.id, draft.label]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const updateReconnect = (patch: Partial<DraftProfile['reconnect']>) =>
    setWorkingDraft({ ...workingDraft, reconnect: { ...workingDraft.reconnect, ...patch } });
  const updateProxy = (patch: Partial<ProxyConfig>) =>
    setWorkingDraft({ ...workingDraft, proxy: { ...profileProxy(workingDraft), ...patch } });

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal modal--profile"
        role="dialog"
        aria-modal="true"
        aria-label="Server profile editor"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <span className="panel__title">
            <Pencil size={14} />
            Server profile
          </span>
          <ActionWithHelp help="Değişiklikleri kaydetmeden profil düzenleme penceresini kapatır.">
            <button className="icon-btn" title="Close profile editor" onClick={onClose}>
              <X size={16} />
            </button>
          </ActionWithHelp>
        </div>

        <div className="modal__body profile-editor">
          <section className="profile-editor__mast">
            <span className="avatar avatar--lg">{(workingDraft.label || '??').slice(0, 2).toUpperCase()}</span>
            <div className="profile-editor__mast-copy">
              <strong>{workingDraft.label || 'New account'}</strong>
              <span className="mono">
                {workingDraft.host || 'host'}:{workingDraft.port || 25565}
              </span>
            </div>
            <Toggle
              label="Enabled"
              help="Açık hesaplar Start all ile başlatılır. Kapalı hesap listede kalır ama toplu başlatmaya dahil edilmez."
              checked={workingDraft.enabled}
              onChange={(value) => setWorkingDraft({ ...workingDraft, enabled: value })}
            />
          </section>

          <section className="profile-editor__section">
            <div className="profile-editor__section-head">
              <span className="overline">Identity</span>
            </div>
            <div className="form form--profile">
              <Field
                label="Label"
                value={workingDraft.label}
                onChange={(value) => setWorkingDraft({ ...workingDraft, label: value })}
              />
              <Field
                label="Username"
                value={workingDraft.username}
                autoComplete="username"
                onChange={(value) => setWorkingDraft({ ...workingDraft, username: value })}
              />
            </div>
          </section>

          <section className="profile-editor__section">
            <div className="profile-editor__section-head">
              <span className="overline">Endpoint</span>
            </div>
            <div className="form form--profile">
              <Field label="Host" value={workingDraft.host} mono onChange={(value) => setWorkingDraft({ ...workingDraft, host: value })} />
              <Field
                label="Port"
                value={portText}
                mono
                inputMode="numeric"
                onChange={(value) => {
                  const digits = value.replace(/[^0-9]/g, '').slice(0, 5);
                  setPortText(digits);
                  setWorkingDraft({ ...workingDraft, port: digits ? Number(digits) : 0 });
                }}
              />
              <label className="field">
                <span className="field__label">Version</span>
                <select
                  value={workingDraft.version || 'auto'}
                  onChange={(event) =>
                    setWorkingDraft({ ...workingDraft, version: event.target.value === 'auto' ? false : event.target.value })
                  }
                >
                  <option value="auto">Auto detect</option>
                  {workingDraft.version && !PRESET_VERSIONS.includes(workingDraft.version) ? (
                    <option value={workingDraft.version}>{workingDraft.version}</option>
                  ) : null}
                  {PRESET_VERSIONS.map((version) => (
                    <option key={version} value={version}>
                      {version}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field__label">Auth mode</span>
                <select
                  value={workingDraft.authMode}
                  onChange={(event) => setWorkingDraft({ ...workingDraft, authMode: event.target.value as DraftProfile['authMode'] })}
                >
                  <option value="microsoft">Microsoft</option>
                  <option value="offline">Offline</option>
                </select>
              </label>
            </div>
          </section>

          <section className="profile-editor__section">
            <div className="profile-editor__section-head">
              <span className="overline">Proxy</span>
            </div>
            <div className="toggles">
              <Toggle
                label="Use proxy for this bot"
                help="Bu profil bağlanırken kendi proxy socket'ini kullanır. Proxy password diske yazılmaz."
                checked={profileProxy(workingDraft).enabled}
                onChange={(value) => updateProxy({ enabled: value })}
              />
            </div>
            <div className="form form--profile form--compact" data-disabled={!profileProxy(workingDraft).enabled}>
              <label className="field">
                <span className="field__label">Proxy type</span>
                <select
                  value={profileProxy(workingDraft).type}
                  onChange={(event) => updateProxy({ type: event.target.value as ProxyConfig['type'] })}
                >
                  <option value="socks5">SOCKS5</option>
                  <option value="socks4">SOCKS4</option>
                  <option value="http">HTTP CONNECT</option>
                  <option value="https">HTTPS CONNECT</option>
                </select>
              </label>
              <Field label="Proxy host" value={profileProxy(workingDraft).host} mono onChange={(value) => updateProxy({ host: value })} />
              <Field
                label="Proxy port"
                value={String(profileProxy(workingDraft).port || '')}
                mono
                inputMode="numeric"
                onChange={(value) => updateProxy({ port: Number(value) || 0 })}
              />
              <Field label="Proxy username" value={profileProxy(workingDraft).username} onChange={(value) => updateProxy({ username: value })} />
              <Field
                label="Proxy password"
                value={profileProxy(workingDraft).password}
                type="password"
                autoComplete="current-password"
                onChange={(value) => updateProxy({ password: value })}
              />
            </div>
          </section>

          <section className="profile-editor__section">
            <div className="profile-editor__section-head">
              <span className="overline">Join flow</span>
            </div>
            <StartupFlowPanel draft={workingDraft} onChange={setWorkingDraft} />
          </section>

          <section className="profile-editor__section">
            <div className="profile-editor__section-head">
              <span className="overline">Reconnect policy</span>
            </div>
            <div className="toggles">
              <Toggle
                label="Reconnect enabled"
                help="Beklenmeyen kopmalarda bu profil için yeniden bağlanma denemelerini açar. Manuel Disconnect bunu tetiklemez."
                checked={workingDraft.reconnect.enabled}
                onChange={(value) => updateReconnect({ enabled: value })}
              />
            </div>
            <div className="form form--profile form--compact" data-disabled={!workingDraft.reconnect.enabled}>
              <Field
                label="Max attempts"
                value={String(workingDraft.reconnect.maxAttempts)}
                mono
                inputMode="numeric"
                onChange={(value) => updateReconnect({ maxAttempts: Number(value) || 0 })}
              />
              <Field
                label="Base delay"
                value={String(workingDraft.reconnect.baseDelayMs)}
                mono
                suffix="ms"
                inputMode="numeric"
                onChange={(value) => updateReconnect({ baseDelayMs: Number(value) || 0 })}
              />
              <Field
                label="Max delay"
                value={String(workingDraft.reconnect.maxDelayMs)}
                mono
                suffix="ms"
                inputMode="numeric"
                onChange={(value) => updateReconnect({ maxDelayMs: Number(value) || 0 })}
              />
            </div>
          </section>
        </div>

        <div className="modal__foot">
          <ActionWithHelp help="Pencereyi kapatır ve düzenleme taslağını kaydetmez.">
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </ActionWithHelp>
          <ActionWithHelp help="Profil ayarlarını kaydeder. Auth password sadece çalışma sırasında kullanılır, profil JSON içine yazılmaz.">
            <button className="btn btn--primary" onClick={() => onSave(workingDraft)}>
              <Save size={14} />
              Save profile
            </button>
          </ActionWithHelp>
        </div>
      </div>
    </div>
  );
}

function AccountRow({
  profile,
  session,
  selected,
  onSelect
}: {
  profile: AccountProfile;
  session?: BotSessionSnapshot;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = session?.state ?? 'idle';
  const stateLabel = STATE_LABEL[state];
  return (
    <div className="row-with-help">
      <button className={`row ${selected ? 'is-selected' : ''}`} onClick={onSelect}>
        <span className="avatar">{profile.label.slice(0, 2).toUpperCase()}</span>
        <span className="row__copy">
          <strong>{profile.label}</strong>
          <span>
            {stateLabel} · {profile.host}
          </span>
        </span>
        <span className="row__meta">
          <i className={`dot dot--${state}`} />
          <span>{session?.ping ? `${session.ping}ms` : '—'}</span>
        </span>
      </button>
      <HelpTip text="Bu satır profili seçer. Sağdaki durum noktası son bağlantı halini, ping değeri varsa gecikmeyi gösterir." />
    </div>
  );
}

function CommandBar({
  quickCommands,
  online,
  value,
  completions,
  onChange,
  onSend,
  onQuickScript,
  onComplete
}: {
  quickCommands: ScriptStep[];
  online: boolean;
  value: string;
  completions: string[];
  onChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onQuickScript: (command: string) => void | Promise<void>;
  onComplete: (partial: string) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const runnable = quickCommands.filter((step) => step.command.trim());
  const canSend = online && value.trim().length > 0;

  return (
    <section className="panel command-bar" aria-label="Command bar">
      <div className="command-bar__row">
        <span className="command-bar__icon" aria-hidden>
          <Terminal size={15} />
        </span>
        <input
          ref={inputRef}
          className="command-bar__input mono"
          value={value}
          disabled={!online}
          placeholder={online ? 'Komut yaz — Tab ile tamamla, Enter ile gönder' : 'Bot çevrimdışı'}
          aria-label="Command input"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (canSend) void onSend();
            } else if (event.key === 'Tab') {
              event.preventDefault();
              if (online && value.trim()) void onComplete(value);
            }
          }}
        />
        <ActionWithHelp help="Yazdığın önek için sunucunun tab-completion önerilerini ister (Tab tuşu da çalışır).">
          <button
            type="button"
            className="btn btn--sm"
            disabled={!online || !value.trim()}
            onClick={() => onComplete(value)}
          >
            Complete
          </button>
        </ActionWithHelp>
        <ActionWithHelp help="Komutu/mesajı seçili çevrimiçi oturuma gönderir (Enter tuşu da çalışır).">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!canSend}
            onClick={() => void onSend()}
          >
            <Send size={14} />
            Send
          </button>
        </ActionWithHelp>
        <span className="command-bar__sep" aria-hidden />
        {runnable.length > 0 ? (
          <QuickCommandMenu commands={runnable} online={online} onRun={onQuickScript} />
        ) : (
          <span className="command-bar__hint">Hızlı komut yok — Operations → Command script'ten ekle.</span>
        )}
      </div>
      {completions.length > 0 ? (
        <div className="command-bar__chips" aria-label="Tab completion suggestions">
          {completions.map((item) => (
            <button
              key={item}
              type="button"
              className="command-bar__chip mono"
              onClick={() => {
                onChange(applyCompletion(value, item));
                inputRef.current?.focus();
              }}
            >
              {item}
            </button>
          ))}
          <HelpTip text="Öneriye tıklayınca komut kutusundaki son kelimeyi tamamlar." />
        </div>
      ) : null}
    </section>
  );
}

function ChatConsole({
  session,
  showTimestamps
}: {
  session: BotSessionSnapshot | null;
  showTimestamps: boolean;
}) {
  const lines = session?.chat ?? [];
  const colCount = showTimestamps ? 3 : 2;
  return (
    <section className="panel chat">
      <div className="panel__head">
        <span className="panel__title">
          <MessageSquare size={14} />
          Chat console
        </span>
        <span className="tag">{lines.length} lines</span>
      </div>
      <div className="dtable" aria-label="Chat console">
        <table>
          <thead>
            <tr>
              {showTimestamps ? <th className="td-time">Time</th> : null}
              <th className="td-src">Src</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="empty">
                  No messages yet.
                </td>
              </tr>
            ) : (
              lines.slice(-40).map((line) => (
                <tr key={line.id}>
                  {showTimestamps ? <td className="td-time">{formatTime(line.at)}</td> : null}
                  <td className={`td-src td-src--${line.source}`}>{line.source}</td>
                  <td className="td-msg">{line.message}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PulseRail({ session }: { session: BotSessionSnapshot | null }) {
  const events = session?.events ?? [];
  return (
    <section className="panel pulse-table">
      <div className="panel__head">
        <span className="panel__title">
          <Activity size={14} />
          Pulse rail
        </span>
        <span className="tag">{events.length}</span>
      </div>
      <div className="dtable">
        <table>
          <thead>
            <tr>
              <th className="td-time">Time</th>
              <th>Event</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={3} className="empty">
                  No activity recorded.
                </td>
              </tr>
            ) : (
              events.slice(0, 40).map((event) => (
                <tr key={event.id}>
                  <td className="td-time">{formatTime(event.at)}</td>
                  <td>
                    <span className="td-event">
                      <i className={`dot dot--tone-${event.tone}`} />
                      {event.label}
                    </span>
                  </td>
                  <td className="td-detail">{event.detail ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OperationsPanel({
  draft,
  session,
  discordDraft,
  onChange,
  onSave,
  onStart,
  onStop,
  onApplyDiscord,
  onCaptureChest
}: {
  draft: DraftProfile;
  session: BotSessionSnapshot | null;
  discordDraft: DiscordRuntimeInput;
  onChange: (profile: DraftProfile) => void;
  onSave: () => void;
  onStart: (kind: OperationKind, config?: BotModulesConfig[OperationKind]) => void | Promise<void>;
  onStop: (kind: OperationKind) => void | Promise<void>;
  onApplyDiscord: (input: DiscordRuntimeInput) => void | Promise<void>;
  onCaptureChest: (profileId: string) => Promise<PositionSnapshot | null>;
}) {
  const modules = profileModules(draft);
  const storage = profileStorage(draft);
  const updateStorage = (patch: Partial<StorageConfig>) => onChange({ ...draft, storage: { ...storage, ...patch } });
  const [runtimeDiscord, setRuntimeDiscord] = useState<DiscordRuntimeInput>(discordDraft);
  // The panel is not remounted when the active account changes, so re-seed the
  // write-only runtime fields from the (per-account) parent draft on every switch.
  useEffect(() => {
    setRuntimeDiscord(discordDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);
  const updateModules = (patch: Partial<BotModulesConfig>) => onChange({ ...draft, modules: { ...modules, ...patch } });
  const updateCactus = (patch: Partial<BotModulesConfig['cactusFarm']>) =>
    updateModules({ cactusFarm: { ...modules.cactusFarm, ...patch } });
  const updateCrop = (patch: Partial<BotModulesConfig['cropFarm']>) =>
    updateModules({ cropFarm: { ...modules.cropFarm, ...patch } });
  const updateArea = (patch: Partial<BotModulesConfig['area']>) => updateModules({ area: { ...modules.area, ...patch } });
  const updateGenerator = (patch: Partial<BotModulesConfig['generator']>) =>
    updateModules({ generator: { ...modules.generator, ...patch } });
  const updateScript = (patch: Partial<BotModulesConfig['script']>) =>
    updateModules({ script: { ...modules.script, ...patch } });
  const updateDiscord = (patch: Partial<BotModulesConfig['discord']>) =>
    updateModules({ discord: { ...modules.discord, ...patch } });
  const updateAutoResponse = (patch: Partial<BotModulesConfig['autoResponse']>) =>
    updateModules({ autoResponse: { ...modules.autoResponse, ...patch } });

  return (
    <section className="panel operations">
      <div className="panel__head">
        <span className="panel__title">
          <Bot size={14} />
          Operations
        </span>
        <div className="panel__actions">
          <ActionWithHelp help="Modül ayarlarını seçili profile kaydeder. Discord webhook ve bot token runtime-only kalır.">
            <button className="btn btn--sm" onClick={onSave}>
              <Save size={14} />
              Save modules
            </button>
          </ActionWithHelp>
        </div>
      </div>
      <div className="panel__body operations__body">
        <div className="operation-strip">
          {OPERATION_KINDS.map((kind) => {
            const operation = session?.operations?.[kind];
            const total = operation?.total ?? null;
            const hasBar = total != null && total > 0;
            const progress = hasBar ? `${operation!.completed}/${total}` : null;
            const pct = hasBar ? Math.max(0, Math.min(1, operation!.completed / total)) : 0;
            const isBlocked = operation?.state === 'blocked' || operation?.state === 'error';
            return (
              <div className="operation-chip" key={kind} title={operation?.detail ?? undefined}>
                <span>{OPERATION_TITLES[kind]}</span>
                <strong className={`operation-chip__state operation-chip__state--${operation?.state ?? 'idle'}`}>
                  {operation?.state ?? 'idle'}
                  {progress ? ` ${progress}` : ''}
                </strong>
                {hasBar ? (
                  <span className="bar">
                    <span className="bar__fill bar__fill--ok" style={{ transform: `scaleX(${pct})` }} />
                  </span>
                ) : null}
                {isBlocked && operation?.detail ? (
                  <span className="operation-chip__reason">{operation.detail}</span>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="operations__grid">
          <section className="module-card module-card--wide">
            <div className="module-card__head">
              <span className="panel__title">
                <PackageOpen size={14} />
                Chest storage
                <HelpTip text="Açıkken farmlar ürünü çıktı sandığına boşaltır ve tohum/blok gibi malzemeyi ikmal sandığından çeker. Envanter dolunca durmak yerine boşaltmaya gider; sandık dolu/eksikse yere hiçbir şey dökmeden duraklar ve Discord'dan bildirir. Kaktüs kendi hopper hattını kullanır." />
              </span>
              <Toggle label="Aktif" checked={storage.enabled} onChange={(enabled) => updateStorage({ enabled })} />
            </div>
            <div className="module-card__body module-card__body--stack">
              <div className="area-coords">
                <div className="position-capture">
                  <PositionFields label="İkmal sandığı" value={storage.withdrawFrom} onChange={(withdrawFrom) => updateStorage({ withdrawFrom })} />
                  <CaptureChestButton
                    profileId={draft.id}
                    online={session?.state === 'online'}
                    onRequest={onCaptureChest}
                    onCapture={(withdrawFrom) => updateStorage({ withdrawFrom })}
                  />
                </div>
                <div className="position-capture">
                  <PositionFields label="Çıktı sandığı" value={storage.depositTo} onChange={(depositTo) => updateStorage({ depositTo })} />
                  <CaptureChestButton
                    profileId={draft.id}
                    online={session?.state === 'online'}
                    onRequest={onCaptureChest}
                    onCapture={(depositTo) => updateStorage({ depositTo })}
                  />
                </div>
              </div>
              <div className="area-controls">
                <Field
                  label="Boşalt eşiği"
                  value={String(Math.round(storage.depositAtPercentFull * 100))}
                  mono
                  suffix="%"
                  inputMode="numeric"
                  onChange={(value) => updateStorage({ depositAtPercentFull: clamp((Number(value) || 80) / 100, 0.5, 0.95, 0.8) })}
                />
                <Field
                  label="Tohum sakla"
                  value={String(storage.keepSeedStacks)}
                  mono
                  suffix="stack"
                  inputMode="numeric"
                  onChange={(value) => updateStorage({ keepSeedStacks: clamp(Math.round(Number(value)), 0, 5, 1) })}
                />
                <Field
                  label="Yeniden deneme"
                  value={String(storage.retryAttempts)}
                  mono
                  inputMode="numeric"
                  onChange={(value) => updateStorage({ retryAttempts: clamp(Math.round(Number(value)), 1, 10, 3) })}
                />
              </div>
              <p className="module-hint">İki role aynı koordinatı verirsen tek sandık gibi davranır. Bot yere hiçbir zaman item dökmez.</p>
            </div>
          </section>

          <section className="module-card">
            <div className="module-card__head">
              <span className="panel__title">
                <Hammer size={14} />
                Cactus farm
              </span>
              <OperationButtons
                kind="cactusFarm"
                session={session}
                onStart={() => onStart('cactusFarm', modules.cactusFarm)}
                onStop={() => onStop('cactusFarm')}
              />
            </div>
            <div className="module-card__body">
              <Toggle
                label="Otomatik farm kur"
                help="Su + huni hatlı ikiz sıra havuz farmı kurar: kaktüsler ortak çit hattına büyüyüp kırılır, drop'lar su ile sandığa taşınır. Bot batı kenarda durmalı; farm doğuya (+X) 10, kuzeye (+Z) sıra başına 4 blok uzar."
                checked={modules.cactusFarm.build}
                onChange={(value) => updateCactus({ build: value })}
              />
              {!modules.cactusFarm.build && (
                <Slider
                  label="Layers"
                  help="Kaktüs farm için üst üste kurulacak kat sayısıdır (yalnızca otomatik farm kapalıyken)."
                  min={1}
                  max={12}
                  value={modules.cactusFarm.layers}
                  display={`${modules.cactusFarm.layers}`}
                  onChange={(value) => updateCactus({ layers: value })}
                />
              )}
              {!modules.cactusFarm.build && (
                <Slider
                  label="Radius"
                  help="Botun bulunduğu noktanın çevresinde kullanılacak dikim yarıçapıdır."
                  min={1}
                  max={8}
                  value={modules.cactusFarm.radius}
                  display={`${modules.cactusFarm.radius}`}
                  onChange={(value) => updateCactus({ radius: value })}
                />
              )}
              {modules.cactusFarm.build && (
                <Slider
                  label="Sıra çifti"
                  help="Her sıra çifti 6 kaktüs ekler ve farmı kuzeye 4 blok uzatır (~1.5-2 kaktüs/saat/bitki)."
                  min={1}
                  max={8}
                  value={modules.cactusFarm.rowPairs}
                  display={`${modules.cactusFarm.rowPairs} (${modules.cactusFarm.rowPairs * 6} kaktüs)`}
                  onChange={(value) => updateCactus({ rowPairs: value })}
                />
              )}
              {modules.cactusFarm.build && (
                <label className="field">
                  <span className="field__label">Kırma bloğu</span>
                  <select
                    value={modules.cactusFarm.breakBlock}
                    onChange={(event) =>
                      updateCactus({ breakBlock: event.target.value as BotModulesConfig['cactusFarm']['breakBlock'] })
                    }
                  >
                    <option value="oak_fence">Çit (oak fence)</option>
                    <option value="glass_pane">Cam paneli</option>
                  </select>
                </label>
              )}
              {modules.cactusFarm.build && (
                <label className="field">
                  <span className="field__label">Duvar bloğu</span>
                  <select
                    value={modules.cactusFarm.wallBlock}
                    onChange={(event) =>
                      updateCactus({ wallBlock: event.target.value as BotModulesConfig['cactusFarm']['wallBlock'] })
                    }
                  >
                    <option value="glass">Cam</option>
                    <option value="cobblestone">Cobblestone</option>
                    <option value="smooth_stone">Smooth stone</option>
                  </select>
                </label>
              )}
              <Field
                label="Place delay"
                value={String(modules.cactusFarm.placementDelayMs)}
                mono
                suffix="ms"
                inputMode="numeric"
                onChange={(value) => updateCactus({ placementDelayMs: Number(value) || 0 })}
              />
              {modules.cactusFarm.build && (
                <Toggle
                  label="Toplama sistemi"
                  help="Huni hattı + sandık + su tabakasını da kurar (kapatılırsa yalnızca kuru havuz inşa edilir). Su için sıra çifti başına ~3 kova gerekir."
                  checked={modules.cactusFarm.buildCollection}
                  onChange={(value) => updateCactus({ buildCollection: value })}
                />
              )}
            </div>
          </section>

          <section className="module-card">
            <div className="module-card__head">
              <span className="panel__title">
                <Wheat size={14} />
                Crop farm
              </span>
              <OperationButtons
                kind="cropFarm"
                session={session}
                onStart={() => onStart('cropFarm', modules.cropFarm)}
                onStop={() => onStop('cropFarm')}
              />
            </div>
            <div className="module-card__body">
              <label className="field">
                <span className="field__label">Crop</span>
                <select
                  value={modules.cropFarm.crop}
                  onChange={(event) => updateCrop({ crop: event.target.value as BotModulesConfig['cropFarm']['crop'] })}
                >
                  <option value="wheat">Wheat</option>
                  <option value="carrot">Carrot</option>
                  <option value="potato">Potato</option>
                  <option value="beetroot">Beetroot</option>
                  <option value="nether_wart">Nether wart</option>
                  <option value="pumpkin">Pumpkin</option>
                  <option value="melon">Melon</option>
                </select>
              </label>
              <Slider
                label="Radius"
                help="Hasat taraması için bot çevresindeki yarıçap."
                min={1}
                max={12}
                value={modules.cropFarm.radius}
                display={`${modules.cropFarm.radius}`}
                onChange={(value) => updateCrop({ radius: value })}
              />
              <Field
                label="Harvest delay"
                value={String(modules.cropFarm.harvestDelayMs)}
                mono
                suffix="ms"
                inputMode="numeric"
                onChange={(value) => updateCrop({ harvestDelayMs: Number(value) || 0 })}
              />
              {modules.cropFarm.build && (
                <label className="field">
                  <span className="field__label">Su kaynağı</span>
                  <select
                    value={modules.cropFarm.waterMode}
                    onChange={(event) =>
                      updateCrop({ waterMode: event.target.value as BotModulesConfig['cropFarm']['waterMode'] })
                    }
                  >
                    <option value="auto">Otomatik (kova ile)</option>
                    <option value="existing">Mevcut suyu kullan</option>
                  </select>
                </label>
              )}
              <div className="toggles toggles--inline">
                <Toggle
                  label="Tarlayı kur"
                  help="Hasattan önce toprağı çapalar, merkeze su koyar ve tohumları diker. Yalnızca buğday/havuç/patates/pancar için çalışır."
                  checked={modules.cropFarm.build}
                  onChange={(value) => updateCrop({ build: value })}
                />
                <Toggle
                  label="Otomatik çapala"
                  help="İnşa sırasında mevcut toprağı/çimi otomatik olarak tarlaya (farmland) çevirir."
                  checked={modules.cropFarm.autoTill}
                  onChange={(value) => updateCrop({ autoTill: value })}
                />
                <Toggle
                  label="Replant"
                  help="Hasattan sonra uygun tohum/ürün varsa aynı bloğa yeniden dikmeyi dener."
                  checked={modules.cropFarm.replant}
                  onChange={(value) => updateCrop({ replant: value })}
                />
                <Toggle
                  label="Collect stats"
                  help="Hasat edilen ürünleri canlı istatistik olarak sayar."
                  checked={modules.cropFarm.collectDrops}
                  onChange={(value) => updateCrop({ collectDrops: value })}
                />
              </div>
            </div>
          </section>

          <section className="module-card module-card--wide">
            <div className="module-card__head">
              <span className="panel__title">
                <Boxes size={14} />
                Area operation
                <HelpTip text="Sınırlı bir 3B bölgeyi bir kez baştan sona kazar (boşaltır) ya da blokla doldurur; işlem %100'e ulaşınca biter. Sürekli farm için Generator'ı kullan." />
              </span>
              <OperationButtons
                kind="area"
                session={session}
                onStart={() => onStart('area', modules.area)}
                onStop={() => onStop('area')}
              />
            </div>
            <div className="module-card__body module-card__body--stack">
              <div className="area-controls">
                <label className="field">
                  <span className="field__label">Mode</span>
                  <select value={modules.area.mode} onChange={(event) => updateArea({ mode: event.target.value as 'mine' | 'fill' })}>
                    <option value="mine">Mine (kaz)</option>
                    <option value="fill">Fill (doldur)</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">
                    Koordinat
                    <HelpTip text="Göreli: From/To, botun anlık konumuna eklenir (bot nereye giderse bölge oraya taşınır). Mutlak: dünya koordinatlarını doğrudan kullanır." />
                  </span>
                  <select
                    value={modules.area.coords}
                    onChange={(event) => updateArea({ coords: event.target.value as BotModulesConfig['area']['coords'] })}
                  >
                    <option value="relative">Göreli (bota göre)</option>
                    <option value="absolute">Mutlak (dünya)</option>
                  </select>
                </label>
                <Field
                  label="Fill block"
                  value={modules.area.fillBlock}
                  mono
                  onChange={(value) => updateArea({ fillBlock: value })}
                />
                <Field
                  label="Delay"
                  value={String(modules.area.actionDelayMs)}
                  mono
                  suffix="ms"
                  inputMode="numeric"
                  onChange={(value) => updateArea({ actionDelayMs: Number(value) || 0 })}
                />
              </div>
              <div className="area-coords">
                <div className="position-capture">
                  <PositionFields label="From" value={modules.area.from} onChange={(from) => updateArea({ from })} />
                  {modules.area.coords === 'absolute' ? (
                    <CapturePositionButton position={session?.position ?? null} onCapture={(from) => updateArea({ from })} />
                  ) : null}
                </div>
                <div className="position-capture">
                  <PositionFields label="To" value={modules.area.to} onChange={(to) => updateArea({ to })} />
                  {modules.area.coords === 'absolute' ? (
                    <CapturePositionButton position={session?.position ?? null} onCapture={(to) => updateArea({ to })} />
                  ) : null}
                </div>
              </div>
              <div className="toggles toggles--inline">
                <Toggle
                  label="Hollow (kabuk)"
                  help="Açıkken sadece kutunun dış yüzeylerine dokunur — içi boş oda, sığınak veya duvar yapmak için. Kapalıyken tüm bloklar dolu/kazılır."
                  checked={modules.area.hollow}
                  onChange={(value) => updateArea({ hollow: value })}
                />
                <Toggle
                  label="Yürü / pathfind"
                  help="Açıkken bot erişemediği her bloğa yürür (büyük alanlar için). Kapalıyken yalnızca durduğu yerden erişebildiği blokları işler."
                  checked={modules.area.walk}
                  onChange={(value) => updateArea({ walk: value })}
                />
              </div>
              <AreaPreview from={modules.area.from} to={modules.area.to} mode={modules.area.mode} hollow={modules.area.hollow} />
            </div>
          </section>

          <section className="module-card">
            <div className="module-card__head">
              <span className="panel__title">
                <Pickaxe size={14} />
                Generator
                <HelpTip text="Sabit dur, bir veya birkaç yeniden-oluşan bloğu (taş/cobblestone üreteci) sonsuz döngüde kır → yeniden oluşmasını bekle → tekrar kır. Bir kez biten kazı/dolgu işi için Area'yı kullan." />
              </span>
              <OperationButtons
                kind="generator"
                session={session}
                onStart={() => onStart('generator', modules.generator)}
                onStop={() => onStop('generator')}
              />
            </div>
            <div className="module-card__body module-card__body--stack">
              <GeneratorSlotEditor slots={modules.generator.slots} onChange={(slots) => updateGenerator({ slots })} />
              <div className="generator-controls">
                <Field
                  label="Blok filtresi"
                  value={modules.generator.blockFilter}
                  mono
                  onChange={(value) => updateGenerator({ blockFilter: value })}
                />
                <Field
                  label="Vuruş aralığı"
                  value={String(modules.generator.actionDelayMs)}
                  mono
                  suffix="ms"
                  inputMode="numeric"
                  onChange={(value) => updateGenerator({ actionDelayMs: Number(value) || 0 })}
                />
                <Field
                  label="Regen beklemesi"
                  value={String(modules.generator.regenDelayMs)}
                  mono
                  suffix="ms"
                  inputMode="numeric"
                  onChange={(value) => updateGenerator({ regenDelayMs: Number(value) || 0 })}
                />
              </div>
              <Toggle
                label="Yürü / pathfind"
                help="Genelde kapalı tut: AFK üreteci farmında bot tek yerde durur. Slotlar erişim dışındaysa açarsan bot her slota yürür."
                checked={modules.generator.walk}
                onChange={(value) => updateGenerator({ walk: value })}
              />
              <p className="module-hint">
                Boş blok filtresi = orada ne katı blok varsa kırar. <code className="mono">cobblestone</code> gibi bir ad
                yazarsan yalnızca o blok oluştuğunda kırar, yeniden oluşurken bekler.
              </p>
            </div>
          </section>

          <section className="module-card module-card--wide">
            <div className="module-card__head">
              <span className="panel__title">
                <Terminal size={14} />
                Command script
              </span>
              <div className="module-card__actions">
                <OperationButtons
                  kind="script"
                  session={session}
                  onStart={() => onStart('script', modules.script)}
                  onStop={() => onStop('script')}
                />
              </div>
            </div>
            <div className="module-card__body module-card__body--stack">
              <Toggle
                label="Loop script"
                help="Açıkken script adımları son komuttan sonra başa döner."
                checked={modules.script.loop}
                onChange={(value) => updateScript({ loop: value })}
              />
              <div className="field">
                <span className="field__label">Script steps</span>
                <ScriptStepList
                  steps={modules.script.steps}
                  prefix="step"
                  onChange={(steps) => updateScript({ steps })}
                  commandPlaceholder="/spawn"
                  emptyHint="No script steps yet — they run top to bottom when the script starts."
                />
              </div>
              <div className="field">
                <span className="field__label">Quick commands</span>
                <ScriptStepList
                  steps={modules.script.quickCommands}
                  prefix="quick"
                  onChange={(quickCommands) => updateScript({ quickCommands })}
                  commandPlaceholder="/home"
                  addLabel="Add quick command"
                  showDelay={false}
                  emptyHint="No quick commands yet — each becomes a one-tap button in the command bar."
                />
                <p className="field__hint">Bu komutlar üstteki komut çubuğunda tek-tık buton olarak görünür.</p>
              </div>
            </div>
          </section>

          <section className="module-card module-card--wide">
            <div className="module-card__head">
              <span className="panel__title">
                <MessageSquare size={14} />
                Auto-response
              </span>
              <div className="module-card__actions">
                <Toggle
                  label="Enabled"
                  help="Sunucudan gelen mesajlarda eşleşme yakalarsa seçili bot otomatik yanıt veya komut gönderir."
                  checked={modules.autoResponse.enabled}
                  onChange={(value) => updateAutoResponse({ enabled: value })}
                />
              </div>
            </div>
            <div className="module-card__body module-card__body--stack">
              <AutoResponseList
                rules={modules.autoResponse.rules}
                onChange={(rules) => updateAutoResponse({ rules })}
              />
            </div>
          </section>

          <section className="module-card module-card--wide">
            <div className="module-card__head">
              <span className="panel__title">
                <Globe2 size={14} />
                Discord bridge
              </span>
              <div className="module-card__actions">
                <Toggle
                  label="Enabled"
                  help="Webhook ve bot token bu runtime oturumunda kullanılır; profile JSON içine yazılmaz."
                  checked={modules.discord.enabled}
                  onChange={(value) => updateDiscord({ enabled: value })}
                />
                <OperationButtons
                  kind="discord"
                  session={session}
                  onStart={() => onApplyDiscord({ ...runtimeDiscord, enabled: true, channelId: runtimeDiscord.channelId || modules.discord.channelId })}
                  onStop={() => onApplyDiscord({ ...runtimeDiscord, enabled: false })}
                />
              </div>
            </div>
            <div className="module-card__body module-card__body--stack">
              <div className="form form--discord">
                <Field
                  label="Webhook URL"
                  value={runtimeDiscord.webhookUrl ?? ''}
                  type="password"
                  onChange={(value) => setRuntimeDiscord({ ...runtimeDiscord, webhookUrl: value })}
                />
                <Field
                  label="Bot token"
                  value={runtimeDiscord.botToken ?? ''}
                  type="password"
                  onChange={(value) => setRuntimeDiscord({ ...runtimeDiscord, botToken: value })}
                />
                <Field
                  label="Channel ID"
                  value={runtimeDiscord.channelId ?? modules.discord.channelId}
                  mono
                  onChange={(value) => {
                    setRuntimeDiscord({ ...runtimeDiscord, channelId: value });
                    updateDiscord({ channelId: value });
                  }}
                />
                <Field
                  label="Command prefix"
                  value={modules.discord.commandPrefix}
                  mono
                  onChange={(value) => updateDiscord({ commandPrefix: value })}
                />
              </div>
              <div className="toggles toggles--inline">
                <Toggle
                  label="Notify chat"
                  help="Sunucudan gelen chat satırlarını Discord webhook kanalına yollar."
                  checked={modules.discord.notifyChat}
                  onChange={(value) => updateDiscord({ notifyChat: value })}
                />
                <Toggle
                  label="Remote commands"
                  help="Bot token ve channel ID varsa Discord kanalından prefix ile gelen komutları oyuna yollar."
                  checked={modules.discord.pollCommands}
                  onChange={(value) => updateDiscord({ pollCommands: value })}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function OperationButtons({
  kind,
  session,
  onStart,
  onStop
}: {
  kind: OperationKind;
  session: BotSessionSnapshot | null;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
}) {
  const state = session?.operations?.[kind]?.state ?? 'idle';
  const running = state === 'running';
  const title = OPERATION_TITLES[kind];
  return (
    <div className="operation-buttons">
      <ActionWithHelp help={`${title} modülünü seçili çevrimiçi bot üzerinde başlatır.`}>
        <button className="btn btn--sm btn--primary" disabled={running} aria-label={`Start ${title}`} onClick={() => void onStart()}>
          <Play size={13} />
          Start
        </button>
      </ActionWithHelp>
      <ActionWithHelp help={`${title} modülünü durdurur ve varsa bekleyen iş kuyruğunu temizler.`}>
        <button className="btn btn--sm" disabled={!running} aria-label={`Stop ${title}`} onClick={() => void onStop()}>
          <Square size={13} />
          Stop
        </button>
      </ActionWithHelp>
    </div>
  );
}

type SlotRegion = 'container' | 'main' | 'hotbar' | 'armor';
type MenuActionDef = { key: string; label: string; Icon: typeof Trash2; request: InventoryActionRequest; danger?: boolean };
type OpenMenuState = { slot: number; region: SlotRegion; left: number; top: number };

const ARMOR_SLOTS: { slot: number; dest: EquipDestination; label: string }[] = [
  { slot: 5, dest: 'head', label: 'Baş' },
  { slot: 6, dest: 'torso', label: 'Göğüs' },
  { slot: 7, dest: 'legs', label: 'Bacak' },
  { slot: 8, dest: 'feet', label: 'Ayak' }
];

function rangeInclusive(start: number, end: number): number[] {
  const out: number[] = [];
  for (let value = start; value <= end; value += 1) out.push(value);
  return out;
}

function slotMenuActions(args: {
  slot: number;
  region: SlotRegion;
  item: InventoryItemSnapshot | null;
  windowKind: 'inventory' | 'container';
  hotbarStart: number;
  selectedHotbar: number | null;
}): MenuActionDef[] {
  const { slot, region, item, windowKind, hotbarStart, selectedHotbar } = args;
  const out: MenuActionDef[] = [];
  const dropActions: MenuActionDef[] = item
    ? [
        { key: 'dropOne', label: '1 tane at', Icon: Trash2, request: { action: 'dropOne', slot } },
        { key: 'dropStack', label: 'Yığını at', Icon: Trash2, request: { action: 'dropStack', slot }, danger: true }
      ]
    : [];

  if (region === 'hotbar') {
    const hotbar = slot - hotbarStart;
    if (selectedHotbar !== hotbar) {
      out.push({ key: 'select', label: `Slot ${hotbar + 1} seç`, Icon: Crosshair, request: { action: 'selectHotbar', hotbar } });
    }
  }

  if (region === 'armor') {
    const dest = ARMOR_SLOTS.find((entry) => entry.slot === slot)?.dest;
    if (item && dest) out.push({ key: 'unequip', label: 'Çıkar', Icon: Hand, request: { action: 'unequip', destination: dest } });
    return [...out, ...dropActions];
  }

  if (!item) return out;

  if (region === 'container') {
    out.push({ key: 'transfer', label: 'Envantere aktar', Icon: ArrowRightLeft, request: { action: 'transfer', slot } });
    return out;
  }

  if (windowKind === 'container') {
    out.push({ key: 'transfer', label: 'Sandığa aktar', Icon: ArrowRightLeft, request: { action: 'transfer', slot } });
    return [...out, ...dropActions];
  }

  // Player inventory (no container open): full action set.
  const isHeld = region === 'hotbar' && selectedHotbar === slot - hotbarStart;
  if (isHeld) out.push({ key: 'use', label: 'Kullan', Icon: Hammer, request: { action: 'useHeld' } });
  if (item.equipDestination && item.equipDestination !== 'hand') {
    out.push({ key: 'equip', label: 'Kuşan', Icon: Shirt, request: { action: 'equip', slot, destination: item.equipDestination } });
  }
  if (!isHeld) out.push({ key: 'hold', label: 'Ele al', Icon: Hand, request: { action: 'equip', slot, destination: 'hand' } });
  if (item.edible) out.push({ key: 'eat', label: 'Ye / İç', Icon: Apple, request: { action: 'consume', slot } });
  return [...out, ...dropActions];
}

function InventoryPanel({
  session,
  online,
  onAction
}: {
  session: BotSessionSnapshot | null;
  online: boolean;
  onAction: (request: InventoryActionRequest) => void | Promise<void>;
}) {
  const inventory = session?.inventory ?? null;
  const layout = inventory?.window;
  const container = layout?.kind === 'container';
  const interactive = online && session?.state === 'online' && Boolean(inventory);

  const slotMap = useMemo(() => {
    const map = new Map<number, InventoryItemSnapshot>();
    for (const item of inventory?.slots ?? []) map.set(item.slot, item);
    return map;
  }, [inventory?.slots]);
  const armorMap = useMemo(() => {
    const map = new Map<number, InventoryItemSnapshot>();
    for (const item of inventory?.armor ?? []) map.set(item.slot, item);
    return map;
  }, [inventory?.armor]);

  const [menu, setMenu] = useState<OpenMenuState | null>(null);
  const [dragSlot, setDragSlot] = useState<number | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!interactive) setMenu(null);
  }, [interactive]);

  useEffect(() => {
    if (!menu) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    const onScroll = () => setMenu(null);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      // Must pass the same reference used in addEventListener, otherwise the listener
      // leaks and accumulates every time the slot menu opens.
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menu]);

  const inventoryStart = layout?.inventoryStart ?? 9;
  const hotbarStart = layout?.hotbarStart ?? 36;
  const totalSlots = layout?.totalSlots ?? 46;
  const selectedHotbar = inventory?.selectedHotbar ?? null;

  const containerSlots = container ? rangeInclusive(0, inventoryStart - 1) : [];
  const mainSlots = rangeInclusive(inventoryStart, hotbarStart - 1);
  const hotbarSlots = rangeInclusive(hotbarStart, Math.min(hotbarStart + 8, totalSlots - 1));

  const openMenu = (slot: number, region: SlotRegion, element: HTMLElement) => {
    if (!interactive) return;
    const actions = slotMenuActions({ slot, region, item: regionItem(region, slot), windowKind: container ? 'container' : 'inventory', hotbarStart, selectedHotbar });
    if (actions.length === 0) return;
    const rect = element.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 188));
    // Flip above the slot when there isn't room below (estimate ~38px per item + chrome).
    const estimatedHeight = actions.length * 38 + 12;
    const top =
      rect.bottom + 4 + estimatedHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - estimatedHeight - 4)
        : rect.bottom + 4;
    setMenu({ slot, region, left, top });
  };

  function regionItem(region: SlotRegion, slot: number): InventoryItemSnapshot | null {
    return (region === 'armor' ? armorMap : slotMap).get(slot) ?? null;
  }

  const act = (request: InventoryActionRequest) => {
    setMenu(null);
    void onAction(request);
  };

  const finishDrop = (to: number) => {
    const from = dragSlot;
    setDropSlot(null);
    setDragSlot(null);
    if (from == null || from === to) return;
    void onAction({ action: 'move', from, to });
  };

  const renderCell = (slot: number, region: SlotRegion) => {
    const item = regionItem(region, slot);
    const isActive = region === 'hotbar' && selectedHotbar === slot - hotbarStart;
    const canInteract = interactive && (region !== 'armor' || !container);
    return (
      <SlotCell
        key={`${region}-${slot}`}
        item={item}
        interactive={canInteract}
        active={isActive}
        dragging={dragSlot === slot}
        dropTarget={dropSlot === slot}
        hasMenu={canInteract && (Boolean(item) || region === 'hotbar')}
        onActivate={(element) => openMenu(slot, region, element)}
        onDragStart={() => setDragSlot(slot)}
        onDragEnd={() => {
          setDragSlot(null);
          setDropSlot(null);
        }}
        onDragEnter={() => setDropSlot(slot)}
        onDrop={() => finishDrop(slot)}
      />
    );
  };

  const usedTag = session?.inventoryUsed == null ? 'offline' : `${session.inventoryUsed}/${session.inventorySize ?? 46}`;
  const menuActions = menu
    ? slotMenuActions({ slot: menu.slot, region: menu.region, item: regionItem(menu.region, menu.slot), windowKind: container ? 'container' : 'inventory', hotbarStart, selectedHotbar })
    : [];

  return (
    <section className={`panel inventory-panel ${interactive ? '' : 'inventory-panel--readonly'}`}>
      <div className="panel__head">
        <span className="panel__title">
          <PackageOpen size={14} />
          Live inventory
        </span>
        <span className="tag">{usedTag}</span>
      </div>
      <div className="panel__body inventory-panel__body">
        <div className="held-item held-item--actionable">
          <div className="held-item__info">
            <span className="overline">Elde</span>
            <strong className="held-item__name">
              {inventory?.heldItem ? (() => {
                const icon = itemIconUri(inventory.heldItem.name);
                return icon ? <img className="held-item__icon" src={icon} alt="" draggable={false} /> : null;
              })() : null}
              {inventory?.heldItem?.displayName ?? 'Boş el'}
            </strong>
          </div>
          {interactive && inventory?.heldItem ? (
            <ActionWithHelp help="Eldeki item'ı kullan (yerleştir / fırlat / aktive et).">
              <button type="button" className="btn btn--sm" onClick={() => act({ action: 'useHeld' })}>
                <Hammer size={13} />
                Kullan
              </button>
            </ActionWithHelp>
          ) : null}
        </div>

        {container ? (
          <div className="inventory-container">
            <span className="overline">{inventory?.openWindowTitle || 'Açık pencere'}</span>
            <div className="inventory-grid" aria-label="Container slots">
              {containerSlots.map((slot) => renderCell(slot, 'container'))}
            </div>
          </div>
        ) : (
          <div className="inventory-armor">
            <span className="overline">Zırh</span>
            <div className="inventory-grid inventory-grid--armor" aria-label="Armor slots">
              {ARMOR_SLOTS.map((entry) => renderCell(entry.slot, 'armor'))}
            </div>
          </div>
        )}

        {container ? null : (
          <InventorySection title="Crafting" items={inventory?.crafting ?? []} emptyLabel="Crafting grid boş" />
        )}

        <div className="inventory-backpack">
          <span className="overline">{container ? 'Envanter' : 'Çanta'}</span>
          <div className="inventory-grid" aria-label="Inventory slots">
            {mainSlots.map((slot) => renderCell(slot, 'main'))}
          </div>
        </div>

        <div className="inventory-hotbar">
          <span className="overline">Hotbar</span>
          <div className="inventory-grid inventory-grid--hotbar" aria-label="Hotbar slots">
            {hotbarSlots.map((slot) => renderCell(slot, 'hotbar'))}
          </div>
        </div>

        {!interactive ? <p className="inventory-hint">Bot çevrimdışı — etkileşim için bağlan.</p> : null}
      </div>

      {menu && menuActions.length > 0 && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="slot-menu"
              role="menu"
              aria-label="Slot işlemleri"
              style={{ left: `${menu.left}px`, top: `${menu.top}px` }}
            >
              {menuActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  role="menuitem"
                  className={`slot-menu__item ${action.danger ? 'slot-menu__item--danger' : ''}`}
                  onClick={() => act(action.request)}
                >
                  <action.Icon size={13} aria-hidden="true" />
                  {action.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </section>
  );
}

/**
 * Item artwork for an inventory slot: the bundled 16×16 Minecraft texture when we have
 * one, otherwise the short text label as a fallback (modded/unknown ids, missing art).
 */
function ItemIcon({ item }: { item: InventoryItemSnapshot }) {
  const icon = itemIconUri(item.name);
  if (icon) {
    return <img className="slot__icon" src={icon} alt="" draggable={false} />;
  }
  return <span className="slot__label">{shortItemName(item.displayName)}</span>;
}

function SlotCell({
  item,
  interactive,
  active,
  dragging,
  dropTarget,
  hasMenu,
  onActivate,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop
}: {
  item: InventoryItemSnapshot | null;
  interactive: boolean;
  active: boolean;
  dragging: boolean;
  dropTarget: boolean;
  hasMenu: boolean;
  onActivate: (element: HTMLElement) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDrop: () => void;
}) {
  const className = [
    'slot',
    interactive ? 'slot--interactive' : '',
    active ? 'slot--active' : '',
    dragging ? 'slot--dragging' : '',
    dropTarget ? 'slot--drop-target' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const title = item ? `${item.displayName} ×${item.count}` : 'Boş';
  const dragProps = interactive
    ? {
        draggable: Boolean(item),
        onDragStart: (event: ReactDragEvent<HTMLDivElement>) => {
          if (!item) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = 'move';
          onDragStart();
        },
        onDragEnd,
        onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => {
          event.preventDefault();
          onDragEnter();
        },
        onDragOver: (event: ReactDragEvent<HTMLDivElement>) => event.preventDefault(),
        onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
          event.preventDefault();
          onDrop();
        }
      }
    : {};
  return (
    <div
      className={className}
      title={title}
      role={hasMenu ? 'button' : undefined}
      tabIndex={hasMenu ? 0 : undefined}
      aria-pressed={active || undefined}
      onClick={hasMenu ? (event) => onActivate(event.currentTarget) : undefined}
      onKeyDown={
        hasMenu
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onActivate(event.currentTarget);
              }
            }
          : undefined
      }
      {...dragProps}
    >
      {item ? (
        <>
          <ItemIcon item={item} />
          <strong>{item.count}</strong>
        </>
      ) : null}
    </div>
  );
}

function InventorySection({ title, items, emptyLabel }: { title: string; items: InventoryItemSnapshot[]; emptyLabel: string }) {
  return (
    <div className="inventory-section">
      <span className="overline">{title}</span>
      <div className="inventory-section__items">
        {items.length === 0 ? <span className="inventory-empty">{emptyLabel}</span> : null}
        {items.map((item) => {
          const icon = itemIconUri(item.name);
          return (
            <span className="tag tag--item" key={`${item.slot}-${item.name}`}>
              {icon ? <img className="tag__icon" src={icon} alt="" draggable={false} /> : null}
              {item.displayName} x{item.count}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function PositionFields({
  label,
  value,
  onChange
}: {
  label: string;
  value: BotModulesConfig['area']['from'];
  onChange: (value: BotModulesConfig['area']['from']) => void;
}) {
  const update = (axis: 'x' | 'y' | 'z', nextValue: string) => onChange({ ...value, [axis]: Number(nextValue) || 0 });
  return (
    <fieldset className="position-fields">
      <legend>{label}</legend>
      <input className="mono" value={String(value.x)} inputMode="numeric" aria-label={`${label} X`} onChange={(event) => update('x', event.target.value)} />
      <input className="mono" value={String(value.y)} inputMode="numeric" aria-label={`${label} Y`} onChange={(event) => update('y', event.target.value)} />
      <input className="mono" value={String(value.z)} inputMode="numeric" aria-label={`${label} Z`} onChange={(event) => update('z', event.target.value)} />
    </fieldset>
  );
}

const AREA_VOLUME_LIMIT = 4096;
const MAX_GENERATOR_SLOTS = 16;

function areaBlockCount(from: PositionSnapshot, to: PositionSnapshot, hollow: boolean): number {
  const dx = Math.abs(Math.round(to.x) - Math.round(from.x)) + 1;
  const dy = Math.abs(Math.round(to.y) - Math.round(from.y)) + 1;
  const dz = Math.abs(Math.round(to.z) - Math.round(from.z)) + 1;
  const solid = dx * dy * dz;
  if (!hollow) return solid;
  const inner = Math.max(0, dx - 2) * Math.max(0, dy - 2) * Math.max(0, dz - 2);
  return solid - inner;
}

function CapturePositionButton({
  position,
  onCapture
}: {
  position: PositionSnapshot | null;
  onCapture: (position: PositionSnapshot) => void;
}) {
  const disabled = !position;
  return (
    <ActionWithHelp help="Botun şu anki dünya konumunu bu köşeye yazar. Bot çevrimiçi olmalı.">
      <button
        type="button"
        className="btn btn--xs"
        disabled={disabled}
        onClick={() => {
          if (!position) return;
          onCapture({ x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) });
        }}
      >
        <Crosshair size={12} />
        Konumum
      </button>
    </ActionWithHelp>
  );
}

function CaptureChestButton({
  profileId,
  online,
  onRequest,
  onCapture
}: {
  profileId: string;
  online: boolean;
  onRequest: (profileId: string) => Promise<PositionSnapshot | null>;
  onCapture: (position: PositionSnapshot) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <ActionWithHelp help="Botun baktığı sandığı (yoksa yakınındaki sandığı) yakalayıp bu role yazar. Bot çevrimiçi olmalı.">
      <button
        type="button"
        className="btn btn--xs"
        disabled={!online || busy}
        onClick={async () => {
          setBusy(true);
          try {
            const captured = await onRequest(profileId);
            if (captured) onCapture({ x: Math.round(captured.x), y: Math.round(captured.y), z: Math.round(captured.z) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <Crosshair size={12} />
        {busy ? '…' : 'Sandığı yakala'}
      </button>
    </ActionWithHelp>
  );
}

function AreaPreview({
  from,
  to,
  mode,
  hollow
}: {
  from: PositionSnapshot;
  to: PositionSnapshot;
  mode: 'mine' | 'fill';
  hollow: boolean;
}) {
  const count = areaBlockCount(from, to, hollow);
  const over = count > AREA_VOLUME_LIMIT;
  return (
    <div className={`area-preview ${over ? 'area-preview--over' : ''}`}>
      <span className="area-preview__verb">{mode === 'fill' ? 'Doldurulacak' : 'Kazılacak'}</span>
      <strong className="area-preview__count">≈ {count.toLocaleString('tr-TR')} blok</strong>
      <span className="area-preview__limit">{over ? `üst sınır ${AREA_VOLUME_LIMIT} aşıldı` : `üst sınır ${AREA_VOLUME_LIMIT.toLocaleString('tr-TR')}`}</span>
    </div>
  );
}

function GeneratorSlotEditor({
  slots,
  onChange
}: {
  slots: GeneratorSlot[];
  onChange: (slots: GeneratorSlot[]) => void;
}) {
  const update = (id: string, axis: 'x' | 'y' | 'z', value: string) =>
    onChange(slots.map((slot) => (slot.id === id ? { ...slot, [axis]: Number(value) || 0 } : slot)));
  const remove = (id: string) => onChange(slots.filter((slot) => slot.id !== id));
  const add = () => {
    if (slots.length >= MAX_GENERATOR_SLOTS) return;
    onChange([...slots, { id: makeStepId('gen'), x: 0, y: 0, z: -1 }]);
  };
  return (
    <div className="slot-editor">
      <div className="slot-editor__head">
        <span className="field__label">Üreteç blokları</span>
        <HelpTip text="Döngüde kırılacak blokların bota göre konumu (X/Y/Z offset). Klasik dörtlü taş üreteci için botun dört yanı; tek üreteç için tek satır yeterli." />
        <span className="tag">{slots.length}/{MAX_GENERATOR_SLOTS}</span>
      </div>
      {slots.length === 0 ? (
        <p className="slot-editor__empty">Slot yok — kırılacak en az bir blok ekle.</p>
      ) : (
        <div className="slot-list">
          <div className="slot-row slot-row--head" aria-hidden>
            <span className="slot-row__index">#</span>
            <span>X</span>
            <span>Y</span>
            <span>Z</span>
            <span />
          </div>
          {slots.map((slot, index) => (
            <div className="slot-row" key={slot.id}>
              <span className="slot-row__index">{index + 1}</span>
              <input
                className="mono"
                inputMode="numeric"
                aria-label={`Slot ${index + 1} X`}
                value={String(slot.x)}
                onChange={(event) => update(slot.id, 'x', event.target.value)}
              />
              <input
                className="mono"
                inputMode="numeric"
                aria-label={`Slot ${index + 1} Y`}
                value={String(slot.y)}
                onChange={(event) => update(slot.id, 'y', event.target.value)}
              />
              <input
                className="mono"
                inputMode="numeric"
                aria-label={`Slot ${index + 1} Z`}
                value={String(slot.z)}
                onChange={(event) => update(slot.id, 'z', event.target.value)}
              />
              <div className="slot-row__actions">
                <button
                  type="button"
                  className="icon-btn icon-btn--sm icon-btn--danger"
                  aria-label={`Slot ${index + 1} sil`}
                  onClick={() => remove(slot.id)}
                >
                  <Trash2 size={14} />
                </button>
                <HelpTip text="Bu üreteç bloğunu listeden kaldırır. Her satır, döngüde kırılan ayrı bir bloğu temsil eder." />
              </div>
            </div>
          ))}
        </div>
      )}
      <ActionWithHelp help="Kırılacak yeni bir üreteç bloğu ekler (varsayılan: botun bir blok kuzeyi). En fazla 16 slot.">
        <button type="button" className="btn btn--sm" disabled={slots.length >= MAX_GENERATOR_SLOTS} onClick={add}>
          <Plus size={13} />
          Blok ekle
        </button>
      </ActionWithHelp>
    </div>
  );
}

function RoutinePanel({
  draft,
  onChange,
  onSave
}: {
  draft: DraftProfile;
  onChange: (profile: DraftProfile) => void;
  onSave: () => void;
}) {
  const routine = draft.routine;
  const updateRoutine = (patch: Partial<DraftProfile['routine']>) =>
    onChange({ ...draft, routine: { ...routine, ...patch } });
  const updateReconnect = (patch: Partial<DraftProfile['reconnect']>) =>
    onChange({ ...draft, reconnect: { ...draft.reconnect, ...patch } });

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">AFK routine</span>
        <ActionWithHelp help="AFK routine ve reconnect ayarlarını seçili profile kaydeder.">
          <button className="btn btn--sm" onClick={onSave}>
            <Save size={14} />
            Save
          </button>
        </ActionWithHelp>
      </div>
      <div className="panel__body routine__body">
        <div className="routine__col routine__col--main">
          <div className="toggles">
          <Toggle
            label="Random look"
            help="Rutin çalıştığında kamerayı küçük rastgele açılarla çevirir. Hareket komutu değildir, sadece bakış yönünü değiştirir."
            checked={routine.randomLook}
            onChange={(value) => updateRoutine({ randomLook: value })}
          />
          <Toggle
            label="Auto-jump"
            help="Rutin seçtiğinde jump tuşuna kısa bir pulse gönderir. Sürekli zıplamaz; sadece seçilen rutin adımında çalışır."
            checked={routine.autoJump}
            onChange={(value) => updateRoutine({ autoJump: value })}
          />
          <Toggle
            label="Sneak"
            help="Rutin seçtiğinde sneak durumunu kısa süre açıp kapatır. Diğer hareket kontrolleriyle birlikte rastgele sırada çalışabilir."
            checked={routine.sneakPulse}
            onChange={(value) => updateRoutine({ sneakPulse: value })}
          />
          <Toggle
            label="Swing"
            help="Rutin seçtiğinde sağ kol swing komutu gönderir. Blok kırma veya hedef seçme davranışı eklemez."
            checked={routine.swingArm}
            onChange={(value) => updateRoutine({ swingArm: value })}
          />
          <Toggle
            label="Chat messages"
            help="Açıkken listedeki Türkçe mesajlardan birini gönderir. Birden fazla mesaj varsa aynı mesajı art arda tekrarlamamaya çalışır."
            checked={routine.chatHeartbeat}
            onChange={(value) => updateRoutine({ chatHeartbeat: value })}
          />
          <Toggle
            label="Auto-respawn"
            help="Oturum ölürse respawn isteği gönderir. Sunucu izin verirse karakter tekrar doğar ve rutin devam edebilir."
            checked={routine.autoRespawn}
            onChange={(value) => updateRoutine({ autoRespawn: value })}
          />
          <Toggle
            label="Auto-eat"
            help="Hunger belirlediğin eşik altına inerse güvenli yiyecek seçip yemeye çalışır. Zararlı yiyecekleri bilerek atlar."
            checked={routine.autoEat}
            onChange={(value) => updateRoutine({ autoEat: value })}
          />
          <Toggle
            label="Reconnect"
            help="Beklenmeyen kopmalarda bu hesap için yeniden bağlanma denemelerini açar. Manuel kapatma reconnect başlatmaz."
            checked={draft.reconnect.enabled}
            onChange={(value) => updateReconnect({ enabled: value })}
          />
          <Toggle
            label="Enabled"
            help="Bu profilin Start all ile başlatılıp başlatılmayacağını belirler. Tekli Connect düğmesi yine seçili profili kullanır."
            checked={draft.enabled}
            onChange={(value) => onChange({ ...draft, enabled: value })}
          />
          </div>
          <div className="routine__sliders">
          <Slider
            label="Base interval"
            help="AFK routine için temel bekleme süresidir. Her rutin adımı bu sürenin etrafında planlanır."
            min={3000}
            max={90000}
            step={1000}
            value={routine.intervalMs}
            display={`${Math.round(routine.intervalMs / 1000)}s`}
            onChange={(value) => updateRoutine({ intervalMs: value })}
          />
          <Slider
            label="Interval jitter"
            help="Base interval üzerine rastgele sapma ekler. Yüzde büyüdükçe rutin adımları daha değişken aralıklarla çalışır."
            min={0}
            max={80}
            value={routine.jitterPercent}
            display={`${routine.jitterPercent}%`}
            onChange={(value) => updateRoutine({ jitterPercent: value })}
          />
          <Slider
            label="Eat below"
            help="Hunger bu değere eşit veya altına inerse auto-eat güvenli yiyecek arar ve yemeye çalışır."
            min={1}
            max={19}
            value={routine.eatAtFood}
            display={`${routine.eatAtFood}/20`}
            onChange={(value) => updateRoutine({ eatAtFood: value, pauseAtFood: Math.min(routine.pauseAtFood, value) })}
          />
          <Slider
            label="Pause below"
            help="Hunger bu değere kadar düşer ve güvenli yiyecek yoksa AFK hareketleri duraklar. Hunger toparlanınca rutin devam eder."
            min={0}
            max={routine.eatAtFood}
            value={routine.pauseAtFood}
            display={`${routine.pauseAtFood}/20`}
            onChange={(value) => updateRoutine({ pauseAtFood: value })}
          />
        </div>
        </div>

        <div className="routine__col routine__col--chat">
        <label className="field routine__chat">
          <span className="field__label">Chat messages</span>
          <textarea
            value={routine.chatMessages.join('\n')}
            onChange={(event) =>
              updateRoutine({
                chatMessages: event.target.value
                  .split('\n')
                  .map((messageLine) => messageLine.trim())
                  .filter(Boolean)
              })
            }
            rows={3}
            placeholder="Her satıra bir mesaj"
          />
        </label>
        </div>
      </div>
    </section>
  );
}

function SettingsModal({
  settings,
  runtime,
  showTrayToggle,
  onChange,
  onOpenData,
  onClose
}: {
  settings: AppSettings;
  runtime: LauncherState['runtime'];
  showTrayToggle: boolean;
  onChange: (patch: Partial<AppSettings>) => void;
  onOpenData: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reconnect = settings.defaultReconnect;
  const setReconnect = (patch: Partial<AppSettings['defaultReconnect']>) =>
    onChange({ defaultReconnect: { ...reconnect, ...patch } });

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <span className="panel__title">
            <Settings size={14} />
            Settings
          </span>
          <ActionWithHelp help="Ayar penceresini kapatır. Değişiklikler zaten anlık olarak uygulanır.">
            <button className="icon-btn" title="Close" onClick={onClose}>
              <X size={16} />
            </button>
          </ActionWithHelp>
        </div>

        <div className="modal__body">
          <section className="settings-group">
            <span className="overline">Startup</span>
            <div className="toggles">
              <Toggle
                label="Auto-start enabled accounts on launch"
                help="Uygulama açıldığında Enabled olan profilleri otomatik başlatır. Hesaplar connect stagger süresine göre sırayla bağlanır."
                checked={settings.autoStartOnLaunch}
                onChange={(value) => onChange({ autoStartOnLaunch: value })}
              />
            </div>
            <div className="form form--inline">
              <Field
                label="Connect stagger"
                value={String(settings.connectStaggerMs)}
                mono
                suffix="ms"
                inputMode="numeric"
                onChange={(value) => onChange({ connectStaggerMs: Number(value) || 0 })}
              />
            </div>
          </section>

          <section className="settings-group">
            <span className="overline">Interface</span>
            <div className="toggles">
              <Toggle
                label="Confirm before Stop all"
                help="Stop all basıldığında tüm oturumları kapatmadan önce onay sorar. Yanlışlıkla toplu kapatmayı önler."
                checked={settings.confirmStopAll}
                onChange={(value) => onChange({ confirmStopAll: value })}
              />
              <Toggle
                label="Show chat timestamps"
                help="Chat console içinde mesajların saat sütununu gösterir veya gizler. Mesaj içeriğini değiştirmez."
                checked={settings.showChatTimestamps}
                onChange={(value) => onChange({ showChatTimestamps: value })}
              />
              <Toggle
                label="Compact density"
                help="Panel boşluklarını sıkılaştırır. Küçük ekranlarda daha fazla satır görmeyi kolaylaştırır."
                checked={settings.compactDensity}
                onChange={(value) => onChange({ compactDensity: value })}
              />
            </div>
          </section>

          {showTrayToggle ? (
            <section className="settings-group">
              <span className="overline">Window</span>
              <div className="toggles">
                <Toggle
                  label="Minimize to tray on close"
                  help="Kapatma (X) düğmesine basıldığında uygulamayı kapatmak yerine sistem tepsisine küçültür; oturumlar arka planda çalışmaya devam eder. Tepsi simgesine tıklayarak geri açabilirsin. Kapalıyken X uygulamayı tamamen kapatır."
                  checked={settings.minimizeToTrayOnClose}
                  onChange={(value) => onChange({ minimizeToTrayOnClose: value })}
                />
              </div>
            </section>
          ) : null}

          <section className="settings-group">
            <span className="overline">New account reconnect defaults</span>
            <div className="toggles">
              <Toggle
                label="Reconnect enabled"
                help="Yeni oluşturulan hesaplarda reconnect varsayılanını açık yapar. Mevcut profillerin kendi ayarını değiştirmez."
                checked={reconnect.enabled}
                onChange={(value) => setReconnect({ enabled: value })}
              />
            </div>
            <div className="form form--inline" data-disabled={!reconnect.enabled}>
              <Field
                label="Max attempts"
                value={String(reconnect.maxAttempts)}
                mono
                inputMode="numeric"
                onChange={(value) => setReconnect({ maxAttempts: Number(value) || 0 })}
              />
              <Field
                label="Base delay"
                value={String(reconnect.baseDelayMs)}
                mono
                suffix="ms"
                inputMode="numeric"
                onChange={(value) => setReconnect({ baseDelayMs: Number(value) || 0 })}
              />
              <Field
                label="Max delay"
                value={String(reconnect.maxDelayMs)}
                mono
                suffix="ms"
                inputMode="numeric"
                onChange={(value) => setReconnect({ maxDelayMs: Number(value) || 0 })}
              />
            </div>
          </section>

          <section className="settings-group">
            <span className="overline">About</span>
            <dl className="kv">
              <Kv k="App version" v={runtime.appVersion} />
              <Kv k="Launcher" v={APP_NAME} />
              <Kv k="Developed by" v="smojka" />
              {runtime.webDashboardUrl ? <Kv k="Web dashboard" v={runtime.webDashboardUrl} tone="ok" /> : null}
              <Kv k="System" v={runtime.systemState} tone={runtime.systemState === 'online' ? 'ok' : undefined} />
              <Kv k="Bots online" v={`${runtime.onlineCount}/${runtime.botCount}`} />
            </dl>
          </section>
        </div>

        <div className="modal__foot">
          <ActionWithHelp help="Tüm global settings değerlerini varsayılana döndürür. Profil içindeki hesap ayarlarını silmez.">
            <button className="btn" onClick={() => onChange(structuredClone(DEFAULT_SETTINGS))}>
              <RotateCcw size={14} />
              Reset defaults
            </button>
          </ActionWithHelp>
          <span className="modal__foot-spacer" />
          <ActionWithHelp help="Profil JSON ve Microsoft auth session gibi yerel app dosyalarının bulunduğu klasörü açar.">
            <button className="btn" onClick={onOpenData}>
              <FolderOpen size={14} />
              Open data folder
            </button>
          </ActionWithHelp>
          <ActionWithHelp help="Settings penceresini kapatır. Değişiklikler kapatmadan önce zaten kaydedilmiş olur.">
            <button className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          </ActionWithHelp>
        </div>
      </div>
    </div>
  );
}

function ConnectionPanel({ session, stateLabel }: { session: BotSessionSnapshot | null; stateLabel: string }) {
  const uptime = session?.connectedAt ? formatUptime(session.connectedAt) : '—';
  const lastError = session?.lastError ?? null;
  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">
          <Wifi size={14} />
          Connection
        </span>
        <span className={`tag ${session?.routineActive ? 'tag--ok' : ''}`}>{stateLabel}</span>
      </div>
      <div className="panel__body">
        <dl className="kv">
          <Kv k="Status" v={session?.statusMessage ?? 'Ready'} />
          <Kv k="Uptime" v={uptime} />
          <Kv k="Ping" v={session?.ping ? `${session.ping} ms` : '—'} />
          <Kv k="Routine" v={session?.routineActive ? 'active' : 'idle'} tone={session?.routineActive ? 'ok' : undefined} />
          <Kv k="Reconnects" v={String(session?.reconnectAttempts ?? 0)} />
          <Kv k="Last error" v={lastError ?? 'None'} tone={lastError ? 'danger' : undefined} />
        </dl>
      </div>
    </section>
  );
}

function Kv({ k, v, tone }: { k: string; v: string; tone?: 'ok' | 'danger' }) {
  return (
    <div className="kv__row">
      <dt className="kv__k">{k}</dt>
      <dd className={`kv__v ${tone ? `kv__v--${tone}` : ''}`}>{v}</dd>
    </div>
  );
}

function StartupFlowPanel({ draft, onChange }: { draft: DraftProfile; onChange: (profile: DraftProfile) => void }) {
  const startup = draft.startup;
  const updateStartup = (patch: Partial<DraftProfile['startup']>) =>
    onChange({ ...draft, startup: { ...startup, ...patch } });

  return (
    <form className="joinflow" onSubmit={(event) => event.preventDefault()}>
      <div className="joinflow__head">
        <Toggle
          label="Join flow"
          help="Sunucu önce lobby'ye alıyorsa açılır. Bağlantıdan sonra auth/register, transfer ve opsiyonel flow komutları sırayla gönderilir."
          checked={startup.enabled}
          onChange={(value) => updateStartup({ enabled: value })}
        />
        <span className="joinflow__hint">Lobby auth → SMP transfer → flow commands</span>
      </div>
      <div className="joinflow__grid" data-disabled={!startup.enabled}>
        <label className="field">
          <span className="field__label">Lobby auth</span>
          <select
            value={startup.authMode}
            onChange={(event) => updateStartup({ authMode: event.target.value as DraftProfile['startup']['authMode'] })}
          >
            <option value="login">Login</option>
            <option value="register">Register</option>
            <option value="custom">Custom command</option>
            <option value="none">No auth command</option>
          </select>
        </label>
        <Field
          label={startup.authMode === 'custom' ? 'Custom auth command' : 'Login command'}
          value={startup.authCommandTemplate}
          mono
          onChange={(value) => updateStartup({ authCommandTemplate: value })}
        />
        <Field
          label="Register command"
          value={startup.registerCommandTemplate}
          mono
          onChange={(value) => updateStartup({ registerCommandTemplate: value })}
        />
        <Field
          label="Auth password"
          value={startup.authPassword}
          type="password"
          autoComplete="current-password"
          onChange={(value) => updateStartup({ authPassword: value })}
        />
        <Field
          label="Transfer command"
          value={startup.transferCommand}
          mono
          onChange={(value) => updateStartup({ transferCommand: value })}
        />
        <Field
          label="Auth delay"
          value={String(startup.authDelayMs)}
          mono
          suffix="ms"
          inputMode="numeric"
          onChange={(value) => updateStartup({ authDelayMs: Number(value) || 0 })}
        />
        <Field
          label="Transfer delay"
          value={String(startup.transferDelayMs)}
          mono
          suffix="ms"
          inputMode="numeric"
          onChange={(value) => updateStartup({ transferDelayMs: Number(value) || 0 })}
        />
        <div className="field field--wide">
          <span className="field__label">Flow commands</span>
          <ScriptStepList
            steps={startup.flowCommands ?? []}
            prefix="flow"
            onChange={(steps) => updateStartup({ flowCommands: steps })}
            commandPlaceholder="/home base"
            emptyHint="No flow commands yet — they run in order after the SMP transfer."
          />
        </div>
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  type = 'text',
  inputMode,
  autoComplete,
  mono,
  suffix,
  onChange
}: {
  label: string;
  value: string;
  type?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  autoComplete?: string;
  mono?: boolean;
  suffix?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {suffix ? <em className="field__suffix">{suffix}</em> : null}
      </span>
      <input
        className={mono ? 'mono' : undefined}
        value={value}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ScriptStepList({
  steps,
  prefix,
  onChange,
  commandPlaceholder,
  addLabel = 'Add command',
  showDelay = true,
  emptyHint
}: {
  steps: ScriptStep[];
  prefix: string;
  onChange: (steps: ScriptStep[]) => void;
  commandPlaceholder?: string;
  addLabel?: string;
  showDelay?: boolean;
  emptyHint?: string;
}) {
  const updateStep = (index: number, patch: Partial<ScriptStep>) =>
    onChange(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const removeStep = (index: number) => onChange(steps.filter((_, i) => i !== index));
  const moveStep = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= steps.length) return;
    const next = steps.slice();
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const addStep = () =>
    onChange([...steps, { id: makeStepId(prefix), label: '', command: '', delayMs: 0 }]);

  return (
    <div className={`step-list ${showDelay ? '' : 'step-list--no-delay'}`}>
      {steps.length > 0 ? (
        <div className="step-list__head" aria-hidden>
          <span>Label</span>
          <span>Command</span>
          {showDelay ? <span>Delay</span> : null}
          <span />
        </div>
      ) : null}
      {steps.map((step, index) => (
        <div className="step-list__row" key={step.id}>
          <input
            value={step.label}
            placeholder={`${prefix} ${index + 1}`}
            aria-label={`Step ${index + 1} label`}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => updateStep(index, { label: event.target.value })}
          />
          <input
            className="mono"
            value={step.command}
            placeholder={commandPlaceholder ?? '/command'}
            aria-label={`Step ${index + 1} command`}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => updateStep(index, { command: event.target.value })}
          />
          {showDelay ? (
            <span className="step-list__delay">
              <input
                className="mono"
                value={String(step.delayMs)}
                inputMode="numeric"
                aria-label={`Step ${index + 1} delay in milliseconds`}
                onChange={(event) => updateStep(index, { delayMs: Number(event.target.value) || 0 })}
              />
              <em>ms</em>
            </span>
          ) : null}
          <div className="step-list__actions">
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={`Move step ${index + 1} up`}
              disabled={index === 0}
              onClick={() => moveStep(index, -1)}
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={`Move step ${index + 1} down`}
              disabled={index === steps.length - 1}
              onClick={() => moveStep(index, 1)}
            >
              <ChevronDown size={14} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm icon-btn--danger"
              aria-label={`Remove step ${index + 1}`}
              onClick={() => removeStep(index)}
            >
              <Trash2 size={14} />
            </button>
            <HelpTip text="Komutu sırada yukarı/aşağı taşı veya listeden kaldır. Komutlar yukarıdan aşağıya sırayla çalışır." />
          </div>
        </div>
      ))}
      {steps.length === 0 && emptyHint ? <p className="step-list__empty">{emptyHint}</p> : null}
      <ActionWithHelp help="Listeye yeni bir komut satırı ekler. Label boş bırakılırsa otomatik adlandırılır; boş satırlar kaydederken atılır.">
        <button type="button" className="btn btn--sm step-list__add" onClick={addStep}>
          <Plus size={13} />
          {addLabel}
        </button>
      </ActionWithHelp>
    </div>
  );
}

function AutoResponseList({
  rules,
  onChange
}: {
  rules: AutoResponseRule[];
  onChange: (rules: AutoResponseRule[]) => void;
}) {
  const updateRule = (index: number, patch: Partial<AutoResponseRule>) =>
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  const removeRule = (index: number) => onChange(rules.filter((_, i) => i !== index));
  const moveRule = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= rules.length) return;
    const next = rules.slice();
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const addRule = () =>
    onChange([
      ...rules,
      { id: makeStepId('auto-response'), enabled: true, label: '', match: '', response: '', cooldownMs: 5000 }
    ]);

  return (
    <div className="rule-list">
      {rules.length > 0 ? (
        <div className="rule-list__head" aria-hidden>
          <span>On</span>
          <span>Label</span>
          <span>Match (contains)</span>
          <span>Reply / command</span>
          <span>Cooldown</span>
          <span />
        </div>
      ) : null}
      {rules.map((rule, index) => (
        <div className={`rule-list__row ${rule.enabled ? '' : 'is-off'}`} key={rule.id}>
          <label className="rule-list__enable">
            <input
              type="checkbox"
              checked={rule.enabled}
              aria-label={`Rule ${index + 1} enabled`}
              onChange={(event) => updateRule(index, { enabled: event.target.checked })}
            />
            <span className="rule-list__check" aria-hidden>
              <Check size={12} />
            </span>
          </label>
          <input
            value={rule.label}
            placeholder={`Rule ${index + 1}`}
            aria-label={`Rule ${index + 1} label`}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => updateRule(index, { label: event.target.value })}
          />
          <input
            className="mono"
            value={rule.match}
            placeholder="tpa"
            aria-label={`Rule ${index + 1} match text`}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => updateRule(index, { match: event.target.value })}
          />
          <input
            className="mono"
            value={rule.response}
            placeholder="/tpaccept"
            aria-label={`Rule ${index + 1} reply or command`}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => updateRule(index, { response: event.target.value })}
          />
          <span className="rule-list__cooldown">
            <input
              className="mono"
              value={String(rule.cooldownMs)}
              inputMode="numeric"
              aria-label={`Rule ${index + 1} cooldown in milliseconds`}
              onChange={(event) => updateRule(index, { cooldownMs: Number(event.target.value) || 0 })}
            />
            <em>ms</em>
          </span>
          <div className="rule-list__actions">
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={`Move rule ${index + 1} up`}
              disabled={index === 0}
              onClick={() => moveRule(index, -1)}
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={`Move rule ${index + 1} down`}
              disabled={index === rules.length - 1}
              onClick={() => moveRule(index, 1)}
            >
              <ChevronDown size={14} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm icon-btn--danger"
              aria-label={`Remove rule ${index + 1}`}
              onClick={() => removeRule(index)}
            >
              <Trash2 size={14} />
            </button>
            <HelpTip text="Kuralı yukarı/aşağı taşı veya sil. Soldaki kutu kuralı açıp kapatır." />
          </div>
        </div>
      ))}
      {rules.length === 0 ? (
        <p className="step-list__empty">
          Henüz kural yok — eşleşen sunucu mesajına otomatik yanıt/komut vermek için bir satır ekle.
        </p>
      ) : null}
      <ActionWithHelp help="Yeni bir otomatik yanıt kuralı ekler. Eşleşme metni gelen mesajda (büyük/küçük harf duyarsız) geçerse yanıt/komut gönderilir; bekleme süresi tekrarları sınırlar.">
        <button type="button" className="btn btn--sm rule-list__add" onClick={addRule}>
          <Plus size={13} />
          Add rule
        </button>
      </ActionWithHelp>
    </div>
  );
}

function makeStepId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`;
}

// Replaces the last whitespace-delimited token in the input with the chosen completion.
function applyCompletion(input: string, match: string): string {
  return /\S$/.test(input) ? input.replace(/\S*$/, match) : `${input}${match}`;
}

function Toggle({
  label,
  help,
  checked,
  onChange
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="toggle-wrap">
      <label className={`toggle ${checked ? 'is-on' : ''}`}>
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="toggle__track" aria-hidden />
        <span className="toggle__label">{label}</span>
      </label>
      {help ? <HelpTip text={help} /> : null}
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  display,
  help,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  display: string;
  help?: string;
  onChange: (value: number) => void;
}) {
  const inputId = useId();

  return (
    <div className="slider">
      <span className="slider__top">
        <span className="slider__label-wrap">
          <label className="field__label" htmlFor={inputId}>
            {label}
          </label>
          {help ? <HelpTip text={help} /> : null}
        </span>
        <strong>{display}</strong>
      </span>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  unit,
  max,
  tone = 'info'
}: {
  label: string;
  value: string | number;
  unit?: string;
  max?: number;
  tone?: 'ok' | 'warn' | 'info';
}) {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  const pct = Number.isFinite(numeric) && max ? Math.max(0, Math.min(100, (numeric / max) * 100)) : 0;
  return (
    <div className="kpi">
      <div className="kpi__top">
        <span className="kpi__label">{label}</span>
      </div>
      <strong className="kpi__value">
        {value}
        {unit ? <small> {unit}</small> : null}
      </strong>
      {max ? (
        <span className="bar">
          <span className={`bar__fill bar__fill--${tone}`} style={{ transform: `scaleX(${pct / 100})` }} />
        </span>
      ) : null}
    </div>
  );
}

function Coord({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="coords__cell">
      <span className="coords__k">{k}</span>
      <span className="coords__v">{v}</span>
    </div>
  );
}

function StatusPill({ state, label }: { state: BotSessionSnapshot['state']; label: string }) {
  return (
    <span className={`pill pill--${state}`}>
      <i className={`dot dot--${state}`} />
      {label}
    </span>
  );
}

function StatusItem({
  icon,
  label,
  value,
  tone = 'info'
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'danger' | 'muted' | 'info';
}) {
  return (
    <div className={`statusbar__item statusbar__item--${tone}`}>
      {icon}
      <span className="statusbar__label">{label}</span>
      <strong className="statusbar__value">{value}</strong>
    </div>
  );
}

function compactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return url;
  }
}

function createNewAccountDraft(template: DraftProfile, settings: AppSettings, accountNumber: number): DraftProfile {
  const eatAtFood = clamp(template.routine.eatAtFood, 1, 19, 14);
  const pauseAtFood = Math.min(eatAtFood, clamp(template.routine.pauseAtFood, 0, 19, 6));
  return {
    ...template,
    id: '',
    label: `SESSION_${String(accountNumber).padStart(2, '0')}`,
    username: '',
    enabled: true,
    startup: {
      ...template.startup,
      flowCommands: (template.startup.flowCommands ?? []).map((step) => ({ ...step })),
      authPassword: ''
    },
    routine: {
      ...template.routine,
      autoEat: template.routine.autoEat ?? true,
      eatAtFood,
      pauseAtFood
    },
    reconnect: { ...settings.defaultReconnect },
    proxy: { ...DEFAULT_PROXY_UI },
    modules: profileModules(template)
  };
}

function normalizeDraft(draft: DraftProfile): SaveProfileInput {
  const eatAtFood = clamp(Number(draft.routine.eatAtFood), 1, 19, 14);
  const pauseAtFood = Math.min(eatAtFood, clamp(Number(draft.routine.pauseAtFood), 0, 19, 6));
  return {
    ...draft,
    label: draft.label.trim(),
    username: draft.username.trim(),
    host: draft.host.trim(),
    port: Number(draft.port) || 25565,
    version: draft.version || false,
    startup: {
      ...draft.startup,
      authMode: draft.startup.authMode,
      authCommandTemplate: draft.startup.authCommandTemplate.trim(),
      registerCommandTemplate: draft.startup.registerCommandTemplate.trim(),
      authPassword: draft.startup.authPassword,
      authDelayMs: Math.max(0, Number(draft.startup.authDelayMs) || 0),
      transferCommand: draft.startup.transferCommand.trim(),
      transferDelayMs: Math.max(0, Number(draft.startup.transferDelayMs) || 0),
      flowCommands: normalizeDraftScriptSteps(draft.startup.flowCommands ?? [], 'flow')
    },
    routine: {
      ...draft.routine,
      autoEat: draft.routine.autoEat ?? true,
      eatAtFood,
      pauseAtFood,
      intervalMs: Math.max(3000, Number(draft.routine.intervalMs) || 18000),
      jitterPercent: Math.max(0, Math.min(80, Number(draft.routine.jitterPercent) || 0)),
      chatMessages: draft.routine.chatMessages.map((message) => message.trim()).filter(Boolean)
    },
    proxy: {
      ...profileProxy(draft),
      host: profileProxy(draft).host.trim(),
      username: profileProxy(draft).username.trim(),
      port: Number(profileProxy(draft).port) || 0
    },
    modules: normalizeDraftModules(profileModules(draft))
  };
}

// Save-time cleanup: trim labels/commands and drop blank script rows. The editor
// keeps blank rows live so they can be typed into; they're only discarded on save.
function normalizeDraftModules(modules: BotModulesConfig): BotModulesConfig {
  return {
    ...modules,
    script: {
      ...modules.script,
      steps: normalizeDraftScriptSteps(modules.script.steps, 'step'),
      quickCommands: normalizeDraftScriptSteps(modules.script.quickCommands, 'quick')
    }
  };
}

function profileStorage(profile: DraftProfile): StorageConfig {
  return {
    ...DEFAULT_STORAGE_UI,
    ...profile.storage,
    withdrawFrom: { ...DEFAULT_STORAGE_UI.withdrawFrom, ...profile.storage?.withdrawFrom },
    depositTo: { ...DEFAULT_STORAGE_UI.depositTo, ...profile.storage?.depositTo }
  };
}

function profileModules(profile: DraftProfile): BotModulesConfig {
  const modules = profile.modules;
  return {
    cactusFarm: { ...DEFAULT_MODULES_UI.cactusFarm, ...modules?.cactusFarm },
    cropFarm: { ...DEFAULT_MODULES_UI.cropFarm, ...modules?.cropFarm },
    area: {
      ...DEFAULT_MODULES_UI.area,
      ...modules?.area,
      from: { ...DEFAULT_MODULES_UI.area.from, ...modules?.area?.from },
      to: { ...DEFAULT_MODULES_UI.area.to, ...modules?.area?.to }
    },
    generator: {
      ...DEFAULT_MODULES_UI.generator,
      ...modules?.generator,
      slots: modules?.generator?.slots?.length
        ? modules.generator.slots.map((slot) => ({ ...slot }))
        : DEFAULT_MODULES_UI.generator.slots.map((slot) => ({ ...slot }))
    },
    script: {
      ...DEFAULT_MODULES_UI.script,
      ...modules?.script,
      // Keep rows exactly as the user is editing them — including not-yet-filled
      // blank rows the "Add command" button creates. Stripping empty commands is a
      // save-time concern (normalizeDraft), not a display-time one; doing it here
      // made the add button look broken because new blank rows vanished on re-render.
      steps: Array.isArray(modules?.script?.steps)
        ? modules!.script.steps.map((step) => ({ ...step }))
        : DEFAULT_MODULES_UI.script.steps.map((step) => ({ ...step })),
      quickCommands: Array.isArray(modules?.script?.quickCommands)
        ? modules!.script.quickCommands.map((step) => ({ ...step }))
        : DEFAULT_MODULES_UI.script.quickCommands.map((step) => ({ ...step }))
    },
    discord: { ...DEFAULT_MODULES_UI.discord, ...modules?.discord },
    autoResponse: {
      ...DEFAULT_MODULES_UI.autoResponse,
      ...modules?.autoResponse,
      rules: modules?.autoResponse?.rules?.length
        ? modules.autoResponse.rules.map((rule) => ({ ...rule }))
        : DEFAULT_MODULES_UI.autoResponse.rules.map((rule) => ({ ...rule }))
    }
  };
}

function profileProxy(profile: DraftProfile): ProxyConfig {
  return { ...DEFAULT_PROXY_UI, ...profile.proxy };
}

function normalizeDraftScriptSteps(steps: ScriptStep[], prefix: string): ScriptStep[] {
  return steps
    .map((step, index) => ({
      id: step.id.trim() || `${prefix}-${index + 1}`,
      label: step.label.trim() || `${prefix} ${index + 1}`,
      command: step.command.trim(),
      delayMs: Math.max(0, Number(step.delayMs) || 0)
    }))
    .filter((step) => step.command);
}

function shortItemName(value: string): string {
  const words = value.replaceAll('_', ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return value;
  if (words.length === 1) return words[0].slice(0, 6);
  return words.map((word) => word[0]?.toUpperCase() ?? '').join('').slice(0, 4);
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function formatDimension(value: string | null | undefined): string {
  if (!value) return '—';
  const id = value.replace(/^minecraft:/, '');
  const known: Record<string, string> = {
    overworld: 'Overworld',
    the_nether: 'The Nether',
    nether: 'The Nether',
    the_end: 'The End',
    end: 'The End'
  };
  if (known[id]) return known[id];
  const words = id.replace(/[._-]+/g, ' ').trim();
  return words ? words.replace(/\b\w/g, (char) => char.toUpperCase()) : value;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function formatUptime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
