# DevTrack Discord Bot

Watches your Discord forum channels and automatically posts new threads to the DevTrack API.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure .env
The `.env` file is pre-filled with your token and channel IDs. You just need to set `BOT_SECRET` to match what's in your backend `.env`:

```
BOT_SECRET="your-bot-secret-here"
```

### 3. Add BOT_SECRET to your backend
In your `devtrack-backend/.env`, add:
```
BOT_SECRET="some-long-random-string"
```
Use the same value in both places. Generate one with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Make sure your backend is running
```bash
# In the devtrack-backend folder:
npm run dev
```

### 5. Start the bot
```bash
# In this folder:
npm run dev
```

You should see:
```
DevTrack Bot online as DevTrack Bot#1234
Watching channels:
  Bug Reports  → 1497235230116024351
  Suggestions  → 1497235317218873484
  API          → http://localhost:3001
```

## What happens when someone posts

1. User creates a new thread in `#bug-reports` or `#suggestions`
2. Bot detects it instantly via Discord gateway
3. Bot reads the title, content, and any attached images/videos
4. Bot auto-detects priority (critical/high/medium/low) from keywords
5. Bot auto-tags the report (mobile, auth, api, ui, etc.)
6. Bot downloads attachments and sends everything to your API
7. API stores it all in PostgreSQL
8. Bot reacts with ✅ and posts a confirmation reply in the thread
9. Report appears in your DevTrack dashboard immediately

## Discord Bot Permissions Required
- Read Messages / View Channels
- Send Messages
- Read Message History
- Add Reactions
- `MESSAGE_CONTENT` intent must be enabled in the Discord Developer Portal

## Enabling MESSAGE_CONTENT Intent
Go to discord.com/developers/applications → your app → Bot tab → scroll to "Privileged Gateway Intents" → enable **Message Content Intent** → Save.

## Deployment
To run 24/7, deploy alongside your backend on Railway:
1. Push this folder to GitHub
2. New service in Railway → Deploy from GitHub → select this repo
3. Add the same environment variables in Railway's dashboard
4. Change `API_URL` to your Railway backend URL (not localhost)
