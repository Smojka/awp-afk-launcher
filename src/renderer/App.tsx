import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  Check,
  CircleAlert,
  CircleHelp,
  FolderOpen,
  Gauge,
  MessageSquare,
  Maximize2,
  Minimize2,
  Minus,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Send,
  Settings,
  Square,
  Trash2,
  Wifi,
  X
} from 'lucide-react';
import { getLauncherApi } from './api';
import { DEFAULT_SETTINGS } from '../shared/types';
import type { AccountProfile, AppSettings, BotSessionSnapshot, LauncherApi, LauncherState, SaveProfileInput } from '../shared/types';

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

  if (!state || !draft || !apiClient) {
    return (
      <main className="boot">
        <div className="boot__mark">
          <BrandMark className="boot__glyph" />
          <span>{APP_NAME}</span>
          <small className="boot__credit">{DEVELOPER_CREDIT}</small>
          {error ? <small className="boot__error">{error}</small> : null}
        </div>
      </main>
    );
  }

  const liveState = selectedSession?.state ?? 'idle';
  const isLive = liveState === 'online' || liveState === 'connecting' || liveState === 'reconnecting';
  const position = selectedSession?.position ?? null;
  const showWindowControls = apiClient.platform !== 'darwin';
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

          <ServerProfileSummary
            draft={draft}
            onEdit={() => setProfileEditorOpen(true)}
            onSave={() => saveProfileDraft(draft)}
          />

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
        </main>

        <aside className="rail">
          <RoutinePanel draft={draft} onChange={setDraft} onSave={() => saveProfileDraft(draft)} />
          <ConnectionPanel session={selectedSession} stateLabel={STATE_LABEL[liveState]} />
        </aside>
      </div>

      <footer className="statusbar">
        <StatusItem
          icon={<Activity size={13} />}
          label="System"
          value={state.runtime.systemState}
          tone={state.runtime.systemState === 'online' ? 'ok' : 'warn'}
        />
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
        <SummaryItem label="Lobby auth" value={draft.startup.enabled ? lobbyAuthLabel(draft.startup.authMode) : 'Off'} />
        <SummaryItem label="Transfer" value={draft.startup.transferCommand || 'None'} mono empty={!draft.startup.transferCommand} />
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
  return (
    <div className="row-with-help">
      <button className={`row ${selected ? 'is-selected' : ''}`} onClick={onSelect}>
        <span className="avatar">{profile.label.slice(0, 2).toUpperCase()}</span>
        <span className="row__copy">
          <strong>{profile.label}</strong>
          <span>
            {profile.authMode} · {profile.host}
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
          help="Sunucu önce lobby'ye alıyorsa açılır. Bağlantıdan sonra auth/register komutu, ardından transfer komutu sırayla gönderilir."
          checked={startup.enabled}
          onChange={(value) => updateStartup({ enabled: value })}
        />
        <span className="joinflow__hint">Lobby auth → SMP transfer</span>
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
          <span className={`bar__fill bar__fill--${tone}`} style={{ width: `${pct}%` }} />
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
      authPassword: ''
    },
    routine: {
      ...template.routine,
      autoEat: template.routine.autoEat ?? true,
      eatAtFood,
      pauseAtFood
    },
    reconnect: { ...settings.defaultReconnect }
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
      transferDelayMs: Math.max(0, Number(draft.startup.transferDelayMs) || 0)
    },
    routine: {
      ...draft.routine,
      autoEat: draft.routine.autoEat ?? true,
      eatAtFood,
      pauseAtFood,
      intervalMs: Math.max(3000, Number(draft.routine.intervalMs) || 18000),
      jitterPercent: Math.max(0, Math.min(80, Number(draft.routine.jitterPercent) || 0)),
      chatMessages: draft.routine.chatMessages.map((message) => message.trim()).filter(Boolean)
    }
  };
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
