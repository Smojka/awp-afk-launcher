import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  DiscordRuntimeInput,
  LauncherApi,
  LauncherState,
  OperationKind,
  OperationStartRequest,
  SaveProfileInput
} from '../src/shared/types.js';

const api: LauncherApi = {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('launcher:getState') as Promise<LauncherState>,
  saveProfile: (profile: SaveProfileInput) => ipcRenderer.invoke('profile:save', profile) as Promise<LauncherState>,
  deleteProfile: (profileId: string) => ipcRenderer.invoke('profile:delete', profileId) as Promise<LauncherState>,
  selectProfile: (profileId: string) => ipcRenderer.invoke('profile:select', profileId) as Promise<LauncherState>,
  connect: (profileId: string) => ipcRenderer.invoke('bot:connect', profileId) as Promise<LauncherState>,
  disconnect: (profileId: string) => ipcRenderer.invoke('bot:disconnect', profileId) as Promise<LauncherState>,
  startAll: () => ipcRenderer.invoke('bot:startAll') as Promise<LauncherState>,
  stopAll: () => ipcRenderer.invoke('bot:stopAll') as Promise<LauncherState>,
  sendChat: (profileId: string, message: string) =>
    ipcRenderer.invoke('bot:sendChat', profileId, message) as Promise<LauncherState>,
  startOperation: (profileId: string, request: OperationStartRequest) =>
    ipcRenderer.invoke('bot:startOperation', profileId, request) as Promise<LauncherState>,
  stopOperation: (profileId: string, kind: OperationKind) =>
    ipcRenderer.invoke('bot:stopOperation', profileId, kind) as Promise<LauncherState>,
  runQuickScript: (profileId: string, command: string) =>
    ipcRenderer.invoke('bot:runQuickScript', profileId, command) as Promise<LauncherState>,
  completeChat: (profileId: string, partial: string) =>
    ipcRenderer.invoke('bot:completeChat', profileId, partial) as Promise<string[]>,
  configureDiscord: (profileId: string, input: DiscordRuntimeInput) =>
    ipcRenderer.invoke('bot:configureDiscord', profileId, input) as Promise<LauncherState>,
  updateSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke('app:updateSettings', patch) as Promise<LauncherState>,
  openUserData: () => ipcRenderer.invoke('app:openUserData') as Promise<void>,
  minimizeWindow: () => ipcRenderer.invoke('window:minimize') as Promise<void>,
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize') as Promise<boolean>,
  closeWindow: () => ipcRenderer.invoke('window:close') as Promise<void>,
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
  onWindowMaximizedChange: (listener: (isMaximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isMaximized: boolean) => listener(isMaximized);
    ipcRenderer.on('window:maximized', handler);
    return () => ipcRenderer.off('window:maximized', handler);
  },
  onState: (listener: (state: LauncherState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: LauncherState) => listener(state);
    ipcRenderer.on('launcher:state', handler);
    return () => ipcRenderer.off('launcher:state', handler);
  }
};

contextBridge.exposeInMainWorld('afkLauncher', api);
