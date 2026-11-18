import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { captionLanguage, requiredText, youtubeVideo } from './evidence-input.mjs';

const exec = promisify(execFile);
export const CAPTION_MAX_BYTES = 4 * 1024 * 1024;

async function runDownloader(executable, args) {
  const inherited = /^(path|pathext|systemroot|windir|temp|tmp|lang|lc_all)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => inherited.test(name)));
  await exec(executable, args, { timeout: 90_000, maxBuffer: 256_000, windowsHide: true, env });
}

/** Optional owner-approved acquisition step. It saves one caption track with no media downloads. */
export async function fetchYouTubeCaptions({ videoUrl, directory, rightsBasis, language = 'en', automatic = false, executable = process.env.ROAST_YT_DLP || 'yt-dlp', run = runDownloader }) {
  const video = youtubeVideo(videoUrl);
  const rights = requiredText(rightsBasis, 'Caption rights basis', 1000);
  const track = captionLanguage(language);
  if (typeof automatic !== 'boolean') throw new Error('Set automatic captions explicitly to true or false.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  const staging = await mkdtemp(path.join(root, '.caption-'));
  try {
    const template = path.join(staging, '%(id)s.%(ext)s');
    const args = [
      '--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-cookies', '--no-cookies-from-browser',
      '--no-playlist', '--skip-download', automatic ? '--write-auto-subs' : '--write-subs',
      '--sub-langs', `^${track}$`, '--sub-format', 'vtt', '--socket-timeout', '15',
      '--retries', '0', '--fragment-retries', '0', '--no-progress', '--output', template, '--', video.url,
    ];
    try { await run(executable, args); } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('Install yt-dlp or set ROAST_YT_DLP to its executable path.');
      throw new Error('yt-dlp could not fetch the requested caption track. The local caption importer is available.');
    }
    const entries = await readdir(staging, { withFileTypes: true });
    const name = `${video.id}.${track}.vtt`;
    if (!entries.some((entry) => entry.name === name && entry.isFile())) {
      throw new Error(`No ${automatic ? 'automatic' : 'manual'} ${track} WebVTT caption track was available.`);
    }
    const downloaded = path.join(staging, name);
    const { size } = await stat(downloaded);
    if (!size || size > CAPTION_MAX_BYTES) throw new Error('The caption track is empty or exceeds the 4 MiB import limit.');
    const bytes = await readFile(downloaded);
    if (!/^\uFEFF?WEBVTT(?:[ \t]|\r?$)/m.test(bytes.toString('utf8').split('\n', 1)[0])) throw new Error('yt-dlp did not return WebVTT captions.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const transcriptKind = automatic ? 'automatic' : 'manual';
    const fileName = `${video.id}.${track}.${transcriptKind}.${hash.slice(0, 16)}.vtt`;
    const file = path.join(directory, fileName);
    try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!(await readFile(file)).equals(bytes)) throw new Error('A different caption file already occupies the output path.');
    }
    return { file, videoUrl: video.url, language: track, transcriptKind, rightsBasis: rights, contentHash: `sha256:${hash}` };
  } finally {
    if (path.dirname(staging) === root) await rm(staging, { recursive: true, force: true });
  }
}
