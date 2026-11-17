import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { validVideoId } from './evidence-input.mjs';

const exec = promisify(execFile);
const fields = {
  getVideo: 'title,channel,channelId,durationSeconds,publishDate',
  getChannel: 'name,channelId',
  listChannelVideos: 'id,title,published',
};
const failure = {
  auth: 'permission_denied', blocked: 'not_available', rate: 'rate_limited',
};

export const metadataStatuses = ['ok', 'partial', 'not_configured', 'not_available', 'permission_denied', 'rate_limited', 'provider_error'];

function rows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.columns) && Array.isArray(data?.rows)) {
    return data.rows.filter(Array.isArray).map((row) => Object.fromEntries(data.columns.map((name, i) => [name, row[i]])));
  }
  return data && typeof data === 'object' ? [data] : [];
}

const text = (value) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null;

export function normalizedVideoMetadata(result) {
  const status = metadataStatuses.includes(result?.status) ? result.status : 'provider_error';
  if (status !== 'ok' && status !== 'partial') return { status };
  const title = text(result.title);
  const channel = text(result.channel);
  const channelId = text(result.channelId);
  const duration = Number(result.durationSeconds);
  const durationSeconds = Number.isFinite(duration) && duration > 0 ? duration : null;
  const date = typeof result.publishedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(result.publishedAt)
    ? Date.parse(result.publishedAt) : NaN;
  const publishedAt = Number.isFinite(date) ? new Date(date).toISOString() : null;
  return { status: title && channelId && durationSeconds && publishedAt ? 'ok' : 'partial', title, channel, channelId, durationSeconds, publishedAt };
}

/** Explicitly configured API Anything CLI path. Only known public YouTube reads are available. */
export function createApiAnythingMetadata({ cli = process.env.ROAST_API_ANYTHING_CLI, call } = {}) {
  const configured = typeof cli === 'string' && path.isAbsolute(cli) && /\.(?:m?js)$/i.test(cli);
  const invoke = call || (async (op, args) => {
    const options = { timeout: 20_000, maxBuffer: 256_000, windowsHide: true };
    const cliArgs = [cli, 'call', 'youtube', op, '--json', JSON.stringify(args), '--fields', fields[op], '--max-tier', '1'];
    const { stdout } = await exec(process.execPath, cliArgs, options).catch((error) => ({ stdout: error?.stdout ?? '' }));
    return JSON.parse(stdout);
  });

  async function read(op, args) {
    if (!call && !configured) return { status: 'not_configured', items: [] };
    try {
      const result = await invoke(op, args);
      if (result?.ok !== true) return { status: failure[result?.class] ?? 'provider_error', items: [] };
      const items = rows(result.data);
      return { status: items.length ? 'ok' : 'not_available', items };
    } catch {
      return { status: 'provider_error', items: [] };
    }
  }

  return {
    async getVideo({ videoId }) {
      if (!validVideoId(videoId)) return { status: 'not_available' };
      const { status, items } = await read('getVideo', { videoId });
      const video = items[0] ?? {};
      return normalizedVideoMetadata({ status, title: video.title, channel: video.channel, channelId: video.channelId, durationSeconds: video.durationSeconds, publishedAt: video.publishDate });
    },
    async getChannel({ handle }) {
      const { status, items } = await read('getChannel', { handle });
      const channel = items[0] ?? {};
      const channelId = text(channel.channelId);
      return { status: status === 'ok' && !channelId ? 'partial' : status, name: text(channel.name), channelId };
    },
    async listChannelVideos({ handle }) {
      const { status, items } = await read('listChannelVideos', { handle });
      const videos = items.filter((video) => validVideoId(video?.id)).slice(0, 30).map((video) => ({
        id: video.id, title: text(video.title), published: text(video.published), url: `https://www.youtube.com/watch?v=${video.id}`,
      }));
      return { status: status === 'ok' && !videos.length ? 'not_available' : status, videos };
    },
  };
}
