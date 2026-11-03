import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// One directory per saga: runs/local/<id>/events.jsonl. appendFileSync is used on purpose: an event is on disk
// before the next action starts, so a crash can never lose the hash of a broadcast transaction.

export const RUNS_DIR = process.env.SAGA_RUNS_DIR ?? join(process.cwd(), "runs", "local");

export function newSagaId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `saga-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function eventsFile(id, dir = RUNS_DIR) {
  return join(dir, id, "events.jsonl");
}

export function fileSink(id, dir = RUNS_DIR) {
  mkdirSync(join(dir, id), { recursive: true });
  const file = eventsFile(id, dir);
  return (entry) => appendFileSync(file, JSON.stringify(entry) + "\n");
}

export function loadEvents(id, dir = RUNS_DIR) {
  const file = eventsFile(id, dir);
  if (!existsSync(file)) throw new Error(`no saga "${id}" in ${dir}`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** "latest" → the most recently written saga id. */
export function resolveId(id, dir = RUNS_DIR) {
  if (id && id !== "latest") return id;
  if (!existsSync(dir)) throw new Error("no sagas yet");
  const ids = readdirSync(dir).filter((d) => existsSync(eventsFile(d, dir)));
  if (!ids.length) throw new Error("no sagas yet");
  return ids.sort((a, b) => statSync(eventsFile(b, dir)).mtimeMs - statSync(eventsFile(a, dir)).mtimeMs)[0];
}
