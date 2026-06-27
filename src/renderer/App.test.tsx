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
    completeChat: async (profileId, partial) => {
      const session = state.sessions[profileId];
      const completions = ['/spawn', '/home', `${partial}test`].filter(Boolean);
      if (session) session.tabCompletions = completions;
      return completions;
    },
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
    }
  };
}

function buttonsWithoutAdjacentHelp(root: ParentNode) {
  return Array.from(root.querySelectorAll('button')).filter((button) => {
    if (button.getAttribute('role') === 'tab') return false;
    const parent = button.parentElement;
    return !parent || !Array.from(parent.children).some((child) => child.classList.contains('help-tip'));
  });
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
    expect(screen.getByText('Auto response')).toBeInTheDocument();
    expect(screen.getByText('Match replies')).toBeInTheDocument();
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
    expect(within(dialog).getByText('Reconnect policy')).toBeInTheDocument();
  });

  it('shows live connection state in the account sidebar instead of auth mode', async () => {
    render(<App api={createTestApi()} />);

    const onlineRow = await screen.findByRole('button', { name: /ARKONAS_SMP/i });
    expect(within(onlineRow).getByText('Online · play.arkonas.net')).toBeInTheDocument();
    expect(within(onlineRow).queryByText('offline · play.arkonas.net')).not.toBeInTheDocument();
  });

  it('does not silently fall back to simulated data when the desktop bridge and local web API are missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));

    render(<App />);

    expect(await screen.findByText(/Local web dashboard API is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Server profile')).not.toBeInTheDocument();
  });

  it('renders help affordances beside buttons and sliders', async () => {
    const user = userEvent.setup();
    const { container } = render(<App api={createTestApi()} />);

    await screen.findByRole('heading', { name: 'ChunkKeeper' });

    expect(buttonsWithoutAdjacentHelp(container)).toEqual([]);
    const sliders = Array.from(container.querySelectorAll('.slider'));
    expect(sliders.length).toBeGreaterThanOrEqual(8);
    expect(sliders.every((slider) => slider.querySelector('.help-tip'))).toBe(true);
    const connectHelp = screen.getByLabelText(/Seçili hesabı bağlar/i);
    expect(connectHelp).toBeInTheDocument();

    await user.hover(connectHelp);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(/Seçili hesabı bağlar/i);
    expect(tooltip.parentElement).toBe(document.body);
    await user.unhover(connectHelp);

    await user.click(screen.getByTitle('Settings'));
    let dialog = await screen.findByRole('dialog', { name: /^settings$/i });
    expect(buttonsWithoutAdjacentHelp(dialog)).toEqual([]);
    expect(dialog.querySelectorAll('.help-tip').length).toBeGreaterThanOrEqual(dialog.querySelectorAll('button').length);
    await user.click(within(dialog).getByRole('button', { name: /^done$/i }));

    await user.click(screen.getByRole('button', { name: /^edit profile$/i }));
    dialog = await screen.findByRole('dialog', { name: /^server profile editor$/i });
    expect(buttonsWithoutAdjacentHelp(dialog)).toEqual([]);
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
    expect(screen.getByText('Auto response')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: /inventory/i }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'tabpanel-inventory');

    await user.click(screen.getByRole('tab', { name: /routine/i }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'tabpanel-routine');
    expect(screen.getByText('AFK routine')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: /activity/i }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'tabpanel-activity');
    expect(screen.getByText('Pulse rail')).toBeVisible();
  });
});
