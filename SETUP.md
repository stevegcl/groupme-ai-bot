# GroupMe AI Chatbot — Setup Guide

A free AI chatbot for GroupMe powered by Claude. No SMS fees, no Twilio required.
GroupMe gives your bot a phone number automatically via the app.

---

## What You Need (All Free)

| Thing | Where | Cost |
|---|---|---|
| GroupMe account | groupme.com | Free |
| Anthropic API key | console.anthropic.com | Free tier available |
| Hosting | Railway or Render | Free tier |
| GitHub account | github.com | Free |

---

## Step 1: Create Your GroupMe Bot

1. Go to **https://dev.groupme.com** and log in
2. Click **"Bots"** → **"Create Bot"**
3. Choose a GroupMe group to add it to (create a new group if needed)
4. Set:
   - **Bot Name**: Whatever you want (e.g. "AI Assistant")
   - **Callback URL**: Leave blank for now — you'll fill this in after deploying
   - **Avatar URL**: Optional bot profile picture
5. Click **Submit** — copy the **Bot ID** shown on the next page

---

## Step 2: Get Your Anthropic API Key

1. Go to **https://console.anthropic.com**
2. Sign up / log in
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-...`)

---

## Step 3: Deploy to Railway (Free)

1. Push this project to a GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   gh repo create groupme-ai-bot --public --push
   ```

2. Go to **https://railway.app** → **New Project** → **Deploy from GitHub**

3. Select your repo

4. Add environment variables in Railway dashboard:
   ```
   GROUPME_BOT_ID=your_bot_id
   ANTHROPIC_API_KEY=sk-ant-...
   BOT_NAME=AI Assistant
   RESPOND_TO_ALL=false
   ```

5. Railway will give you a public URL like `https://groupme-ai-bot.up.railway.app`

---

## Step 4: Connect the Webhook

1. Go back to **https://dev.groupme.com/bots**
2. Click **Edit** on your bot
3. Set **Callback URL** to: `https://YOUR-RAILWAY-URL.railway.app/webhook`
4. Save

---

## Step 5: Test It!

In your GroupMe group, type:
```
@ai What's the weather like today?
```

The bot will respond! 🎉

---

## Customization

### Change who the bot responds to

**Edit `.env`:**
- `RESPOND_TO_ALL=true` → bot replies to every single message
- `RESPOND_TO_ALL=false` → bot only replies when someone says `@ai` or the bot's name

### Change the bot's personality

**Edit `index.js`**, find `SYSTEM_PROMPT` and rewrite it:
```js
const SYSTEM_PROMPT = `You are a sarcastic but helpful assistant named Rex. 
You love making jokes but always answer the question eventually.`;
```

### Livestock / finance bot
Since you've been building livestock futures bots, change the system prompt to:
```js
const SYSTEM_PROMPT = `You are an expert in livestock commodities markets.
You can discuss Live Cattle (LE), Feeder Cattle (GF), Lean Hogs (HE), 
Class III Milk (DC), and Butter (CB) futures. Help users understand 
market trends, contract specs, and trading strategies.`;
```

---

## Alternative: Deploy to Render (also free)

1. Go to **https://render.com** → **New Web Service**
2. Connect your GitHub repo
3. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
4. Add the same environment variables
5. Use the Render URL as your GroupMe callback URL

---

## How It Works

```
User sends message in GroupMe
        ↓
GroupMe POSTs to your /webhook
        ↓
Server checks if bot is mentioned (@ai or bot name)
        ↓
Sends conversation history to Claude API
        ↓
Claude responds
        ↓
Server POSTs reply to GroupMe bot endpoint
        ↓
Message appears in group chat
```

The bot remembers the last 20 messages of conversation per group, so it has context.
