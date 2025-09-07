import 'dotenv/config'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import https from 'https'
import TelegramBot from 'node-telegram-bot-api'
import { addTorrentViaRqbit, addMagnetViaRqbit, getStatusViaRqbit } from './api.js'

// Настройки окружения
const BOT_TOKEN: string | undefined = process.env.BOT_TOKEN
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set. Export BOT_TOKEN and restart.')
  process.exit(1)
}
if (!process.env.RQBIT_API_BASE) {
  console.error('RQBIT_API_BASE is not set. Export RQBIT_API_BASE and restart.')
  process.exit(1)
}

// Временная папка для хранения входящих .torrent файлов перед перемещением
const TMP_DIR: string = process.env.TMP_DIR || path.join(process.cwd(), 'tmp')
await fsp.mkdir(TMP_DIR, { recursive: true })

// Простое состояние в памяти для отслеживания ожидаемых входных данных
const awaitingTorrent = new Map<number, boolean>() // chatId -> true (ожидаем .torrent документ)
const awaitingMagnet = new Map<number, boolean>() // chatId -> true (ожидаем magnet-ссылку)

const bot = new TelegramBot(BOT_TOKEN, { polling: true })

function isTorrentDocument(msg: any): boolean {
  const doc = msg.document
  if (!doc) return false
  const name = (doc.file_name || '').toLowerCase()
  const mime = (doc.mime_type || '').toLowerCase()
  return name.endsWith('.torrent') || mime === 'application/x-bittorrent'
}

function downloadFileFromTelegram(filePath: string, destPath: string): Promise<string> {
  const token = BOT_TOKEN!
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download file: HTTP ${res.statusCode}`))
          return
        }
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve(destPath)))
      })
      .on('error', (err) => {
        reject(err)
      })
  })
}

async function handleDownloadCommand(msg: TelegramBot.Message) {
  const chatId = msg.chat.id as number
  awaitingTorrent.set(chatId, true)
  await bot.sendMessage(chatId, 'Пришлите .torrent файл как документ.')
}

async function handleIncomingDocument(msg: TelegramBot.Message) {
  const chatId = msg.chat.id as number
  const expecting = awaitingTorrent.get(chatId) === true
  if (!expecting) return // игнорируем, если не запрашивали

  if (!isTorrentDocument(msg)) {
    await bot.sendMessage(chatId, 'Это не .torrent файл. Попробуйте снова.')
    return
  }

  const doc = msg.document
  try {
    const file = await bot.getFile(doc.file_id)
    const tempName = `${doc.file_unique_id || doc.file_id}.torrent`
    const tempPath = path.join(TMP_DIR, tempName)
    await downloadFileFromTelegram(file.file_path!, tempPath)

    await addTorrentViaRqbit(tempPath)

    awaitingTorrent.delete(chatId)
    await bot.sendMessage(chatId, 'Торрент принят и добавлен в rqbit.')
  } catch (err: any) {
    console.error(err)
    await bot.sendMessage(chatId, `Не удалось добавить торрент: ${err.message}`)
  }
}

async function handleMagnetsLinkCommand(msg: any) {
  const chatId = msg.chat.id as number
  awaitingMagnet.set(chatId, true)
  await bot.sendMessage(chatId, 'Отправьте magnet ссылку (начинается с magnet:? ).')
}

async function handleIncomingText(msg: any) {
  const chatId = msg.chat.id as number
  const expectingMagnet = awaitingMagnet.get(chatId) === true
  if (!expectingMagnet) return

  const text = (msg.text || '').trim()
  if (!text.toLowerCase().startsWith('magnet:?')) {
    await bot.sendMessage(chatId, 'Это не похоже на magnet ссылку. Попробуйте снова.')
    return
  }
  try {
    await addMagnetViaRqbit(text)
    awaitingMagnet.delete(chatId)
    await bot.sendMessage(chatId, 'Magnet ссылка добавлена в rqbit.')
  } catch (err: any) {
    await bot.sendMessage(chatId, `Не удалось добавить magnet: ${err.message}`)
  }
}

async function handleStatusCommand(msg: any) {
  const chatId = msg.chat.id as number
  try {
    const items = await getStatusViaRqbit()
    if (!items.length) {
      await bot.sendMessage(chatId, 'Нет активных торрентов.')
      return
    }
    const lines = items.map((t: any) => {
      let status = '✅'
      if (t.infoData.state === 'paused') status = '⏸️'
      if (t.infoData.state === 'live') status = '⬇️'
      const pct = t.infoData.total_bytes > 0 ? Math.floor((t.infoData.progress_bytes / t.infoData.total_bytes) * 100) : 0
      return `${t.id}: ${t.name} ${status} ${pct}%`
    })
    await bot.sendMessage(chatId, lines.join('\n\n'))
  } catch (err: any) {
    await bot.sendMessage(chatId, `Не удалось получить статус: ${err.message}`)
  }
}

// Обработчики команд
bot.setMyCommands([
  { command: 'download', description: 'Загрузить торрент (пришлите .torrent файл)' },
  { command: 'status', description: 'Показать статус загрузок' },
  { command: 'magnets_link', description: 'Добавить торрент по magnet ссылке' }
])

bot.onText(/^\/start/, async (msg: any) => {
  const text = [
    'Привет! Я бот для загрузки торрентов через rqbit.',
    'Команды:',
    '/download — пришлите .torrent файл для добавления',
    '/status — показать статус текущих загрузок',
    '/magnets_link — добавить торрент по magnet ссылке'
  ].join('\n')
  await bot.sendMessage(msg.chat.id, text)
})

bot.onText(/^\/download/, handleDownloadCommand)
bot.onText(/^\/status/, handleStatusCommand)
bot.onText(/^\/magnets_link/, handleMagnetsLinkCommand)

bot.on('document', handleIncomingDocument as any)
bot.on('text', handleIncomingText as any)

bot.on('message', async (msg: any) => {
  // Подсказка, если прислали файл без /download
  if (msg.document && isTorrentDocument(msg) && !awaitingTorrent.get(msg.chat.id)) {
    await bot.sendMessage(msg.chat.id, 'Сначала отправьте команду /download, затем пришлите файл.')
  }
})

console.log('Bot started. Waiting for messages...')
