import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  Boxes,
  Bot,
  Check,
  ChevronUp,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  FolderOpen,
  Gauge,
  Globe2,
  Hammer,
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
  Square,
  Trash2,
  Wheat,
  Wifi,
  X
} from 'lucide-react';
import { getLauncherApi } from './api';
import { DEFAULT_SETTINGS } from '../shared/types';
import type {
  AccountProfile,
  AppSettings,
  AutoResponseRule,
  BotModulesConfig,
  BotSessionSnapshot,
  DiscordRuntimeInput,
  InventoryItemSnapshot,
  LauncherApi,
  LauncherState,
  OperationKind,
  ProxyConfig,
  SaveProfileInput,
  ScriptStep
} from '../shared/types';

type DraftProfile = AccountProfile;

const APP_NAME = 'ChunkKeeper';
const APP_TAGLINE = 'Minecraft AFK command desk';
const DEVELOPER_CREDIT = 'Developed by smojka';

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

const DEFAULT_MODULES_UI: BotModulesConfig = {
  cactusFarm: { enabled: false, layers: 1, radius: 2, placementDelayMs: 550, build: true, breakBlock: 'oak_fence', buildCollection: true },
  cropFarm: { enabled: false, crop: 'wheat', radius: 4, harvestDelayMs: 750, replant: true, collectDrops: true, build: true, autoTill: true, waterMode: 'auto' },
  area: {
    enabled: false,
    mode: 'mine',
    from: { x: -2, y: 0, z: -2 },
    to: { x: 2, y: 2, z: 2 },
    fillBlock: 'cobblestone',
    actionDelayMs: 450
  },
  generator: { enabled: false, mode: 'forward', direction: 'north', depth: 4, actionDelayMs: 350 },
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
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

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

  const selectedProfile = useMemo(() => {
    if (!state) return null;
    return state.profiles.find((profile) => profile.id === state.selectedProfileId) ?? state.profiles[0] ?? null;
  }, [state]);

  const selectedSession = state && draft?.id ? state.sessions[draft.id] ?? null : null;

  useEffect(() => {
    if (selectedProfile) {
      setDraft(structuredClone(selectedProfile));
    }
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
    await run(() => apiClient!.sendChat(profileId, message));
  }

  async function startOperation(kind: OperationKind, config?: BotModulesConfig[OperationKind]) {
    if (!draft?.id) return;
    await run(() => apiClient!.startOperation(draft.id, { kind, config }));
  }

  async function stopOperation(kind: OperationKind) {
    if (!draft?.id) return;
    await run(() => apiClient!.stopOperation(draft.id, kind));
  }

  async function runQuickScript(command: string) {
    if (!draft?.id) return;
    await run(() => apiClient!.runQuickScript(draft.id, command));
  }

  async function completeChat(partial: string) {
    if (!draft?.id) return;
    const completions = await apiClient!.completeChat(draft.id, partial);
    setChatCompletions(completions);
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
              <Coord k="Dim" v={selectedSession?.dimension ?? '—'} />
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
              chatCompletions={chatCompletions}
              onChange={setDraft}
              onSave={() => saveProfileDraft(draft)}
              onStart={startOperation}
              onStop={stopOperation}
              onQuickScript={runQuickScript}
              onCompleteChat={completeChat}
              onApplyDiscord={applyDiscordRuntime}
            />
          </section>

          <section
            className="tabpane"
            role="tabpanel"
            id="tabpanel-inventory"
            aria-labelledby="tab-inventory"
            hidden={activeTab !== 'inventory'}
          >
            <InventoryPanel session={selectedSession} />
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
                value={chatMessage}
                onChange={setChatMessage}
                onSend={sendChat}
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
      <ActionWithHelp help="Pencereyi kapatır. Çalışan oturum davranışı işletim sistemi ve uygulama ayarlarına göre devam eder.">
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

  useEffect(() => {
    setWorkingDraft(structuredClone(draft));
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
                value={String(workingDraft.port)}
                mono
                inputMode="numeric"
                onChange={(value) => setWorkingDraft({ ...workingDraft, port: Number(value) || 25565 })}
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
                  <option value="1.21.1">1.21.1</option>
                  <option value="1.20.6">1.20.6</option>
                  <option value="1.20.1">1.20.1</option>
                  <option value="1.19.4">1.19.4</option>
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

function ChatConsole({
  session,
  value,
  onChange,
  onSend,
  showTimestamps
}: {
  session: BotSessionSnapshot | null;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
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
      <div className="chat__input">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void onSend();
          }}
          placeholder="Send a message or command…"
        />
        <ActionWithHelp help="Yazdığın mesajı seçili çevrimiçi oturuma chat veya komut olarak gönderir. Enter tuşu da aynı işlemi yapar.">
          <button className="btn btn--primary" onClick={onSend}>
            <Send size={14} />
            Send
          </button>
        </ActionWithHelp>
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
  chatCompletions,
  onChange,
  onSave,
  onStart,
  onStop,
  onQuickScript,
  onCompleteChat,
  onApplyDiscord
}: {
  draft: DraftProfile;
  session: BotSessionSnapshot | null;
  discordDraft: DiscordRuntimeInput;
  chatCompletions: string[];
  onChange: (profile: DraftProfile) => void;
  onSave: () => void;
  onStart: (kind: OperationKind, config?: BotModulesConfig[OperationKind]) => void | Promise<void>;
  onStop: (kind: OperationKind) => void | Promise<void>;
  onQuickScript: (command: string) => void | Promise<void>;
  onCompleteChat: (partial: string) => void | Promise<void>;
  onApplyDiscord: (input: DiscordRuntimeInput) => void | Promise<void>;
}) {
  const modules = profileModules(draft);
  const [scriptPartial, setScriptPartial] = useState('/s');
  const [runtimeDiscord, setRuntimeDiscord] = useState<DiscordRuntimeInput>(discordDraft);
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
            const progress =
              operation && operation.total ? `${operation.completed}/${operation.total}` : null;
            return (
              <div className="operation-chip" key={kind} title={operation?.detail ?? undefined}>
                <span>{OPERATION_TITLES[kind]}</span>
                <strong className={`operation-chip__state operation-chip__state--${operation?.state ?? 'idle'}`}>
                  {operation?.state ?? 'idle'}
                  {progress ? ` ${progress}` : ''}
                </strong>
              </div>
            );
          })}
        </div>

        <div className="operations__grid">
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
                help="Sadece kaktüs dikmek yerine kıran blok + toplama hattı içeren tam otomatik farm kurar. Bot her bloğa yürüyerek inşa eder."
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
              <Slider
                label="Radius"
                help="Botun bulunduğu noktanın çevresinde kullanılacak farm yarıçapıdır."
                min={1}
                max={8}
                value={modules.cactusFarm.radius}
                display={`${modules.cactusFarm.radius}`}
                onChange={(value) => updateCactus({ radius: value })}
              />
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
                  label="Toplama hattı"
                  help="Düşen kaktüsleri toplamak için kırma bloğunun altına hopper hattı yerleştirir."
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
                <Pickaxe size={14} />
                Area operation
              </span>
              <OperationButtons
                kind="area"
                session={session}
                onStart={() => onStart('area', modules.area)}
                onStop={() => onStop('area')}
              />
            </div>
            <div className="module-card__body module-card__body--coords">
              <label className="field">
                <span className="field__label">Mode</span>
                <select value={modules.area.mode} onChange={(event) => updateArea({ mode: event.target.value as 'mine' | 'fill' })}>
                  <option value="mine">Mine</option>
                  <option value="fill">Fill</option>
                </select>
              </label>
              <PositionFields
                label="From"
                value={modules.area.from}
                onChange={(from) => updateArea({ from })}
              />
              <PositionFields label="To" value={modules.area.to} onChange={(to) => updateArea({ to })} />
              <Field label="Fill block" value={modules.area.fillBlock} mono onChange={(value) => updateArea({ fillBlock: value })} />
              <Field
                label="Delay"
                value={String(modules.area.actionDelayMs)}
                mono
                suffix="ms"
                inputMode="numeric"
                onChange={(value) => updateArea({ actionDelayMs: Number(value) || 0 })}
              />
            </div>
          </section>

          <section className="module-card">
            <div className="module-card__head">
              <span className="panel__title">
                <Pickaxe size={14} />
                Generator
              </span>
              <OperationButtons
                kind="generator"
                session={session}
                onStart={() => onStart('generator', modules.generator)}
                onStop={() => onStop('generator')}
              />
            </div>
            <div className="module-card__body">
              <label className="field">
                <span className="field__label">Mode</span>
                <select
                  value={modules.generator.mode}
                  onChange={(event) => updateGenerator({ mode: event.target.value as BotModulesConfig['generator']['mode'] })}
                >
                  <option value="forward">Forward</option>
                  <option value="four_way">4-way</option>
                </select>
              </label>
              <label className="field">
                <span className="field__label">Direction</span>
                <select
                  value={modules.generator.direction}
                  onChange={(event) => updateGenerator({ direction: event.target.value as BotModulesConfig['generator']['direction'] })}
                >
                  <option value="north">North</option>
                  <option value="south">South</option>
                  <option value="east">East</option>
                  <option value="west">West</option>
                </select>
              </label>
              <Slider
                label="Depth"
                help="Tek yönlü veya 4 yönlü kazıda her yönde hedeflenen blok sayısı."
                min={1}
                max={64}
                value={modules.generator.depth}
                display={`${modules.generator.depth}`}
                onChange={(value) => updateGenerator({ depth: value })}
              />
            </div>
          </section>

          <section className="module-card module-card--wide">
            <div className="module-card__head">
              <span className="panel__title">
                <MessageSquare size={14} />
                Script and Discord
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
            <div className="module-card__body module-card__body--script">
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
                <span className="field__label">Quick buttons</span>
                <ScriptStepList
                  steps={modules.script.quickCommands}
                  prefix="quick"
                  onChange={(quickCommands) => updateScript({ quickCommands })}
                  commandPlaceholder="/home"
                  addLabel="Add button"
                  showDelay={false}
                  emptyHint="No quick buttons yet — each becomes a one-tap command below."
                />
              </div>
              <div className="quick-buttons">
                {modules.script.quickCommands.map((step) => (
                  <ActionWithHelp key={step.id} help={`${step.command} komutunu seçili çevrimiçi bota hemen gönderir.`}>
                    <button className="btn btn--sm" onClick={() => onQuickScript(step.command)}>
                      <Send size={13} />
                      {step.label}
                    </button>
                  </ActionWithHelp>
                ))}
              </div>
              <div className="completion-row">
                <Field label="Tab complete" value={scriptPartial} mono onChange={setScriptPartial} />
                <ActionWithHelp help="Seçili çevrimiçi bot üzerinden sunucunun tab completion önerilerini ister.">
                  <button className="btn btn--sm" onClick={() => onCompleteChat(scriptPartial)}>
                    Complete
                  </button>
                </ActionWithHelp>
              </div>
              {chatCompletions.length > 0 ? (
                <div className="completion-list">
                  {chatCompletions.map((item) => (
                    <span className="tag" key={item}>
                      {item}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="auto-response-box">
                <Toggle
                  label="Auto response"
                  help="Sunucudan gelen mesajlarda eşleşme yakalarsa seçili bot otomatik yanıt veya komut gönderir."
                  checked={modules.autoResponse.enabled}
                  onChange={(value) => updateAutoResponse({ enabled: value })}
                />
                <label className="field">
                  <span className="field__label">Match replies</span>
                  <textarea
                    rows={3}
                    value={autoResponseRulesToText(modules.autoResponse.rules)}
                    onChange={(event) => updateAutoResponse({ rules: textToAutoResponseRules(event.target.value) })}
                    placeholder="TPA accept | tpa | /tpaccept | 5000"
                  />
                </label>
              </div>

              <div className="discord-box">
                <div className="discord-box__head">
                  <Toggle
                    label="Discord bridge"
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

function InventoryPanel({ session }: { session: BotSessionSnapshot | null }) {
  const inventory = session?.inventory;
  const slots = inventory?.storage ?? [];
  return (
    <section className="panel inventory-panel">
      <div className="panel__head">
        <span className="panel__title">
          <PackageOpen size={14} />
          Live inventory
        </span>
        <span className="tag">{session?.inventoryUsed == null ? 'offline' : `${session.inventoryUsed}/${session.inventorySize ?? 46}`}</span>
      </div>
      <div className="panel__body inventory-panel__body">
        <div className="held-item">
          <span className="overline">Held</span>
          <strong>{inventory?.heldItem?.displayName ?? 'Empty hand'}</strong>
        </div>
        <InventorySection title="Armor" items={inventory?.armor ?? []} emptyLabel="No armor" />
        <InventorySection title="Crafting" items={inventory?.crafting ?? []} emptyLabel="Crafting grid empty" />
        <div className="inventory-grid" aria-label="Inventory slots">
          {Array.from({ length: 36 }, (_, index) => {
            const item = slots[index];
            return (
              <div className="slot" key={index} title={item ? `${item.displayName} x${item.count}` : 'Empty'}>
                {item ? (
                  <>
                    <span>{shortItemName(item.displayName)}</span>
                    <strong>{item.count}</strong>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
        {inventory?.openWindowTitle ? (
          <div className="held-item">
            <span className="overline">Open window</span>
            <strong>{inventory.openWindowTitle}</strong>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function InventorySection({ title, items, emptyLabel }: { title: string; items: InventoryItemSnapshot[]; emptyLabel: string }) {
  return (
    <div className="inventory-section">
      <span className="overline">{title}</span>
      <div className="inventory-section__items">
        {items.length === 0 ? <span className="inventory-empty">{emptyLabel}</span> : null}
        {items.map((item) => (
          <span className="tag" key={`${item.slot}-${item.name}`}>
            {shortItemName(item.displayName)} x{item.count}
          </span>
        ))}
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

        <label className="field">
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
    </section>
  );
}

function SettingsModal({
  settings,
  runtime,
  onChange,
  onOpenData,
  onClose
}: {
  settings: AppSettings;
  runtime: LauncherState['runtime'];
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

function makeStepId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`;
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
    modules: profileModules(draft)
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
    generator: { ...DEFAULT_MODULES_UI.generator, ...modules?.generator },
    script: {
      ...DEFAULT_MODULES_UI.script,
      ...modules?.script,
      steps: modules?.script?.steps?.length
        ? normalizeDraftScriptSteps(modules.script.steps, 'step')
        : DEFAULT_MODULES_UI.script.steps,
      quickCommands: modules?.script?.quickCommands?.length
        ? normalizeDraftScriptSteps(modules.script.quickCommands, 'quick')
        : DEFAULT_MODULES_UI.script.quickCommands
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

function autoResponseRulesToText(rules: AutoResponseRule[]): string {
  return rules.map((rule) => `${rule.label} | ${rule.match} | ${rule.response} | ${rule.cooldownMs}`).join('\n');
}

function textToAutoResponseRules(value: string): AutoResponseRule[] {
  return value
    .split('\n')
    .map((line, index) => {
      const [label = '', match = '', response = '', cooldown = ''] = line.split('|').map((part) => part.trim());
      return {
        id: `auto-response-${index + 1}`,
        enabled: true,
        label: label || `Rule ${index + 1}`,
        match,
        response,
        cooldownMs: Number(cooldown) || 5000
      };
    })
    .filter((rule) => rule.match && rule.response);
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
