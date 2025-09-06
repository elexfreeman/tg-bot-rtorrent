import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import https from 'https';
import TelegramBot from 'node-telegram-bot-api';
import { initLibtorrent, addTorrentFile, addMagnet, getStatus as ltGetStatus } from './libtorrent.js';

// Environment configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set. Export BOT_TOKEN and restart.');
  process.exit(1);
}

// libtorrent options
// DOWNLOAD_DIR: folder where files will be saved by libtorrent
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'download');

// Temp directory for storing incoming .torrent files before moving
const TMP_DIR = process.env.TMP_DIR || path.join(process.cwd(), 'tmp');
await fsp.mkdir(TMP_DIR, { recursive: true });
await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });

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

// Initialize libtorrent session
await initLibtorrent({ downloadDir: DOWNLOAD_DIR });

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

    // Add via libtorrent
    await addTorrentFile(tempPath, { savePath: DOWNLOAD_DIR });
    awaitingTorrent.delete(chatId);
    await bot.sendMessage(chatId, `Торрент принят и добавлен в libtorrent.`);
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
    await addMagnet(text, { savePath: DOWNLOAD_DIR });
    awaitingMagnet.delete(chatId);
    await bot.sendMessage(chatId, 'Magnet ссылка добавлена в libtorrent.');
  } catch (err) {
    await bot.sendMessage(chatId, `Не удалось добавить magnet: ${err.message}`);
  }
}

async function handleStatusCommand(msg) {
  const chatId = msg.chat.id;
  try {
    const items = ltGetStatus();
    if (!items.length) {
      await bot.sendMessage(chatId, 'Нет активных торрентов.');
      return;
    }
    const lines = items.slice(0, 15).map((t) => {
      const pct = t.sizeBytes > 0 ? Math.floor((t.doneBytes / t.sizeBytes) * 100) : 0;
      const st = t.complete ? '✅' : (t.downRate > 0 ? '⬇️' : '⏸️');
      const dr = t.downRate ? `${Math.round(t.downRate / 1024)} KB/s` : '0 KB/s';
      return `${st} ${t.name}\n— ${pct}% • ${dr}`;
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
    'Привет! Я бот для загрузки торрентов (node-libtorrent).',
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
