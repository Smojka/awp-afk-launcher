import { randomUUID } from 'node:crypto';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createDemoState } from './demoState';
import type { LauncherApi, LauncherState, SaveProfileInput } from '../shared/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createTestApi(): LauncherApi {
  let state = createDemoState();
  const listeners = new Set<(state: LauncherState) => void>();

  const publish = () => {
    state = {
      ...state,
      runtime: {
        ...state.runtime,
        botCount: state.profiles.length,
        onlineCount: Object.values(state.sessions).filter((session) => session.state === 'online').length
      }
    };
    const snapshot = structuredClone(state);
    listeners.forEach((listener) => listener(snapshot));
    return Promise.resolve(snapshot);
  };

  return {
    platform: 'win32',
    secretAvailable: async () => true,
    getState: async () => structuredClone(state),
    saveProfile: async (profile: SaveProfileInput) => {
      const id = profile.id || `session-${Date.now().toString(36)}`;
      const nextProfile = { ...profile, id };
      const existing = state.profiles.findIndex((item) => item.id === id);
      state = {
        ...state,
        profiles:
          existing >= 0
            ? state.profiles.map((item) => (item.id === id ? nextProfile : item))
            : [...state.profiles, nextProfile],
        selectedProfileId: id
      };
      if (!state.sessions[id]) {
        state.sessions[id] = structuredClone(createDemoState().sessions['session-02']);
        state.sessions[id].profileId = id;
      }
      return publish();
    },
    deleteProfile: async (profileId: string) => {
      const { [profileId]: _deleted, ...sessions } = state.sessions;
      state = {
        ...state,
        profiles: state.profiles.filter((profile) => profile.id !== profileId),
        sessions,
        selectedProfileId: state.profiles.find((profile) => profile.id !== profileId)?.id ?? null
      };
      return publish();
    },
    selectProfile: async (profileId: string) => {
      state = { ...state, selectedProfileId: profileId };
      return publish();
    },
    connect: async (profileId: string) => {
      const session = state.sessions[profileId];
      if (session) {
        session.state = 'online';
        session.statusMessage = 'Online';
        session.routineActive = true;
        session.health = 20;
        session.food = 20;
        session.connectedAt = new Date().toISOString();
      }
      return publish();
    },
    disconnect: async (profileId: string) => {
      const session = state.sessions[profileId];
      if (session) {
        session.state = 'offline';
        session.statusMessage = 'Stopped';
        session.routineActive = false;
        session.connectedAt = null;
      }
      return publish();
    },
    startAll: async () => {
      for (const profile of state.profiles.filter((item) => item.enabled)) {
        const session = state.sessions[profile.id];
        if (session) {
          session.state = 'online';
          session.statusMessage = 'Online';
          session.routineActive = true;
        }
      }
      return publish();
    },
    stopAll: async () => {
      for (const session of Object.values(state.sessions)) {
        session.state = 'offline';
        session.statusMessage = 'Stopped';
        session.routineActive = false;
      }
      return publish();
    },
    sendChat: async (profileId: string, message: string) => {
      const session = state.sessions[profileId];
      if (session) {
        session.chat = [
          ...session.chat,
          { id: `chat-${Date.now()}`, at: new Date().toISOString(), source: 'bot', message }
        ];
      }
      return publish();
    },
    startOperation: async (profileId, request) => {
      const session = state.sessions[profileId];
      if (session) {
        session.operations[request.kind] = {
          ...session.operations[request.kind],
          state: 'running',
          detail: 'Test operation running',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
      }
      return publish();
    },
    stopOperation: async (profileId, kind) => {
      const session = state.sessions[profileId];
      if (session) {
        session.operations[kind] = {
          ...session.operations[kind],
          state: 'idle',
          detail: 'Stopped',
          updatedAt: new Date().toISOString()
        };
      }
      return publish();
    },
    runQuickScript: async (profileId, command) => {
      const session = state.sessions[profileId];
      if (session) {
        session.chat = [
          ...session.chat,
          { id: `quick-${Date.now()}`, at: new Date().toISOString(), source: 'bot', message: command }
        ];
      }
      return publish();
    },
    inventoryAction: async () => publish(),
    completeChat: async (profileId, partial) => {
      const session = state.sessions[profileId];
      const completions = ['/spawn', '/home', `${partial}test`].filter(Boolean);
      if (session) session.tabCompletions = completions;
      return completions;
    },
    capturePosition: async () => null,
    configureDiscord: async (profileId, input) => {
      const session = state.sessions[profileId];
      if (session) {
        session.operations.discord = {
          ...session.operations.discord,
          state: input.enabled ? 'running' : 'idle',
          detail: input.enabled ? 'Discord bridge configured for this runtime session' : 'Discord bridge disabled',
          updatedAt: new Date().toISOString()
        };
      }
      return publish();
    },
    updateSettings: async (patch) => {
      state = { ...state, settings: { ...state.settings, ...patch } };
      return publish();
    },
    openUserData: async () => undefined,
    minimizeWindow: async () => undefined,
    toggleMaximizeWindow: async () => true,
    closeWindow: async () => undefined,
    isWindowMaximized: async () => false,
    onWindowMaximizedChange: () => () => undefined,
    onState: (listener: (state: LauncherState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    checkForUpdates: async () => ({
      updateAvailable: false,
      currentVersion: '0.0.0',
      latestVersion: '0.0.0',
      notes: '',
      htmlUrl: '',
      assetUrl: null,
      installMode: 'auto' as const
    }),
    downloadUpdate: async () => undefined,
    onUpdateAvailable: () => () => undefined,
    onUpdateProgress: () => () => undefined,
    onUpdateDownloaded: () => () => undefined,
    onUpdateError: () => () => undefined
  };
}

describe('ChunkKeeper UI', () => {
  it('renders the command desk and AFK-specific controls', async () => {
    const user = userEvent.setup();
    render(<App api={createTestApi()} />);

    expect(await screen.findByRole('heading', { name: 'ChunkKeeper' })).toBeInTheDocument();
    expect(screen.getByText('Developed by')).toBeInTheDocument();
    expect(screen.getByText('smojka')).toBeInTheDocument();
    expect(screen.getByText('Server profile')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit profile$/i })).toBeInTheDocument();
    expect(screen.getByText('AFK routine')).toBeInTheDocument();
    expect(screen.getByText('Auto-eat')).toBeInTheDocument();
    expect(screen.getByText('Eat below')).toBeInTheDocument();
    expect(screen.getByText('Pause below')).toBeInTheDocument();
    expect(screen.getByText('Auto-response')).toBeInTheDocument();
    expect(screen.getByText('Match (contains)')).toBeInTheDocument();
    expect(screen.getByLabelText('Command input')).toBeInTheDocument();
    expect(screen.getByText('Pulse rail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Window controls')).toBeInTheDocument();
    expect(screen.getByTitle('Minimize')).toBeInTheDocument();
    expect(screen.getByTitle('Maximize')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^edit profile$/i }));
    const dialog = await screen.findByRole('dialog', { name: /^server profile editor$/i });

    expect(within(dialog).getByText('Identity')).toBeInTheDocument();
    expect(within(dialog).getByText('Endpoint')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Join flow').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Lobby auth')).toBeInTheDocument();
    expect(within(dialog).getByText('Login command')).toBeInTheDocument();
    expect(within(dialog).getByText('Register command')).toBeInTheDocument();
    expect(within(dialog).getByText('Flow commands')).toBeInTheDocument();
    expect(within(dialog).getByText('Reconnect policy')).toBeInTheDocument();
  });

  it('shows live connection state in the account sidebar instead of auth mode', async () => {
    render(<App api={createTestApi()} />);

    const onlineRow = await screen.findByRole('button', { name: /ARKONAS_SMP/i });
    expect(within(onlineRow).getByText('Online · play.arkonas.net')).toBeInTheDocument();
    expect(within(onlineRow).queryByText('offline · play.arkonas.net')).not.toBeInTheDocument();
  });

  it('shows tab-completion suggestions and clears them once the input changes', async () => {
    const user = userEvent.setup();
    render(<App api={createTestApi()} />);
    await screen.findByRole('heading', { name: 'ChunkKeeper' });

    const input = screen.getByLabelText('Command input');
    await user.click(input);
    await user.keyboard('/h');
    await user.keyboard('{Tab}');

    const suggestions = await screen.findByLabelText('Tab completion suggestions');
    expect(within(suggestions).getByText('/home')).toBeInTheDocument();

    // Typing past the suggestions must drop them rather than leaving stale chips up.
    await user.keyboard('o');
    expect(screen.queryByLabelText('Tab completion suggestions')).not.toBeInTheDocument();
  });

  it('does not silently fall back to simulated data when the desktop bridge and local web API are missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));

    render(<App />);

    expect(await screen.findByText(/Local web dashboard API is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Server profile')).not.toBeInTheDocument();
  });

  it('creates a new account draft without copying the selected account password, then saves it', async () => {
    const user = userEvent.setup();
    const authPassword = randomUUID();
    const username = randomUUID();
    render(<App api={createTestApi()} />);

    await screen.findByRole('heading', { name: 'ChunkKeeper' });

    await user.click(screen.getByRole('button', { name: /^edit profile$/i }));
    let dialog = await screen.findByRole('dialog', { name: /^server profile editor$/i });
    await user.type(within(dialog).getByLabelText(/^Auth password$/i), authPassword);
    await user.click(within(dialog).getByRole('button', { name: /^save profile$/i }));

    await user.click(screen.getByRole('button', { name: /^new account$/i }));
    dialog = await screen.findByRole('dialog', { name: /^server profile editor$/i });

    expect(within(dialog).getByLabelText(/^Label$/i)).toHaveValue('SESSION_03');
    expect(within(dialog).getByLabelText(/^Username$/i)).toHaveValue('');
    expect(within(dialog).getByLabelText(/^Auth password$/i)).toHaveValue('');

    await user.clear(within(dialog).getByLabelText(/^Label$/i));
    await user.type(within(dialog).getByLabelText(/^Label$/i), 'SESSION_03_TEST');
    await user.type(within(dialog).getByLabelText(/^Username$/i), username);
    await user.click(within(dialog).getByRole('button', { name: /^save profile$/i }));

    expect((await screen.findAllByText('SESSION_03_TEST')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /^edit profile$/i }));
    dialog = await screen.findByRole('dialog', { name: /^server profile editor$/i });
    expect(within(dialog).getByDisplayValue(username)).toBeInTheDocument();
  });

  it('lets the operator stop all sessions from the top bar', async () => {
    const user = userEvent.setup();
    render(<App api={createTestApi()} />);

    await screen.findByRole('heading', { name: 'ChunkKeeper' });
    await user.click(screen.getByRole('button', { name: /^stop all$/i }));

    expect(screen.getByTitle('Sessions online')).toHaveTextContent(/0\s*\/\s*\d+\s*online/);
  });

  it('applies settings changes to the rendered app state', async () => {
    const user = userEvent.setup();
    const { container } = render(<App api={createTestApi()} />);

    await screen.findByRole('heading', { name: 'ChunkKeeper' });
    await user.click(screen.getByTitle('Settings'));
    await user.click(screen.getByLabelText(/^Compact density$/i));

    expect(container.querySelector('.app')).toHaveClass('is-compact');

    await user.clear(screen.getByLabelText(/^Max attempts$/i));
    await user.type(screen.getByLabelText(/^Max attempts$/i), '3');
    await user.click(screen.getByRole('button', { name: /^done$/i }));
    await user.click(screen.getByRole('button', { name: /^new account$/i }));
    await user.click(within(await screen.findByRole('dialog', { name: /^server profile editor$/i })).getByRole('button', { name: /^close$/i }));
    await user.click(screen.getByTitle('Settings'));

    expect(screen.getByLabelText(/^Max attempts$/i)).toHaveValue('3');
  });

  it('switches the visible workspace section when a tab is clicked', async () => {
    const user = userEvent.setup();
    render(<App api={createTestApi()} />);

    await screen.findByRole('heading', { name: 'ChunkKeeper' });

    const overviewTab = screen.getByRole('tab', { name: /overview/i });
    expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'tabpanel-overview');
    expect(screen.getByText('Server profile')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: /operations/i }));
    expect(screen.getByRole('tab', { name: /operations/i })).toHaveAttribute('aria-selected', 'true');
    expect(overviewTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'tabpanel-operations');
    expect(screen.getByText('Auto-response')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: /inventory/i }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'tabpanel-inventory');

    await user.click(screen.getByRole('tab', { name: /routine/i }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'tabpanel-routine');
    expect(screen.getByText('AFK routine')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: /activity/i }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'tabpanel-activity');
    expect(screen.getByText('Pulse rail')).toBeVisible();
  });

  it('adds an editable blank quick-command row when the add button is clicked', async () => {
    // Regression: the editor used to normalize+strip blank rows on every render,
    // so the row the "Add quick command" button created vanished immediately and
    // the button looked dead. Blank rows must survive until save.
    const user = userEvent.setup();
    render(<App api={createTestApi()} />);

    await screen.findByRole('heading', { name: 'ChunkKeeper' });
    await user.click(screen.getByRole('tab', { name: /operations/i }));

    const before = screen.queryAllByPlaceholderText('/home').length;
    await user.click(screen.getByRole('button', { name: /add quick command/i }));

    const rows = screen.getAllByPlaceholderText('/home');
    expect(rows.length).toBe(before + 1);

    // The new row is real and accepts input.
    const fresh = rows[rows.length - 1];
    await user.type(fresh, '/spawn');
    expect(fresh).toHaveValue('/spawn');
  });

  it('renders the chest storage card and captures an output-chest position from the bot', async () => {
    const user = userEvent.setup();
    const api = createTestApi();
    const capture = vi.spyOn(api, 'capturePosition').mockResolvedValue({ x: 10, y: 64, z: -5 });
    render(<App api={api} />);

    await screen.findByRole('heading', { name: 'ChunkKeeper' });
    await user.click(screen.getByRole('tab', { name: /operations/i }));

    expect(screen.getByText('Chest storage')).toBeInTheDocument();
    // Supply + output roles each get their own capture button.
    const captureButtons = screen.getAllByRole('button', { name: /sandığı yakala/i });
    expect(captureButtons.length).toBe(2);

    await user.click(captureButtons[1]); // output chest
    expect(capture).toHaveBeenCalledWith('session-01');
    expect(await screen.findByLabelText('Çıktı sandığı Z')).toHaveValue('-5');
  });

  it('opens a searchable quick-command menu from the command bar and sends the picked command', async () => {
    const user = userEvent.setup();
    const api = createTestApi();
    const runQuickScript = vi.spyOn(api, 'runQuickScript');
    render(<App api={api} />);

    await screen.findByRole('heading', { name: 'ChunkKeeper' });

    // The selected demo profile (ARKONAS_SMP) is online, so quick commands run.
    const commandBar = screen.getByRole('region', { name: /command bar/i });
    await user.click(within(commandBar).getByRole('button', { name: /quick/i }));

    // The menu lists the default quick commands (Spawn + Home).
    const search = await screen.findByRole('textbox', { name: /quick command search/i });
    expect(screen.getByRole('menuitem', { name: /spawn/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /home/i })).toBeInTheDocument();

    // Typing filters the list down.
    await user.type(search, 'home');
    expect(screen.queryByRole('menuitem', { name: /spawn/i })).not.toBeInTheDocument();

    // Picking an item dispatches the command and closes the menu.
    await user.click(screen.getByRole('menuitem', { name: /home/i }));
    expect(runQuickScript).toHaveBeenCalledWith('session-01', '/home');
    expect(screen.queryByRole('menuitem', { name: /home/i })).not.toBeInTheDocument();
  });

  it('opens a slot action menu and dispatches the picked inventory action', async () => {
    const user = userEvent.setup();
    const api = createTestApi();
    const inventoryAction = vi.spyOn(api, 'inventoryAction');
    render(<App api={api} />);

    await screen.findByRole('heading', { name: 'ChunkKeeper' });
    await user.click(screen.getByRole('tab', { name: /inventory/i }));

    // The online demo session holds Sand x48 in hotbar slot 37.
    const sandSlot = screen.getByTitle('Sand ×48');
    await user.click(sandSlot);

    // The popover offers contextual actions; pick "Yığını at" (drop stack).
    await user.click(await screen.findByRole('menuitem', { name: /yığını at/i }));
    expect(inventoryAction).toHaveBeenCalledWith('session-01', { action: 'dropStack', slot: 37 });
  });
});
