require("dotenv").config();
const { Telegraf, Markup, session } = require("telegraf");
const { OpenAI } = require("openai");
const {
  getUserTopic,
  setUserTopic,
  getUserLastQuestion,
  setUserLastQuestion,
  saveAnswer,
  getUserStats,
  clearUserStats,
} = require("./db");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const userTopics = new Map();
const userSessions = new Map();
const pendingTopicUsers = new Set();

async function askGPT(topic) {
  const messages = [
    {
      role: "system",
      content: `You are a quiz bot helping users learn about "${topic}". Ask short, specific questions. Respond using the format:\nQUESTION: ...`,
    },
    { role: "user", content: "Start quiz" },
  ];

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
  });

  const text = res.choices[0].message.content.trim();
  const match = text.match(/QUESTION:\s*(.*)/i);
  return match ? match[1].trim() : text;
}

async function evaluateAnswer(question, userAnswer, topic) {
  const messages = [
    {
      role: "system",
      content: `Evaluate the user's answer to "${question}" on "${topic}". Respond strictly in format:\nSCORE: (0-10)\nCORRECT ANSWER: ...\nNEXT QUESTION: ...`,
    },
    { role: "user", content: userAnswer },
  ];

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
  });

  let text = res.choices[0].message.content.trim();

  if (!/SCORE:/i.test(text) || !/CORRECT ANSWER:/i.test(text)) {
    const repairPrompt = `You did not follow the format. Reformat your response for question "${question}" and user answer "${userAnswer}" correctly.`;
    const retry = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: repairPrompt }],
    });
    text = retry.choices[0].message.content.trim();
  }

  const score = parseInt(text.match(/SCORE:\s*(\d+)/i)?.[1] || 0);
  const correct = text.match(/CORRECT ANSWER:\s*(.*)/i)?.[1]?.trim() || "";
  const next = text.match(/NEXT QUESTION:\s*(.*)/i)?.[1]?.trim() || "";

  return { score, correct, next };
}

bot.command("start", async (ctx) => {
  await ctx.reply("Welcome! Please enter a topic you'd like to learn.");
});

bot.command("profile", async (ctx) => {
  const username = ctx.message.from.username || ctx.message.from.first_name;
  const topic = ctx.session?.topic || "Not set";

  const records = await getUserStats(username);
  const total = records.length;
  const avg =
    records.reduce((sum, r) => sum + (r.score || 0), 0) / (total || 1);

  await ctx.reply(
    `👤 @${username}\n\n` +
      `📊 Total Questions: ${total}\n` +
      `🎯 Average Score: ${avg.toFixed(1)} / 10\n` +
      `📚 Current Topic: ${topic}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("📈 Detailed Stats", "detailed"),
        Markup.button.callback("🔁 Change Topic", "change_topic"),
      ],
      [Markup.button.callback("🧹 Clear Stats", "clear_stats")],
    ])
  );
});

bot.action("change_topic", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name;
  pendingTopicUsers.add(username);
  await ctx.reply("✏️ Please enter a new topic (e.g., 'JavaScript basics'):");
});

bot.action("clear_stats", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name;
  await clearUserStats(username);
  if (!ctx.session) ctx.session = {};
  ctx.session.topic = null;
  await ctx.reply("🧹 Your stats have been cleared.");
});

bot.action("detailed", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name;
  const records = await getUserStats(username);

  const grouped = {};
  for (const r of records) {
    const topic = r.topic || "Unknown";
    if (!grouped[topic]) grouped[topic] = [];
    grouped[topic].push(r.score || 0);
  }

  const lines = Object.entries(grouped).map(([t, scores]) => {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return `${t} — ${avg.toFixed(0)} / 10`;
  });

  await ctx.reply(`🔍 Topic Breakdown:\n\n${lines.join("\n")}`);
});

bot.on("text", async (ctx) => {
  const username = ctx.message.from.username || ctx.message.from.first_name;
  const text = ctx.message.text.trim();

  if (text.toLowerCase().startsWith("/change")) {
    const newTopic = text.replace("/change", "").trim();

    if (!newTopic) {
      return ctx.reply(
        "❗️Please specify the topic after /change, for example: /change React"
      );
    }

    const current = await getUserTopic(username);
    if (current && current !== newTopic) {
      ctx.session = { pendingTopic: newTopic };
      return ctx.reply(
        `❓ Do you want to switch to topic "${newTopic}"?`,
        Markup.inlineKeyboard([
          [Markup.button.callback("✅ Yes", "confirm_topic")],
          [Markup.button.callback("❌ No", "cancel_topic")],
        ])
      );
    }

    await setUserTopic(username, newTopic);
    if (!ctx.session) ctx.session = {};
    ctx.session.topic = newTopic;

    const firstQuestion = await askGPT(newTopic);
    await setUserLastQuestion(username, firstQuestion);

    return ctx.reply(
      `✅ Topic set to: ${newTopic}\n\n🧠 First Question: ${firstQuestion}`
    );
  }

  if (ctx.session?.pendingTopic) {
    return ctx.reply("❗️Please confirm your topic using the buttons above.");
  }

  let topic = await getUserTopic(username);
  if (!topic) {
    topic = text;
    await setUserTopic(username, topic);
    if (!ctx.session) ctx.session = {};
    ctx.session.topic = topic;

    const firstQ = await askGPT(topic);
    await setUserLastQuestion(username, firstQ);

    return ctx.reply(
      `✅ Topic set to: ${topic}\n\n🧠 First Question: ${firstQ}`
    );
  }

  const prevQ = await getUserLastQuestion(username);
  if (!prevQ) {
    const q = await askGPT(topic);
    await setUserLastQuestion(username, q);
    return ctx.reply(`🧠 ${q}`);
  }

  const { score, correct, next } = await evaluateAnswer(prevQ, text, topic);

  await ctx.reply(
    `✅ Score: ${score}/10\n\n✅ Correct: ${correct}\n\n🧠 Next: ${next}`
  );

  await saveAnswer(username, {
    question: prevQ,
    answer: text,
    correctAnswer: correct,
    score,
    topic,
  });

  await setUserLastQuestion(username, next);
});

bot.action("confirm_topic", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name;
  const newTopic = ctx.session?.pendingTopic;
  if (newTopic) {
    await setUserTopic(username, newTopic);
    if (!ctx.session) ctx.session = {};
    ctx.session.topic = newTopic;

    const firstQ = await askGPT(newTopic);
    await setUserLastQuestion(username, firstQ);
    ctx.session.pendingTopic = null;

    await ctx.reply(
      `✅ Topic set to: ${newTopic}\n\n🧠 First Question: ${firstQ}`
    );
  }
});

bot.action("cancel_topic", async (ctx) => {
  ctx.session.pendingTopic = null;
  await ctx.reply("✏️ Please, write your topic for study.");
});

bot.launch();
console.log("🤖 GainBrainBot running with MongoDB, GPT quiz, and stats!");
