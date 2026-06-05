require("dotenv").config();
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const BOT_ID = process.env.GROUPME_BOT_ID;
const BOT_NAME = process.env.BOT_NAME || "Livestock Bot";
const NEWS_API_KEY = process.env.NEWS_API_KEY;

// Setup Claude (primary)
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Setup Gemini (backup)
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;
const geminiModel = genAI
  ? genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: `You are an expert livestock and commodities market assistant in a GroupMe group chat.
You specialize in Live Cattle, Feeder Cattle, Lean Hogs, Class III Milk, and Butter futures.
Keep responses concise (under 1000 characters). Be friendly and conversational.
When given live futures data or news, summarize it in a clear helpful way.`,
    })
  : null;

const geminiSessions = {};
const claudeHistory = {};

const SYSTEM_PROMPT = `You are a helpful, friendly AI assistant in a GroupMe group chat.
You specialize in livestock and commodities markets but can answer ANY question on any topic.
Keep responses concise (under 1000 characters). Be friendly and conversational.
When given live futures data or news, summarize it in a clear helpful way.`;

// Livestock futures tickers
const LIVESTOCK_TICKERS = {
  "live cattle": "LE=F",
  "cattle": "LE=F",
  "le": "LE=F",
  "feeder cattle": "GF=F",
  "feeder": "GF=F",
  "gf": "GF=F",
  "lean hogs": "HE=F",
  "hogs": "HE=F",
  "he": "HE=F",
  "milk": "DC=F",
  "class iii milk": "DC=F",
  "dc": "DC=F",
  "butter": "CB=F",
  "cb": "CB=F",
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

  if (msg.includes("all prices") || msg.includes("market update") || msg.includes("all futures") || msg.includes("all livestock")) {
    return { type: "all_livestock" };
  }

  for (const [keyword, ticker] of Object.entries(LIVESTOCK_TICKERS)) {
    if (msg.includes(keyword)) {
      return { type: "livestock", ticker, name: keyword };
    }
  }

 const stockMatch = msg.match(/\b([a-z]{1,5})\s*(stock|price|futures|quote)?\b/);
  if (stockMatch) {
    const ticker = stockMatch[1].toUpperCase();
    const ignore = ["THE", "FOR", "AND", "HOW", "WHAT", "IS", "OF", "A", "HI", "HEY", "LOL", "YES", "NO", "CAN", "YOU", "GIVE", "MORE", "STEP", "PLUG", "TIRE", "DOES", "WHY", "WHO", "GET", "PUT", "SET", "LET", "DID", "HAS", "HAD", "ARE", "WAS", "NOT", "BUT", "ITS", "ALL", "OUT", "NEW", "NOW", "OLD", "TOO", "USE", "DO", "TO", "IN", "IT", "MY", "ME", "UP", "SO", "IF", "GO", "ON", "AT", "BE", "BY", "OR", "AN"];
    if (!ignore.includes(ticker) && ticker.length >= 2) return { type: "stock", ticker };
  }

  const newsMatch = msg.match(/news\s+(?:about|on)?\s+(.+)/) ||
                    msg.match(/latest\s+(?:news\s+)?(?:about|on)?\s+(.+)/);
  if (newsMatch) return { type: "news", query: newsMatch[1].trim() };

  return { type: "chat" };
}

// ── Ask Claude ───────────────────────────────────────────────────
async function askClaude(groupId, prompt) {
  if (!claudeHistory[groupId]) claudeHistory[groupId] = [];
  claudeHistory[groupId].push({ role: "user", content: prompt });
  if (claudeHistory[groupId].length > 20) claudeHistory[groupId] = claudeHistory[groupId].slice(-20);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: claudeHistory[groupId],
  });

  const reply = response.content[0].text;
  claudeHistory[groupId].push({ role: "assistant", content: reply });
  return reply;
}

// ── Ask Gemini ───────────────────────────────────────────────────
async function askGemini(groupId, prompt) {
  if (!geminiSessions[groupId]) geminiSessions[groupId] = geminiModel.startChat({ history: [] });
  const result = await geminiSessions[groupId].sendMessage(prompt);
  return result.response.text();
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
        prompt = `${name} wants a livestock market update. Live futures:\n${lines}\nSummarize in a friendly helpful way.`;
      }
    } else if (intent.type === "livestock") {
      const data = await getFuturesPrice(intent.ticker);
      if (data) {
        const dir = parseFloat(data.change) >= 0 ? "📈" : "📉";
        prompt = `${name} asked about ${intent.name} futures. Live data:
Price: $${data.price}
Change: ${parseFloat(data.change) >= 0 ? "+" : ""}${data.change} (${parseFloat(data.changePct) >= 0 ? "+" : ""}${data.changePct}%) ${dir}
Previous Close: $${data.prev}
Summarize this in a friendly way with market context.`;
      }
    } else if (intent.type === "stock") {
      const data = await getFuturesPrice(intent.ticker);
      if (data) {
        const dir = parseFloat(data.change) >= 0 ? "📈" : "📉";
        prompt = `${name} asked about ${intent.ticker}. Live price: $${data.price}, Change: ${data.change} (${data.changePct}%) ${dir}. Summarize this.`;
      }
    } else if (intent.type === "news") {
      const news = await getNews(intent.query);
      if (news) {
        prompt = `${name} asked for news about "${intent.query}". Latest headlines:\n${news}\nSummarize in a friendly way.`;
      }
    }

    let aiReply;

    // Try Claude first, fall back to Gemini
    if (anthropic) {
      try {
        aiReply = await askClaude(groupId, prompt);
        console.log("[Claude replied]");
      } catch (err) {
        console.error("Claude failed, trying Gemini:", err.message);
        if (geminiModel) {
          aiReply = await askGemini(groupId, prompt);
          console.log("[Gemini replied as fallback]");
        } else {
          throw err;
        }
      }
    } else if (geminiModel) {
      aiReply = await askGemini(groupId, prompt);
      console.log("[Gemini replied]");
    } else {
      aiReply = "No AI configured. Please set ANTHROPIC_API_KEY or GEMINI_API_KEY.";
    }

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
  res.json({
    status: "Livestock AI Bot is running!",
    bot: BOT_NAME,
    claude: !!anthropic,
    gemini: !!geminiModel,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐄 ${BOT_NAME} running on port ${PORT}`));
