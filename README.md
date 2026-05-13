# 🪼 JellyBot

A Discord bot for **watch parties** powered by your Jellyfin server.

---

## 📦 Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it "JellyBot"
3. Go to **Bot** tab → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - Server Members Intent
   - Message Content Intent
5. Copy your **Bot Token**
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Use Slash Commands`, `Read Message History`
7. Use the generated URL to invite the bot to your server

### 3. Set environment variable

**Linux/Mac:**
```bash
export DISCORD_TOKEN=your_bot_token_here
node index.js
```

**Windows:**
```cmd
set DISCORD_TOKEN=your_bot_token_here
node index.js
```

**Or create a `.env` file** (install `dotenv` and add `require('dotenv').config()` to top of index.js):
```env
DISCORD_TOKEN=your_bot_token_here
```

---

## ⚙️ First-time Discord Configuration

Once the bot is in your server, run this command **as a server admin**:

```
/config server_url:http://YOUR_JELLYFIN_IP:8096 api_token:YOUR_TOKEN
```

**OR with username/password:**
```
/config server_url:http://192.168.1.10:8096 username:admin password:yourpass
```

To get your Jellyfin API token:
1. Open Jellyfin web UI
2. Go to **Dashboard → API Keys**
3. Click **+** to generate a new key

---

## 🎮 All Commands

| Command | Description |
|---------|-------------|
| `/config` | ⚙️ Set Jellyfin server URL + credentials (admin only) |
| `/status` | 📡 Check server connection |
| `/search <query>` | 🔍 Search for movies, shows, music |
| `/recent` | 🆕 Show recently added media |
| `/libraries` | 📚 List all media libraries |
| `/info <item_id>` | ℹ️ Get details about a specific item |
| `/watch <item_id>` | 🎬 Start a watch party |
| `/party` | 👥 Show current party status & controls |
| `/join` | 👋 Join the active watch party |
| `/leave` | 🚪 Leave the watch party |
| `/pause` | ⏸️ Pause (notifies all members) |
| `/resume` | ▶️ Resume (notifies all members) |
| `/stop` | ⏹️ End the watch party |
| `/stream <item_id>` | 🔗 Get direct stream links |
| `/nowplaying` | 📺 See active playback sessions |
| `/help` | ❓ Show all commands |

---

## 💡 How Watch Parties Work

JellyBot is a **coordination bot** — it syncs people via Discord messages, not by controlling their players directly.

1. Host runs `/search batman` → picks a movie from the dropdown
2. Bot posts stream link + watch party panel
3. Members click **Join** or run `/join`
4. Host clicks **Pause/Resume** → bot pings all members to pause/resume
5. Everyone watches at the same time in their own player (browser, VLC, Jellyfin app, etc.)

---

## 🐳 Docker (optional)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "index.js"]
```

```bash
docker build -t jellybot .
docker run -e DISCORD_TOKEN=your_token jellybot
```

---

## 🗂️ Config Storage

Server configs are stored in `config.json` in the bot directory. Each Discord server has its own Jellyfin configuration, so you can run one bot for multiple servers.

---

Made with 🪼 — powered by [Jellyfin](https://jellyfin.org)
