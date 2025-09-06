import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import https from 'https';
import TelegramBot from 'node-telegram-bot-api';

// Environment configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const TORRENT_DOWNLOAD_FOLDER = process.env.TORRENT_DOWNLOAD_FOLDER;
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
// rqbit HTTP API configuration
const RQBIT_API_BASE = (process.env.RQBIT_API_BASE || '').replace(/\/$/, '');
const RQBIT_API_TOKEN = process.env.RQBIT_API_TOKEN || '';

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
		console.log('tempPath',tempPath, tempName );
    await downloadFileFromTelegram(file.file_path, tempPath);

    await addTorrentViaRqbit(tempPath, tempName);

    awaitingTorrent.delete(chatId);
    await bot.sendMessage(chatId, 'Торрент принят и добавлен в rqbit.');
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
    await addMagnetViaRqbit(text);
    awaitingMagnet.delete(chatId);
    await bot.sendMessage(chatId, 'Magnet ссылка добавлена в rqbit.');
  } catch (err) {
    await bot.sendMessage(chatId, `Не удалось добавить magnet: ${err.message}`);
  }
}

async function handleStatusCommand(msg) {
  const chatId = msg.chat.id;
  try {
    const items = await getStatusViaRqbit();
    if (!items.length) {
      await bot.sendMessage(chatId, 'Нет активных торрентов.');
      return;
    }
		/*
			*
			* {
    id: 0,
    info_hash: 'ecfb270544a6935f959e75a7dd4303664c08b950',
    name: 'Adobe Photoshop 2023 24.7.4.1251 RePack by KpoJIuK.exe',
    output_folder: '../1/',
    infoData: {
      state: 'paused',
      file_progress: [Array],
      error: null,
      progress_bytes: 571154421,
      uploaded_bytes: 0,
      total_bytes: 3279626229,
      finished: false,
      live: null
    }
  }
			*
			* */
    const lines = items.map((t) => {

      //const pct = t.sizeBytes > 0 ? Math.floor((t.doneBytes / t.sizeBytes) * 100) : 0;
      //const st = t.complete ? '✅' : (t.state ? '⬇️' : '⏸️');
      //const dr = t.downRate ? `${Math.round(t.downRate / 1024)} KB/s` : '0 KB/s';
			let status = '✅';
			if(t.infoData.state === 'paused') {
				status = '⏸️';
			}
			if(t.infoData.state === 'live') {
				status = '⬇️';
			}
      const pct = t.infoData.total_bytes > 0 ? Math.floor((t.infoData.progress_bytes / t.infoData.total_bytes) * 100) : 0;

			return `${t.id}: ${t.name} ${status} ${pct}`;
    });
    await bot.sendMessage(chatId, lines.join('\n\n'));
  } catch (err) {
    await bot.sendMessage(chatId, `Не удалось получить статус: ${err.message}`);
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
    'Привет! Я бот для загрузки торрентов через rqbit.',
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
// rqbit functions added at end to ensure availability
// (Definitions)

function rqbitHeaders(extra) {
  const headers = Object.assign({ Accept: 'application/json' }, extra || {});
  if (RQBIT_API_TOKEN) headers['Authorization'] = `Bearer ${RQBIT_API_TOKEN}`;
  return headers;
}

async function rqbitFetch(pathname, init = {}) {
  if (!RQBIT_API_BASE) throw new Error('RQBIT_API_BASE is not configured');
  const url = `${RQBIT_API_BASE}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
  const res = await fetch(url, { ...init, headers: rqbitHeaders(init.headers || {}) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rqbit API error ${res.status}: ${text || res.statusText}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

async function addTorrentViaRqbit(filePath) {
	let res;
  const url = `${RQBIT_API_BASE}/torrents?&overwrite=true&only_files=0&initial_peers=&output_folder=${TORRENT_DOWNLOAD_FOLDER}`;
  const buf = await fsp.readFile(filePath);
		 res = await fetch(url, {
			method: "POST",
			// для .torrent корректный тип:
			headers: { "Content-Type": "application/x-bittorrent" },
			body: buf
		});
		if(res.status !== 200) {
			throw 'Ошибка обработки торент файла';
		}

	return res;
}

async function addMagnetViaRqbit(magnetLink) {
  if (!magnetLink || !magnetLink.toLowerCase().startsWith('magnet:?')) {
    throw new Error('Неверная ссылка magnet.');
  }
  const url = `${RQBIT_API_BASE}/torrents?&overwrite=true&only_files=0&initial_peers=&output_folder=${TORRENT_DOWNLOAD_FOLDER}`;
	 const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: magnetLink
	});
	if(res.status !== 200) {
		throw new Error('Не удалось добавить magnet в rqbit API');
	}
}

const getTorrentList = async () => {
  const url = '/torrents';
  let lastErr;
	let data = [];
    try {
      data = (await rqbitFetch(url, { method: 'GET' })).torrents
    } catch (e) {
      lastErr = e;
  throw lastErr || new Error('rqbit API ошибка получения списка торенов');
  }
  return data;
}

const getTorrentStatusById = async (torrentId) => {
  const url = `torrents/${torrentId}/stats/v1`;
  let lastErr;
	let data = [];
    try {
      data = await rqbitFetch(url, { method: 'GET' });
    } catch (e) {
      lastErr = e;
  throw lastErr || new Error('rqbit API ошибка получения списка торенов');
  }
  return data;
}

async function getStatusViaRqbit() {
  let lastErr;
	let torrentList = [];
    try {
			torrentList = await getTorrentList();
			for(let torrent of torrentList) {
				torrent.infoData = await getTorrentStatusById(torrent.id);
			}
    } catch (e) {
      lastErr = e;
			throw lastErr || new Error('rqbit API недоступен для получения статуса');
  }
  return torrentList;
}
