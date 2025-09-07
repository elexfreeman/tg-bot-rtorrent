import fsp from 'fs/promises'
import {TorrentI, TorrentListRespI, TorrentStatusI} from './apiTypes.js'

const RQBIT_API_BASE: string = (process.env.RQBIT_API_BASE || '').replace(/\/$/, '')
const RQBIT_API_TOKEN: string = process.env.RQBIT_API_TOKEN || ''
const TORRENT_DOWNLOAD_FOLDER: string | undefined = process.env.TORRENT_DOWNLOAD_FOLDER

function rqbitHeaders(extra?: Record<string, string>) {
  const headers = Object.assign({ Accept: 'application/json' }, extra || {}) as Record<string, string>
  if (RQBIT_API_TOKEN) headers['Authorization'] = `Bearer ${RQBIT_API_TOKEN}`
  return headers
}

async function rqbitFetch(pathname: string, init: RequestInit = {}) {
  const url = `${RQBIT_API_BASE}${pathname.startsWith('/') ? '' : '/'}${pathname}`
  const res = await fetch(url, { ...init, headers: rqbitHeaders((init.headers as any) || {}) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`rqbit API error ${res.status}: ${text || res.statusText}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) return res.json()
  return res.text()
}

export async function addTorrentViaRqbit(filePath: string) {
  const url = `${RQBIT_API_BASE}/torrents?&overwrite=true&only_files=0&initial_peers=&output_folder=${encodeURIComponent(
    TORRENT_DOWNLOAD_FOLDER || ''
  )}`
	const buf: any = await fsp.readFile(filePath)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-bittorrent' },
    body: buf
  })
  if (res.status !== 200) {
    throw new Error('Ошибка обработки торрент файла')
  }
}

export async function addMagnetViaRqbit(magnetLink: string) {
  if (!magnetLink || !magnetLink.toLowerCase().startsWith('magnet:?')) {
    throw new Error('Неверная ссылка magnet.')
  }
  const url = `${RQBIT_API_BASE}/torrents?&overwrite=true&only_files=0&initial_peers=&output_folder=${encodeURIComponent(
    TORRENT_DOWNLOAD_FOLDER || ''
  )}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: magnetLink
  })
  if (res.status !== 200) {
    throw new Error('Не удалось добавить magnet в rqbit API')
  }
}

const getTorrentList = async (): Promise<TorrentI[]> => {
  const url = '/torrents'
  try {
    const result: TorrentListRespI = await rqbitFetch(url, { method: 'GET' })
    return Array.isArray(result?.torrents) ? result.torrents : []
  } catch (e: any) {
    throw e || new Error('rqbit API ошибка получения списка торрентов')
  }
}

const getTorrentStatusById = async (torrentId: number): Promise<TorrentStatusI> => {
  const url = `torrents/${torrentId}/stats/v1`
  try {
    let data =  await rqbitFetch(url, { method: 'GET' })
		return data;
  } catch (e: any) {
    throw e || new Error('rqbit API ошибка получения статуса торрента')
  }
}

export async function getStatusViaRqbit(): Promise<TorrentI[]> {
  try {
		const torrentList = await getTorrentList()
    for (const torrent of torrentList) {
      torrent.infoData = await getTorrentStatusById(torrent.id)
    }
    return torrentList
  } catch (e: any) {
    throw e || new Error('rqbit API недоступен для получения статуса')
  }
}

