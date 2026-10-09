// Pure timing math (SPEC §4): word counts, per-joke seconds, set totals and duration formatting.
import { activeVersion, deliveredText, findJoke, findTopic } from './model.js';

const DEFAULT_WPM = 140;
const DEFAULT_PAUSE_SEC = 2;
const SNIPPET_LENGTH = 60;
const MINUS_SIGN = '−';

/** Words = whitespace-separated tokens that contain at least one letter or digit ("—" alone is not a word). */
export function countWords(text) {
  if (typeof text !== 'string' || text === '') return 0;
  let count = 0;
  for (const token of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(token)) count++;
  return count;
}

function paceOf(settings) {
  const wpm = Number(settings?.wpm);
  const pauseSec = Number(settings?.pauseSec);
  return {
    wpm: Number.isFinite(wpm) && wpm > 0 ? wpm : DEFAULT_WPM,
    pauseSec: Number.isFinite(pauseSec) && pauseSec >= 0 ? pauseSec : DEFAULT_PAUSE_SEC,
  };
}

/** Seconds a joke takes on stage: its manual override, else delivered words at `wpm` plus the laugh pause. */
export function jokeSeconds(joke, settings) {
  if (Number.isFinite(joke.overrideSec)) return Math.max(0, joke.overrideSec);
  const { wpm, pauseSec } = paceOf(settings);
  return Math.max(0, (countWords(deliveredText(joke)) / wpm) * 60 + pauseSec);
}

/** First 60 characters of the delivered text with whitespace collapsed. */
function snippetOf(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH);
}

/** Running estimate for the active version's set, in set order. */
export function setEstimate(ws) {
  const version = activeVersion(ws);
  const settings = ws.settings;
  const items = [];
  let totalSec = 0;
  let words = 0;
  for (const jokeId of version.set.jokeIds) {
    const hit = findJoke(ws, jokeId);
    if (!hit) continue; // normalize guarantees membership; tolerate a stale id anyway
    const { joke, topic } = hit;
    const text = deliveredText(joke);
    const snippet = snippetOf(text);
    const jokeWords = countWords(text);
    const seconds = jokeSeconds(joke, settings);
    items.push({
      jokeId,
      title: joke.title || snippet || 'Untitled joke',
      snippet,
      topicTitle: topic.title,
      seconds,
      words: jokeWords,
      overridden: Number.isFinite(joke.overrideSec),
    });
    totalSec += seconds;
    words += jokeWords;
  }
  const targetSec = Number(settings?.targetSec);
  const target = Number.isFinite(targetSec) && targetSec > 0 ? targetSec : 0;
  return {
    totalSec,
    words,
    items,
    targetSec: target,
    deltaSec: totalSec - target,
    ratio: target > 0 ? totalSec / target : 0,
  };
}

/** How much of a topic is in the set and how long those jokes take. */
export function topicEstimate(ws, topicId) {
  const hit = findTopic(ws, topicId);
  if (!hit) throw new Error(`Unknown topic: ${topicId}`);
  const { version, topic } = hit;
  const inSetIds = new Set(version.set.jokeIds);
  let inSet = 0;
  let seconds = 0;
  for (const joke of topic.jokes) {
    if (!inSetIds.has(joke.id)) continue;
    inSet++;
    seconds += jokeSeconds(joke, ws.settings);
  }
  return { inSet, total: topic.jokes.length, seconds };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'm:ss' rounded to the nearest second; 'h:mm:ss' from one hour. Sign is ignored (see formatDelta). */
export function formatDuration(sec) {
  const total = Number.isFinite(sec) ? Math.round(Math.abs(sec)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Signed duration: '+0:12', '−0:12' (U+2212) or '0:00'. */
export function formatDelta(sec) {
  const rounded = Number.isFinite(sec) ? Math.round(sec) : 0;
  if (rounded === 0) return '0:00';
  return `${rounded > 0 ? '+' : MINUS_SIGN}${formatDuration(rounded)}`;
}

/** '5:00' → 300, '90' → 90, '1:02:03' → 3723; anything else → null. */
export function parseDuration(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = /^(\d+):(\d{1,2})$/.exec(trimmed);
  if (m) {
    const s = Number(m[2]);
    return s < 60 ? Number(m[1]) * 60 + s : null;
  }
  const h = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(trimmed);
  if (h) {
    const min = Number(h[2]);
    const s = Number(h[3]);
    return min < 60 && s < 60 ? Number(h[1]) * 3600 + min * 60 + s : null;
  }
  return null;
}
