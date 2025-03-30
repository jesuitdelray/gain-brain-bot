const fs = require("fs");
const axios = require("axios");
const { Telegraf, Markup } = require("telegraf");
const { OpenAI } = require("openai");
const { Client } = require("@notionhq/client");
require("dotenv").config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const userTopics = new Map();
const userSessions = new Map();

function truncate(str, length = 20) {
  return str.length > length ? str.slice(0, length - 1) + "…" : str;
}

async function askGPT(topic) {
  const messages = [
    {
      role: "system",
      content: `
You are a quiz bot helping users learn about "${topic}".
Ask short, specific questions.
Respond using the following format:
QUESTION: ...
`,
    },
    { role: "user", content: "Start quiz" },
  ];

  const chatResponse = await openai.chat.completions.create({
    messages,
    model: "gpt-4o-mini",
  });

  const text = chatResponse.choices[0].message.content.trim();
  const match = text.match(/QUESTION:\s*(.*)/i);
  return match ? match[1].trim() : text;
}

async function evaluateAnswer(question, userAnswer, topic) {
  const messages = [
    {
      role: "system",
      content: `
Evaluate the user's answer to the question "${question}" on topic "${topic}".
Respond with:
SCORE: (0-10)
CORRECT ANSWER: ...
NEXT QUESTION: ...
`,
    },
    { role: "user", content: userAnswer },
  ];

  const chatResponse = await openai.chat.completions.create({
    messages,
    model: "gpt-4o-mini",
  });

  let text = chatResponse.choices[0].message.content.trim();

  if (!/SCORE:/i.test(text) || !/CORRECT ANSWER:/i.test(text)) {
    const repairPrompt = `
You did not follow the format correctly. Please strictly reply in this format:

SCORE: (0-10)
CORRECT ANSWER: ...
NEXT QUESTION: ...

Now fix the previous answer for the question: "${question}" and user answer: "${userAnswer}"
    `;
    const retry = await openai.chat.completions.create({
      messages: [{ role: "user", content: repairPrompt }],
      model: "gpt-4o-mini",
    });
    text = retry.choices[0].message.content.trim();
  }

  const score = parseInt(text.match(/SCORE:\s*(\d+)/i)?.[1] || 0);

  const correct = text.match(/CORRECT ANSWER:\s*(.*)/i)?.[1]?.trim() || "";
  const next = text.match(/NEXT QUESTION:\s*(.*)/i)?.[1]?.trim() || "";

  return { score, correct, next };
}
async function saveToNotion({
  username,
  question,
  userAnswer,
  correct,
  score,
  topic,
}) {
  try {
    await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        User: { rich_text: [{ text: { content: username } }] },
        Question: { title: [{ text: { content: question } }] },
        Answer: { rich_text: [{ text: { content: userAnswer } }] },
        CorrectAnswer: { rich_text: [{ text: { content: correct } }] },
        Score: { number: score },
        Topic: { rich_text: [{ text: { content: topic } }] },
        Date: { date: { start: new Date().toISOString() } },
      },
    });
  } catch (err) {
    console.error("❌ Notion save error:", err.message);
  }
}

bot.command("start", async (ctx) => {
  await ctx.reply("Welcome! Please enter a topic you'd like to learn.");
});

bot.command("profile", async (ctx) => {
  const username = ctx.message.from.username || ctx.message.from.first_name;
  const topic = userTopics.get(username) || "Not set";

  const response = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      property: "User",
      rich_text: { equals: username },
    },
  });

  const pages = response.results;
  const total = pages.length;
  const avg =
    pages.reduce((sum, p) => sum + (p.properties.Score?.number || 0), 0) /
    (total || 1);

  await ctx.reply(
    `👤 @${username}\n\n📊 Total Questions: ${total}\n🎯 Average Score: ${avg.toFixed(
      1
    )} / 10\n📚 Current Topic: ${topic}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📈 Detailed Stats", "detailed")],
      [Markup.button.callback("🔁 Change Topic", "change_topic")],
    ])
  );
});

bot.action("detailed", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name;
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      property: "User",
      rich_text: { equals: username },
    },
  });

  const grouped = {};
  res.results.forEach((p) => {
    const topic =
      p.properties.Topic?.rich_text?.[0]?.text?.content || "Unknown";
    const score = p.properties.Score?.number || 0;
    if (!grouped[topic]) grouped[topic] = [];
    grouped[topic].push(score);
  });

  const lines = Object.entries(grouped).map(([t, scores]) => {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return `${t} — ${avg.toFixed(0)}%`;
  });

  await ctx.reply(`🔍 Topic Breakdown:\n\n${lines.join("\n")}`);
});

bot.action("change_topic", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name;
  userTopics.delete(username);
  userSessions.delete(username);
  await ctx.reply("✏️ Enter a new topic (e.g., 'JavaScript Basics'):");
});

bot.on("text", async (ctx) => {
  const username = ctx.message.from.username || ctx.message.from.first_name;
  const text = ctx.message.text.trim();

  // Установка темы
  if (!userTopics.has(username)) {
    userTopics.set(username, text);
    const firstQuestion = await askGPT(text);
    userSessions.set(username, { lastQuestion: firstQuestion });
    return ctx.reply(
      `✅ Topic set to: ${text}\n\n🧠 First Question: ${firstQuestion}`
    );
  }

  // Ответ на вопрос
  const topic = userTopics.get(username);
  const session = userSessions.get(username) || { lastQuestion: "" };
  const prevQ = session.lastQuestion;

  if (!prevQ) {
    const newQ = await askGPT(topic);
    userSessions.set(username, { lastQuestion: newQ });
    return ctx.reply(`🧠 ${newQ}`);
  }

  const { score, correct, next } = await evaluateAnswer(prevQ, text, topic);

  await ctx.reply(
    `✅ Score: ${score}/10\n✅ Correct: ${correct}\n\n🧠 Next: ${next}`
  );

  await saveToNotion({
    username,
    question: prevQ,
    userAnswer: text,
    correct,
    score,
    topic,
  });

  userSessions.set(username, { lastQuestion: next });
});

bot.launch();
console.log(
  "🤖 GainBrainBot running with smart sessions, retry, Notion, and stats..."
);
