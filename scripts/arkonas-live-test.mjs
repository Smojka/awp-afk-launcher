import mineflayer from 'mineflayer';

const originalWarn = console.warn;
console.warn = (...args) => {
  const text = args.map(String).join(' ');
  if (text.startsWith('Chunk size is ')) return;
  originalWarn(...args);
};

const HOST = process.env.ARKONAS_HOST || 'play.arkonas.net';
const PORT = Number(process.env.ARKONAS_PORT || 25565);
const VERSION = process.env.ARKONAS_VERSION || '1.20.1';
const USERNAME = process.env.ARKONAS_USERNAME || '';
const PASSWORD = process.env.ARKONAS_PASSWORD || '';
const AUTH_DELAY_MS = Number(process.env.ARKONAS_AUTH_DELAY_MS || 2500);
const TRANSFER_DELAY_MS = Number(process.env.ARKONAS_TRANSFER_DELAY_MS || 3500);
const TIMEOUT_MS = Number(process.env.ARKONAS_TIMEOUT_MS || 60000);
const TRANSFER_COMMAND = process.env.ARKONAS_TRANSFER_COMMAND ?? '/smp';
const OBSERVE_AFTER_AUTH_MS = Number(process.env.ARKONAS_OBSERVE_AFTER_AUTH_MS || 10000);
const DISCOVER_COMMANDS = process.env.ARKONAS_DISCOVER_COMMANDS === '1';
const RESOURCE_PACK_MODE = process.env.ARKONAS_RESOURCE_PACK_MODE || 'arkonas';

if (!USERNAME) {
  console.error('[arkonas-live-test] ARKONAS_USERNAME is required. This script no longer creates/registers new accounts.');
  process.exit(1);
}

if (!PASSWORD) {
  console.error('[arkonas-live-test] ARKONAS_PASSWORD is required for an existing account.');
  process.exit(1);
}

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME,
  auth: 'offline',
  version: VERSION
});

let spawnCount = 0;
let loggedIn = false;
let loginCommandSent = false;
let transferSent = false;
let fallbackSent = false;
let finished = false;
let spawnCountAtTransfer = 0;
const messages = [];

console.log(`[arkonas-live-test] connecting host=${HOST}:${PORT} username=<provided> auth=offline version=${VERSION ?? 'auto'}`);

bot._client.on('add_resource_pack', (packet) => {
  if (!packet.uuid) return;
  console.log(`[arkonas-live-test] accepting forced resource pack uuid=${packet.uuid} mode=${RESOURCE_PACK_MODE}`);
  setTimeout(() => {
    if (RESOURCE_PACK_MODE === 'vanilla' && typeof bot.acceptResourcePack === 'function') {
      bot.acceptResourcePack();
    } else if (RESOURCE_PACK_MODE === 'arkonas') {
      bot._client.write('resource_pack_receive', { uuid: packet.uuid, result: 3 });
      bot._client.write('resource_pack_receive', { uuid: packet.uuid, result: 4 });
      bot._client.write('resource_pack_receive', { uuid: packet.uuid, result: 0 });
    } else if (RESOURCE_PACK_MODE === 'arkonas-delay') {
      bot._client.write('resource_pack_receive', { uuid: packet.uuid, result: 3 });
      setTimeout(() => {
        bot._client.write('resource_pack_receive', { uuid: packet.uuid, result: 4 });
      }, 1500);
      setTimeout(() => {
        bot._client.write('resource_pack_receive', { uuid: packet.uuid, result: 0 });
      }, 3000);
    } else {
      bot._client.write('resource_pack_receive', { uuid: packet.uuid, result: 3 });
      bot._client.write('resource_pack_receive', { uuid: packet.uuid, result: 0 });
    }
    console.log('[arkonas-live-test] reported resource pack loaded');
  }, 0);
});

const hardTimeout = setTimeout(() => {
  finish(false, 'timeout waiting for lobby auth / SMP transfer');
}, TIMEOUT_MS);

bot.once('login', () => {
  console.log('[arkonas-live-test] protocol login accepted');
});

bot.on('spawn', () => {
  spawnCount += 1;
  console.log(`[arkonas-live-test] spawn #${spawnCount} dimension=${bot.game?.dimension ?? 'unknown'}`);

  if (spawnCount === 1) {
    setTimeout(() => {
      if (finished || transferSent) return;
      if (!loggedIn) {
        console.log('[arkonas-live-test] no auth prompt yet; trying login command for existing account');
        sendLogin();
      }
      scheduleTransfer();
    }, AUTH_DELAY_MS);
  } else if (transferSent && spawnCount > spawnCountAtTransfer) {
    finish(true, 'new spawn observed after transfer command');
  }
});

bot.on('messagestr', (message) => {
  const clean = sanitize(message);
  if (!clean) return;
  messages.push(clean);
  console.log(`[server] ${redact(clean)}`);

  const normalized = normalizeForMatching(clean);
  if (looksLikeRegisterPrompt(normalized)) {
    finish(false, 'server requested registration; refusing to create a new account');
    return;
  }
  if (looksLikeAuthSuccess(normalized)) {
    loggedIn = true;
    scheduleTransfer();
    return;
  }
  if (!loggedIn && looksLikeLoginPrompt(normalized)) {
    sendLogin();
    scheduleTransfer();
    return;
  }
  if (transferSent && looksLikeUnknownCommand(normalized)) {
    sendFallbackTransfer();
    return;
  }
  if (transferSent && !looksLikeUnknownCommand(normalized) && looksLikeSmpArrival(normalized)) {
    finish(true, 'server message confirmed SMP arrival after transfer command');
  }
});

bot.on('kicked', (reason) => {
  finish(false, `kicked: ${stringify(reason)}`);
});

bot.on('error', (error) => {
  finish(false, `error: ${error instanceof Error ? error.message : String(error)}`);
});

bot.on('end', () => {
  if (!finished) {
    finish(false, 'connection ended before SMP confirmation');
  }
});

function sendLogin() {
  if (loggedIn || finished) return;
  loggedIn = true;
  loginCommandSent = true;
  bot.chat(`/login ${PASSWORD}`);
  console.log('[arkonas-live-test] sent /login ******');
}

function scheduleTransfer() {
  if (transferSent || finished) return;
  if (!TRANSFER_COMMAND.trim()) {
    console.log('[arkonas-live-test] transfer disabled by ARKONAS_TRANSFER_COMMAND');
    setTimeout(() => {
      if (finished) return;
      void discoverCommands().finally(() => {
        finish(true, `observed post-auth without transfer: ${describePosition()}`);
      });
    }, OBSERVE_AFTER_AUTH_MS);
    return;
  }
  transferSent = true;
  spawnCountAtTransfer = spawnCount;
  setTimeout(() => {
    if (finished) return;
    bot.chat(TRANSFER_COMMAND);
    console.log(`[arkonas-live-test] sent ${TRANSFER_COMMAND}`);

    setTimeout(() => {
      if (finished || fallbackSent || spawnCount > spawnCountAtTransfer) return;
      sendFallbackTransfer();
    }, Math.max(TRANSFER_DELAY_MS, 5000));
  }, TRANSFER_DELAY_MS);
}

function sendFallbackTransfer() {
  if (finished || fallbackSent) return;
  if (TRANSFER_COMMAND.trim() === '/smp') {
    finish(false, '/smp returned an unknown-command response');
    return;
  }
  fallbackSent = true;
  spawnCountAtTransfer = spawnCount;
  bot.chat('/smp');
  console.log('[arkonas-live-test] sent /smp fallback');
}

function looksLikeRegisterPrompt(text) {
  return text.includes('/register') || text.includes('/kayit') || text.includes('kayit ol');
}

function looksLikeLoginPrompt(text) {
  if (looksLikeAuthSuccess(text)) return false;
  return text.includes('/login') || text.includes('/giris') || text.includes('giris yap');
}

function looksLikeAuthSuccess(text) {
  return text.includes('basari') ||
    text.includes('success') ||
    text.includes('logged in') ||
    text.includes('giris basarili') ||
    text.includes('otomatik giris yapildi') ||
    text.includes('zaten giris') ||
    text.includes('already logged');
}

function looksLikeUnknownCommand(text) {
  return text.includes('unknown or incomplete command') || text.includes('unknown command') || text.includes('bilinmeyen komut');
}

function looksLikeSmpArrival(text) {
  return text.includes('smp') && !looksLikeUnknownCommand(text);
}

function normalizeForMatching(message) {
  const smallCaps = {
    'ᴀ': 'a',
    'ʙ': 'b',
    'ᴄ': 'c',
    'ᴅ': 'd',
    'ᴇ': 'e',
    'ꜰ': 'f',
    'ɢ': 'g',
    'ʜ': 'h',
    'ɪ': 'i',
    'ᴊ': 'j',
    'ᴋ': 'k',
    'ʟ': 'l',
    'ᴍ': 'm',
    'ɴ': 'n',
    'ᴏ': 'o',
    'ᴘ': 'p',
    'ʀ': 'r',
    'ꜱ': 's',
    'ᴛ': 't',
    'ᴜ': 'u',
    'ᴠ': 'v',
    'ᴡ': 'w',
    'ʏ': 'y',
    'ᴢ': 'z'
  };

  return String(message)
    .replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ]/g, (character) => smallCaps[character] ?? character)
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i')
    .replaceAll('ğ', 'g')
    .replaceAll('ü', 'u')
    .replaceAll('ş', 's')
    .replaceAll('ö', 'o')
    .replaceAll('ç', 'c');
}

function finish(success, reason) {
  if (finished) return;
  finished = true;
  clearTimeout(hardTimeout);
  console.log(`[arkonas-live-test] ${success ? 'success' : 'failed'}: ${reason}`);
  console.log(`[arkonas-live-test] summary spawns=${spawnCount} loginCommand=${loginCommandSent} transferCommand=${transferSent} fallbackCommand=${fallbackSent}`);
  bot.quit();
  setTimeout(() => process.exit(success ? 0 : 1), 250);
}

function describePosition() {
  const pos = bot.entity?.position;
  const xyz = pos ? `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}` : 'unknown';
  const playerNames = Object.keys(bot.players ?? {}).slice(0, 8).join(',') || 'none';
  const sidebar = describeSidebar();
  return `dimension=${bot.game?.dimension ?? 'unknown'} pos=${xyz} players=${Object.keys(bot.players ?? {}).length} names=${playerNames}${sidebar ? ` sidebar=${sidebar}` : ''}`;
}

function describeSidebar() {
  const sidebar = bot.scoreboard?.sidebar;
  if (!sidebar) return '';
  const title = sanitize(sidebar.title ?? sidebar.name ?? '');
  const items = Object.values(sidebar.items ?? {})
    .map((item) => sanitize(item.displayName ?? item.name ?? ''))
    .filter(Boolean)
    .slice(0, 6)
    .join('|');
  return [title, items].filter(Boolean).join(':');
}

async function discoverCommands() {
  if (!DISCOVER_COMMANDS || typeof bot.tabComplete !== 'function') return;
  for (const prefix of ['/s', '/server ', '/l', '/warp ', '/menu']) {
    try {
      const matches = await bot.tabComplete(prefix, true, false, 5000);
      const normalized = matches
        .map((match) => typeof match === 'string' ? match : match.match ?? match.text ?? JSON.stringify(match))
        .slice(0, 20);
      console.log(`[arkonas-live-test] completions ${prefix}: ${normalized.join(', ') || 'none'}`);
    } catch (error) {
      console.log(`[arkonas-live-test] completions ${prefix}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function sanitize(message) {
  return String(message)
    .replace(/\u00a7[0-9a-fk-or]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function redact(message) {
  return message
    .replaceAll(PASSWORD, '******')
    .replaceAll(USERNAME, '<username>');
}

function stringify(value) {
  try {
    return redact(typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    return redact(String(value));
  }
}
