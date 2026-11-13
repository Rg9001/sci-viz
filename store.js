// Progress storage. Uses Upstash Redis (free, permanent) when
// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set; otherwise a
// local JSON file (fine locally, but Render's free tier wipes it on restart).
import { readFile, writeFile, mkdir } from "node:fs/promises";

const KEY = "sciviz:attempts";
const MAX = 1000;
const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const FILE = new URL("./data/progress.json", import.meta.url);

export const persistent = Boolean(URL_ && TOKEN);

async function redis(...command) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Upstash ${res.status}`);
  return (await res.json()).result;
}

async function readFileList() {
  try { return JSON.parse(await readFile(FILE, "utf8")); } catch { return []; }
}

export async function addAttempt(attempt) {
  if (persistent) {
    await redis("LPUSH", KEY, JSON.stringify(attempt));
    await redis("LTRIM", KEY, 0, MAX - 1);
    return;
  }
  const list = await readFileList();
  list.unshift(attempt);
  await mkdir(new URL("./data/", import.meta.url), { recursive: true });
  await writeFile(FILE, JSON.stringify(list.slice(0, MAX)));
}

/** Newest first. */
export async function getAttempts() {
  if (persistent) return (await redis("LRANGE", KEY, 0, MAX - 1)).map((s) => JSON.parse(s));
  return readFileList();
}

const day = (ts) => new Date(ts).toISOString().slice(0, 10);

export function summarize(attempts, { subject } = {}) {
  const list = subject
    ? attempts.filter((a) => (a.subject || "").toLowerCase().includes(subject.toLowerCase()))
    : attempts;
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);

  const topics = new Map();
  for (const a of list) {
    const k = a.topic || "General";
    if (!topics.has(k)) topics.set(k, { topic: k, subject: a.subject, scores: [] });
    topics.get(k).scores.push(a.score); // newest first
  }
  const topicStats = [...topics.values()].map((t) => {
    const recent = t.scores.slice(0, 3), older = t.scores.slice(3, 6);
    return {
      topic: t.topic, subject: t.subject, attempts: t.scores.length, avg: avg(t.scores),
      last: t.scores[0], trend: older.length ? avg(recent) - avg(older) : 0,
    };
  }).sort((a, b) => b.attempts - a.attempts);

  // Streak: consecutive UTC days with at least one attempt, ending today or yesterday.
  const days = new Set(list.map((a) => day(a.ts)));
  let streak = 0;
  const d = new Date();
  if (!days.has(day(d))) d.setUTCDate(d.getUTCDate() - 1);
  while (days.has(day(d))) { streak++; d.setUTCDate(d.getUTCDate() - 1); }

  const activity = [];
  for (let i = 13; i >= 0; i--) {
    const x = new Date(); x.setUTCDate(x.getUTCDate() - i);
    const k = day(x);
    activity.push({ day: k, count: list.filter((a) => day(a.ts) === k).length });
  }

  return {
    total: list.length,
    avgScore: avg(list.map((a) => a.score)),
    accuracy: list.length ? Math.round(100 * list.filter((a) => a.verdict === "correct").length / list.length) : 0,
    streak,
    topics: topicStats,
    weakTopics: topicStats.filter((t) => t.avg < 75).sort((a, b) => a.avg - b.avg).slice(0, 5),
    recent: list.slice(0, 8),
    activity,
    persistent,
  };
}
