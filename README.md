Telegram rTorrent Bot (Node.js)

Features
- /download: asks for a .torrent file and adds it to rTorrent
- /status: shows progress for current torrents (via rtxmlrpc)
- /magnets_link: adds torrent via magnet link (requires rtxmlrpc)

Prerequisites
- Node.js 18+
- A running rTorrent instance
  - Option A (recommended): rTorrent watch directory enabled (WATCH_DIR)
  - Option B: rtxmlrpc installed and rTorrent SCGI enabled (RTORRENT_SCGI)

Environment
- BOT_TOKEN: Telegram bot token from @BotFather
- WATCH_DIR: Path to rTorrent watch directory (optional, recommended)
- RTORRENT_SCGI: Host:port to rTorrent SCGI (default: 127.0.0.1:5000)
- TMP_DIR: Temp folder for incoming files (default: ./tmp)

.env file
- Copy `.env.example` to `.env` and fill values
  - cp .env.example .env
  - Edit `.env` with your token and paths

Install
1) npm install
2) export BOT_TOKEN=xxxx
3) Option A (watch dir): export WATCH_DIR=/path/to/watch
   - Ensure rTorrent is configured to watch this directory
4) Option B (rtxmlrpc): install rtxmlrpc and export RTORRENT_SCGI=127.0.0.1:5000

Note: The app also loads environment variables from a local `.env` via `dotenv`.

Run
- npm start

Notes
- /download uses WATCH_DIR if set; otherwise it attempts to add via rtxmlrpc.
- /status requires rtxmlrpc + SCGI. If unavailable, a helpful error is shown.
- The bot expects .torrent files sent as “document”, not as “photo” or “file compressed”.
- /magnets_link requires rtxmlrpc + SCGI; watch directory cannot be used for magnets.
