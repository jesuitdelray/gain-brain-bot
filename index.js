const fs = require("fs");
const axios = require("axios");
const { Telegraf } = require("telegraf");
const { OpenAI } = require("openai");
const { Client } = require("@notionhq/client");
require("dotenv").config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

async function askGPT(question) {
  const chatResponse = await openai.chat.completions.create({
    messages: [
      {
        role: "system",
        content: `
I want to train my brain and make it smarter by asking deep questions like "why", "how", "what", and "when".

Respond with:
- a short, precise, fact-based answer in clear, scientific language.
- no fluff or oversimplification — be concise but meaningful.
- include one thought-provoking follow-up question that builds on the answer to keep thinking going.

All responses must be in simple but not childish language.

Use the following format:
Question: ...
Answer: ...
Follow-up Question: ...
        `,
      },
      { role: "user", content: question },
    ],
    model: "gpt-4o-mini",
  });

  const text = chatResponse.choices[0].message.content.trim();

  const qMatch = text.match(/Question:\s*(.+)/i);
  const aMatch = text.match(/Answer:\s*(.+)/i);
  const fMatch = text.match(/Follow-up Question:\s*(.+)/i);

  return {
    question: qMatch?.[1]?.trim() || question,
    answer: aMatch?.[1]?.trim() || text,
    followUp: fMatch?.[1]?.trim() || null,
    raw: text,
  };
}

async function saveToNotion(question, answer, followUp, user) {
  try {
    await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Question: {
          title: [{ text: { content: question } }],
        },
        Answer: {
          rich_text: [{ text: { content: answer } }],
        },
        FollowUp: followUp
          ? {
              rich_text: [{ text: { content: followUp } }],
            }
          : undefined,
        User: {
          rich_text: [{ text: { content: user } }],
        },
        Date: {
          date: { start: new Date().toISOString() },
        },
      },
    });
  } catch (err) {
    console.error("❌ Notion save error:", JSON.stringify(err, null, 2));
  }
}

function getReplyKeyboard(followUp) {
  return followUp
    ? {
        reply_markup: {
          keyboard: [[{ text: followUp }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    : {};
}

bot.on("text", async (ctx) => {
  const user =
    ctx.message.from.username ||
    `${ctx.message.from.first_name || ""} ${
      ctx.message.from.last_name || ""
    }`.trim();
  const input = ctx.message.text;

  try {
    const gpt = await askGPT(input);
    const responseText = `💬 ${gpt.answer}${
      gpt.followUp ? `\n\n➡️ ${gpt.followUp}` : ""
    }`;

    await ctx.reply(responseText, getReplyKeyboard(gpt.followUp));
    await saveToNotion(gpt.question, gpt.answer, gpt.followUp, user);
    console.log(`[${user}] ${gpt.question} => OK`);
  } catch (err) {
    console.error("Text Msg Error:", err);
    await ctx.reply("❌ Something went wrong.");
  }
});

bot.on(["voice", "audio"], async (ctx) => {
  const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id;
  const duration =
    ctx.message.voice?.duration || ctx.message.audio?.duration || 0;
  const user =
    ctx.message.from.username ||
    `${ctx.message.from.first_name || ""} ${
      ctx.message.from.last_name || ""
    }`.trim();

  try {
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
    fs.writeFileSync("voice.ogg", response.data);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream("voice.ogg"),
      model: "whisper-1",
    });

    const question = transcription.text;
    const gpt = await askGPT(question);
    const responseText = `💬 ${gpt.answer}${
      gpt.followUp ? `\n\n➡️ ${gpt.followUp}` : ""
    }`;

    await ctx.reply(responseText, getReplyKeyboard(gpt.followUp));
    await saveToNotion(gpt.question, gpt.answer, gpt.followUp, user);

    const cost = ((duration / 60) * 0.006).toFixed(5);
    console.log(`[${user}] 🎤 ${gpt.question} => OK`);
    console.log(`⏱ Duration: ${duration}s, 💸 Whisper cost: $${cost}`);
  } catch (err) {
    console.error("Voice Msg Error:", err);
    await ctx.reply("❌ Could not process voice.");
  }
});

bot.launch();
console.log(
  "🤖 GainBrainBot is running with user logging + reply follow-up..."
);
