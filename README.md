Telegram rqbit Bot (Node.js)

Features
- /download: send a .torrent file — bot adds it to rqbit
- /status: shows progress for current torrents via rqbit HTTP API
- /magnets_link: adds torrent via magnet link

Prerequisites
- Node.js 18+
- A running rqbit instance with HTTP API enabled (and reachable from the bot)

Environment
- BOT_TOKEN: Telegram bot token from @BotFather
- RQBIT_API_BASE: Base URL of rqbit HTTP API (e.g. http://127.0.0.1:3030)
- RQBIT_API_TOKEN: Optional bearer token for rqbit API (if configured)
- TORRENT_DOWNLOAD_FOLDER: Path where rqbit writes downloaded data
- TMP_DIR: Temp folder for incoming files (default: ./tmp)

.env file
- Copy `.env.example` to `.env` and fill values
  - cp .env.example .env
  - Edit `.env` with your token and rqbit API base URL

Install
1) npm install
2) npm i -D typescript @types/node
3) export BOT_TOKEN=xxxx
4) export RQBIT_API_BASE=http://127.0.0.1:3030
   - Ensure rqbit is running with HTTP API enabled and accessible

Note: The app also loads environment variables from a local `.env` via `dotenv`.

Run
- Build: `npm run build`
- Start: `npm start` (runs built `dist/bot.js`)
- Dev (watch types): `npm run dev` (then run `npm start` in another terminal)

Notes
- The bot expects .torrent files sent as “document”, not as “photo” or archives.
- rqbit API paths vary by version. This bot uses `/torrents`, `/torrents/{id}/stats/v1` endpoints; adjust if yours differ.
- Project is now in TypeScript; compiled JS is in `dist/`.
