require("dotenv").config();
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());

const BOT_ID = process.env.GROUPME_BOT_ID;
const BOT_NAME = process.env.BOT_NAME || "Livestock Bot";
const NEWS_API_KEY = process.env.NEWS_API_KEY;

// Setup Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction: `You are an expert livestock and commodities market assistant in a GroupMe group chat.
You specialize in Live Cattle, Feeder Cattle, Lean Hogs, Class III Milk, and Butter futures.
You can explain market trends, contract specs, and trading strategies.
Keep responses concise (under 1000 characters). Be friendly and conversational.
When given live futures data or news, summarize it in a clear helpful way.`,
});

const chatSessions = {};

// Livestock futures tickers on Yahoo Finance
const LIVESTOCK_TICKERS = {
  "live cattle": "LE=F",
  "cattle": "LE=F",
  "feeder cattle": "GF=F",
  "feeder": "GF=F",
  "lean hogs": "HE=F",
  "hogs": "HE=F",
  "milk": "DC=F",
  "class iii milk": "DC=F",
  "butter": "CB=F",
};

// ── Send message to GroupMe ──────────────────────────────────────
async function sendGroupMeMessage(text) {
  const res = await fetch("https://api.groupme.com/v3/bots/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_id: BOT_ID, text }),
  });
  if (!res.ok) console.error("GroupMe send error:", await res.text());
}

// ── Chunk long messages ──────────────────────────────────────────
function chunkMessage(text, maxLen = 950) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf(". ", maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt === -1) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }
  return chunks;
}

// ── Fetch futures price from Yahoo Finance ───────────────────────
async function getFuturesPrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const change = meta.regularMarketPrice - meta.chartPreviousClose;
    const changePct = (change / meta.chartPreviousClose) * 100;
    return {
      ticker,
      price: meta.regularMarketPrice?.toFixed(2),
      prev: meta.chartPreviousClose?.toFixed(2),
      change: change.toFixed(2),
      changePct: changePct.toFixed(2),
      currency: meta.currency || "USD",
    };
  } catch (err) {
    console.error("Futures fetch error:", err.message);
    return null;
  }
}

// ── Fetch all livestock prices ───────────────────────────────────
async function getAllLivestockPrices() {
  const tickers = [
    { name: "Live Cattle", ticker: "LE=F" },
    { name: "Feeder Cattle", ticker: "GF=F" },
    { name: "Lean Hogs", ticker: "HE=F" },
    { name: "Class III Milk", ticker: "DC=F" },
    { name: "Butter", ticker: "CB=F" },
  ];
  const results = await Promise.all(
    tickers.map(async (t) => {
      const data = await getFuturesPrice(t.ticker);
      return { name: t.name, data };
    })
  );
  return results.filter((r) => r.data !== null);
}

// ── Fetch news ───────────────────────────────────────────────────
async function getNews(query) {
  try {
    if (!NEWS_API_KEY) return null;
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=3&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.articles || data.articles.length === 0) return null;
    return data.articles.slice(0, 3).map((a) => `• ${a.title} (${a.source.name})`).join("\n");
  } catch (err) {
    console.error("News fetch error:", err.message);
    return null;
  }
}

// ── Detect intent ────────────────────────────────────────────────
function detectIntent(message) {
  const msg = message.toLowerCase();

  // Check for "all prices" or "market update"
  if (msg.includes("all prices") || msg.includes("market update") || msg.includes("all futures") || msg.includes("all livestock")) {
    return { type: "all_livestock" };
  }

  // Check for specific livestock
  for (const [keyword, ticker] of Object.entries(LIVESTOCK_TICKERS)) {
    if (msg.includes(keyword)) {
      return { type: "livestock", ticker, name: keyword };
    }
  }

  // Check for any stock ticker
  const stockMatch = msg.match(/\b([a-z]{1,5})\s*(stock|price|futures|quote)\b/);
  if (stockMatch) {
    const ticker = stockMatch[1].toUpperCase();
    const ignore = ["THE", "FOR", "AND", "HOW", "WHAT", "IS", "OF", "A"];
    if (!ignore.includes(ticker)) return { type: "stock", ticker };
  }

  // News
  const newsMatch = msg.match(/news\s+(?:about|on)?\s+(.+)/) ||
                    msg.match(/latest\s+(?:news\s+)?(?:about|on)?\s+(.+)/);
  if (newsMatch) return { type: "news", query: newsMatch[1].trim() };

  return { type: "chat" };
}

// ── Main webhook ─────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const { name, text, sender_type, group_id } = req.body;
  if (sender_type === "bot") return;
  if (!text || text.trim() === "") return;

  const groupId = group_id || "default";
  const userMessage = text.trim();
  console.log(`[${new Date().toISOString()}] ${name}: ${userMessage}`);

  const botMentioned =
    userMessage.toLowerCase().includes("@ai") ||
    userMessage.toLowerCase().includes(BOT_NAME.toLowerCase()) ||
    process.env.RESPOND_TO_ALL === "true";
  if (!botMentioned) return;

  if (!chatSessions[groupId]) {
    chatSessions[groupId] = model.startChat({ history: [] });
  }

  try {
    const intent = detectIntent(userMessage);
    let prompt = `${name} says: ${userMessage}`;

    if (intent.type === "all_livestock") {
      const prices = await getAllLivestockPrices();
      if (prices.length > 0) {
        const lines = prices.map((p) => {
          const dir = parseFloat(p.data.change) >= 0 ? "📈" : "📉";
          return `${p.name}: $${p.data.price} (${parseFloat(p.data.changePct) >= 0 ? "+" : ""}${p.data.changePct}%) ${dir}`;
        }).join("\n");
        prompt = `${name} wants a livestock market update. Here are the live futures prices:\n${lines}\nSummarize this in a friendly helpful way.`;
      }
    }

    else if (intent.type === "livestock") {
      const data = await getFuturesPrice(intent.ticker);
      if (data) {
        const dir = parseFloat(data.change) >= 0 ? "📈" : "📉";
        prompt = `${name} asked about ${intent.name} futures. Live data:
Price: $${data.price}
Change: ${parseFloat(data.change) >= 0 ? "+" : ""}${data.change} (${parseFloat(data.changePct) >= 0 ? "+" : ""}${data.changePct}%) ${dir}
Previous Close: $${data.prev}
Summarize this in a friendly way and add any relevant market context.`;
      }
    }

    else if (intent.type === "stock") {
      const data = await getFuturesPrice(intent.ticker);
      if (data) {
        const dir = parseFloat(data.change) >= 0 ? "📈" : "📉";
        prompt = `${name} asked about ${intent.ticker}. Live price: $${data.price}, Change: ${data.change} (${data.changePct}%) ${dir}. Summarize this.`;
      }
    }

    else if (intent.type === "news") {
      const news = await getNews(intent.query);
      if (news) {
        prompt = `${name} asked for news about "${intent.query}". Latest headlines:\n${news}\nSummarize in a friendly way.`;
      }
    }

    const result = await chatSessions[groupId].sendMessage(prompt);
    const aiReply = result.response.text();

    const chunks = chunkMessage(aiReply);
    for (const chunk of chunks) {
      await sendGroupMeMessage(chunk);
      if (chunks.length > 1) await new Promise((r) => setTimeout(r, 500));
    }

    console.log(`[BOT REPLY] ${aiReply.slice(0, 100)}`);
  } catch (err) {
    console.error("Bot error:", err.message);
    await sendGroupMeMessage("Sorry, I ran into an error. Try again!");
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Livestock AI Bot is running!", bot: BOT_NAME });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐄 ${BOT_NAME} running on port ${PORT}`));
