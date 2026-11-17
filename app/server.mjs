// @ts-check
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexRoom } from "./lib/codex-room.mjs";
import { loadSaved, listSaved, subscribe } from "./lib/council.mjs";
import { APP_ROOT, env } from "./lib/env.mjs";
import { BOARD, loadRoster } from "./lib/seats.mjs";
import { RoomError } from "./lib/session-store.mjs";
import * as watch from "./lib/watch.mjs";

const PUBLIC = fs.realpathSync(path.join(APP_ROOT, "public"));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8" };
const MAX_BODY = 64 * 1024;
const HEADERS = {
  "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { ...HEADERS, "content-type": type });
  return res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    throw new RoomError(415, "Send an application/json request.");
  }
  if (Number(req.headers["content-length"]) > MAX_BODY) throw new RoomError(413, "The request is too large.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RoomError(413, "The request is too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
    return value;
  } catch { throw new RoomError(400, "Send a valid JSON object."); }
}

function rosterResponse(runner) {
  const frame = (key, shape) => ["webp", "png", "jpg"].map((ext) => `${key}-${shape}.${ext}`)
    .find((file) => fs.existsSync(path.join(PUBLIC, "portraits", file)));
  const seats = loadRoster().map((seat) => ({ ...seat, portraits: Object.fromEntries(["base", "open", "mid", "blink"]
    .map((shape) => [shape, frame(seat.key, shape)]).filter(([, file]) => file).map(([shape, file]) => [shape, `/portraits/${file}`])) }));
  return { seats, board: BOARD, runner, hasKey: runner === "codex" };
}

function beginStream(res) {
  res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
  res.write(": connected\n\n");
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.on("close", () => clearInterval(ping));
}

function streamSession(req, res, store, id) {
  const last = Number(req.headers["last-event-id"]);
  let offset = Number.isSafeInteger(last) && last > 0 ? last : 0;
  const current = store.get(id, offset);
  if (!current) return false;
  if (offset > current.eventCount) offset = 0;
  if (current.status !== "running" && offset === current.eventCount) {
    res.writeHead(204, HEADERS);
    res.end();
    return true;
  }
  beginStream(res);
  const pump = () => {
    try {
      const session = store.get(id, offset);
      if (!session) return res.end();
      for (const event of session.events) {
        offset++;
        res.write(`id: ${offset}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (session.status !== "running") return res.end();
    } catch { res.end(); }
  };
  const interval = setInterval(pump, 250);
  res.on("close", () => clearInterval(interval));
  pump();
  return true;
}

function serveAsset(req, res, pathname) {
  const candidate = path.resolve(PUBLIC, `.${pathname === "/" ? "/index.html" : decodeURIComponent(pathname)}`);
  let file;
  try { file = fs.realpathSync(candidate); } catch { return send(res, 404, "Not found", "text/plain"); }
  if (!file.startsWith(`${PUBLIC}${path.sep}`) || !fs.statSync(file).isFile()) return send(res, 404, "Not found", "text/plain");
  res.writeHead(200, { ...HEADERS, "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(file);
  stream.on("error", () => res.destroy());
  return stream.pipe(res);
}

/** @param {{dataDir?: string, runner?: string, generate?: Parameters<typeof createCodexRoom>[0]["generate"], legacy?: boolean}} [settings] */
export function createRoomServer({ dataDir, runner = env("COUNCIL_RUNNER") || "codex", generate, legacy = true } = {}) {
  if (!["codex", "viewer"].includes(runner)) throw new Error('COUNCIL_RUNNER must be "codex" or "viewer".');
  const room = createCodexRoom({ dataDir, generate });
  const { store } = room;
  let legacyTimer;
  if (legacy) {
    watch.scan();
    legacyTimer = setInterval(() => { try { watch.scan(); } catch { /* A legacy file may still be in progress. */ } }, 1000);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const address = server.address();
      const host = req.headers.host?.toLowerCase();
      const port = address && typeof address === "object" ? address.port : 0;
      const suffix = port === 80 ? "" : `:${port}`;
      if (host !== `127.0.0.1${suffix}` && host !== `localhost${suffix}`) throw new RoomError(403, "Open the room on loopback.");
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw new RoomError(400, "Invalid room URL.");
      const origin = req.headers.origin;
      if ((origin || req.method === "POST") && origin !== `http://${host}`) throw new RoomError(403, "Use the room’s own origin.");
      const { pathname } = new URL(req.url, `http://${host}`);

      if (req.method === "POST") {
        if (pathname === "/api/council") {
          if (runner === "viewer") return send(res, 403, { error: "This room is viewing Codex sessions. Start a council with $roast-room in Codex." });
          const { id, completion } = room.start(await readJson(req));
          completion.catch(() => console.error("Could not save the council state."));
          return send(res, 202, { id });
        }
        const control = pathname.match(/^\/api\/council\/([\w-]+)\/(clarification|cancel)$/);
        if (control) {
          const [, id, action] = control;
          const data = await readJson(req);
          if (action === "clarification") store.answer(id, data.answer);
          else store.cancel(id);
          return send(res, 202, { id });
        }
        return send(res, 404, { error: "Room action not found." });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Unsupported room request." });

      if (pathname === "/api/seats") return send(res, 200, rosterResponse(runner));
      if (pathname === "/api/sessions") {
        const earlier = legacy ? [...listSaved().map(({ id, title, mode, status }) => ({ id, title, mode, status, source: "archive" })), ...watch.listLive()] : [];
        return send(res, 200, { sessions: [...store.list(), ...earlier].sort((a, b) => b.id.localeCompare(a.id)),
          running: store.activeId(), live: legacy ? watch.runningId() : null });
      }
      const stream = pathname.match(/^\/api\/stream\/([\w-]+)$/);
      if (stream && req.method === "GET") {
        const [, id] = stream;
        if (streamSession(req, res, store, id)) return;
        const old = legacy && watch.getLive(id);
        if (!old) return send(res, 404, { error: "Session not found." });
        beginStream(res);
        subscribe(old, res);
        if (old.status !== "running") res.end();
        return;
      }
      const archive = pathname.match(/^\/api\/sessions\/([\w-]+)(\/report\.md)?$/);
      if (archive) {
        const [, id, report] = archive;
        if (report) {
          const markdown = store.report(id);
          return markdown ? send(res, 200, markdown, "text/markdown; charset=utf-8") : send(res, 404, { error: "The decision report is not available." });
        }
        const saved = store.get(id);
        if (saved) return send(res, 200, saved);
        const live = legacy && watch.getLive(id);
        const earlier = legacy && (loadSaved(id) || (live && { id, title: live.title, mode: live.mode, status: live.status, events: live.events }));
        return earlier ? send(res, 200, earlier) : send(res, 404, { error: "Session not found." });
      }
      return serveAsset(req, res, pathname);
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof URIError) return send(res, 400, { error: "Invalid room URL." });
      if (error.safe) return send(res, error.statusCode || 500, { error: error.message });
      return send(res, 500, { error: "The local room could not complete the request." });
    }
  });
  server.on("close", () => {
    clearInterval(legacyTimer);
    room.close().catch(() => console.error("Could not close the room store."));
  });
  return server;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(env("PORT") || 4730);
  const server = createRoomServer();
  server.listen(port, "127.0.0.1", () => {
    const bound = server.address();
    if (bound && typeof bound === "object") console.log(`Roast Room on http://127.0.0.1:${bound.port}`);
  });
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
