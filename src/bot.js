import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import https from 'https';
import { spawn } from 'child_process';
import TelegramBot from 'node-telegram-bot-api';

// Environment configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set. Export BOT_TOKEN and restart.');
  process.exit(1);
}

// rTorrent integration options
// 1) Preferred: use a watch directory where rTorrent picks up new .torrent files
//    Set WATCH_DIR=/path/to/watch
// 2) Fallback: use rtxmlrpc to add and query torrents via XML-RPC/SCGI
//    Set RTORRENT_SCGI=127.0.0.1:5000 (host:port for scgi_port in .rtorrent.rc)
//    Requires rtxmlrpc binary installed and in PATH.
const WATCH_DIR = process.env.WATCH_DIR || '';
const RTORRENT_SCGI = process.env.RTORRENT_SCGI || '127.0.0.1:5000';

// Temp directory for storing incoming .torrent files before moving
const TMP_DIR = process.env.TMP_DIR || path.join(process.cwd(), 'tmp');
await fsp.mkdir(TMP_DIR, { recursive: true });

// Simple in-memory state to track which chats are awaiting inputs
const awaitingTorrent = new Map(); // chatId -> true (awaiting .torrent document)
const awaitingMagnet = new Map(); // chatId -> true (awaiting magnet link)

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function isTorrentDocument(msg) {
  const doc = msg.document;
  if (!doc) return false;
  const name = (doc.file_name || '').toLowerCase();
  const mime = (doc.mime_type || '').toLowerCase();
  return name.endsWith('.torrent') || mime === 'application/x-bittorrent';
}

function downloadFileFromTelegram(filePath, destPath) {
  const token = BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download file: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function saveTorrentToWatchDir(tempFile, originalName) {
  if (!WATCH_DIR) {
    throw new Error('WATCH_DIR is not configured.');
  }
  await fsp.mkdir(WATCH_DIR, { recursive: true });
  const target = path.join(WATCH_DIR, originalName || path.basename(tempFile));
  await fsp.copyFile(tempFile, target);
  return target;
}

function execRtxmlrpc(args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = 'rtxmlrpc';
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const to = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('rtxmlrpc timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString())) ;
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(to);
      if (code !== 0) return reject(new Error(stderr || `rtxmlrpc exited ${code}`));
      resolve(stdout.trim());
    });
  });
}

async function addTorrentViaRtxmlrpc(filePath) {
  // Attempt using load.start with local file path. Some setups may require load.raw_start.
  // Try common methods in order.
  const scgi = RTORRENT_SCGI;
  const attempts = [
    ['load.start', '', filePath],
    ['load.raw_start', '', await fsp.readFile(filePath)],
  ];
  for (const attempt of attempts) {
    try {
      const [method, empty, payload] = attempt;
      const args = ['-p', scgi, method];
      if (payload instanceof Buffer) {
        // rtxmlrpc expects hex for binary args; but many builds accept base64 or raw.
        // Fallback to writing temp and using load.start.
        continue;
      } else {
        args.push(empty, payload);
      }
      await execRtxmlrpc(args);
      return true;
    } catch (e) {
      // try next
    }
  }
  throw new Error('Failed to add torrent via rtxmlrpc. Ensure rtxmlrpc is installed and rTorrent exposes SCGI.');
}

async function addMagnetViaRtxmlrpc(magnetLink) {
  if (!magnetLink || !magnetLink.toLowerCase().startsWith('magnet:?')) {
    throw new Error('Неверная ссылка magnet.');
  }
  const scgi = RTORRENT_SCGI;
  // load.start with empty tied directory and the magnet URI
  await execRtxmlrpc(['-p', scgi, 'load.start', '', magnetLink]);
  return true;
}

async function handleDownloadCommand(msg) {
  const chatId = msg.chat.id;
  awaitingTorrent.set(chatId, true);
  await bot.sendMessage(chatId, 'Пришлите .torrent файл как документ.');
}

async function handleIncomingDocument(msg) {
  const chatId = msg.chat.id;
  const expecting = awaitingTorrent.get(chatId) === true;
  if (!expecting) return; // ignore if not requested

  if (!isTorrentDocument(msg)) {
    await bot.sendMessage(chatId, 'Это не .torrent файл. Попробуйте снова.');
    return;
  }

  const doc = msg.document;
  try {
    const file = await bot.getFile(doc.file_id);
    const tempName = `${doc.file_unique_id || doc.file_id}.torrent`;
    const tempPath = path.join(TMP_DIR, tempName);
    await downloadFileFromTelegram(file.file_path, tempPath);

    let methodUsed = '';
    if (WATCH_DIR) {
      const target = await saveTorrentToWatchDir(tempPath, doc.file_name || tempName);
      methodUsed = `Файл помещён в watch директорию: ${target}`;
    } else {
      // Try via rtxmlrpc
      await addTorrentViaRtxmlrpc(tempPath);
      methodUsed = 'Добавлено в rTorrent через rtxmlrpc.';
    }

    awaitingTorrent.delete(chatId);
    await bot.sendMessage(chatId, `Торрент принят и добавлен. ${methodUsed}`);
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, `Не удалось добавить торрент: ${err.message}`);
  }
}

async function handleMagnetsLinkCommand(msg) {
  const chatId = msg.chat.id;
  awaitingMagnet.set(chatId, true);
  await bot.sendMessage(chatId, 'Отправьте magnet ссылку (начинается с magnet:? ).');
}

async function handleIncomingText(msg) {
  const chatId = msg.chat.id;
  const expectingMagnet = awaitingMagnet.get(chatId) === true;
  if (!expectingMagnet) return;

  const text = (msg.text || '').trim();
  if (!text.toLowerCase().startsWith('magnet:?')) {
    await bot.sendMessage(chatId, 'Это не похоже на magnet ссылку. Попробуйте снова.');
    return;
  }
  try {
    await addMagnetViaRtxmlrpc(text);
    awaitingMagnet.delete(chatId);
    await bot.sendMessage(chatId, 'Magnet ссылка добавлена в rTorrent.');
  } catch (err) {
    await bot.sendMessage(chatId, `Не удалось добавить magnet: ${err.message}\nУбедитесь, что доступен rtxmlrpc и настроен SCGI (RTORRENT_SCGI).`);
  }
}

async function getStatusViaRtxmlrpc() {
  // Use d.multicall2 to fetch fields for all items in main view
  const fields = [
    'd.get_hash=',
    'd.get_name=',
    'd.get_state=', // 0 stopped, 1 started
    'd.get_complete=', // 1 complete, 0 incomplete
    'd.get_completed_bytes=',
    'd.get_size_bytes=',
    'd.get_down_rate=',
    'd.get_up_rate=',
  ];
  const args = ['-p', RTORRENT_SCGI, 'd.multicall2', '', 'main', ...fields];
  const out = await execRtxmlrpc(args, { timeoutMs: 5000 });

  // rtxmlrpc output format can vary. Try to parse lines like:
  // ( "hash" "name" 1 0 123 456 0 0 ) repeated per torrent
  // We will extract quoted strings and numbers per line.
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    // Collect tokens: quoted strings or integers
    const tokens = [];
    const re = /"([^"]*)"|(-?\d+)/g;
    let m;
    while ((m = re.exec(line))) {
      if (m[1] !== undefined) tokens.push(m[1]); else tokens.push(Number(m[2]));
    }
    if (tokens.length >= fields.length) {
      const [hash, name, state, complete, doneBytes, sizeBytes, downRate, upRate] = tokens;
      items.push({ hash, name, state, complete, doneBytes, sizeBytes, downRate, upRate });
    }
  }
  return items;
}

async function handleStatusCommand(msg) {
  const chatId = msg.chat.id;
  try {
    const items = await getStatusViaRtxmlrpc();
    if (!items.length) {
      await bot.sendMessage(chatId, 'Нет активных торрентов.');
      return;
    }
    const lines = items.slice(0, 15).map((t) => {
      const pct = t.sizeBytes > 0 ? Math.floor((t.doneBytes / t.sizeBytes) * 100) : 0;
      const st = t.complete ? '✅' : (t.state ? '⬇️' : '⏸️');
      const dr = t.downRate ? `${Math.round(t.downRate / 1024)} KB/s` : '0 KB/s';
      return `${st} ${t.name}\n— ${pct}% • ${dr}`;
    });
    await bot.sendMessage(chatId, lines.join('\n\n'));
  } catch (err) {
    const hint = WATCH_DIR
      ? 'Статус требует rtxmlrpc и SCGI (RTORRENT_SCGI) для опроса.'
      : 'Проверьте установку rtxmlrpc и SCGI (RTORRENT_SCGI).';
    await bot.sendMessage(chatId, `Не удалось получить статус: ${err.message}\n${hint}`);
  }
}

// Command handlers
bot.setMyCommands([
  { command: 'download', description: 'Загрузить торрент (пришлите .torrent файл)' },
  { command: 'status', description: 'Показать статус загрузок' },
  { command: 'magnets_link', description: 'Добавить торрент по magnet ссылке' },
]);

bot.onText(/^\/start/, async (msg) => {
  const text = [
    'Привет! Я бот для загрузки торрентов через rTorrent.',
    'Команды:',
    '/download — пришлите .torrent файл для добавления',
    '/status — показать статус текущих загрузок',
    '/magnets_link — добавить торрент по magnet ссылке',
  ].join('\n');
  await bot.sendMessage(msg.chat.id, text);
});

bot.onText(/^\/download/, handleDownloadCommand);
bot.onText(/^\/status/, handleStatusCommand);
bot.onText(/^\/magnets_link/, handleMagnetsLinkCommand);

bot.on('document', handleIncomingDocument);
bot.on('text', handleIncomingText);

bot.on('message', async (msg) => {
  // Friendly nudge if they sent a file without /download
  if (msg.document && isTorrentDocument(msg) && !awaitingTorrent.get(msg.chat.id)) {
    await bot.sendMessage(msg.chat.id, 'Сначала отправьте команду /download, затем пришлите файл.');
  }
});

console.log('Bot started. Waiting for messages...');
