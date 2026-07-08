import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  DiscordRuntimeInput,
  InventoryActionRequest,
  LauncherApi,
  LauncherState,
  OperationKind,
  OperationStartRequest,
  PositionSnapshot,
  SaveProfileInput,
  UpdateCheckResult,
  UpdateDownloadedInfo,
  UpdateProgress
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
  inventoryAction: (profileId: string, request: InventoryActionRequest) =>
    ipcRenderer.invoke('bot:inventoryAction', profileId, request) as Promise<LauncherState>,
  completeChat: (profileId: string, partial: string) =>
    ipcRenderer.invoke('bot:completeChat', profileId, partial) as Promise<string[]>,
  capturePosition: (profileId: string) =>
    ipcRenderer.invoke('bot:capturePosition', profileId) as Promise<PositionSnapshot | null>,
  configureDiscord: (profileId: string, input: DiscordRuntimeInput) =>
    ipcRenderer.invoke('bot:configureDiscord', profileId, input) as Promise<LauncherState>,
  updateSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke('app:updateSettings', patch) as Promise<LauncherState>,
  secretAvailable: () => ipcRenderer.invoke('secret:isAvailable') as Promise<boolean>,
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
  },
  checkForUpdates: () => ipcRenderer.invoke('update:check') as Promise<UpdateCheckResult>,
  downloadUpdate: () => ipcRenderer.invoke('update:download') as Promise<void>,
  onUpdateAvailable: (listener: (info: UpdateCheckResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: UpdateCheckResult) => listener(info);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.off('update:available', handler);
  },
  onUpdateProgress: (listener: (progress: UpdateProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: UpdateProgress) => listener(progress);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.off('update:progress', handler);
  },
  onUpdateDownloaded: (listener: (info: UpdateDownloadedInfo) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: UpdateDownloadedInfo) => listener(info);
    ipcRenderer.on('update:downloaded', handler);
    return () => ipcRenderer.off('update:downloaded', handler);
  },
  onUpdateError: (listener: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on('update:error', handler);
    return () => ipcRenderer.off('update:error', handler);
  }
};

contextBridge.exposeInMainWorld('afkLauncher', api);
