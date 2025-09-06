Telegram Torrent Bot (node-libtorrent)

Features
- /download: send a .torrent file and it’s added to libtorrent
- /status: shows progress for current torrents (via libtorrent session)
- /magnets_link: adds torrent via magnet link

Prerequisites
- Node.js 18+
- node-libtorrent npm package and system libtorrent installed
  - Install libtorrent-rasterbar on your OS (e.g., via brew/apt)
  - npm i node-libtorrent

Environment
- BOT_TOKEN: Telegram bot token from @BotFather
- DOWNLOAD_DIR: Path where libtorrent will save data (default: ./download)
- TMP_DIR: Temp folder for incoming files (default: ./tmp)

.env file
- Copy `.env.example` to `.env` and fill values
  - cp .env.example .env
  - Edit `.env` with your token and paths

Install
1) Install system libtorrent-rasterbar (varies by OS)
2) npm install
3) npm install node-libtorrent
4) export BOT_TOKEN=xxxx
5) Optionally export DOWNLOAD_DIR=/path/to/save

Note: The app also loads environment variables from a local `.env` via `dotenv`.

Run
- npm start

Notes
- The bot expects .torrent files sent as “document”, not as “photo” or “compressed”.
- If node-libtorrent is not installed or fails to load, the bot will report a clear error.
