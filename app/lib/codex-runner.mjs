// @ts-check
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "code_mode", "code_mode_host", "multi_agent", "multi_agent_v2",
  "apps", "plugins", "remote_plugin", "hooks", "plugin_hooks", "memories", "goals",
  "browser_use", "browser_use_external", "in_app_browser", "computer_use", "image_generation",
  "standalone_web_search", "skill_mcp_dependency_install", "tool_suggest", "current_time_reminder",
  "workspace_dependencies", "request_permissions_tool",
];
const MAX_OUTPUT_BYTES = 512 * 1024;

/** @param {{cwd: string, schemaPath: string, model: string}} settings */
export function codexArguments({ cwd, schemaPath, model }) {
  return [
    "exec", "--ignore-user-config", "--ignore-rules", "--strict-config", "--ephemeral",
    "--skip-git-repo-check", "--sandbox", "read-only", "--cd", cwd, "--color", "never", "--json",
    "--model", model, "--output-schema", schemaPath,
    "-c", 'approval_policy="never"', "-c", 'model_provider="openai"', "-c", 'model_reasoning_effort="low"',
    "-c", 'web_search="disabled"', "-c", "mcp_servers={}", "-c", "orchestrator.mcp.enabled=false",
    "-c", "orchestrator.skills.enabled=false", "-c", "skills.include_instructions=false",
    "-c", "project_doc_max_bytes=0", "-c", "include_environment_context=false",
    ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]), "-",
  ];
}

/** @param {string} workDir @param {NodeJS.ProcessEnv} [source] */
export function codexEnvironment(workDir, source = process.env) {
  const names = new Set([
    "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "USERPROFILE", "HOME", "APPDATA",
    "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "LANG", "LC_ALL", "CODEX_HOME",
  ]);
  const childEnv = Object.fromEntries(Object.entries(source).filter(([name]) => names.has(name.toUpperCase())));
  return {
    ...childEnv,
    TEMP: workDir, TMP: workDir, TMPDIR: workDir,
    // Codex 0.144.1 omits its executor environment with this value, including view_image and apply_patch.
    CODEX_EXEC_SERVER_URL: "none", CODEX_SQLITE_HOME: workDir,
  };
}

class CodexJobError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = "runtime") {
    super(message);
    this.code = code;
    this.safe = true;
  }
}

/** @param {{type?:string,item?:{type?:string,text?:string}}} event */
function checkEvent(event) {
  if (event?.type?.startsWith("item.") && !["agent_message", "reasoning", "error"].includes(event.item?.type ?? "")) {
    throw new CodexJobError("Codex attempted a tool call. The council stopped that job.", "tool");
  }
}

/** @param {{type?:string,item?:{type?:string,text?:string}}[]} events */
export function readCodexResult(events) {
  events.forEach(checkEvent);
  if (!events.some((event) => event.type === "turn.completed") || events.some((event) => event.type === "turn.failed")) {
    throw new CodexJobError("Codex did not complete the job.");
  }
  const last = events.findLast((event) => event.type === "item.completed" && event.item?.type === "agent_message");
  try {
    const value = JSON.parse(last?.item?.text ?? "");
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
    return value;
  } catch {
    throw new CodexJobError("Codex returned malformed structured output.", "invalid-output");
  }
}

/** @param {string} [configured] */
function findExecutable(configured) {
  if (configured) {
    if (!path.isAbsolute(configured) || !fs.existsSync(configured) ||
        (process.platform === "win32" && path.extname(configured).toLowerCase() !== ".exe")) {
      throw new CodexJobError("Set CODEX_BIN to the absolute path of the native Codex executable.");
    }
    return configured;
  }
  if (process.platform !== "win32") return "codex";
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute);
  const npmDir = path.join(process.env.APPDATA ?? os.homedir(), "npm");
  const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, "codex.exe")),
    ...[...new Set([npmDir, ...pathDirs])].map((dir) => path.join(dir, "node_modules", "@openai", "codex",
      "node_modules", `@openai/codex-win32-${process.arch}`, "vendor", target, "bin", "codex.exe")),
  ];
  const exe = candidates.find((candidate) => fs.existsSync(candidate));
  if (!exe) throw new CodexJobError("Install Codex CLI or set CODEX_BIN to its native codex.exe.");
  return exe;
}

/** @param {string} executable @param {string[]} args @param {string} cwd @param {string} prompt @param {AbortSignal | undefined} signal @param {number} timeoutMs */
function runChild(executable, args, cwd, prompt, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, args, {
      cwd, env: codexEnvironment(cwd), windowsHide: true, detached: process.platform !== "win32",
      shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    /** @type {{type?:string,item?:{type?:string,text?:string}}[]} */
    const events = [];
    let pending = "";
    let stderr = "";
    let bytes = 0;
    /** @type {unknown} */
    let failure;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      if (!child.pid) return;
      if (process.platform === "win32") child.kill();
      else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const abort = () => stop(signal?.reason ?? new CodexJobError("The council was cancelled."));
    const timer = setTimeout(() => stop(new CodexJobError("A Codex job timed out.", "timeout")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const consume = (line) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      checkEvent(event);
      events.push(event);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) return stop(new CodexJobError("Codex exceeded the structured output limit."));
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      try { lines.forEach(consume); } catch (error) { stop(error); }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.stdin.on("error", () => { /* `close` observes the process's failure. */ });
    child.on("error", () => stop(new CodexJobError("Unable to launch the Codex CLI.")));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure instanceof CodexJobError || signal?.aborted ? failure : new CodexJobError("Codex emitted invalid JSON events."));
      if (exitCode !== 0) {
        const details = stderr + JSON.stringify(events.filter((event) => event.type === "turn.failed" || event.type === "error"));
        if (/rate limit|usage limit|too many requests|quota/i.test(details)) return reject(new CodexJobError("Codex reached its usage or rate limit.", "rate-limit"));
        if (/unauthorized|not logged in|authentication|invalid api key/i.test(details)) return reject(new CodexJobError("Run codex login before starting the council.", "auth"));
        if (/unsupported|not supported|unknown variant|unrecognized|unknown feature|failed to parse/i.test(details)) return reject(new CodexJobError("The installed Codex CLI rejected the model or council settings. Check CODEX_MODEL and the CLI version.", "config"));
        return reject(new CodexJobError(`Codex exited before producing a result (exit ${exitCode ?? "unknown"}).`));
      }
      try { consume(pending); resolve(readCodexResult(events)); } catch (error) { reject(error); }
    });
    child.stdin.end(prompt, "utf8");
  });
}

/** @param {{executable?:string,model?:string,timeoutMs?:number}} [settings] */
export function createCodexRunner({ executable, model = "gpt-6.2-sol", timeoutMs = 180_000 } = {}) {
  let cli;
  let cliVersion;
  function runtime() {
    if (!cliVersion) {
      cli = findExecutable(executable);
      const result = spawnSync(cli, ["--version"], { windowsHide: true, timeout: 5000, encoding: "utf8" });
      const match = result.stdout?.match(/codex-cli (\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?/);
      if (!match || (+match[1] === 0 && (+match[2] < 144 || (+match[2] === 144 && +match[3] < 1)))) {
        throw new CodexJobError("Roast Room requires Codex CLI 0.144.1 or later.");
      }
      cliVersion = match[0];
    }
    return { provider: "openai-codex", model, cliVersion, preset: "isolated-read-only-v1" };
  }

  /** @param {{prompt:string,schema:object,signal?:AbortSignal,stage?:string}} job */
  async function generate({ prompt, schema, signal }) {
    signal?.throwIfAborted();
    runtime();
    const tmp = fs.realpathSync(os.tmpdir());
    const cwd = fs.mkdtempSync(path.join(tmp, "roast-room-job-"));
    try {
      const schemaPath = path.join(cwd, "schema.json");
      fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
      return await runChild(cli, codexArguments({ cwd, schemaPath, model }), cwd, prompt, signal, timeoutMs);
    } finally {
      if (path.dirname(cwd) === tmp && path.basename(cwd).startsWith("roast-room-job-")) {
        fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }
  return { runtime, generate };
}
