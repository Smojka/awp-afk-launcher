import mineflayer from 'mineflayer';

const host = process.env.MC_HOST ?? '127.0.0.1';
const port = Number(process.env.MC_PORT ?? 25565);
const username = process.env.MC_USERNAME ?? `AFKSmoke${Math.floor(Math.random() * 1000)}`;
const version = process.env.MC_VERSION || false;
const timeoutMs = Number(process.env.MC_TIMEOUT_MS ?? 45000);

const started = Date.now();
let finished = false;

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  version
});

const timeout = setTimeout(() => {
  finish(1, `Timed out after ${timeoutMs}ms waiting for spawn`);
}, timeoutMs);

bot.once('spawn', () => {
  const position = bot.entity?.position;
  finish(0, 'Spawned into local test server', {
    username: bot.username,
    health: bot.health,
    food: bot.food,
    dimension: bot.game?.dimension,
    position: position
      ? {
          x: Math.round(position.x * 10) / 10,
          y: Math.round(position.y * 10) / 10,
          z: Math.round(position.z * 10) / 10
        }
      : null,
    elapsedMs: Date.now() - started
  });
});

bot.on('kicked', (reason) => {
  finish(1, 'Bot was kicked', { reason });
});

bot.on('error', (error) => {
  finish(1, 'Bot connection failed', { error: error.message });
});

function finish(code, message, extra = {}) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  console.log(JSON.stringify({ ok: code === 0, message, host, port, ...extra }, null, 2));
  try {
    bot.quit();
  } catch {
    // The connection may already be closed.
  }
  setTimeout(() => process.exit(code), 100);
}
