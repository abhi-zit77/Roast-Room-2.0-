export function youtubeVideo(input) {
  let url;
  try { url = new URL(typeof input === 'string' ? input.trim() : ''); } catch { /* report uniformly below */ }
  let id;
  if (url?.protocol === 'https:' && !url.port && !url.username && !url.password) {
    if (url.hostname === 'youtu.be') id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    }
  }
  if (!validVideoId(id)) throw new Error('Supply a valid HTTPS YouTube video URL.');
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

export function validVideoId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
}

export function requiredText(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new Error(`${label} must be text between 1 and ${limit} characters.`);
  }
  return value.trim();
}

export function captionLanguage(value = 'en') {
  if (typeof value !== 'string' || !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8}){0,3}$/.test(value)) {
    throw new Error('Supply one caption language code, such as en or en-US.');
  }
  return value;
}

export function approvedHandle(value) {
  if (typeof value !== 'string' || !/^@?[A-Za-z0-9_.-]{3,30}$/.test(value.trim())) {
    throw new Error('Supply an approved YouTube channel handle, such as @Example.');
  }
  return value.trim().replace(/^@/, '').toLowerCase();
}
