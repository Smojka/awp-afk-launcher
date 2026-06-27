import type {
  AppSettings,
  DiscordRuntimeInput,
  LauncherApi,
  LauncherState,
  OperationKind,
  OperationStartRequest,
  SaveProfileInput
} from '../shared/types';

const DEFAULT_LOCAL_WEB_PORT = '3000';

export function getLauncherApi(): LauncherApi {
  return window.afkLauncher ?? createHttpLauncherApi(resolveLocalWebApiBaseUrl());
}

function createHttpLauncherApi(baseUrl: string): LauncherApi {
  const stateListeners = new Set<(state: LauncherState) => void>();
  let eventSource: EventSource | null = null;

  const publish = (state: LauncherState) => {
    stateListeners.forEach((listener) => listener(state));
  };

  const ensureEventSource = () => {
    if (eventSource || typeof EventSource === 'undefined') return;
    eventSource = new EventSource(`${baseUrl}/api/events`);
    eventSource.addEventListener('state', (event) => {
      try {
        publish(JSON.parse(event.data) as LauncherState);
      } catch {
        // Ignore malformed event frames and let the next valid state frame recover.
      }
    });
  };

  const request = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
    if (typeof fetch !== 'function') {
      throw localApiUnavailableError(baseUrl);
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers
        }
      });
    } catch (error) {
      throw localApiUnavailableError(baseUrl, error);
    }

    const payload = await readJsonResponse(response);
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : response.statusText;
      throw new Error(message || `Request failed with HTTP ${response.status}`);
    }
    return payload as T;
  };

  return {
    platform: 'web',
    getState: async () => request<LauncherState>('/api/state'),
    saveProfile: async (profile: SaveProfileInput) =>
      request<LauncherState>('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(profile)
      }),
    deleteProfile: async (profileId: string) =>
      request<LauncherState>(`/api/profiles/${encodeURIComponent(profileId)}`, {
        method: 'DELETE'
      }),
    selectProfile: async (profileId: string) =>
      request<LauncherState>(`/api/profiles/${encodeURIComponent(profileId)}/select`, {
        method: 'POST'
      }),
    connect: async (profileId: string) =>
      request<LauncherState>(`/api/bots/${encodeURIComponent(profileId)}/connect`, {
        method: 'POST'
      }),
    disconnect: async (profileId: string) =>
      request<LauncherState>(`/api/bots/${encodeURIComponent(profileId)}/disconnect`, {
        method: 'POST'
      }),
    startAll: async () =>
      request<LauncherState>('/api/bots/start-all', {
        method: 'POST'
      }),
    stopAll: async () =>
      request<LauncherState>('/api/bots/stop-all', {
        method: 'POST'
      }),
    sendChat: async (profileId: string, message: string) =>
      request<LauncherState>(`/api/bots/${encodeURIComponent(profileId)}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message })
      }),
    startOperation: async (profileId: string, operationRequest: OperationStartRequest) =>
      request<LauncherState>(`/api/bots/${encodeURIComponent(profileId)}/operations`, {
        method: 'POST',
        body: JSON.stringify(operationRequest)
      }),
    stopOperation: async (profileId: string, kind: OperationKind) =>
      request<LauncherState>(`/api/bots/${encodeURIComponent(profileId)}/operations/${encodeURIComponent(kind)}`, {
        method: 'DELETE'
      }),
    runQuickScript: async (profileId: string, command: string) =>
      request<LauncherState>(`/api/bots/${encodeURIComponent(profileId)}/quick-script`, {
        method: 'POST',
        body: JSON.stringify({ command })
      }),
    completeChat: async (profileId: string, partial: string) => {
      const result = await request<{ completions: string[] }>(`/api/bots/${encodeURIComponent(profileId)}/complete`, {
        method: 'POST',
        body: JSON.stringify({ partial })
      });
      return result.completions;
    },
    configureDiscord: async (profileId: string, input: DiscordRuntimeInput) =>
      request<LauncherState>(`/api/bots/${encodeURIComponent(profileId)}/discord`, {
        method: 'POST',
        body: JSON.stringify(input)
      }),
    updateSettings: async (patch: Partial<AppSettings>) =>
      request<LauncherState>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch)
      }),
    openUserData: async () => {
      await request<{ ok: boolean }>('/api/open-user-data', { method: 'POST' });
    },
    minimizeWindow: async () => undefined,
    toggleMaximizeWindow: async () => false,
    closeWindow: async () => undefined,
    isWindowMaximized: async () => false,
    onWindowMaximizedChange: () => () => undefined,
    onState: (listener: (state: LauncherState) => void) => {
      stateListeners.add(listener);
      ensureEventSource();
      return () => {
        stateListeners.delete(listener);
        if (stateListeners.size === 0 && eventSource) {
          eventSource.close();
          eventSource = null;
        }
      };
    }
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

function resolveLocalWebApiBaseUrl(): string {
  const configuredBaseUrl = localApiBaseFromQuery();
  if (configuredBaseUrl) return configuredBaseUrl;

  const { hostname, origin, port, protocol } = window.location;
  if ((protocol === 'http:' || protocol === 'https:') && isLoopbackHostname(hostname)) {
    if (port === DEFAULT_LOCAL_WEB_PORT || port === '') return origin;
    return `${protocol}//127.0.0.1:${DEFAULT_LOCAL_WEB_PORT}`;
  }
  return `http://127.0.0.1:${DEFAULT_LOCAL_WEB_PORT}`;
}

function localApiBaseFromQuery(): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get('apiBase');
    if (!value) return null;
    const url = new URL(value);
    if (!isLoopbackHostname(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function localApiUnavailableError(baseUrl: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? ` ${cause.message}` : '';
  return new Error(`Local web dashboard API is unavailable at ${baseUrl}. Start ChunkKeeper first, then open localhost:${DEFAULT_LOCAL_WEB_PORT}.${detail}`);
}
