const { MongoClient } = require("mongodb");
require("dotenv").config();

const client = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db("gainbrain");
  }
  return db;
}

async function getUserTopic(username) {
  const db = await connectDB();
  const user = await db.collection("users").findOne({ username });
  return user?.topic || null;
}

async function setUserTopic(username, topic) {
  const db = await connectDB();
  await db
    .collection("users")
    .updateOne({ username }, { $set: { topic } }, { upsert: true });
}

async function getUserLastQuestion(username) {
  const db = await connectDB();
  const user = await db.collection("users").findOne({ username });
  return user?.lastQuestion || null;
}

async function setUserLastQuestion(username, lastQuestion) {
  const db = await connectDB();
  await db
    .collection("users")
    .updateOne({ username }, { $set: { lastQuestion } }, { upsert: true });
}

async function saveAnswer(username, data) {
  const db = await connectDB();
  await db.collection("answers").insertOne({
    username,
    ...data,
    createdAt: new Date(),
  });
}

async function getUserStats(username) {
  const db = await connectDB();
  const answers = await db.collection("answers").find({ username }).toArray();
  return answers;
}

async function clearUserStats(username) {
  const db = await connectDB();
  await db.collection("answers").deleteMany({ username });
}

module.exports = {
  getUserTopic,
  setUserTopic,
  getUserLastQuestion,
  setUserLastQuestion,
  saveAnswer,
  getUserStats,
  clearUserStats,
};
