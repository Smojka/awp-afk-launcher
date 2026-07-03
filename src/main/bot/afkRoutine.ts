import type { AfkActionType, AfkRoutineConfig, SessionEvent } from '../../shared/types.js';

export interface RoutineBot {
  chat?: (message: string) => void;
  look?: (yaw: number, pitch: number, force?: boolean) => void;
  setControlState?: (control: string, state: boolean) => void;
  swingArm?: (arm?: 'left' | 'right') => void;
}

export interface RoutineCallbacks {
  emitEvent: (event: Omit<SessionEvent, 'id' | 'at' | 'profileId'>) => void;
  /** Return true to skip this tick's action. Used to hold the anti-AFK jiggle while a
   *  build/farm operation is driving the bot — a random look or jump pulse landing in
   *  the middle of a pathfinder walk corrupts it (walks time out, placements mis-aim). */
  shouldHold?: () => boolean;
}

export function calculateRoutineDelay(
  intervalMs: number,
  jitterPercent: number,
  random: () => number = Math.random
): number {
  const safeInterval = Math.max(3000, intervalMs);
  const safeJitter = Math.max(0, Math.min(80, jitterPercent));
  const spread = safeInterval * (safeJitter / 100);
  const offset = (random() * 2 - 1) * spread;
  return Math.max(1500, Math.round(safeInterval + offset));
}

export function chooseRoutineActions(config: AfkRoutineConfig): AfkActionType[] {
  const actions: AfkActionType[] = [];
  if (config.randomLook) actions.push('look');
  if (config.autoJump) actions.push('jump');
  if (config.sneakPulse) actions.push('sneak');
  if (config.swingArm) actions.push('swing');
  if (config.chatHeartbeat && config.chatMessages.length > 0) actions.push('chat');
  return actions;
}

export class AfkRoutine {
  private timeout: NodeJS.Timeout | null = null;
  private stopped = true;
  private lastChatMessage: string | null = null;

  constructor(
    private readonly profileId: string,
    private readonly bot: RoutineBot,
    private readonly config: AfkRoutineConfig,
    private readonly callbacks: RoutineCallbacks,
    private readonly random: () => number = Math.random
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.bot.setControlState?.('jump', false);
    this.bot.setControlState?.('sneak', false);
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = calculateRoutineDelay(this.config.intervalMs, this.config.jitterPercent, this.random);
    this.timeout = setTimeout(() => {
      this.tick();
      this.schedule();
    }, delay);
  }

  private tick(): void {
    if (this.callbacks.shouldHold?.()) return;
    const actions = chooseRoutineActions(this.config);
    if (actions.length === 0) return;
    const action = actions[Math.floor(this.random() * actions.length)] ?? actions[0];
    this.runAction(action);
  }

  private runAction(action: AfkActionType): void {
    switch (action) {
      case 'look': {
        const yaw = this.random() * Math.PI * 2;
        const pitch = (this.random() - 0.5) * 0.5;
        this.bot.look?.(yaw, pitch, true);
        this.emit('look', 'Look pulse', 'Randomized view angle');
        break;
      }
      case 'jump':
        this.pulseControl('jump', 240, 'Jump pulse');
        break;
      case 'sneak':
        this.pulseControl('sneak', 420, 'Sneak pulse');
        break;
      case 'swing':
        this.bot.swingArm?.('right');
        this.emit('swing', 'Swing pulse', 'Right arm animation');
        break;
      case 'chat': {
        const message = this.chooseChatMessage();
        if (message) {
          this.bot.chat?.(message);
          this.lastChatMessage = message;
          this.emit('chat', 'Chat message', message);
        }
        break;
      }
      default:
        break;
    }
  }

  private chooseChatMessage(): string | undefined {
    const messages = this.config.chatMessages.map((message) => message.trim()).filter(Boolean);
    if (messages.length <= 1) return messages[0];
    const candidates = messages.filter((message) => message !== this.lastChatMessage);
    return candidates[Math.floor(this.random() * candidates.length)] ?? candidates[0];
  }

  private pulseControl(control: string, durationMs: number, label: string): void {
    this.bot.setControlState?.(control, true);
    setTimeout(() => this.bot.setControlState?.(control, false), durationMs);
    this.emit(control === 'jump' ? 'jump' : 'sneak', label, `${durationMs}ms`);
  }

  private emit(type: AfkActionType, label: string, detail?: string): void {
    this.callbacks.emitEvent({
      type,
      tone: type === 'chat' ? 'info' : 'ok',
      label,
      detail
    });
  }
}
