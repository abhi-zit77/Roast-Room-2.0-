import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CAPTION_MAX_BYTES } from './evidence-download.mjs';
import { approvedHandle, captionLanguage, requiredText, youtubeVideo } from './evidence-input.mjs';
import { createApiAnythingMetadata, normalizedVideoMetadata } from './evidence-metadata.mjs';

const maxPassages = 8;
const minimumGap = 3;
const maxPassageSeconds = 45;
const maxPassageCharacters = 900;
  const captionParserVersion = 1;
const stopWords = new Set('about after already been before being could doing does from going have into just more must only over same should some than that them then there these they this those want were what when where which while will with would your'.split(' '));
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const cleanSpace = (value) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
const speakerKey = (value) => cleanSpace(value).toLowerCase();

function advisorKey(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value)) throw new Error('Supply a valid advisor key.');
  return value;
}

function parseTimestamp(value) {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error('Caption contains an invalid timecode.');
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
  if (!Number.isFinite(seconds)) throw new Error('Caption contains an invalid timecode.');
  return seconds;
}

function normalizeRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length > 200) throw new Error('Provide at most 200 verified speaker ranges.');
  const ordered = ranges.map(({ startSeconds, endSeconds, speaker, verifiedAgainst } = {}) => {
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
      throw new Error('A verified speaker range needs increasing startSeconds and endSeconds.');
    }
    return {
      startSeconds, endSeconds, speaker: requiredText(speaker, 'Verified speaker', 120),
      ...(verifiedAgainst ? { verifiedAgainst: requiredText(verifiedAgainst, 'Speaker verification reference', 500) } : {}),
    };
  }).sort((a, b) => a.startSeconds - b.startSeconds);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i - 1].endSeconds > ordered[i].startSeconds) throw new Error('Verified speaker ranges cannot overlap.');
  }
  return ordered;
}

function parseCues(bytes, type, ranges, advisorName, transcriptKind) {
  const contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
  const blocks = contents.trim().split(/\n(?:[ \t]*\n)+/);
  if (type === '.vtt') {
    if (!/^WEBVTT(?:[ \t]|$)/.test(blocks[0].split('\n', 1)[0])) throw new Error('The .vtt file must start with WEBVTT.');
    blocks.shift();
  }
  const cues = [];
  const advisor = speakerKey(advisorName);
  const inlineTimestamp = /<(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}>/;
  const rolling = type === '.vtt' && transcriptKind !== 'manual' && inlineTimestamp.test(contents);
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0])) continue;
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index < 0 && rolling) continue;
    if (index < 0 || index > 1) throw new Error('A caption block has no start and end timecode.');
    const timemark = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[index]);
    if (!timemark) throw new Error('Caption contains an invalid timecode.');
    const [startSeconds, endSeconds] = timemark.slice(1, 3).map(parseTimestamp);
    if (endSeconds <= startSeconds) continue;
    const body = lines.slice(index + 1);
    // Rolling YouTube cues can retain the preceding speaker's line. Only word-timed lines are new text.
    const markup = (rolling ? body.filter((line) => inlineTimestamp.test(line)) : body).join(' ');
    const hints = [...new Set(Array.from(markup.matchAll(/<v(?:\.[^>\s]+)?\s+([^>]+)>/gi), (match) => speakerKey(match[1])))];
    const cueText = cleanSpace(markup.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|nbsp|quot|apos|lrm|rlm);/g, (_, name) => ({
      amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'", lrm: '', rlm: '',
    })[name]));
    if (!cueText) continue;
    const range = ranges.find((span) => span.startSeconds <= startSeconds && span.endSeconds >= endSeconds);
    const verified = range && hints.every((name) => name === speakerKey(range.speaker));
    cues.push({
      text: cueText, startSeconds, endSeconds, range: verified ? range : null,
      speaker: verified ? range.speaker : null,
      speakerStatus: verified ? 'verified' : 'uncertain',
      advisorAttribution: Boolean(verified && speakerKey(range.speaker) === advisor),
    });
  }
  if (!cues.length) throw new Error('The subtitle file has no usable caption cues.');
  return cues.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

function passagesFromCues(cues) {
  const passages = [];
  for (const cue of cues) {
    const last = passages.at(-1);
    if (last?.range && cue.range === last.range && cue.startSeconds >= last.endSeconds
      && cue.startSeconds - last.endSeconds <= minimumGap && cue.endSeconds - last.startSeconds <= maxPassageSeconds
      && last.text.length + cue.text.length + 1 <= maxPassageCharacters) {
      last.text += ` ${cue.text}`;
      last.endSeconds = cue.endSeconds;
    } else {
      passages.push({ ...cue, text: cue.text.slice(0, maxPassageCharacters) });
    }
  }
  return passages;
}

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 3000;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sources (
    source_id TEXT PRIMARY KEY, advisor_id TEXT NOT NULL, video_id TEXT NOT NULL, current_version TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sources_by_advisor ON sources(advisor_id);
  CREATE TABLE IF NOT EXISTS source_versions (
    source_id TEXT NOT NULL REFERENCES sources(source_id), version TEXT NOT NULL, metadata TEXT NOT NULL,
    PRIMARY KEY (source_id, version)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS passages (
    id TEXT UNIQUE NOT NULL, source_id TEXT NOT NULL, version TEXT NOT NULL, start_seconds REAL NOT NULL,
    text TEXT NOT NULL, evidence TEXT NOT NULL, FOREIGN KEY(source_id, version) REFERENCES source_versions(source_id, version)
  ) STRICT;
  CREATE VIRTUAL TABLE IF NOT EXISTS passage_search USING fts5(text, content='passages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
  CREATE TABLE IF NOT EXISTS withdrawals (
    video_id TEXT PRIMARY KEY, withdrawn_at TEXT NOT NULL, reason TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS approved_channels (
    advisor_id TEXT NOT NULL, handle TEXT NOT NULL, PRIMARY KEY (advisor_id, handle)
  ) STRICT;
`;

function searchQuery(brief, seat) {
  const options = Array.isArray(brief?.options) ? brief.options.map((option) => option?.label ?? option) : [];
  const combined = [brief?.idea, brief?.decision, brief?.context, brief?.question, ...options, seat?.dimension]
    .filter((value) => typeof value === 'string').join(' ').slice(0, 10000).toLowerCase();
  const terms = (combined.match(/[\p{L}\p{N}][\p{L}\p{N}]{2,}/gu) || []).filter((term) => !stopWords.has(term));
  return [...new Set(terms)].slice(0, 36).map((term) => `"${term}"`).join(' OR ');
}

function diverseCandidates(rows) {
  const bySource = new Map();
  for (const row of rows) {
    if (!bySource.has(row.source_id)) bySource.set(row.source_id, []);
    const source = bySource.get(row.source_id);
    if (source.length < maxPassages / 2) source.push(row);
  }
  const groups = [...bySource.values()].slice(0, 4);
  const ordered = [];
  for (let i = 0; i < maxPassages / 2; i += 1) {
    for (const group of groups) if (group[i]) ordered.push(group[i]);
  }
  return ordered.slice(0, maxPassages).map((row) => ({ ...JSON.parse(row.evidence), text: row.text }));
}

function freezePacket(status, gaps, passages) {
  for (const item of passages) {
    if (item.verifiedRange) Object.freeze(item.verifiedRange);
    Object.freeze(item);
  }
  return Object.freeze({ status, gaps: Object.freeze(gaps), passages: Object.freeze(passages) });
}

/** Verify a short direct quote against the speaker and literal caption text in this seat's frozen packet. */
export function validateQuote(packet, { evidenceId, advisorId, quote } = {}) {
  if (typeof quote !== 'string' || !quote.trim()) return false;
  const item = packet?.passages?.find((passage) => passage.id === evidenceId);
  return Boolean(item && item.advisorId === advisorId && item.speakerStatus === 'verified' && item.advisorAttribution === true
    && cleanSpace(item.text).includes(cleanSpace(quote)));
}

/** Store permitted captions and provenance locally. A council receives frozen copies of the selected passages. */
export function createEvidenceStore(dbPath, { metadata = createApiAnythingMetadata() } = {}) {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(schema);

  function listSources(advisorId) {
    if (advisorId !== undefined) advisorKey(advisorId);
    return db.prepare(`SELECT v.metadata, w.withdrawn_at, w.reason FROM sources s
      JOIN source_versions v ON v.source_id = s.source_id AND v.version = s.current_version
      LEFT JOIN withdrawals w ON w.video_id = s.video_id
      WHERE (? IS NULL OR s.advisor_id = ?) ORDER BY s.source_id`).all(advisorId ?? null, advisorId ?? null).map((row) => ({
      ...JSON.parse(row.metadata), withdrawnAt: row.withdrawn_at, withdrawalReason: row.reason,
    }));
  }

  async function importTranscript({ file, videoUrl, advisorId, advisorName, rightsBasis, language = 'en', transcriptKind = 'provided', speakerRanges = [] }) {
    const video = youtubeVideo(videoUrl);
    const key = advisorKey(advisorId);
    const name = requiredText(advisorName, 'Assigned advisor name', 120);
    const rights = requiredText(rightsBasis, 'Caption rights basis', 1000);
    const track = captionLanguage(language);
    if (!['provided', 'manual', 'automatic'].includes(transcriptKind)) throw new Error('Unknown caption track type.');
    const ranges = normalizeRanges(speakerRanges);
    const type = typeof file === 'string' ? path.extname(file).toLowerCase() : '';
    if (!['.vtt', '.srt'].includes(type)) throw new Error('Import a local .vtt or .srt caption file.');
    const info = await stat(file);
    if (!info.isFile() || !info.size || info.size > CAPTION_MAX_BYTES) throw new Error('Import a nonempty caption file up to 4 MiB.');
    const bytes = await readFile(file);
    if (bytes.length > CAPTION_MAX_BYTES) throw new Error('The caption file exceeds the 4 MiB import limit.');
    const cues = parseCues(bytes, type, ranges, name, transcriptKind);
    if (db.prepare('SELECT 1 FROM withdrawals WHERE video_id = ?').get(video.id)) throw new Error('This YouTube source was withdrawn.');

    let result;
    try { result = await metadata?.getVideo({ videoId: video.id }); } catch { result = { status: 'provider_error' }; }
    const sourceMetadata = normalizedVideoMetadata(result ?? { status: 'not_configured' });
    if (sourceMetadata.durationSeconds && cues.some((cue) => cue.endSeconds > sourceMetadata.durationSeconds + 1)) {
      throw new Error('Caption cues exceed the duration reported for the linked YouTube video.');
    }
    const sourceId = `${key}:yt:${video.id}`;
    const transcriptHash = sha256(bytes);
    const importedAt = new Date().toISOString();
    const version = sha256(JSON.stringify({ transcriptHash, name, rights, track, transcriptKind, ranges, sourceMetadata, captionParserVersion }));
    const storedCues = passagesFromCues(cues);
    const identity = { sourceId, advisorId: key, advisorName: name, version, videoId: video.id, transcriptHash, language: track, transcriptKind, rightsBasis: rights };
    const provenance = {
      ...identity, canonicalUrl: video.url, importedAt, title: sourceMetadata.title ?? null, channel: sourceMetadata.channel ?? null,
      channelId: sourceMetadata.channelId ?? null, publishedAt: sourceMetadata.publishedAt ?? null, metadataStatus: sourceMetadata.status,
      durationSeconds: sourceMetadata.durationSeconds ?? null, passages: storedCues.length, verifiedRanges: ranges.length, captionParserVersion,
    };

    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT 1 FROM withdrawals WHERE video_id = ?').get(video.id)) throw new Error('This YouTube source was withdrawn.');
      db.prepare(`INSERT INTO sources VALUES (?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET current_version = excluded.current_version`).run(sourceId, key, video.id, version);
      const existing = db.prepare('SELECT metadata FROM source_versions WHERE source_id = ? AND version = ?').get(sourceId, version);
      if (!existing) {
        db.prepare('INSERT INTO source_versions VALUES (?, ?, ?)').run(sourceId, version, JSON.stringify(provenance));
        const insertPassage = db.prepare('INSERT INTO passages (id, source_id, version, start_seconds, text, evidence) VALUES (?, ?, ?, ?, ?, ?)');
        const indexPassage = db.prepare('INSERT INTO passage_search (rowid, text) VALUES (?, ?)');
        for (const [index, cue] of storedCues.entries()) {
          const { text, range, ...span } = cue;
          const id = `${sourceId}:${version.slice(7, 31)}:${index + 1}`;
          const evidence = {
            id, ...identity, ...span, title: provenance.title, channel: provenance.channel, channelId: provenance.channelId,
            publishedAt: provenance.publishedAt, importedAt, metadataStatus: provenance.metadataStatus,
            url: `${video.url}&t=${Math.floor(span.startSeconds)}`, contentHash: sha256(text),
            speakerVerification: range?.verifiedAgainst ? 'reviewed_against_reference' : range ? 'user_verified_range' : null,
            verifiedRange: range ? Object.freeze({ ...range }) : null,
            instructionPolicy: 'untrusted_source_text',
          };
          const inserted = insertPassage.run(id, sourceId, version, span.startSeconds, text, JSON.stringify(evidence));
          indexPassage.run(inserted.lastInsertRowid, text);
        }
      }
      db.exec('COMMIT');
      return existing ? JSON.parse(existing.metadata) : provenance;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getEvidence({ seat, brief }) {
    const key = advisorKey(typeof seat === 'string' ? seat : seat?.key);
    const sources = listSources(key);
    const active = sources.filter((source) => !source.withdrawnAt);
    if (!active.length) return freezePacket('framework_only', [sources.length ? 'This seat’s imported sources were withdrawn.' : 'No permitted captions have been imported for this seat.'], []);

    const query = searchQuery(brief, seat);
    const rows = !query ? [] : db.prepare(`SELECT p.source_id, p.text, p.evidence FROM passage_search
      JOIN passages p ON p.rowid = passage_search.rowid
      JOIN sources s ON s.source_id = p.source_id AND s.current_version = p.version
      LEFT JOIN withdrawals w ON w.video_id = s.video_id
      WHERE passage_search MATCH ? AND s.advisor_id = ? AND w.video_id IS NULL
      ORDER BY json_extract(p.evidence, '$.advisorAttribution') DESC, bm25(passage_search), p.source_id, p.start_seconds, p.id LIMIT 128`).all(query, key);
    const passages = diverseCandidates(rows);
    const gaps = [];
    if (!passages.length) gaps.push('No imported passages match this decision.');
    if (passages.length && !passages.some((passage) => passage.advisorAttribution)) gaps.push('No relevant passage has a verified speaker range for this advisor.');
    const metadataGaps = new Map(passages.filter((item) => item.metadataStatus !== 'ok').map((item) => [item.sourceId, item]));
    for (const source of metadataGaps.values()) {
      gaps.push(`YouTube metadata for ${source.videoId} is ${source.metadataStatus.replaceAll('_', ' ')}.`);
    }
    return freezePacket(passages.length ? 'transcript' : 'framework_only', gaps, passages);
  }

  function withdrawSource(sourceId, reason) {
    const key = requiredText(sourceId, 'Source ID', 120);
    const explanation = requiredText(reason, 'Withdrawal reason', 500);
    const source = db.prepare('SELECT video_id FROM sources WHERE source_id = ?').get(key);
    if (!source) throw new Error('No imported source matches that ID.');
    db.prepare('INSERT OR IGNORE INTO withdrawals VALUES (?, ?, ?)').run(source.video_id, new Date().toISOString(), explanation);
    return getWithdrawals([key])[key];
  }

  function getWithdrawals(sourceIds) {
    const ids = sourceIds && new Set(sourceIds);
    const rows = db.prepare(`SELECT s.source_id, w.withdrawn_at, w.reason FROM withdrawals w JOIN sources s ON s.video_id = w.video_id`).all();
    return Object.fromEntries(rows.filter((row) => !ids || ids.has(row.source_id)).map((row) => [row.source_id, { withdrawnAt: row.withdrawn_at, reason: row.reason }]));
  }

  function approveChannel({ advisorId, handle }) {
    const key = advisorKey(advisorId);
    const channel = approvedHandle(handle);
    db.prepare('INSERT OR IGNORE INTO approved_channels VALUES (?, ?)').run(key, channel);
    return { advisorId: key, handle: channel };
  }

  async function discoverChannel({ advisorId, handle }) {
    const key = advisorKey(advisorId);
    const channelHandle = approvedHandle(handle);
    if (!db.prepare('SELECT 1 FROM approved_channels WHERE advisor_id = ? AND handle = ?').get(key, channelHandle)) throw new Error('This channel handle must be approved for the advisor before discovery.');
    if (!metadata?.getChannel || !metadata?.listChannelVideos) return { status: 'not_configured', channel: null, videos: [] };
    try {
      const channel = await metadata.getChannel({ handle: channelHandle });
      if (channel.status !== 'ok') return { status: channel.status, channel, videos: [] };
      const listed = await metadata.listChannelVideos({ handle: channelHandle });
      return { status: listed.status, channel, videos: listed.videos };
    } catch {
      return { status: 'provider_error', channel: null, videos: [] };
    }
  }

  return { importTranscript, listSources, getEvidence, withdrawSource, getWithdrawals, approveChannel, discoverChannel, close: () => db.close() };
}
