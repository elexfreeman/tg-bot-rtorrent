import path from 'path';

// Lightweight adapter around node-libtorrent
// Exposes: init, addTorrentFile, addMagnet, getStatus

let lt = null;
let session = null;

export async function initLibtorrent({ downloadDir }) {
  if (session) return session;
  try {
    // Dynamic import to allow startup message if not installed
    lt = await import('node-libtorrent');
    // Some bindings export via default, others as namespace
    lt = lt?.default || lt;
  } catch (e) {
    throw new Error('node-libtorrent не установлен. Установите пакет и системные зависимости libtorrent.');
  }

  // Create libtorrent session and listen on common ports
  // API aligns with libtorrent C++ bindings exposed to Node.
  try {
    session = new lt.session();
    // Try to enable incoming connections
    if (typeof session.listen_on === 'function') {
      session.listen_on(6881, 6891);
    }
    // Ensure DHT/UPnP/NAT-PMP enabled if available
    if (typeof session.start_dht === 'function') session.start_dht();
    if (typeof session.start_upnp === 'function') session.start_upnp();
    if (typeof session.start_lsd === 'function') session.start_lsd();
  } catch (e) {
    throw new Error(`Не удалось инициализировать libtorrent: ${e.message}`);
  }

  // Resolve download dir once; adapter accepts per-call override too
  session.__default_save_path = downloadDir;
  return session;
}

export function ensureSession() {
  if (!session) throw new Error('libtorrent сессия не инициализирована');
  return session;
}

export function addTorrentFile(filePath, { savePath } = {}) {
  const ses = ensureSession();
  const target = savePath || ses.__default_save_path || process.cwd();

  try {
    const ti = new lt.torrent_info(filePath);
    const p = new lt.add_torrent_params();
    p.ti = ti;
    p.save_path = path.resolve(target);
    const handle = ses.add_torrent(p);
    return handle;
  } catch (e) {
    throw new Error(`Ошибка добавления .torrent: ${e.message}`);
  }
}

export function addMagnet(uri, { savePath } = {}) {
  const ses = ensureSession();
  const target = savePath || ses.__default_save_path || process.cwd();

  try {
    // Prefer parse_magnet_uri + add_torrent for better control
    const p = new lt.add_torrent_params();
    if (typeof lt.parse_magnet_uri === 'function') {
      lt.parse_magnet_uri(uri, p);
      p.save_path = path.resolve(target);
      const handle = ses.add_torrent(p);
      return handle;
    }
    // Fallback to helper if binding exposes it
    if (typeof lt.add_magnet_uri === 'function') {
      return lt.add_magnet_uri(ses, uri, { save_path: path.resolve(target) });
    }
    throw new Error('Биндинги не поддерживают parse_magnet_uri/add_magnet_uri');
  } catch (e) {
    throw new Error(`Ошибка добавления magnet: ${e.message}`);
  }
}

export function getStatus() {
  const ses = ensureSession();
  const out = [];
  if (typeof ses.get_torrents !== 'function') return out;
  for (const h of ses.get_torrents()) {
    try {
      const s = h.status ? h.status() : null;
      if (!s) continue;
      const name = s.name || (h.name ? h.name() : '');
      const size = s.total_wanted || s.total || 0;
      const done = s.total_wanted_done || s.total_done || Math.round((s.progress || 0) * size);
      const downRate = s.download_rate || 0;
      const upRate = s.upload_rate || 0;
      const complete = !!(s.is_seeding || s.is_finished || (s.state === 5));
      const state = s.state ?? (complete ? 5 : (downRate > 0 ? 3 : 0));
      out.push({ name, sizeBytes: size, doneBytes: done, downRate, upRate, complete, state });
    } catch {
      // ignore broken handle
    }
  }
  return out;
}

