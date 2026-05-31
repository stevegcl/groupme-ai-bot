require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BOT_ID = process.env.GROUPME_BOT_ID;
const BOT_NAME = process.env.BOT_NAME || "AI Assistant";

// Store recent conversation history per group (in-memory, per session)
const conversationHistory = {};

// System prompt — customize this!
const SYSTEM_PROMPT = `You are a helpful, friendly AI assistant in a GroupMe group chat. 
Keep responses concise (under 1000 characters when possible) since this is a chat interface.
Be conversational and engaging. You can answer questions, help with tasks, tell jokes, discuss topics, and more.`;

// Send a message back to the GroupMe group
async function sendGroupMeMessage(text) {
  const response = await fetch("https://api.groupme.com/v3/bots/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_id: BOT_ID, text }),
  });
  if (!response.ok) {
    console.error("GroupMe send error:", await response.text());
  }
}

// Split long messages into chunks (GroupMe max is ~1000 chars)
function chunkMessage(text, maxLen = 950) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a sentence or word boundary
    let splitAt = remaining.lastIndexOf(". ", maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt === -1) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }
  return chunks;
}

// Webhook endpoint that GroupMe POSTs to
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Respond immediately to GroupMe

  const { name, text, sender_type, group_id } = req.body;

  // Ignore messages from bots (including our own) to prevent loops
  if (sender_type === "bot") return;
  if (!text || text.trim() === "") return;

  const groupId = group_id || "default";
  const userMessage = text.trim();

  console.log(`[${new Date().toISOString()}] ${name}: ${userMessage}`);

  // Initialize history for this group if needed
  if (!conversationHistory[groupId]) {
    conversationHistory[groupId] = [];
  }

  // Add user message to history
  conversationHistory[groupId].push({
    role: "user",
    content: `${name} says: ${userMessage}`,
  });

  // Keep history to last 20 messages to avoid token bloat
  if (conversationHistory[groupId].length > 20) {
    conversationHistory[groupId] = conversationHistory[groupId].slice(-20);
  }

  try {
    // Check if bot is being addressed (optional: only respond when mentioned)
    const botMentioned =
      userMessage.toLowerCase().includes("@ai") ||
      userMessage.toLowerCase().includes(BOT_NAME.toLowerCase()) ||
      process.env.RESPOND_TO_ALL === "true";

    if (!botMentioned) return;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: conversationHistory[groupId],
    });

    const aiReply = response.content[0].text;

    // Add AI response to history
    conversationHistory[groupId].push({
      role: "assistant",
      content: aiReply,
    });

    // Send reply (split if too long)
    const chunks = chunkMessage(aiReply);
    for (const chunk of chunks) {
      await sendGroupMeMessage(chunk);
      if (chunks.length > 1) await new Promise((r) => setTimeout(r, 500)); // small delay between chunks
    }

    console.log(`[BOT REPLY] ${aiReply.slice(0, 100)}...`);
  } catch (err) {
    console.error("Claude API error:", err.message);
    await sendGroupMeMessage("Sorry, I ran into an error. Try again!");
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "GroupMe AI Bot is running!", bot: BOT_NAME });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 ${BOT_NAME} webhook server running on port ${PORT}`);
  console.log(`Bot ID: ${BOT_ID || "NOT SET - check .env"}`);
});
