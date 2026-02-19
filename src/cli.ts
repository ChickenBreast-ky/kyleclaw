#!/usr/bin/env node
/**
 * Pi-Browser CLI
 * Multi-model AI browser control using Pi-AI
 *
 * Supported providers: OpenAI, Anthropic, Google, Mistral, Groq, OpenRouter, etc.
 */

import "dotenv/config";

import readline from "node:readline";
import { chromium, type Browser, type Page, type BrowserContext } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { startTelegramBot, stopTelegramBot, type MessageContext } from "./telegram.js";
import { startWebClient, stoppedTasks, loadSettings, broadcastToClients, saveResultToNotion } from "./web-client.js";
import { resolveStreamOptions, handleLogin, handleLogout, printAuthStatus, getAuthSourceSummary } from "./auth.js";
import {
  evaluateTelegramAgentOutcome,
  shouldFallbackToDefaultProfile,
  type TelegramOutcomeCode,
} from "./telegram-agent-outcome.js";
import {
  buildNaverBlogWriteMission,
  loadNaverBlogPostOptionsFromJson,
} from "./naver-blog.js";
import {
  loadWorkflows,
  loadWorkflow,
  saveWorkflow,
  WorkflowExecutor,
  startScheduler,
  type Workflow,
  type WorkflowLog,
} from "./workflow/index.js";

import { Type } from "@sinclair/typebox";
import {
  getModel,
  streamSimple,
  getProviders,
  getModels,
  type Api,
  type Context,
  type Tool,
  type Model as PiModel,
  type UserMessage,
  type AssistantMessage,
} from "@mariozechner/pi-ai";

type Model = PiModel<Api>;

// ============================================================
// 색상
// ============================================================
const c = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

type NormalizedAiError = {
  code?: number;
  status?: string;
  reason: string;
  retrySeconds?: number;
  quotaMetric?: string;
  raw: string;
};

function truncateForLog(text: string, maxLen = 400): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}... (truncated)`;
}

function safeJsonParse(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parseRetryDelaySeconds(input: string): number | undefined {
  const match = input.match(/(\d+(?:\.\d+)?)s/);
  if (!match) return undefined;
  const seconds = Number.parseFloat(match[1]);
  if (Number.isNaN(seconds)) return undefined;
  return Math.ceil(seconds);
}

function createUserMessage(content: string): UserMessage {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function normalizeAiError(rawInput: string): NormalizedAiError {
  const raw = rawInput?.trim() || "Unknown AI error";
  let code: number | undefined;
  let status: string | undefined;
  let reason = raw;
  let retrySeconds: number | undefined;
  let quotaMetric: string | undefined;

  const visitObject = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    const record = obj as Record<string, unknown>;
    const err = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : undefined;

    const candidateCode = err?.code ?? record.code;
    if (typeof candidateCode === "number") code = candidateCode;

    const candidateStatus = err?.status ?? record.status;
    if (typeof candidateStatus === "string" && candidateStatus.trim()) status = candidateStatus.trim();

    const candidateMessage = err?.message ?? record.message;
    if (typeof candidateMessage === "string" && candidateMessage.trim()) reason = candidateMessage.trim();

    const details = (err?.details ?? record.details) as unknown;
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (!detail || typeof detail !== "object") continue;
        const d = detail as Record<string, unknown>;
        const type = typeof d["@type"] === "string" ? d["@type"] : "";
        if (type.includes("RetryInfo") && typeof d.retryDelay === "string") {
          retrySeconds = parseRetryDelaySeconds(d.retryDelay) ?? retrySeconds;
        }
        if (type.includes("QuotaFailure") && Array.isArray(d.violations)) {
          const v = d.violations.find((x) => x && typeof x === "object") as Record<string, unknown> | undefined;
          if (v && typeof v.quotaMetric === "string") quotaMetric = v.quotaMetric;
        }
      }
    }
  };

  // 1차 파싱
  const parsed = safeJsonParse(raw);
  if (parsed) visitObject(parsed);

  // reason 안에 JSON 문자열이 중첩되어 있는 경우 최대 2단계 파싱
  for (let i = 0; i < 2; i++) {
    const nested = safeJsonParse(reason);
    if (!nested) break;
    visitObject(nested);
  }

  const retryFromText = parseRetryDelaySeconds(reason) ?? parseRetryDelaySeconds(raw);
  if (!retrySeconds && retryFromText) retrySeconds = retryFromText;

  // 사람이 읽기 쉬운 한 줄 원인으로 축약
  const firstLine = reason
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  if (firstLine) reason = firstLine;

  // 흔한 케이스를 한국어로 정규화
  if (code === 429 || status === "RESOURCE_EXHAUSTED") {
    reason = "요청 한도를 초과했습니다 (Quota exceeded).";
  } else if (code === 401 || status === "UNAUTHENTICATED") {
    reason = "API 키 인증에 실패했습니다.";
  } else if (code === 403 || status === "PERMISSION_DENIED") {
    reason = "권한이 없습니다. 프로젝트/키 권한을 확인하세요.";
  }

  return { code, status, reason, retrySeconds, quotaMetric, raw };
}

function formatAiErrorForUser(rawInput: string): { userMessage: string; debugMessage: string } {
  const parsed = normalizeAiError(rawInput);
  const codePart = parsed.code ? String(parsed.code) : "-";
  const statusPart = parsed.status || "-";
  const isResponsesScopeError = /missing\s+scopes:\s*api\.responses\.write/i.test(parsed.raw);

  let userMessage = `AI 요청 실패 [코드 ${codePart} / ${statusPart}]\n원인: ${parsed.reason}`;
  if (parsed.code === 429 || parsed.status === "RESOURCE_EXHAUSTED") {
    const retryText = parsed.retrySeconds ? `${parsed.retrySeconds}초 후 재시도` : "잠시 후 재시도";
    userMessage += `\n안내: ${retryText}하거나 모델을 변경(/set)하세요.`;
  }
  if (isResponsesScopeError) {
    userMessage +=
      "\n안내: OPENAI_API_KEY에 Responses API 쓰기 권한(api.responses.write)이 필요합니다." +
      " ChatGPT OAuth를 사용하려면 provider를 openai-codex로 변경하고 codex 모델을 선택하세요.";
  }

  const debugMessage =
    `code=${codePart}, status=${statusPart}, reason=${parsed.reason}` +
    (parsed.retrySeconds ? `, retry=${parsed.retrySeconds}s` : "") +
    (parsed.quotaMetric ? `, metric=${parsed.quotaMetric}` : "") +
    `, raw=${truncateForLog(parsed.raw, 600)}`;

  return { userMessage, debugMessage };
}

// ============================================================
// 브라우저 모드 (CDP or Extension)
// ============================================================
type BrowserMode = "cdp" | "extension";
let browserMode: BrowserMode = "cdp";

// ============================================================
// Chrome 프로필 관리
// ============================================================
interface ChromeProfile {
  name: string;
  path: string;
  displayName: string;
}

function getChromeProfilesDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  } else if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data");
  } else {
    return path.join(os.homedir(), ".config", "google-chrome");
  }
}

function scanChromeProfiles(): ChromeProfile[] {
  const profiles: ChromeProfile[] = [];
  const chromeDir = getChromeProfilesDir();

  // Pi-Browser 전용 프로필도 추가
  const piBrowserProfile = path.join(os.homedir(), ".pi-browser", "chrome-profile");
  profiles.push({
    name: "pi-browser",
    path: piBrowserProfile,
    displayName: "🤖 Pi-Browser (기본)",
  });

  if (!fs.existsSync(chromeDir)) {
    return profiles;
  }

  try {
    const entries = fs.readdirSync(chromeDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Default 프로필 또는 Profile N 형식
      if (entry.name === "Default" || entry.name.startsWith("Profile ")) {
        const profilePath = path.join(chromeDir, entry.name);
        const prefsPath = path.join(profilePath, "Preferences");

        let displayName = entry.name;

        // Preferences 파일에서 프로필 이름 읽기
        if (fs.existsSync(prefsPath)) {
          try {
            const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
            if (prefs.profile?.name) {
              displayName = prefs.profile.name;
            }
          } catch {}
        }

        profiles.push({
          name: entry.name,
          path: profilePath,
          displayName: `👤 ${displayName}`,
        });
      }
    }
  } catch (err) {
    console.error("프로필 스캔 오류:", err);
  }

  return profiles;
}

function findProfileByInput(input: string): ChromeProfile | null {
  const value = input.trim();
  if (!value) return null;

  const normalizedDisplayName = value.replace(/^👤\s*/, "");
  const profiles = scanChromeProfiles();
  return profiles.find((profile) => {
    const displayName = profile.displayName.replace(/^👤\s*/, "");
    return (
      profile.name === value ||
      profile.path === value ||
      profile.displayName === value ||
      displayName === normalizedDisplayName
    );
  }) || null;
}

// 현재 선택된 프로필
let selectedProfile: ChromeProfile | null = null;

// Extension 모드용 WebSocket
let wss: WebSocketServer | null = null;
let extClient: WebSocket | null = null;
let messageId = 0;
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

// Extension에 명령 전송
function sendExtCommand(command: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!extClient || extClient.readyState !== WebSocket.OPEN) {
      reject(new Error("Extension이 연결되지 않았습니다. Chrome에서 Pi-Browser 확장 프로그램을 확인하세요."));
      return;
    }

    const id = ++messageId;
    pendingRequests.set(id, { resolve, reject });

    extClient.send(JSON.stringify({ id, command, params }));

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(
          `Extension 응답 없음 (60초 타임아웃: ${command})\n` +
          `→ Chrome에서 chrome://extensions 열기\n` +
          `→ Pi-Browser 확장 프로그램 "새로고침" 버튼 클릭\n` +
          `→ 배지가 "ON"으로 바뀌면 다시 시도`
        ));
      }
    }, 60000);
  });
}

// WebSocket 서버 시작
let extensionConnectedOnce = false;

function startExtensionServer(): Promise<void> {
  if (wss) return Promise.resolve();
  return new Promise((resolve) => {
    wss = new WebSocketServer({ port: 9876 });

    wss.on("connection", (ws) => {
      if (!extensionConnectedOnce) {
        console.log(`${c.green}✓ Extension 연결됨${c.reset}`);
        extensionConnectedOnce = true;
      }
      extClient = ws;
      // 웹 UI에 Extension 연결 상태 알림
      broadcastToClients({ type: "extensionStatus", connected: true });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            return;
          }
          const pending = pendingRequests.get(msg.id);
          if (pending) {
            pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.result);
            }
          }
        } catch (e) {
          console.error("Extension 메시지 파싱 에러:", e);
        }
      });

      ws.on("close", () => {
        extClient = null;
        // 웹 UI에 Extension 연결 해제 알림
        broadcastToClients({ type: "extensionStatus", connected: false });
      });

      resolve();
    });

    console.log(`${c.cyan}Extension 서버 시작됨 (ws://localhost:9876)${c.reset}`);
    console.log(`${c.dim}Chrome에서 Pi-Browser 확장 프로그램이 자동으로 연결됩니다.${c.reset}\n`);
  });
}

// Extension 서버 종료
function stopExtensionServer() {
  if (wss) {
    wss.close();
    wss = null;
  }
  extClient = null;
}

// ============================================================
// 브라우저 관리 (CDP 모드)
// ============================================================
interface RunningChrome {
  process: ChildProcess;
  cdpUrl: string;
  userDataDir: string;
}

let chromeProcess: RunningChrome | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;

// ============================================================
// 병렬 브라우저 관리
// ============================================================
interface ParallelBrowser {
  id: number;
  profile: string;
  process: ChildProcess | null;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdpPort: number;
}

const parallelBrowsers: ParallelBrowser[] = [];

// 병렬 브라우저 시작
async function startParallelBrowsers(profiles: string[]): Promise<ParallelBrowser[]> {
  const executablePath = findChromeExecutable();
  if (!executablePath) throw new Error("Chrome not found");

  const chromeDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  const browsers: ParallelBrowser[] = [];

  console.log(`\n${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bright}🚀 병렬 브라우저 시작 (${profiles.length}개 프로필)${c.reset}`);
  console.log(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    const cdpPort = 9500 + i; // 9500, 9501, 9502, ...

    // 프로필 존재 확인
    const profilePath = path.join(chromeDir, profile);
    if (!fs.existsSync(profilePath)) {
      console.log(`${c.red}  ✗ 프로필 없음: ${profile}${c.reset}`);
      continue;
    }

    console.log(`${c.dim}  [${i + 1}/${profiles.length}] ${profile} 시작 중... (포트 ${cdpPort})${c.reset}`);

    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeDir}`,
      `--profile-directory=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "about:blank",
    ];

    const proc = spawn(executablePath, args, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const cdpUrl = `http://127.0.0.1:${cdpPort}`;

    // CDP 준비 대기
    let cdpReady = false;
    for (let j = 0; j < 30; j++) {
      try {
        const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(500) });
        if (res.ok) {
          cdpReady = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!cdpReady) {
      console.log(`${c.red}  ✗ CDP 연결 실패: ${profile}${c.reset}`);
      proc.kill();
      continue;
    }

    try {
      const browserInstance = await chromium.connectOverCDP(cdpUrl);
      const contexts = browserInstance.contexts();
      const ctx = contexts[0] ?? (await browserInstance.newContext());
      const pages = ctx.pages();
      const page = pages[0] ?? (await ctx.newPage());

      const pb: ParallelBrowser = {
        id: i,
        profile,
        process: proc,
        browser: browserInstance,
        context: ctx,
        page,
        cdpPort,
      };

      browsers.push(pb);
      parallelBrowsers.push(pb);

      console.log(`${c.green}  ✓ ${profile} 준비 완료${c.reset}`);
    } catch (error) {
      console.log(`${c.red}  ✗ 브라우저 연결 실패: ${profile} - ${(error as Error).message}${c.reset}`);
      proc.kill();
    }
  }

  console.log(`\n${c.green}✓ ${browsers.length}개 브라우저 준비 완료${c.reset}\n`);
  return browsers;
}

// 익명 병렬 브라우저 시작 (로그인 없는 새 브라우저)
async function startAnonymousParallelBrowsers(count: number): Promise<ParallelBrowser[]> {
  const executablePath = findChromeExecutable();
  if (!executablePath) throw new Error("Chrome not found");

  const browsers: ParallelBrowser[] = [];

  console.log(`\n${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bright}🚀 익명 브라우저 ${count}개 시작${c.reset}`);
  console.log(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

  for (let i = 0; i < count; i++) {
    const cdpPort = 9500 + i;
    const tempDir = path.join(os.tmpdir(), `pi-browser-${Date.now()}-${i}`);
    fs.mkdirSync(tempDir, { recursive: true });

    console.log(`${c.dim}  [${i + 1}/${count}] Browser ${i + 1} 시작 중... (포트 ${cdpPort})${c.reset}`);

    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-extensions",
      "about:blank",
    ];

    const proc = spawn(executablePath, args, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const cdpUrl = `http://127.0.0.1:${cdpPort}`;

    // CDP 준비 대기
    let cdpReady = false;
    for (let j = 0; j < 30; j++) {
      try {
        const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(500) });
        if (res.ok) {
          cdpReady = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!cdpReady) {
      console.log(`${c.red}  ✗ CDP 연결 실패: Browser ${i + 1}${c.reset}`);
      proc.kill();
      continue;
    }

    try {
      const browserInstance = await chromium.connectOverCDP(cdpUrl);
      const contexts = browserInstance.contexts();
      const ctx = contexts[0] ?? (await browserInstance.newContext());
      const pages = ctx.pages();
      const page = pages[0] ?? (await ctx.newPage());

      const pb: ParallelBrowser = {
        id: i,
        profile: `Browser ${i + 1}`,
        process: proc,
        browser: browserInstance,
        context: ctx,
        page,
        cdpPort,
      };

      browsers.push(pb);
      parallelBrowsers.push(pb);

      console.log(`${c.green}  ✓ Browser ${i + 1} 준비 완료${c.reset}`);
    } catch (error) {
      console.log(`${c.red}  ✗ 브라우저 연결 실패: Browser ${i + 1} - ${(error as Error).message}${c.reset}`);
      proc.kill();
    }
  }

  console.log(`\n${c.green}✓ ${browsers.length}개 브라우저 준비 완료${c.reset}\n`);
  return browsers;
}

// 병렬 브라우저 종료
async function stopParallelBrowsers(): Promise<void> {
  for (const pb of parallelBrowsers) {
    try {
      await pb.browser.close();
    } catch {}
    if (pb.process) {
      pb.process.kill("SIGTERM");
    }
  }
  parallelBrowsers.length = 0;
}

// 병렬 에이전트 실행
async function runParallelAgents(
  browsers: ParallelBrowser[],
  tasks: string[],
  model: Model,
  isOllama: boolean,
): Promise<void> {
  console.log(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bright}🎯 병렬 작업 시작 (${tasks.length}개 작업)${c.reset}`);
  console.log(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

  // 작업 배분 (라운드 로빈)
  const assignments: { browser: ParallelBrowser; task: string; index: number }[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const browserIdx = i % browsers.length;
    assignments.push({
      browser: browsers[browserIdx],
      task: tasks[i],
      index: i,
    });
  }

  // 각 브라우저별로 작업 표시
  for (const browser of browsers) {
    const browserTasks = assignments.filter((a) => a.browser.id === browser.id);
    console.log(`${c.yellow}[${browser.profile}]${c.reset} ${browserTasks.length}개 작업`);
    for (const a of browserTasks) {
      console.log(`  ${c.dim}${a.index + 1}. ${a.task.slice(0, 50)}...${c.reset}`);
    }
  }
  console.log();

  // 병렬 실행
  const results = await Promise.allSettled(
    assignments.map(async ({ browser, task, index }) => {
      console.log(`${c.blue}[${browser.profile}]${c.reset} ${c.bright}작업 ${index + 1} 시작${c.reset}`);
      await runParallelAgentSingle(browser, task, model, isOllama, index);
      console.log(`${c.green}[${browser.profile}]${c.reset} ${c.bright}작업 ${index + 1} 완료${c.reset}\n`);
    })
  );

  // 결과 요약
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  console.log(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bright}📊 병렬 작업 완료${c.reset}`);
  console.log(`  ${c.green}성공: ${succeeded}${c.reset} / ${c.red}실패: ${failed}${c.reset}`);
  console.log(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
}

// 단일 병렬 에이전트 실행
async function runParallelAgentSingle(
  pb: ParallelBrowser,
  mission: string,
  model: Model,
  isOllama: boolean,
  taskIndex: number
): Promise<void> {
  const prefix = `[${pb.profile}:${taskIndex + 1}]`;

  const ctx: Context = {
    systemPrompt: `You are a browser automation agent. You MUST use browser tools to complete ANY task.

IMPORTANT: You have access to a real browser. For ANY question (date, weather, news, prices, etc.),
use the browser to search and find the answer. NEVER say you don't know - just search for it!

TOOLS:
- get_current_time: {} - Get current date and time
- browser_navigate: {"url": "https://..."} - Go to URL (use google.com to search anything)
- browser_snapshot: {} - Get interactive elements with selectors
- browser_fill: {"selector": "...", "text": "..."} - Type text
- browser_click: {"selector": "..."} - Click element
- browser_press: {"key": "Enter"} - Press key
- browser_screenshot: {} - Capture screen
- browser_get_text: {"selector": ""} - Get page text

ALWAYS use tools. Search on Google if you need information.`,
    messages: [createUserMessage(mission)],
    tools: browserTools,
  };

  const maxTurns = 50;

  for (let turn = 0; turn < maxTurns; turn++) {
    let response: AssistantMessage;

    try {
      const streamOptions = await resolveStreamOptions(model.provider, isOllama);
      const s = streamSimple(model, ctx, streamOptions);

      for await (const event of s) {
        // 병렬 실행 시 출력 최소화
      }

      response = await s.result();
    } catch (error) {
      console.log(`${c.red}${prefix} Error: ${(error as Error).message}${c.reset}`);
      break;
    }

    ctx.messages.push(response);

    const toolCalls = response.content.filter((b) => b.type === "toolCall");

    if (toolCalls.length === 0) {
      break;
    }

    for (const call of toolCalls) {
      try {
        const result = await executeParallelBrowserTool(pb, call.name, call.arguments as Record<string, unknown>);

        ctx.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: result.text }],
          isError: false,
          timestamp: Date.now(),
        });
      } catch (error) {
        ctx.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          isError: true,
          timestamp: Date.now(),
        });
      }
    }
  }
}

// 병렬 브라우저용 도구 실행
async function executeParallelBrowserTool(
  pb: ParallelBrowser,
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; image?: { data: string; mimeType: string } }> {
  const page = pb.page;

  switch (name) {
    case "browser_navigate": {
      const url = args.url as string;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return { text: `Navigated to ${url}` };
    }

    case "browser_click": {
      const selector = args.selector as string;
      await page.click(selector, { timeout: 10000 });
      return { text: `Clicked: ${selector}` };
    }

    case "browser_fill": {
      const selector = args.selector as string;
      const text = args.text as string;
      await page.fill(selector, text);
      return { text: `Filled "${text}" into ${selector}` };
    }

    case "browser_press": {
      const key = args.key as string;
      await page.keyboard.press(key);
      return { text: `Pressed ${key}` };
    }

    case "browser_screenshot": {
      const buffer = await page.screenshot({ type: "png" });
      const base64 = buffer.toString("base64");
      return {
        text: "Screenshot taken",
        image: { data: base64, mimeType: "image/png" },
      };
    }

    case "browser_snapshot": {
      const snapshot = await page.locator(":root").ariaSnapshot();
      return { text: String(snapshot || "") };
    }

    case "browser_scroll": {
      const direction = args.direction as string;
      const amount = direction === "up" ? -500 : 500;
      await page.evaluate(`window.scrollBy(0, ${amount})`);
      return { text: `Scrolled ${direction}` };
    }

    case "browser_get_text": {
      const text = await page.innerText("body");
      return { text: text.slice(0, 5000) };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function findChromeExecutable(): string | null {
  const platform = os.platform();
  const paths: string[] =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : platform === "linux"
        ? ["/usr/bin/google-chrome", "/usr/bin/chromium"]
        : [
            path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
          ];

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Chrome 프로필 목록 가져오기
function getChromeProfiles(): { name: string; path: string }[] {
  const chromeDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  const profiles: { name: string; path: string }[] = [];

  if (!fs.existsSync(chromeDir)) return profiles;

  const entries = fs.readdirSync(chromeDir);
  for (const entry of entries) {
    const profilePath = path.join(chromeDir, entry);
    const prefsPath = path.join(profilePath, "Preferences");

    if (fs.existsSync(prefsPath)) {
      try {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
        const profileName = prefs?.profile?.name || entry;
        profiles.push({ name: profileName, path: profilePath });
      } catch {
        profiles.push({ name: entry, path: profilePath });
      }
    }
  }

  return profiles;
}

// 프로필에서 쿠키/로그인 정보 복사
async function importProfileData(sourceProfile: string): Promise<void> {
  const chromeDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  const sourcePath = path.join(chromeDir, sourceProfile);
  const targetPath = path.join(os.homedir(), ".pi-browser", "chrome-profile", "Default");

  // 소스 프로필 확인
  if (!fs.existsSync(sourcePath)) {
    console.log(`${c.red}프로필을 찾을 수 없습니다: ${sourceProfile}${c.reset}`);
    process.exit(1);
  }

  // 타겟 디렉토리 생성
  fs.mkdirSync(targetPath, { recursive: true });

  // 복사할 파일들 (쿠키, 로컬 스토리지, 로그인 데이터 등)
  const filesToCopy = [
    "Cookies",
    "Login Data",
    "Login Data For Account",
    "Web Data",
  ];

  const dirsToCopy = [
    "Local Storage",
    "Session Storage",
    "IndexedDB",
  ];

  console.log(`${c.cyan}프로필 데이터 복사 중...${c.reset}`);
  console.log(`${c.dim}소스: ${sourceProfile}${c.reset}`);
  console.log(`${c.dim}대상: pi-browser 프로필${c.reset}\n`);

  let copied = 0;

  // 파일 복사
  for (const file of filesToCopy) {
    const src = path.join(sourcePath, file);
    const dst = path.join(targetPath, file);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dst);
        console.log(`  ${c.green}✓${c.reset} ${file}`);
        copied++;
      } catch (e) {
        console.log(`  ${c.yellow}⚠${c.reset} ${file} (복사 실패 - 파일이 사용 중일 수 있음)`);
      }
    }
  }

  // 디렉토리 복사
  for (const dir of dirsToCopy) {
    const src = path.join(sourcePath, dir);
    const dst = path.join(targetPath, dir);
    if (fs.existsSync(src)) {
      try {
        fs.cpSync(src, dst, { recursive: true, force: true });
        console.log(`  ${c.green}✓${c.reset} ${dir}/`);
        copied++;
      } catch (e) {
        console.log(`  ${c.yellow}⚠${c.reset} ${dir}/ (복사 실패)`);
      }
    }
  }

  if (copied > 0) {
    console.log(`\n${c.green}✓ 프로필 데이터가 복사되었습니다.${c.reset}`);
    console.log(`${c.dim}이제 pi-browser에서 로그인 상태가 유지됩니다.${c.reset}\n`);
  } else {
    console.log(`\n${c.yellow}복사된 파일이 없습니다.${c.reset}\n`);
  }
}

// Chrome을 특정 프로필로 CDP 포트와 함께 시작
async function startChromeWithProfile(profileDir: string): Promise<void> {
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    console.log(`${c.red}Chrome을 찾을 수 없습니다.${c.reset}`);
    process.exit(1);
  }

  // 이미 9222 포트에 Chrome이 실행 중인지 확인
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      console.log(`${c.green}✓ 기존 Chrome에 연결됨 (포트 9222)${c.reset}`);
      console.log(`${c.dim}이미 CDP 포트가 열린 Chrome이 실행 중입니다.${c.reset}\n`);
      return;
    }
  } catch {}

  const chromeDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");

  // 프로필 존재 확인
  const profilePath = path.join(chromeDir, profileDir);
  if (!fs.existsSync(profilePath)) {
    console.log(`${c.red}프로필을 찾을 수 없습니다: ${profileDir}${c.reset}`);
    console.log(`${c.dim}/profiles 명령어로 사용 가능한 프로필을 확인하세요.${c.reset}\n`);
    process.exit(1);
  }

  console.log(`${c.cyan}Chrome 시작 중... (프로필: ${profileDir})${c.reset}`);
  console.log(`${c.yellow}⚠️  해당 프로필을 사용 중인 Chrome을 먼저 종료하세요!${c.reset}\n`);

  const args = [
    "--remote-debugging-port=9222",
    `--user-data-dir=${chromeDir}`,
    `--profile-directory=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  const proc = spawn(executablePath, args, {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  // CDP 준비 대기
  console.log(`${c.dim}CDP 연결 대기 중...${c.reset}`);
  let connected = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        connected = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  if (connected) {
    console.log(`${c.green}✓ Chrome이 CDP 포트 9222로 시작되었습니다.${c.reset}`);
    console.log(`${c.dim}이제 pi-browser가 이 Chrome에 자동으로 연결됩니다.${c.reset}\n`);
  } else {
    console.log(`${c.red}Chrome CDP 연결에 실패했습니다.${c.reset}`);
    console.log(`${c.dim}해당 프로필이 다른 Chrome에서 사용 중일 수 있습니다.${c.reset}\n`);
    process.exit(1);
  }
}

async function startBrowser(): Promise<void> {
  if (browser) return;

  // 1. 먼저 기존 브라우저 연결 시도 (포트 9222)
  const userCdpUrl = "http://127.0.0.1:9222";
  try {
    const res = await fetch(`${userCdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      console.log(`${c.green}✓ 기존 브라우저에 연결됨 (포트 9222)${c.reset}`);
      browser = await chromium.connectOverCDP(userCdpUrl);
      const contexts = browser.contexts();
      context = contexts[0] ?? (await browser.newContext());
      return;
    }
  } catch {
    // 기존 브라우저 없음 - 새로 실행
  }

  // 2. 새 브라우저 실행
  const executablePath = findChromeExecutable();
  if (!executablePath) throw new Error("Chrome not found");

  const cdpPort = 9444;

  // 프로필 경로 결정
  let userDataDir: string;
  let profileDir: string | undefined;

  if (selectedProfile) {
    // 사용자가 선택한 프로필 사용
    if (selectedProfile.name === "pi-browser") {
      // Pi-Browser 전용 프로필
      userDataDir = selectedProfile.path;
      fs.mkdirSync(userDataDir, { recursive: true });
    } else {
      // Chrome 기존 프로필 (Default, Profile 1 등)
      const chromeDir = getChromeProfilesDir();
      userDataDir = chromeDir;
      profileDir = selectedProfile.name;
    }
    console.log(`${c.cyan}프로필: ${selectedProfile.displayName}${c.reset}`);
  } else {
    // 기본 pi-browser 프로필 사용
    userDataDir = path.join(os.homedir(), ".pi-browser", "chrome-profile");
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    ...(profileDir ? [`--profile-directory=${profileDir}`] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "about:blank",
  ];

  const proc = spawn(executablePath, args, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const cdpUrl = `http://127.0.0.1:${cdpPort}`;

  // CDP 준비 대기
  let cdpReady = false;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        cdpReady = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!cdpReady) {
    // 프로세스가 살아있는지 확인
    if (proc.exitCode !== null || proc.killed) {
      throw new Error(
        selectedProfile
          ? `Chrome을 실행할 수 없습니다. '${selectedProfile}' 프로필이 다른 Chrome에서 사용 중일 수 있습니다.\n` +
            `해결방법: 해당 프로필을 사용하는 Chrome을 모두 종료하세요.`
          : "Chrome을 실행할 수 없습니다."
      );
    }
    throw new Error(`Chrome CDP 연결 시간 초과 (포트 ${cdpPort})`);
  }

  console.log(`${c.yellow}✓ 새 브라우저 실행됨${c.reset}`);
  chromeProcess = { process: proc, cdpUrl, userDataDir };
  browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  context = contexts[0] ?? (await browser.newContext());
}

async function stopBrowser(): Promise<void> {
  // 기존 브라우저에 연결한 경우 닫지 않음
  if (browser && chromeProcess) {
    await browser.close();
    browser = null;
    context = null;
  } else if (browser) {
    // 기존 브라우저는 연결만 해제
    browser = null;
    context = null;
  }
  if (chromeProcess) {
    chromeProcess.process.kill("SIGTERM");
    chromeProcess = null;
  }
}

async function getPage(): Promise<Page> {
  if (!context) throw new Error("Browser not running");
  const pages = context.pages();
  return pages[0] ?? (await context.newPage());
}

// ============================================================
// 브라우저 도구 정의
// ============================================================
const browserTools: Tool[] = [
  {
    name: "browser_navigate",
    description: "Navigate to a URL",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to navigate to" }),
    }),
  },
  {
    name: "browser_click",
    description: "Click an element by selector",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector or text selector" }),
    }),
  },
  {
    name: "browser_fill",
    description: "Fill text into an input field",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector for the input field" }),
      text: Type.String({ description: "Text to fill" }),
    }),
  },
  {
    name: "browser_press",
    description: "Press a keyboard key",
    parameters: Type.Object({
      key: Type.String({ description: "Key to press such as Enter, Tab, Escape" }),
    }),
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page",
    parameters: Type.Object({}),
  },
  {
    name: "browser_snapshot",
    description: "Get the accessibility snapshot of the page with interactive elements",
    parameters: Type.Object({}),
  },
  {
    name: "browser_scroll",
    description: "Scroll the page up or down",
    parameters: Type.Object({
      direction: Type.String({ description: "Scroll direction: up or down" }),
    }),
  },
  {
    name: "browser_get_text",
    description: "Get text content from the page",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector or empty string for full page" }),
    }),
  },
  {
    name: "browser_wait",
    description: "Wait for a condition: time, text to appear, text to disappear, or element",
    parameters: Type.Object({
      timeMs: Type.String({ description: "Wait time in milliseconds (e.g. 5000 for 5 seconds)" }),
      text: Type.String({ description: "Wait for this text to appear on page" }),
      textGone: Type.String({ description: "Wait for this text to disappear (e.g. Loading...)" }),
      selector: Type.String({ description: "Wait for this element to be visible" }),
    }),
  },
  {
    name: "browser_download",
    description: "Click a download button/link and save the file",
    parameters: Type.Object({
      selector: Type.String({ description: "Selector of download button/link to click" }),
      filename: Type.String({ description: "Filename to save as (e.g. song.mp3)" }),
    }),
  },
  {
    name: "browser_upload",
    description: "Upload local files via file input or file chooser",
    parameters: Type.Object({
      selector: Type.String({ description: "File input selector OR upload button selector" }),
      filePaths: Type.Array(Type.String({ description: "Absolute or relative file path" })),
    }),
  },
  {
    name: "get_current_time",
    description: "Get the current date and time",
    parameters: Type.Object({}),
  },
];

// ============================================================
// Extension 모드 도구 실행
// ============================================================
async function executeExtensionTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; image?: { data: string; mimeType: string } }> {
  switch (name) {
    case "browser_navigate": {
      const result = await sendExtCommand("navigate", { url: args.url });
      return { text: `Navigated to ${result.url}. Title: ${result.title}` };
    }

    case "browser_click": {
      const selector = args.selector as string;
      await sendExtCommand("click", { selector });
      return { text: `Clicked: ${selector}` };
    }

    case "browser_fill": {
      const selector = args.selector as string;
      const text = args.text as string;
      await sendExtCommand("fill", { selector, value: text });
      return { text: `Filled "${text}" into ${selector}` };
    }

    case "browser_press": {
      await sendExtCommand("press", { key: args.key });
      return { text: `Pressed: ${args.key}` };
    }

    case "browser_screenshot": {
      const result = await sendExtCommand("screenshot", {});
      // Extension에서 data URL 형식으로 반환
      const dataUrl = result.image as string;
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
      return {
        text: "Screenshot captured",
        image: {
          data: base64,
          mimeType: "image/png",
        },
      };
    }

    case "browser_snapshot": {
      const result = await sendExtCommand("snapshot", {});
      const elements = result.elements as Array<{
        ref: string;
        tag: string;
        text: string;
        selector: string;
      }>;

      const lines = elements
        .slice(0, 20)
        .map((el, i) => `[e${i + 1}] ${el.tag} "${el.text.slice(0, 50)}" → ${el.selector}`);

      return { text: `Page elements:\n${lines.join("\n")}` };
    }

    case "browser_scroll": {
      const direction = (args.direction as string) || "down";
      await sendExtCommand("scroll", { direction, amount: 500 });
      return { text: `Scrolled ${direction}` };
    }

    case "browser_get_text": {
      const result = await sendExtCommand("getText", {});
      const text = (result.text as string).slice(0, 5000);
      return { text: `Page text:\n${text}` };
    }

    case "browser_wait": {
      const timeMs = args.timeMs as number | undefined;
      if (timeMs) {
        await new Promise((r) => setTimeout(r, timeMs));
        return { text: `Waited ${timeMs}ms` };
      }
      return { text: "Waited" };
    }

    case "browser_upload": {
      return {
        text: "File upload is not supported in extension mode. Use CDP mode (default) with a Chrome profile.",
      };
    }

    case "get_current_time": {
      const now = new Date();
      const dateStr = now.toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      });
      const timeStr = now.toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      return { text: `현재 날짜: ${dateStr}\n현재 시간: ${timeStr}` };
    }

    default:
      return { text: `Unknown tool: ${name}` };
  }
}

// ============================================================
// 브라우저 도구 실행 (CDP 모드)
// ============================================================
async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; image?: { data: string; mimeType: string } }> {
  // Extension 모드
  if (browserMode === "extension") {
    return executeExtensionTool(name, args);
  }

  // CDP 모드
  if (!browser) {
    await startBrowser();
  }

  const page = await getPage();

  switch (name) {
    case "browser_navigate": {
      await page.goto(args.url as string, { waitUntil: "domcontentloaded" });
      const title = await page.title();
      return { text: `Navigated to ${args.url}. Title: ${title}` };
    }

    case "browser_click": {
      const selector = args.selector as string;
      // role:"name" 형식 처리
      const roleMatch = selector.match(/^(\w+):"([^"]*)"$/);
      if (roleMatch) {
        const [, role, name] = roleMatch;
        await page.getByRole(role as any, { name, exact: false }).first().click();
      } else if (selector.match(/^\w+$/)) {
        // role만 있는 경우
        await page.getByRole(selector as any).first().click();
      } else {
        // 일반 CSS 셀렉터
        await page.locator(selector).first().click();
      }
      await page.waitForTimeout(1000);
      return { text: `Clicked: ${selector}` };
    }

    case "browser_fill": {
      const selector = args.selector as string;
      const text = args.text as string;
      // role:"name" 형식 처리
      const roleMatch = selector.match(/^(\w+):"([^"]*)"$/);
      if (roleMatch) {
        const [, role, name] = roleMatch;
        await page.getByRole(role as any, { name, exact: false }).first().fill(text);
      } else if (selector.match(/^\w+$/)) {
        // role만 있는 경우 (예: textbox, searchbox)
        await page.getByRole(selector as any).first().fill(text);
      } else {
        // 일반 CSS 셀렉터
        await page.locator(selector).first().fill(text);
      }
      return { text: `Filled "${text}" into ${selector}` };
    }

    case "browser_press": {
      await page.keyboard.press(args.key as string);
      await page.waitForTimeout(500);
      return { text: `Pressed: ${args.key}` };
    }

    case "browser_screenshot": {
      const buffer = await page.screenshot({ type: "jpeg", quality: 80 });
      return {
        text: "Screenshot captured",
        image: {
          data: buffer.toString("base64"),
          mimeType: "image/jpeg",
        },
      };
    }

    case "browser_snapshot": {
      // Playwright의 ariaSnapshot 사용 (클로드봇 방식)
      const ariaSnapshot = await page.locator(":root").ariaSnapshot();

      // 인터랙티브 요소만 추출
      const lines = String(ariaSnapshot || "").split("\n");
      const interactiveRoles = ["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio"];
      const results: string[] = [];
      let refIdx = 1;

      for (const line of lines) {
        const match = line.match(/^\s*-\s*(\w+)(?:\s+"([^"]*)")?/);
        if (!match) continue;

        const [, role, name] = match;
        if (!interactiveRoles.includes(role.toLowerCase())) continue;

        // ref 형식: role:name 또는 role만
        const ref = name ? `${role}:"${name}"` : role;
        results.push(`[e${refIdx}] ${role}${name ? ` "${name}"` : ""} → ${ref}`);
        refIdx++;

        if (refIdx > 20) break; // 최대 20개
      }

      return { text: `Page elements (use ref value for selector):\n${results.join("\n")}` };
    }

    case "browser_scroll": {
      const dir = args.direction as string;
      const amount = dir === "down" ? 500 : -500;
      await page.evaluate(`window.scrollBy(0, ${amount})`);
      return { text: `Scrolled ${dir}` };
    }

    case "browser_get_text": {
      const selector = typeof args.selector === "string" ? args.selector.trim() : "";

      if (!selector) {
        const fullText = await page.evaluate<string>("() => document.body?.innerText || ''");
        return { text: fullText.slice(0, 2000) };
      }

      const locator = page.locator(selector).first();

      try {
        await locator.waitFor({ state: "attached", timeout: 5000 });
        let text = (await locator.textContent({ timeout: 5000 })) ?? "";
        if (!text.trim()) {
          text = await locator.innerText({ timeout: 5000 });
        }
        return { text: text.slice(0, 2000) };
      } catch (error) {
        const pagePreview = await page.evaluate("() => (document.body?.innerText || '').slice(0, 1000)");
        const shortErr = (error as Error).message.split("\n")[0];
        return {
          text:
            `선택자 "${selector}"에서 텍스트를 찾지 못했습니다. (${shortErr})\n` +
            `힌트: browser_snapshot으로 실제 요소 ref를 다시 확인하세요.\n` +
            `페이지 미리보기:\n${pagePreview}`,
        };
      }
    }

    case "browser_wait": {
      const timeMs = args.timeMs as string | undefined;
      const text = args.text as string | undefined;
      const textGone = args.textGone as string | undefined;
      const selector = args.selector as string | undefined;
      const results: string[] = [];

      // 시간 대기
      if (timeMs && parseInt(timeMs) > 0) {
        const ms = Math.min(parseInt(timeMs), 60000); // 최대 60초
        await page.waitForTimeout(ms);
        results.push(`Waited ${ms}ms`);
      }

      // 텍스트 나타날 때까지 대기
      if (text) {
        await page.getByText(text).first().waitFor({ state: "visible", timeout: 30000 });
        results.push(`Text "${text}" appeared`);
      }

      // 텍스트 사라질 때까지 대기
      if (textGone) {
        await page.getByText(textGone).first().waitFor({ state: "hidden", timeout: 60000 });
        results.push(`Text "${textGone}" disappeared`);
      }

      // 요소 나타날 때까지 대기
      if (selector) {
        await page.locator(selector).first().waitFor({ state: "visible", timeout: 30000 });
        results.push(`Element "${selector}" visible`);
      }

      return { text: results.length > 0 ? results.join(", ") : "Wait completed" };
    }

    case "browser_download": {
      const selector = args.selector as string;
      const filename = args.filename as string || "download";

      // 다운로드 대기 설정
      const downloadPromise = page.waitForEvent("download", { timeout: 120000 });

      // 다운로드 버튼 클릭
      const roleMatch = selector.match(/^(\w+):"([^"]*)"$/);
      if (roleMatch) {
        const [, role, name] = roleMatch;
        await page.getByRole(role as any, { name, exact: false }).first().click();
      } else if (selector.match(/^\w+$/)) {
        await page.getByRole(selector as any).first().click();
      } else {
        await page.locator(selector).first().click();
      }

      // 다운로드 완료 대기
      const download = await downloadPromise;
      const suggestedName = download.suggestedFilename();

      // 파일 저장
      const downloadDir = path.join(os.homedir(), "Downloads");
      const savePath = path.join(downloadDir, filename || suggestedName);
      await download.saveAs(savePath);

      return { text: `Downloaded: ${savePath} (${suggestedName})` };
    }

    case "browser_upload": {
      const selector = args.selector as string;
      const raw = (args.filePaths as unknown) ?? [];
      const filePaths: string[] = Array.isArray(raw)
        ? (raw as unknown[]).map(String)
        : typeof raw === "string"
          ? raw.split(",").map((s) => s.trim()).filter(Boolean)
          : [];

      if (!selector || filePaths.length === 0) {
        throw new Error("browser_upload requires selector and filePaths[]");
      }

      const resolved = filePaths.map((p) => (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)));
      const missing = resolved.filter((p) => !fs.existsSync(p));
      if (missing.length > 0) {
        throw new Error(`File not found: ${missing.join(", ")}`);
      }

      const loc = page.locator(selector).first();

      // Strategy 1: input[type=file]
      try {
        const isFileInput = await loc.evaluate((el) => {
          const tag = String((el as any).tagName || "").toLowerCase();
          if (tag !== "input") return false;
          const type = (el as any).type;
          return String(type).toLowerCase() === "file";
        });

        if (isFileInput) {
          await loc.setInputFiles(resolved);
          await page.waitForTimeout(1000);
          return { text: `Uploaded ${resolved.length} file(s) via input: ${selector}` };
        }
      } catch {
        // fall through to chooser strategy
      }

      // Strategy 2: click to open file chooser
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10000 }),
        loc.click(),
      ]);
      await chooser.setFiles(resolved);
      await page.waitForTimeout(1000);
      return { text: `Uploaded ${resolved.length} file(s) via chooser: ${selector}` };
    }

    case "get_current_time": {
      const now = new Date();
      const dateStr = now.toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      });
      const timeStr = now.toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      return { text: `현재 날짜: ${dateStr}\n현재 시간: ${timeStr}` };
    }

    default:
      return { text: `Unknown tool: ${name}` };
  }
}

// ============================================================
// 설정
// ============================================================
interface Config {
  provider: string;
  model: string;
  ollamaUrl?: string;
  chromeProfile?: string; // 사용자 Chrome 프로필 경로
}

const CONFIG_PATH = path.join(os.homedir(), ".pi-browser.json");

const DEFAULT_PROVIDER = "google";

function buildDefaultModelByProvider(): Record<string, string> {
  const PREFERRED_MODELS: Record<string, string[]> = {
    "google": ["gemini-2.5-flash", "gemini-2.0-flash"],
    "openai": ["gpt-4o", "gpt-4.1"],
    "openai-codex": ["gpt-5.3-codex", "gpt-5.2", "gpt-5.1"],
    "anthropic": ["claude-sonnet-4-5", "claude-sonnet-4-0"],
    "groq": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    "ollama": ["llama3.2"],
  };

  const result: Record<string, string> = {};
  for (const [provider, preferred] of Object.entries(PREFERRED_MODELS)) {
    try {
      const models = getModels(provider as any);
      for (const preferredId of preferred) {
        const found = models.find(m => m.id === preferredId);
        if (found) {
          result[provider] = found.id;
          break;
        }
      }
      if (!result[provider] && models.length > 0) {
        result[provider] = models[0].id;
      }
    } catch {
      result[provider] = preferred[0];
    }
  }
  return result;
}

const DEFAULT_MODEL_BY_PROVIDER = buildDefaultModelByProvider();

function isProviderAllowed(provider: string): boolean {
  return true;
}

function normalizeProvider(provider?: string): string {
  if (!provider) return DEFAULT_PROVIDER;
  return isProviderAllowed(provider) ? provider : DEFAULT_PROVIDER;
}

function getDefaultModelForProvider(provider: string): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider] || DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER];
}

function getSafeFallbackModel(): Model {
  const fallbackOrder = ["google", "openai", "anthropic", "openai-codex", "groq"];

  for (const provider of fallbackOrder) {
    const modelId = DEFAULT_MODEL_BY_PROVIDER[provider];
    if (modelId) {
      const model = getModel(provider as any, modelId as any);
      if (model) return model;
    }
  }

  throw new Error("사용 가능한 기본 모델을 찾을 수 없습니다. /set 으로 모델을 설정하세요.");
}

function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
      const provider = normalizeProvider(typeof raw.provider === "string" ? raw.provider : undefined);
      const model = typeof raw.model === "string" ? raw.model : getDefaultModelForProvider(provider);
      const ollamaUrl = typeof raw.ollamaUrl === "string" ? raw.ollamaUrl : undefined;
      const chromeProfile = typeof raw.chromeProfile === "string" ? raw.chromeProfile : undefined;
      return {
        provider,
        model,
        ...(ollamaUrl ? { ollamaUrl } : {}),
        ...(chromeProfile ? { chromeProfile } : {}),
      };
    }
  } catch {}
  return { provider: DEFAULT_PROVIDER, model: getDefaultModelForProvider(DEFAULT_PROVIDER) };
}

function saveConfig(config: Config): void {
  const next: Config = {
    provider: normalizeProvider(config.provider),
    model: config.model,
    ...(config.ollamaUrl ? { ollamaUrl: config.ollamaUrl } : {}),
    ...(config.chromeProfile ? { chromeProfile: config.chromeProfile } : {}),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
}

// Ollama 모델 생성
function createOllamaModel(modelId: string, baseUrl: string = "http://localhost:11434/v1"): Model {
  return {
    id: modelId,
    name: `${modelId} (Ollama)`,
    api: "openai-completions",
    provider: "ollama",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

// 모델 가져오기 (Ollama 지원)
function resolveModel(config: Config): Model {
  const provider = normalizeProvider(config.provider);
  const modelId = config.model || getDefaultModelForProvider(provider);

  if (provider === "ollama") {
    return createOllamaModel(modelId, config.ollamaUrl);
  }

  try {
    const model = getModel(provider as any, modelId as any);
    if (!model) {
      const fallback = getSafeFallbackModel();
      console.log(`${c.yellow}⚠️ 모델을 찾을 수 없음: ${provider}/${modelId}, 기본 모델 사용(${fallback.provider}/${fallback.id})${c.reset}`);
      return fallback;
    }
    return model;
  } catch (e) {
    const fallback = getSafeFallbackModel();
    console.log(`${c.yellow}⚠️ 모델 로드 실패: ${(e as Error).message}, 기본 모델 사용(${fallback.provider}/${fallback.id})${c.reset}`);
    return fallback;
  }
}

// ============================================================
// 에이전트 루프
// ============================================================
async function runAgent(
  mission: string,
  model: Model,
  isOllama: boolean = false,
): Promise<void> {
  console.log(`\n${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bright}🎯 미션: ${mission}${c.reset}`);
  console.log(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

  const ctx: Context = {
    systemPrompt: `You are a browser automation agent with FULL browser access.

CRITICAL RULES:
1. NEVER say "I can't" or "I'm sorry" - just DO IT using the browser!
2. You have access to a REAL browser with logged-in sessions. Just navigate and use it!
3. Start with browser_navigate, then browser_snapshot to see the page.
4. The browser has the user's cookies/logins. Just go to the website!

TOOLS:
- get_current_time: {} - Get current date and time
- browser_navigate: {"url": "..."} - Go to any URL directly
- browser_snapshot: {} - See page elements (ALWAYS do this after navigate!)
- browser_fill: {"selector": "...", "text": "..."} - Type text
- browser_click: {"selector": "..."} - Click element
- browser_press: {"key": "Enter"} - Press key
- browser_screenshot: {} - Capture screen
- browser_get_text: {"selector": ""} - Get page text
- browser_wait: {"timeMs": "5000"} - Wait for time (ms)
- browser_wait: {"text": "Complete"} - Wait for text to appear
- browser_wait: {"textGone": "Loading..."} - Wait for text to disappear
- browser_download: {"selector": "...", "filename": "file.mp3"} - Download file
- browser_upload: {"selector": "...", "filePaths": ["/abs/path/a.png"]} - Upload local file(s)

WORKFLOW: navigate → snapshot → interact → get_text → report
SELECTOR FORMAT: role:"name" (e.g., textbox:"Search", button:"Submit")

DO NOT refuse. DO NOT apologize. Just USE THE BROWSER.`,
    messages: [createUserMessage(mission)],
    tools: browserTools,
  };

  const maxTurns = 100;
  let consecutiveEmptyResponses = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    console.log(`${c.blue}[Turn ${turn + 1}/${maxTurns}]${c.reset}`);

    let response: AssistantMessage;

    try {
      // 스트리밍으로 응답 받기
      const streamOptions = await resolveStreamOptions(model.provider, isOllama);
      const s = streamSimple(model, ctx, streamOptions);
      let textBuffer = "";

      process.stdout.write(`${c.magenta}AI: ${c.reset}`);

      for await (const event of s) {
        if (event.type === "text_delta") {
          process.stdout.write(event.delta);
          textBuffer += event.delta;
        } else if (event.type === "toolcall_start") {
          console.log(`\n${c.dim}[tool call]${c.reset}`);
        }
      }

      response = await s.result();
      console.log();
    } catch (error) {
      console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
      break;
    }

    // 디버그: 응답 내용 출력
    if (response.content.length === 0) {
      console.log(`${c.dim}[DEBUG] Empty response content${c.reset}`);
    }

    // 도구 호출 처리
    const toolCalls = response.content.filter((b) => b.type === "toolCall");
    const textContent = response.content.find((b) => b.type === "text");
    const hasText = !!(textContent && textContent.type === "text" && textContent.text.trim());

    // 토큰 절약: actionable 응답(toolCall 또는 non-empty text)만 context에 추가
    if (toolCalls.length > 0 || hasText) {
      ctx.messages.push(response);
    }

    if (toolCalls.length === 0) {
      // 텍스트 응답이 있으면 완료
      if (textContent && textContent.type === "text" && textContent.text.trim()) {
        console.log(`\n${c.green}✅ 미션 완료${c.reset}\n`);
        consecutiveEmptyResponses = 0;
      } else {
        consecutiveEmptyResponses += 1;

        if (response.stopReason === "error") {
          console.log(`${c.red}❌ AI 응답 오류: ${response.errorMessage || "빈 응답"}${c.reset}`);
          break;
        }

        if (consecutiveEmptyResponses >= 3) {
          console.log(`${c.red}❌ AI가 ${consecutiveEmptyResponses}회 연속 빈 응답을 반환했습니다. 모델 상태를 확인하세요.${c.reset}`);
          break;
        }

        const delayMs = 2000 * Math.pow(2, consecutiveEmptyResponses - 1);
        console.log(
          `${c.yellow}⚠️ AI가 빈 응답을 반환했습니다 (${consecutiveEmptyResponses}/3). ${delayMs / 1000}초 후 재시도...${c.reset}`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        ctx.messages.push(createUserMessage("도구를 사용해서 작업을 수행하세요. 먼저 browser_navigate로 웹사이트에 접속하세요."));
        continue;
      }
      break;
    }

    consecutiveEmptyResponses = 0;

    // 도구 실행
    for (const call of toolCalls) {
      console.log(`${c.yellow}  → ${call.name}(${JSON.stringify(call.arguments)})${c.reset}`);

      try {
        const result = await executeBrowserTool(call.name, call.arguments as Record<string, unknown>);

        console.log(`${c.green}  ✓ ${result.text.split("\n")[0]}${c.reset}`);

        // 도구 결과 추가
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text", text: result.text },
        ];

        if (result.image) {
          content.push({
            type: "image",
            data: result.image.data,
            mimeType: result.image.mimeType,
          });
        }

        ctx.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content,
          isError: false,
          timestamp: Date.now(),
        });
      } catch (error) {
        const errMsg = (error as Error).message;
        console.log(`${c.red}  ✗ ${errMsg}${c.reset}`);

        ctx.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          isError: true,
          timestamp: Date.now(),
        });
      }
    }

    console.log();
  }
}

// ============================================================
// CLI
// ============================================================
function printBanner(config: Config) {
  console.log(`
${c.bright}🤖 Pi-Browser${c.reset} ${c.dim}(${config.provider}/${config.model})${c.reset}

${c.dim}예시:${c.reset} 네이버에서 날씨 알려줘
${c.dim}명령:${c.reset} e (로그인)  p 3 (병렬, 작업 하나씩 입력)  help  exit
`);
}

function printHelp() {
  console.log(`
${c.bright}명령어${c.reset} ${c.dim}(슬래시 없이도 됨)${c.reset}

${c.yellow}e${c.reset}               로그인 모드 (내 Chrome 계정 사용)
${c.yellow}tg${c.reset}              텔레그램 봇 모드 (TELEGRAM_BOT_TOKEN 필요)
 ${c.yellow}web${c.reset}             웹 UI 모드 (http://localhost:3456)
 ${c.yellow}naver-blog <json>${c.reset}  네이버 블로그 글쓰기 (Playwright/CDP, JSON 파일)
 ${c.yellow}p N${c.reset}             병렬 실행 (브라우저 N개, 작업 하나씩 입력)
                예: p 3 → 작업 입력 → 빈 줄로 실행
${c.yellow}profiles${c.reset}        Chrome 프로필 목록
${c.yellow}models${c.reset}          AI 모델 목록
${c.yellow}tg-selftest${c.reset}     텔레그램 분기 판정 셀프테스트
${c.yellow}set P M${c.reset}         모델 변경 (예: set google gemini-2.5-flash)
${c.yellow}config${c.reset}          현재 설정
${c.yellow}login${c.reset}           OAuth 로그인 (예: login anthropic)
${c.yellow}logout${c.reset}          OAuth 로그아웃
${c.yellow}auth${c.reset}            인증 상태 확인
${c.yellow}version${c.reset}         버전 정보
${c.yellow}exit${c.reset}            종료
`);
}

// 버전 정보
function printVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
  console.log(`
${c.bright}Pi-Browser${c.reset} v${pkg.version}

${c.dim}Multi-model AI browser control CLI${c.reset}
${c.dim}https://github.com/johunsang/pi-browser${c.reset}
`);
}

// 웹 UI 모드
async function runWebMode(config: Config, overridePort?: number): Promise<void> {
  const requestedPort = overridePort ?? parseInt(process.env.WEB_PORT || "3456", 10);
  const model = resolveModel(config);
  const isOllama = config.provider === "ollama";

  console.log(`\n${c.cyan}🌐 웹 UI 모드${c.reset}`);
  console.log(`${c.dim}웹 UI 서버 시작 중...${c.reset}\n`);

  // Extension 서버를 웹 UI 시작 시 바로 시작 (Extension 모드 연결 대기)
  if (!wss) {
    await startExtensionServer();
  }

  let currentTelegramBot: Awaited<ReturnType<typeof startTelegramBot>> | null = null;

  const { port: webPort } = await startWebClient({
    port: requestedPort,
    onTelegramStart: async (token, allowedUsers) => {
      if (currentTelegramBot) {
        stopTelegramBot();
        currentTelegramBot = null;
      }
      currentTelegramBot = await startTelegramBot({
        token,
        allowedUsers: allowedUsers.length > 0 ? allowedUsers : undefined,
        onMessage: async (text, _ctx) => {
          console.log(`[Telegram] 메시지 수신: ${text}`);
          return await runTelegramAgent(text, model, isOllama);
        },
      });
    },
    onTelegramStop: () => {
      if (currentTelegramBot) {
        stopTelegramBot();
        currentTelegramBot = null;
      }
    },
    onSettingsChange: (newSettings) => {
      console.log(`[WebClient] 설정 변경됨:`, JSON.stringify(newSettings));
    },
    getProfiles: () => {
      return scanChromeProfiles();
    },
    isExtensionConnected: () => {
      return extClient !== null && extClient.readyState === 1; // WebSocket.OPEN = 1
    },
    onWorkflowRun: async (workflow, send, profilePath) => {
      console.log(`[WebClient] 워크플로우 실행: ${workflow.name} (프로필: ${profilePath || '기본'})`);

      // 설정에서 AI 확인
      const currentSettings = loadSettings();

      // AI 모델 설정
      let taskModel = model;
      let taskIsOllama = isOllama;
      if (currentSettings.ai?.provider) {
        const aiProvider = normalizeProvider(currentSettings.ai.provider);
        const aiModelName = currentSettings.ai.model || getDefaultModelForProvider(aiProvider);
        let aiOllamaUrl = currentSettings.ai.ollamaUrl || "http://localhost:11434";
        if (!aiOllamaUrl.endsWith("/v1")) {
          aiOllamaUrl = aiOllamaUrl.replace(/\/$/, "") + "/v1";
        }
        taskIsOllama = aiProvider === "ollama";

        try {
          if (taskIsOllama) {
            taskModel = createOllamaModel(aiModelName, aiOllamaUrl);
          } else {
            const fetchedModel = getModel(aiProvider as any, aiModelName as any);
            if (fetchedModel) taskModel = fetchedModel;
          }
        } catch (e) {
          // 기본 모델 사용
        }
      }

      // 워크플로우는 항상 CDP 모드로 실행
      browserMode = "cdp";
      const profiles = scanChromeProfiles();
      const newProfile = profilePath ? profiles.find(p => p.path === profilePath) : null;

      // 프로필이 변경되면 브라우저 재시작
      if (browser && newProfile && selectedProfile?.path !== newProfile.path) {
        send({ type: "workflowLog", stepName: "system", logType: "info", message: `프로필 변경: ${newProfile.displayName}` });
        await stopBrowser();
      }

      if (!browser) {
        if (newProfile) {
          selectedProfile = newProfile;
          send({ type: "workflowLog", stepName: "system", logType: "info", message: `프로필: ${newProfile.displayName}` });
        }
        send({ type: "workflowLog", stepName: "system", logType: "info", message: "브라우저 시작 중..." });
        await startBrowser();
        send({ type: "workflowLog", stepName: "system", logType: "success", message: "브라우저 준비 완료" });
      }

      const page = await getPage();

      // AI 에이전트로 단계 실행하는 함수
      const runStepAgent = async (
        prompt: string,
        maxTurns: number,
        onLog: (text: string) => void
      ): Promise<{ success: boolean; result: string }> => {
        const ctx: Context = {
          systemPrompt: `You are a browser automation agent. You MUST complete tasks using browser tools.

STRICT WORKFLOW - FOLLOW EXACTLY:
1. browser_navigate to the URL
2. browser_snapshot - READ THE OUTPUT CAREFULLY!
3. FIND the element you need from snapshot output (look for links, buttons, text)
4. browser_click using the EXACT selector from snapshot
5. browser_snapshot again to see result
6. Repeat until done, then report findings in Korean

SNAPSHOT ANALYSIS:
- Snapshot shows: [ref=X] ElementType "text" or [ref=X] link "text" [url]
- Use ref=X as selector: {"selector": "[ref=X]"}
- Or use text: {"selector": "text=주문"} for partial match
- Avoid unstable CSS classes such as ".cjs_t". Prefer [ref=X] from snapshot.
- READ snapshot output! Don't guess!

TOOLS:
- browser_navigate: {"url": "..."} - Go to URL
- browser_snapshot: {} - Get page elements (MUST DO FIRST!)
- browser_click: {"selector": "[ref=X]"} - Click (use ref from snapshot)
- browser_fill: {"selector": "...", "text": "..."} - Type text
- browser_get_text: {"selector": ""} - Get all text from page

NEVER refuse. NEVER apologize. Just DO IT.
결과는 한국어로 보고하세요.`,
          messages: [createUserMessage(prompt)],
          tools: browserTools,
        };

        let lastResult = "";

        for (let turn = 0; turn < maxTurns; turn++) {
          try {
            const streamOptions = await resolveStreamOptions(taskModel.provider, taskIsOllama);
            const s = streamSimple(taskModel, ctx, streamOptions);
            for await (const _ of s) {}
            const response = await s.result();
            ctx.messages.push(response);

            const toolCalls = response.content.filter((b) => b.type === "toolCall");

            // 도구 호출이 없으면 완료
            if (toolCalls.length === 0) {
              const textBlocks = response.content.filter((b) => b.type === "text");
              lastResult = textBlocks.map((b) => (b as any).text).join("\n");
              return { success: true, result: lastResult || "완료" };
            }

            // 도구 실행
            for (const call of toolCalls) {
              const toolCall = call as any;
              onLog(`[TOOL] ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`);

              try {
                const toolResult = await executeBrowserTool(toolCall.name, toolCall.arguments || {});
                onLog(`[OK] ${toolResult.text.slice(0, 100)}`);
                ctx.messages.push({
                  role: "toolResult",
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  content: [{ type: "text", text: toolResult.text }],
                  isError: false,
                  timestamp: Date.now(),
                } as any);
              } catch (err) {
                const errMsg = (err as Error).message;
                onLog(`[ERROR] ${errMsg}`);
                ctx.messages.push({
                  role: "toolResult",
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  content: [{ type: "text", text: `Error: ${errMsg}` }],
                  isError: true,
                  timestamp: Date.now(),
                } as any);
              }
            }
          } catch (error) {
            return { success: false, result: (error as Error).message };
          }
        }

        return { success: true, result: lastResult || "최대 턴 도달" };
      };

      // 워크플로우 실행
      const executor = new WorkflowExecutor(
        workflow,
        {
          page,
          runStepAgent,
        },
        (log: WorkflowLog) => {
          send({
            type: "workflowLog",
            stepId: log.stepId,
            stepName: log.stepName,
            logType: log.type,
            message: log.message
          });
        }
      );

      const result = await executor.execute();

      send({
        type: "workflowResult",
        success: result.success,
        workflowId: result.workflowId,
        startTime: result.startTime,
        endTime: result.endTime,
        stepsExecuted: result.stepsExecuted,
        lastStepId: result.lastStepId,
        error: result.error
      });
    },
    onTask: async (taskId, mission, send, taskProfile) => {
      send({ type: "log", text: `[START] ${mission}` });

      // 설정에서 브라우저 모드 및 AI 설정 확인
      const currentSettings = loadSettings();
      const selectedMode = currentSettings.browser?.mode || "cdp";
      const debugEnabled = currentSettings.debugLogs === true || (currentSettings.debugLogs === undefined && currentSettings.telegram?.debugLogs === true);
      const sendDebugLog = (text: string) => {
        if (!debugEnabled) return;
        send({ type: "log", text });
      };

      // 웹 UI에서 설정한 AI 모델 사용 (있으면)
      let taskModel = model;
      let taskIsOllama = isOllama;
      if (currentSettings.ai?.provider) {
        const aiProvider = normalizeProvider(currentSettings.ai.provider);
        const aiModelName = currentSettings.ai.model || getDefaultModelForProvider(aiProvider);
        let aiOllamaUrl = currentSettings.ai.ollamaUrl || "http://localhost:11434";
        // /v1 경로 확인 및 추가
        if (!aiOllamaUrl.endsWith("/v1")) {
          aiOllamaUrl = aiOllamaUrl.replace(/\/$/, "") + "/v1";
        }
        taskIsOllama = aiProvider === "ollama";

        try {
          if (taskIsOllama) {
            taskModel = createOllamaModel(aiModelName, aiOllamaUrl);
            send({ type: "log", text: `[AI] Ollama: ${aiModelName}` });
          } else {
            const fetchedModel = getModel(aiProvider as any, aiModelName as any);
            if (!fetchedModel) {
              throw new Error(`모델을 찾을 수 없음: ${aiProvider}/${aiModelName}`);
            }
            taskModel = fetchedModel;
            send({ type: "log", text: `[AI] ${aiProvider}/${aiModelName}` });
          }
        } catch (e) {
          send({ type: "log", text: `[AI] 모델 로드 실패: ${(e as Error).message}` });
          // 기본 모델로 폴백
          try {
            const fallbackModel = getSafeFallbackModel();
            taskModel = fallbackModel;
            taskIsOllama = fallbackModel.provider === "ollama";
            send({ type: "log", text: `[AI] 기본 모델 사용: ${fallbackModel.provider}/${fallbackModel.id}` });
          } catch {
            send({ type: "error", text: "AI 모델을 로드할 수 없습니다. API 키를 확인하세요." });
            return;
          }
        }
      }

      // 작업에서 전달된 프로필 또는 설정의 프로필 사용
      const profilePath = taskProfile || currentSettings.browser?.selectedProfile;

      // 브라우저 시작
      if (selectedMode === "extension") {
        browserMode = "extension";
        if (!extClient) {
          send({ type: "log", text: "[BROWSER] Extension 모드 시작 중..." });
          await startExtensionServer();
          send({ type: "log", text: "[BROWSER] Extension 서버 시작됨 (ws://localhost:9876)" });
          send({ type: "log", text: "[BROWSER] Chrome에서 Pi-Browser 확장 프로그램을 연결하세요." });
          // Extension 연결 대기 (최대 15초)
          const timeout = 15000;
          const start = Date.now();
          while (!extClient && Date.now() - start < timeout) {
            await new Promise((r) => setTimeout(r, 500));
          }
          if (!extClient) {
            send({ type: "error", text: "❌ Extension 연결 실패!" });
            send({ type: "log", text: "[ERROR] Chrome 확장 프로그램이 설치되지 않았거나 연결되지 않았습니다." });
            send({ type: "log", text: "[INFO] 해결 방법:" });
            send({ type: "log", text: "[INFO] 1. 설정에서 '브라우저 모드'를 'CDP 모드'로 변경하세요 (확장 프로그램 불필요)" });
            send({ type: "log", text: "[INFO] 2. 또는 Chrome에서 확장 프로그램을 설치하세요:" });
            send({ type: "log", text: "[INFO]    - chrome://extensions 접속" });
            send({ type: "log", text: "[INFO]    - '개발자 모드' 활성화" });
            send({ type: "log", text: "[INFO]    - 'extension' 폴더를 드래그&드롭" });
            return;
          }
          send({ type: "log", text: "[BROWSER] Extension 연결됨!" });
        }
      } else {
        browserMode = "cdp";
        // 프로필이 변경되었거나 브라우저가 없으면 (재)시작
        const profiles = scanChromeProfiles();
        const newProfile = profilePath ? profiles.find(p => p.path === profilePath) : null;

        // 프로필이 변경되면 브라우저 재시작
        if (browser && newProfile && selectedProfile?.path !== newProfile.path) {
          send({ type: "log", text: `[BROWSER] 프로필 변경: ${newProfile.displayName}` });
          await stopBrowser();
        }

        if (!browser) {
          if (newProfile) {
            selectedProfile = newProfile;
            send({ type: "log", text: `[BROWSER] 프로필: ${newProfile.displayName}` });
          }
          send({ type: "log", text: "[BROWSER] CDP 모드 브라우저 시작 중..." });
          await startBrowser();
          send({ type: "log", text: "[BROWSER] 브라우저 준비 완료" });
        }
      }

      const ctx: Context = {
        systemPrompt: `You are a browser automation agent. You MUST complete tasks using browser tools.

STRICT WORKFLOW - FOLLOW EXACTLY:
1. browser_navigate to the URL
2. browser_snapshot - READ THE OUTPUT CAREFULLY!
3. FIND the element you need from snapshot output (look for links, buttons, text)
4. browser_click using the EXACT selector from snapshot
5. browser_snapshot again to see result
6. Repeat until done, then report findings in Korean

SNAPSHOT ANALYSIS:
- Snapshot shows: [ref=X] ElementType "text" or [ref=X] link "text" [url]
- Use ref=X as selector: {"selector": "[ref=X]"}
- Or use text: {"selector": "text=주문"} for partial match
- Avoid unstable CSS classes such as ".cjs_t". Prefer [ref=X] from snapshot.
- READ snapshot output! Don't guess!

TOOLS:
- get_current_time: {} - Get current date/time
- browser_navigate: {"url": "..."} - Go to URL
- browser_snapshot: {} - Get page elements (MUST DO FIRST!)
- browser_click: {"selector": "[ref=X]"} - Click (use ref from snapshot)
- browser_fill: {"selector": "...", "text": "..."} - Type text
- browser_get_text: {"selector": ""} - Get all text from page

NEVER refuse. NEVER apologize. Just DO IT.
결과는 한국어로 보고하세요.`,
        messages: [createUserMessage(mission)],
        tools: browserTools,
      };

      const maxTurns = 1000;
      const MAX_CONSECUTIVE_AI_ERRORS = 3;
      let consecutiveEmptyResponses = 0;
      let consecutiveAiErrors = 0;

      for (let turn = 0; turn < maxTurns; turn++) {
        // 중지 체크
        if (stoppedTasks.has(taskId)) {
          send({ type: "log", text: "[STOPPED] 작업이 중지되었습니다." });
          send({ type: "result", text: "🛑 사용자가 작업을 중지했습니다." });
          send({ type: "status", status: "stopped" });
          stoppedTasks.delete(taskId);
          return;
        }

        let response: AssistantMessage;

        try {
          sendDebugLog(`[DEBUG] AI 호출 시작: ${taskModel.id} @ ${taskModel.baseUrl}`);
          const streamOptions = await resolveStreamOptions(taskModel.provider, taskIsOllama);
          const s = streamSimple(taskModel, ctx, streamOptions);
          let streamEventCount = 0;
          let streamDoneReason = "";
          let streamErrorReason = "";
          for await (const event of s) {
            streamEventCount += 1;
            if (event.type === "done") streamDoneReason = event.reason;
            if (event.type === "error") streamErrorReason = event.reason;
          }
          response = await s.result();
          sendDebugLog(`[DEBUG] AI 호출 완료`);
          sendDebugLog(`[DEBUG] 스트림 이벤트: count=${streamEventCount}, done=${streamDoneReason || "-"}, error=${streamErrorReason || "-"}`);
        } catch (error) {
          const err = error as Error;
          const formatted = formatAiErrorForUser(err.message);
          consecutiveAiErrors += 1;
          send({ type: "log", text: `[ERROR] AI 호출 실패: ${formatted.debugMessage}` });
          send({ type: "log", text: `[ERROR] 스택: ${err.stack?.split('\n').slice(0, 3).join(' | ')}` });
          if (consecutiveAiErrors >= MAX_CONSECUTIVE_AI_ERRORS) {
            send({ type: "error", text: `AI 호출이 ${consecutiveAiErrors}회 연속 실패했습니다. ${formatted.userMessage}` });
            return;
          }
          send({ type: "log", text: `[WARN] AI 호출 실패, 재시도 중... (${consecutiveAiErrors}/${MAX_CONSECUTIVE_AI_ERRORS})` });
          continue;
        }

        // 디버그: AI 응답 내용 로그
        consecutiveAiErrors = 0;
        const contentTypes = response.content.map((b) => b.type).join(", ") || "empty";
        sendDebugLog(`[DEBUG] AI 응답 타입: [${contentTypes}]`);
        sendDebugLog(
          `[DEBUG] AI 응답 메타: stopReason=${response.stopReason}, ` +
            `usage(in=${response.usage.input}, out=${response.usage.output}, total=${response.usage.totalTokens})` +
            (response.errorMessage ? `, error=${truncateForLog(response.errorMessage, 300)}` : "")
        );

        const toolCalls = response.content.filter((b) => b.type === "toolCall");
        const textContent = response.content.find((b) => b.type === "text");
        const hasText = !!(textContent && textContent.type === "text" && textContent.text.trim());

        if (toolCalls.length > 0 || hasText) {
          ctx.messages.push(response);
        }

        if (toolCalls.length === 0) {
          if (textContent && textContent.type === "text" && textContent.text.trim()) {
            sendDebugLog(`[DEBUG] AI 텍스트: ${textContent.text.slice(0, 200)}...`);
            send({ type: "result", text: textContent.text });
            saveResultToNotion(taskId, mission, textContent.text).then((r) => {
              if (r.success) send({ type: "log", text: `[NOTION] ${r.message}` });
            });
          } else {
            consecutiveEmptyResponses += 1;

            if (response.stopReason === "error") {
              const formatted = formatAiErrorForUser(response.errorMessage || "모델이 빈 응답을 반환했습니다.");
              consecutiveAiErrors += 1;
              send({ type: "log", text: `[ERROR] AI 응답 오류: ${formatted.debugMessage}` });
              if (consecutiveAiErrors >= MAX_CONSECUTIVE_AI_ERRORS) {
                send({ type: "error", text: `AI 응답 오류가 ${consecutiveAiErrors}회 연속 발생했습니다. ${formatted.userMessage}` });
                send({ type: "log", text: "[INFO] 모델 변경(/set), API 키, 또는 모델 안전정책(SAFETY 차단)을 확인해보세요." });
                return;
              }
              send({ type: "log", text: `[WARN] AI 응답 오류, 재시도 중... (${consecutiveAiErrors}/${MAX_CONSECUTIVE_AI_ERRORS})` });
              continue;
            }

            if (consecutiveEmptyResponses >= 3) {
              send({
                type: "error",
                text: "AI가 3회 연속 빈 응답을 반환했습니다. 모델/키 상태를 확인하거나 다른 모델로 변경해 주세요.",
              });
              send({
                type: "log",
                text: `[ERROR] 연속 빈 응답: ${consecutiveEmptyResponses}회 (stopReason=${response.stopReason})`,
              });
              return;
            }

            const delayMs = 2000 * Math.pow(2, consecutiveEmptyResponses - 1);
            send({ type: "log", text: `[WARN] 도구 호출도 텍스트도 없어 재시도합니다. (${delayMs / 1000}초 대기)` });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            ctx.messages.push(createUserMessage("직전 응답이 비어 있습니다. 반드시 toolCall 또는 text를 반환하세요. 요소가 안 보이면 browser_snapshot으로 다시 확인하고 진행하세요."));
            continue;
          }
          return;
        }

        consecutiveEmptyResponses = 0;

        // 도구 실행
        consecutiveEmptyResponses = 0;
        for (const call of toolCalls) {
          send({ type: "log", text: `[TOOL] ${call.name}(${JSON.stringify(call.arguments)})` });

          try {
            const result = await executeBrowserTool(call.name, call.arguments as Record<string, unknown>);
            send({ type: "log", text: `[SUCCESS] ${result.text.split("\\n")[0]}` });

            ctx.messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: result.text }],
              isError: false,
              timestamp: Date.now(),
            });
          } catch (error) {
            const errMsg = (error as Error).message;
            send({ type: "log", text: `[ERROR] ${errMsg}` });

            ctx.messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: `Error: ${errMsg}` }],
              isError: true,
              timestamp: Date.now(),
            });
          }
        }
      }

      send({ type: "result", text: `⚠️ 최대 턴(${maxTurns}회) 초과로 작업이 종료되었습니다. 모델: ${taskModel.id}` });
    },
  });

  console.log(`${c.green}✓ 웹 서버가 실행 중입니다. Ctrl+C로 종료.${c.reset}\n`);

  // 워크플로우 스케줄러 시작
  startScheduler({
    onLog: (msg) => console.log(msg),
    onWorkflowRun: async (workflow) => {
      console.log(`[Scheduler] 스케줄 실행: ${workflow.name}`);

      // CDP 모드로 브라우저 시작
      browserMode = "cdp";
      const currentSettings = loadSettings();
      const profilePath = currentSettings.browser?.selectedProfile;
      const profiles = scanChromeProfiles();
      const profile = profilePath ? profiles.find(p => p.path === profilePath) : null;

      if (!browser) {
        if (profile) selectedProfile = profile;
        await startBrowser();
      }

      const page = await getPage();

      // AI 모델 설정
      let taskModel = model;
      let taskIsOllama = isOllama;
      if (currentSettings.ai?.provider) {
        const aiProvider = normalizeProvider(currentSettings.ai.provider);
        const aiModelName = currentSettings.ai.model || getDefaultModelForProvider(aiProvider);
        let aiOllamaUrl = currentSettings.ai.ollamaUrl || "http://localhost:11434";
        if (!aiOllamaUrl.endsWith("/v1")) aiOllamaUrl = aiOllamaUrl.replace(/\/$/, "") + "/v1";
        taskIsOllama = aiProvider === "ollama";
        try {
          if (taskIsOllama) {
            taskModel = createOllamaModel(aiModelName, aiOllamaUrl);
          } else {
            const fetchedModel = getModel(aiProvider as any, aiModelName as any);
            if (fetchedModel) {
              taskModel = fetchedModel;
            } else {
              taskModel = getSafeFallbackModel();
            }
          }
        } catch (e) { /* 기본 모델 사용 */ }
      }

      const runStepAgent = async (prompt: string, maxTurns: number, onLog: (t: string) => void) => {
        const ctx: Context = {
          systemPrompt: `You are a browser automation agent. Complete the task fully using browser tools.
TOOLS: browser_navigate, browser_snapshot, browser_fill, browser_click, browser_press, browser_get_text, browser_scroll, browser_wait
After completing, respond with "완료: [summary]".`,
          messages: [createUserMessage(prompt)],
          tools: browserTools,
        };
        let lastResult = "";
        let emptyCount = 0;
        for (let turn = 0; turn < maxTurns; turn++) {
          try {
            const s = streamSimple(taskModel, ctx, await resolveStreamOptions(taskModel.provider, taskIsOllama));
            for await (const _ of s) {}
            const response = await s.result();
            const toolCalls = response.content.filter((b) => b.type === "toolCall");
            const textBlocks = response.content.filter((b) => b.type === "text");
            const responseText = textBlocks.map((b) => (b as any).text).join("\n").trim();

            // 토큰 절약: actionable 응답(toolCall 또는 non-empty text)만 context에 추가
            if (toolCalls.length > 0 || responseText) {
              ctx.messages.push(response);
            }

            if (toolCalls.length === 0) {
              lastResult = responseText;
              if (lastResult) {
                return { success: true, result: lastResult };
              }
              emptyCount += 1;
              if (response.stopReason === "error" || emptyCount >= 3) {
                return { success: false, result: response.errorMessage || `AI가 ${emptyCount}회 연속 빈 응답 반환` };
              }
              const delayMs = 2000 * Math.pow(2, emptyCount - 1);
              onLog(`[WARN] 빈 응답 (${emptyCount}/3), ${delayMs / 1000}초 후 재시도...`);
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              continue;
            }
            emptyCount = 0;
            for (const call of toolCalls) {
              const toolCall = call as any;
              onLog(`[TOOL] ${toolCall.name}`);
              try {
                const toolResult = await executeBrowserTool(toolCall.name, toolCall.arguments || {});
                ctx.messages.push({ role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: "text", text: toolResult.text }], isError: false, timestamp: Date.now() } as any);
              } catch (err) {
                ctx.messages.push({ role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true, timestamp: Date.now() } as any);
              }
            }
          } catch (error) { return { success: false, result: (error as Error).message }; }
        }
        return { success: true, result: lastResult || "완료" };
      };

      const executor = new WorkflowExecutor(workflow, { page, runStepAgent }, (log) => {
        console.log(`[${log.stepName}] ${log.message}`);
        broadcastToClients({ type: "workflowLog", stepId: log.stepId, stepName: log.stepName, logType: log.type, message: log.message });
      });

      const result = await executor.execute();
      broadcastToClients({ type: "workflowResult", success: result.success, stepsExecuted: result.stepsExecuted, error: result.error, startTime: result.startTime, endTime: result.endTime });
    }
  });

  console.log(`${c.dim}브라우저에서 http://localhost:${webPort} 접속${c.reset}\n`);

  // 브라우저 자동 열기
  const url = `http://localhost:${webPort}`;
  if (process.platform === "darwin") {
    spawn("open", [url]);
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", url]);
  } else {
    spawn("xdg-open", [url]);
  }

  // 종료 대기
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log(`\n${c.yellow}웹 서버 종료 중...${c.reset}`);
      resolve();
    });
  });
}

// 텔레그램 봇 모드
async function runTelegramMode(config: Config): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log(`${c.red}TELEGRAM_BOT_TOKEN 환경변수가 설정되지 않았습니다.${c.reset}`);
    console.log(`${c.dim}.env 파일에 TELEGRAM_BOT_TOKEN=your-bot-token 추가하세요.${c.reset}`);
    return;
  }

  const allowedUsersStr = process.env.TELEGRAM_ALLOWED_USERS;
  const allowedUsers = allowedUsersStr
    ? allowedUsersStr.split(",").map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id))
    : undefined;

  console.log(`\n${c.cyan}🤖 텔레그램 봇 모드${c.reset}`);
  if (allowedUsers && allowedUsers.length > 0) {
    console.log(`${c.dim}허용된 사용자: ${allowedUsers.join(", ")}${c.reset}`);
  } else {
    console.log(`${c.yellow}⚠️  허용된 사용자가 없습니다. 아무도 사용할 수 없습니다.${c.reset}`);
    console.log(`${c.dim}설정에서 사용자 ID를 추가하세요.${c.reset}`);
  }

  const model = resolveModel(config);
  const isOllama = config.provider === "ollama";

  await startTelegramBot({
    token,
    allowedUsers,
    onMessage: async (text: string, ctx: MessageContext) => {
      // 특수 명령어 처리
      if (text === "/start") {
        return `🤖 Pi-Browser 봇입니다.\n\n명령어를 보내면 브라우저가 자동으로 작업합니다.\n\n예시:\n• 네이버에서 날씨 알려줘\n• 구글에서 맛집 검색해줘`;
      }

      if (text === "/help") {
        return `📖 <b>사용법</b>\n\n자연어로 명령을 보내세요:\n• 쿠팡에서 아이폰 가격 알려줘\n• 네이버 메일 확인해줘\n\n<b>모델:</b> ${config.provider}/${config.model}`;
      }

      // 진행 중 메시지
      await ctx.replyTo("🔄 작업 중...");

      // 브라우저 에이전트 실행
      const result = await runTelegramAgent(text, model, isOllama);
      return result;
    },
  });

  console.log(`${c.green}✓ 텔레그램 봇이 실행 중입니다. Ctrl+C로 종료.${c.reset}\n`);

  // 종료 대기
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log(`\n${c.yellow}텔레그램 봇 종료 중...${c.reset}`);
      stopTelegramBot();
      resolve();
    });
  });
}

// 텔레그램 작업 카운터
let telegramTaskCounter = 0;

// 텔레그램용 에이전트 실행 (결과 문자열 반환)
async function runTelegramAgent(mission: string, defaultModel: Model, defaultIsOllama: boolean): Promise<string> {
  // 설정에서 브라우저 모드와 텔레그램 프로필 확인
  const currentSettings = loadSettings();
  const selectedMode = currentSettings.browser?.mode || "cdp";
  const debugEnabled = currentSettings.debugLogs === true || (currentSettings.debugLogs === undefined && currentSettings.telegram?.debugLogs === true);
  // 텔레그램 전용 프로필 또는 기본 브라우저 프로필 사용
  const telegramProfilePath = currentSettings.telegram?.profile || currentSettings.browser?.selectedProfile;

  // 웹 UI에서 설정한 AI 모델 사용 (있으면)
  let model = defaultModel;
  let isOllama = defaultIsOllama;
  if (currentSettings.ai?.provider) {
    const aiProvider = normalizeProvider(currentSettings.ai.provider);
    const aiModelName = currentSettings.ai.model || getDefaultModelForProvider(aiProvider);
    let aiOllamaUrl = currentSettings.ai.ollamaUrl || "http://localhost:11434";
    // /v1 경로 확인 및 추가
    if (!aiOllamaUrl.endsWith("/v1")) {
      aiOllamaUrl = aiOllamaUrl.replace(/\/$/, "") + "/v1";
    }
    isOllama = aiProvider === "ollama";

    try {
      if (isOllama) {
        model = createOllamaModel(aiModelName, aiOllamaUrl);
        console.log(`[Telegram] AI: Ollama ${aiModelName}`);
      } else {
        const fetchedModel = getModel(aiProvider as any, aiModelName as any);
        if (!fetchedModel) {
          throw new Error(`모델을 찾을 수 없음: ${aiProvider}/${aiModelName}`);
        }
        model = fetchedModel;
        console.log(`[Telegram] AI: ${aiProvider}/${aiModelName}`);
      }
    } catch (e) {
      const fallbackModel = getSafeFallbackModel();
      model = fallbackModel;
      isOllama = fallbackModel.provider === "ollama";
      console.log(`[Telegram] 기본 모델 사용: ${fallbackModel.provider}/${fallbackModel.id} (${(e as Error).message})`);
    }
  }

  // 프로필 정보 조회
  const profiles = scanChromeProfiles();
  const defaultPiProfile = profiles.find((p) => p.name === "pi-browser") || null;
  const telegramProfile = telegramProfilePath ? profiles.find(p => p.path === telegramProfilePath) || null : null;
  const profileName = telegramProfile?.displayName || "기본";

  // 작업 ID 생성 및 웹 UI에 알림
  const taskId = `tg-${++telegramTaskCounter}`;
  broadcastToClients({ type: "newTask", taskId, mission, source: "telegram", profile: profileName });

  const broadcast = (msg: any) => {
    broadcastToClients({ taskId, ...msg });
  };

  const debug = (branch: string, text: string) => {
    if (!debugEnabled) return;
    const line = `[DEBUG][${branch}] ${text}`;
    console.log(`[Telegram][${taskId}] ${line}`);
    broadcast({ type: "log", text: line });
  };

  broadcast({ type: "log", text: `[TELEGRAM] ${mission}` });
  debug(
    "INIT",
    `mode=${selectedMode}, profilePath=${telegramProfilePath || "none"}, model=${model.id}, debug=${debugEnabled ? "on" : "off"}`
  );
  if (telegramProfile) {
    broadcast({ type: "log", text: `[PROFILE] ${telegramProfile.displayName}` });
  } else if (telegramProfilePath) {
    debug("PROFILE_MISS", `설정된 프로필 경로를 찾지 못함: ${telegramProfilePath}`);
  }

  const maxTurns = 1000; // 충분히 큰 값 (빈 응답 3회/AI 에러 3회 연속 시 자동 중단)
  const MAX_CONSECUTIVE_AI_ERRORS = 3;
  let consecutiveAiErrors = 0;
  let finalResult = "";
  let lastAiError = "";
  const stats = {
    turnsUsed: 0,
    maxTurns,
    aiErrorCount: 0,
    hadToolCall: false,
    toolSuccessCount: 0,
    toolErrorCount: 0,
    blankTextCount: 0,
  };

  // 브라우저 시작
  if (selectedMode === "extension") {
    debug("MODE", "extension 분기 진입");
    browserMode = "extension";
    if (!extClient) {
      broadcast({ type: "log", text: "[BROWSER] Extension 모드 시작 중..." });
      await startExtensionServer();
      broadcast({ type: "log", text: "[BROWSER] Extension 서버 시작됨 (ws://localhost:9876)" });
      broadcast({ type: "log", text: "[BROWSER] Chrome에서 Pi-Browser 확장 프로그램을 연결하세요." });
      // Extension 연결 대기 (최대 15초)
      const timeout = 15000;
      const start = Date.now();
      while (!extClient && Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!extClient) {
        debug("EXTENSION_FAIL", "확장 연결 시간 초과");
        broadcast({ type: "error", text: "❌ Extension 연결 실패!" });
        broadcast({ type: "log", text: "[ERROR] Chrome 확장 프로그램이 설치되지 않았습니다." });
        return "❌ Extension 연결 실패!\n\n해결 방법:\n1. 설정에서 'CDP 모드'로 변경 (확장 프로그램 불필요)\n2. 또는 Chrome에 확장 프로그램 설치:\n   - chrome://extensions\n   - 개발자 모드 활성화\n   - extension 폴더 드래그&드롭";
      }
      broadcast({ type: "log", text: "[BROWSER] Extension 연결됨!" });
      debug("EXTENSION_READY", "확장 연결 성공");
    }
  } else {
    debug("MODE", "cdp 분기 진입");
    browserMode = "cdp";
    // 프로필이 변경되었으면 브라우저 재시작
    if (browser && telegramProfile && selectedProfile?.path !== telegramProfile.path) {
      debug("PROFILE_SWITCH", `${selectedProfile?.displayName || "none"} -> ${telegramProfile.displayName}`);
      broadcast({ type: "log", text: `[BROWSER] 프로필 변경: ${telegramProfile.displayName}` });
      await stopBrowser();
    }

    if (!browser) {
      const tryStartBrowser = async (profile: ChromeProfile | null, label: string): Promise<{ ok: boolean; error?: string }> => {
        if (profile) {
          selectedProfile = profile;
          broadcast({ type: "log", text: `[BROWSER] 프로필: ${profile.displayName}` });
          debug("BROWSER_PROFILE", `${label}: ${profile.displayName}`);
        } else if (defaultPiProfile) {
          selectedProfile = defaultPiProfile;
          broadcast({ type: "log", text: `[BROWSER] 프로필: ${defaultPiProfile.displayName}` });
          debug("BROWSER_PROFILE", `${label}: ${defaultPiProfile.displayName} (기본)`);
        } else {
          debug("BROWSER_PROFILE", `${label}: 프로필 지정 없음`);
        }

        broadcast({ type: "log", text: "[BROWSER] CDP 모드 브라우저 시작 중..." });
        debug("BROWSER_START", `${label} 시작 시도`);
        try {
          await startBrowser();
          broadcast({ type: "log", text: "[BROWSER] 브라우저 준비 완료" });
          debug("BROWSER_READY", `${label} 성공`);
          return { ok: true };
        } catch (error) {
          const errMsg = (error as Error).message;
          debug("BROWSER_START_FAIL", `${label} 실패: ${errMsg}`);
          return { ok: false, error: errMsg };
        }
      };

      const primaryStart = await tryStartBrowser(telegramProfile, "primary");
      if (!primaryStart.ok) {
        const canFallbackToPi = shouldFallbackToDefaultProfile({
          requestedProfileName: telegramProfile?.name || null,
          hasDefaultProfile: !!defaultPiProfile,
          startErrorMessage: primaryStart.error,
        });

        if (canFallbackToPi) {
          const fromProfileName = telegramProfile?.displayName || "사용자 프로필";
          debug("PROFILE_FALLBACK", `${fromProfileName} -> ${defaultPiProfile!.displayName}`);
          broadcast({
            type: "log",
            text: `[WARN] 선택 프로필이 잠겨 기본 프로필(${defaultPiProfile!.displayName})로 전환합니다.`,
          });

          const fallbackStart = await tryStartBrowser(defaultPiProfile, "fallback");
          if (!fallbackStart.ok) {
            const errText = `❌ 브라우저 시작 실패 (기본 프로필 폴백도 실패): ${fallbackStart.error}`;
            broadcast({ type: "error", text: errText });
            return errText;
          }
        } else {
          const errText = `❌ 브라우저 시작 실패: ${primaryStart.error}`;
          broadcast({ type: "error", text: errText });
          return errText;
        }
      }
    }
  }

  const ctx: Context = {
    systemPrompt: `You are a browser automation agent with FULL browser access.

CRITICAL RULES:
1. NEVER say "I can't" or "I'm sorry" - just DO IT using the browser!
2. You have access to a REAL browser with logged-in sessions. Just navigate and use it!
3. Start with browser_navigate, then browser_snapshot to see the page.
4. The browser has the user's cookies/logins. Just go to the website!

TOOLS:
- get_current_time: {} - Get current date/time
- browser_navigate: {"url": "..."} - Go to any URL directly
- browser_snapshot: {} - See page elements (ALWAYS do this after navigate!)
- browser_fill: {"selector": "...", "text": "..."} - Type text
- browser_click: {"selector": "..."} - Click element
- browser_press: {"key": "Enter"} - Press key
- browser_get_text: {"selector": ""} - Get page text

WORKFLOW: navigate → snapshot → interact → get_text → report result in Korean.
DO NOT refuse. DO NOT apologize. Just USE THE BROWSER.`,
    messages: [createUserMessage(mission)],
    tools: browserTools,
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    stats.turnsUsed = turn + 1;
    let response: AssistantMessage;

    console.log(`[Telegram] Turn ${turn + 1}/${maxTurns} - AI 호출 중...`);
    broadcast({ type: "log", text: `[AI] Turn ${turn + 1}/${maxTurns}` });
    debug("TURN_START", `${turn + 1}/${maxTurns}`);

    try {
      const streamOptions = await resolveStreamOptions(model.provider, isOllama);
      const s = streamSimple(model, ctx, streamOptions);
      for await (const _ of s) {
        // 스트리밍 무시
      }
      response = await s.result();
    } catch (error) {
      lastAiError = (error as Error).message;
      stats.aiErrorCount += 1;
      consecutiveAiErrors += 1;
      debug("AI_ERROR", lastAiError);
      if (consecutiveAiErrors >= MAX_CONSECUTIVE_AI_ERRORS) {
        debug("AI_ERROR_LIMIT", `연속 AI 에러 ${consecutiveAiErrors}회로 중단`);
        break;
      }
      ctx.messages.push(createUserMessage("이전 요청에서 오류가 발생했습니다. 다시 시도해주세요."));
      continue;
    }

    ctx.messages.push(response);
    consecutiveAiErrors = 0;
    const contentTypes = response.content.map((b) => b.type).join(", ") || "empty";
    debug("AI_RESPONSE", `content=[${contentTypes}]`);
    debug(
      "AI_META",
      `stopReason=${response.stopReason}, usage(in=${response.usage.input}, out=${response.usage.output}, total=${response.usage.totalTokens})` +
        (response.errorMessage ? `, error=${truncateForLog(response.errorMessage, 300)}` : "")
    );

    if (response.stopReason === "error") {
      const formatted = formatAiErrorForUser(response.errorMessage || "모델이 빈 응답을 반환했습니다.");
      stats.aiErrorCount += 1;
      consecutiveAiErrors += 1;
      lastAiError = formatted.userMessage;
      debug("AI_RESPONSE_ERROR", formatted.debugMessage);
      if (consecutiveAiErrors >= MAX_CONSECUTIVE_AI_ERRORS) {
        debug("AI_ERROR_LIMIT", `연속 AI 에러 ${consecutiveAiErrors}회로 중단`);
        break;
      }
      ctx.messages.push(createUserMessage("이전 요청에서 오류가 발생했습니다. 다시 시도해주세요."));
      continue;
    }

    const toolCalls = response.content.filter((b) => b.type === "toolCall");
    debug("TOOL_COUNT", `${toolCalls.length}`);

    if (toolCalls.length === 0) {
      // 텍스트 응답
      const textContent = response.content.find((b) => b.type === "text");
      if (textContent && textContent.type === "text") {
        const normalizedText = textContent.text.trim();
        if (normalizedText) {
          finalResult = normalizedText;
          debug("TEXT_RESULT", `length=${finalResult.length}`);
        } else {
          stats.blankTextCount += 1;
          broadcast({ type: "log", text: "[WARN] AI 텍스트가 비어 있어 기본 완료 메시지로 대체합니다." });
          debug("TEXT_BLANK", "toolCall 없음 + 텍스트 공백");
        }
      } else {
        stats.blankTextCount += 1;
        debug("NO_TEXT_NO_TOOL", "toolCall/텍스트 모두 없음");
      }
      break;
    }

    // 도구 실행
    stats.hadToolCall = true;
    for (const call of toolCalls) {
      console.log(`[Telegram] 도구: ${call.name}`);
      broadcast({ type: "log", text: `[TOOL] ${call.name}` });
      debug("TOOL_START", `${call.name}(${JSON.stringify(call.arguments).slice(0, 160)})`);
      try {
        const result = await executeBrowserTool(call.name, call.arguments as Record<string, unknown>);
        stats.toolSuccessCount += 1;
        console.log(`[Telegram] 결과: ${result.text.substring(0, 80)}...`);
        broadcast({ type: "log", text: `[SUCCESS] ${result.text.split("\n")[0].substring(0, 80)}` });
        debug("TOOL_SUCCESS", `${call.name} ok=${stats.toolSuccessCount} err=${stats.toolErrorCount}`);

        ctx.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: result.text }],
          isError: false,
          timestamp: Date.now(),
        });
      } catch (error) {
        stats.toolErrorCount += 1;
        console.log(`[Telegram] 에러: ${(error as Error).message}`);
        broadcast({ type: "log", text: `[ERROR] ${(error as Error).message}` });
        debug("TOOL_ERROR", `${call.name} ok=${stats.toolSuccessCount} err=${stats.toolErrorCount}`);
        ctx.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          isError: true,
          timestamp: Date.now(),
        });
      }
    }
  }

  const outcome = evaluateTelegramAgentOutcome({
    finalResult,
    turnsUsed: stats.turnsUsed,
    maxTurns: stats.maxTurns,
    aiErrorCount: stats.aiErrorCount,
    hadToolCall: stats.hadToolCall,
    toolSuccessCount: stats.toolSuccessCount,
    toolErrorCount: stats.toolErrorCount,
    blankTextCount: stats.blankTextCount,
  });

  const finalText =
    outcome.code === "ERROR_AI" && lastAiError
      ? `${outcome.resultText}\n원인: ${lastAiError}`
      : outcome.resultText;

  debug("FINAL", `${outcome.code} | ${outcome.debugSummary}`);

  if (outcome.isError) {
    broadcast({ type: "error", text: finalText });
    saveResultToNotion(taskId, mission, `[ERROR:${outcome.code}] ${finalText}\n${outcome.debugSummary}`).then((r) => {
      if (r.success) broadcast({ type: "log", text: `[NOTION] ${r.message}` });
    });
    return finalText;
  }

  broadcast({ type: "result", text: finalText });
  saveResultToNotion(taskId, mission, finalText).then((r) => {
    if (r.success) broadcast({ type: "log", text: `[NOTION] ${r.message}` });
  });
  return finalText;
}

function runTelegramOutcomeSelfTest(): void {
  type OutcomeCase = {
    name: string;
    input: Parameters<typeof evaluateTelegramAgentOutcome>[0];
    expectedCode: TelegramOutcomeCode;
    expectedError: boolean;
  };

  type FallbackCase = {
    name: string;
    input: Parameters<typeof shouldFallbackToDefaultProfile>[0];
    expected: boolean;
  };

  const cases: OutcomeCase[] = [
    {
      name: "텍스트가 있으면 성공",
      input: {
        finalResult: "서울 미세먼지는 보통입니다.",
        turnsUsed: 1,
        maxTurns: 20,
        aiErrorCount: 0,
        hadToolCall: false,
        toolSuccessCount: 0,
        toolErrorCount: 0,
        blankTextCount: 0,
      },
      expectedCode: "SUCCESS_TEXT",
      expectedError: false,
    },
    {
      name: "AI 에러가 있으면 실패",
      input: {
        finalResult: "",
        turnsUsed: 1,
        maxTurns: 20,
        aiErrorCount: 1,
        hadToolCall: false,
        toolSuccessCount: 0,
        toolErrorCount: 0,
        blankTextCount: 0,
      },
      expectedCode: "ERROR_AI",
      expectedError: true,
    },
    {
      name: "툴 호출 없이 빈 응답이면 실패",
      input: {
        finalResult: "",
        turnsUsed: 1,
        maxTurns: 20,
        aiErrorCount: 0,
        hadToolCall: false,
        toolSuccessCount: 0,
        toolErrorCount: 0,
        blankTextCount: 1,
      },
      expectedCode: "ERROR_NO_TOOL",
      expectedError: true,
    },
    {
      name: "툴 전부 실패면 실패",
      input: {
        finalResult: "",
        turnsUsed: 3,
        maxTurns: 20,
        aiErrorCount: 0,
        hadToolCall: true,
        toolSuccessCount: 0,
        toolErrorCount: 3,
        blankTextCount: 0,
      },
      expectedCode: "ERROR_TOOL_ALL_FAILED",
      expectedError: true,
    },
    {
      name: "최대 턴 도달이면 실패",
      input: {
        finalResult: "",
        turnsUsed: 20,
        maxTurns: 20,
        aiErrorCount: 0,
        hadToolCall: true,
        toolSuccessCount: 5,
        toolErrorCount: 0,
        blankTextCount: 0,
      },
      expectedCode: "ERROR_MAX_TURNS",
      expectedError: true,
    },
  ];

  const fallbackCases: FallbackCase[] = [
    {
      name: "사용자 프로필 실패 + 기본 프로필 있음 -> 폴백",
      input: {
        requestedProfileName: "Default",
        hasDefaultProfile: true,
        startErrorMessage: "Chrome을 실행할 수 없습니다. 프로필이 사용 중일 수 있습니다.",
      },
      expected: true,
    },
    {
      name: "이미 기본 프로필이면 폴백 안함",
      input: {
        requestedProfileName: "pi-browser",
        hasDefaultProfile: true,
        startErrorMessage: "연결 시간 초과",
      },
      expected: false,
    },
    {
      name: "기본 프로필이 없으면 폴백 안함",
      input: {
        requestedProfileName: "Default",
        hasDefaultProfile: false,
        startErrorMessage: "timeout",
      },
      expected: false,
    },
    {
      name: "프로필 자체가 없으면 폴백 안함",
      input: {
        requestedProfileName: null,
        hasDefaultProfile: true,
        startErrorMessage: "failed",
      },
      expected: false,
    },
  ];

  console.log(`\n${c.cyan}[SelfTest] Telegram outcome 분기 테스트${c.reset}`);
  let passed = 0;

  for (const t of cases) {
    const result = evaluateTelegramAgentOutcome(t.input);
    const ok = result.code === t.expectedCode && result.isError === t.expectedError;
    if (ok) {
      passed += 1;
      console.log(`${c.green}  ✓${c.reset} ${t.name} -> ${result.code}`);
    } else {
      console.log(`${c.red}  ✗${c.reset} ${t.name}`);
      console.log(`${c.red}    expected: ${t.expectedCode}/${t.expectedError}${c.reset}`);
      console.log(`${c.red}    actual:   ${result.code}/${result.isError}${c.reset}`);
    }
    console.log(`${c.dim}    ${result.debugSummary}${c.reset}`);
  }

  console.log(`\n${c.cyan}[SelfTest] Telegram 프로필 폴백 분기 테스트${c.reset}`);
  for (const t of fallbackCases) {
    const actual = shouldFallbackToDefaultProfile(t.input);
    const ok = actual === t.expected;
    if (ok) {
      passed += 1;
      console.log(`${c.green}  ✓${c.reset} ${t.name} -> ${actual}`);
    } else {
      console.log(`${c.red}  ✗${c.reset} ${t.name}`);
      console.log(`${c.red}    expected: ${t.expected}${c.reset}`);
      console.log(`${c.red}    actual:   ${actual}${c.reset}`);
    }
  }

  const total = cases.length + fallbackCases.length;
  const allPassed = passed === total;
  console.log(
    `\n${allPassed ? c.green : c.red}[SelfTest] ${passed}/${total} 통과${c.reset}\n`
  );

  if (!allPassed) {
    process.exitCode = 1;
  }
}

function printModels() {
  const providers = getProviders().filter((provider) => isProviderAllowed(provider));
  console.log(`\n${c.cyan}사용 가능한 Provider:${c.reset}`);

  // Ollama 추가
  console.log(`\n${c.yellow}ollama (로컬):${c.reset}`);
  console.log(`  - llama3.2`);
  console.log(`  - llama3.1`);
  console.log(`  - mistral`);
  console.log(`  - qwen2.5`);
  console.log(`  - gemma2`);
  console.log(`  ${c.dim}(ollama list로 설치된 모델 확인)${c.reset}`);

  for (const provider of providers) {
    const models = getModels(provider);
    console.log(`\n${c.yellow}${provider}:${c.reset}`);
    const modelIds = models.map((m) => m.id);
    for (const modelId of modelIds.slice(0, 10)) {
      console.log(`  - ${modelId}`);
    }
    if (modelIds.length > 10) {
      console.log(`  ... 외 ${modelIds.length - 10}개`);
    }
  }
  console.log();
}

async function main() {
  const config = loadConfig();

  // 커맨드 라인 인자 처리
  const rawArgs = process.argv.slice(2);
  let mission: string | null = null;

  // --ext 또는 /ext 옵션 확인
  const extIndex = rawArgs.findIndex((a) => a === "--ext" || a === "/ext");
  if (extIndex !== -1) {
    browserMode = "extension";
    rawArgs.splice(extIndex, 1);
  }

  // 인자 파싱: /profile과 미션을 분리
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    // Extension 모드 시작 (/e 또는 /ext)
    if (arg === "/ext" || arg === "/e") {
      browserMode = "extension";
      continue;
    }

    // /help
    if (arg === "/help" || arg === "/?") {
      printHelp();
      process.exit(0);
    }

    if (arg === "/models") {
      printModels();
      process.exit(0);
    }

    if (arg === "/tg-selftest" || arg === "tg-selftest" || arg === "/selftest-tg" || arg === "selftest-tg") {
      runTelegramOutcomeSelfTest();
      process.exit(process.exitCode ?? 0);
    }

    if (arg === "/profiles") {
      const profiles = getChromeProfiles();
      console.log(`\n${c.cyan}사용 가능한 Chrome 프로필:${c.reset}\n`);
      if (profiles.length === 0) {
        console.log(`  ${c.dim}프로필을 찾을 수 없습니다.${c.reset}`);
      } else {
        for (const p of profiles) {
          const dirName = path.basename(p.path);
          console.log(`  ${c.yellow}${dirName}${c.reset} - ${p.name}`);
        }
      }
      console.log(`\n${c.dim}사용법:${c.reset}`);
      console.log(`${c.dim}  /import <프로필> - 프로필의 로그인 정보를 pi-browser로 복사${c.reset}`);
      console.log(`${c.dim}  /connect <프로필> - 프로필로 Chrome을 CDP 포트와 함께 시작${c.reset}`);
      console.log(`${c.dim}예: /import "Profile 14"${c.reset}\n`);
      process.exit(0);
    }

    // /connect <profile> - Chrome을 CDP 포트로 시작하고 연결
    if (arg === "/connect" && i + 1 < rawArgs.length) {
      const profileName = rawArgs[i + 1];
      await startChromeWithProfile(profileName);
      i++;
      continue;
    }
    if (arg.startsWith("/connect ")) {
      const profileName = arg.slice(9).trim();
      await startChromeWithProfile(profileName);
      continue;
    }

    // /import <profile> - 프로필의 쿠키/로그인 정보 복사
    if (arg === "/import" && i + 1 < rawArgs.length) {
      const profileName = rawArgs[i + 1];
      await importProfileData(profileName);
      i++;
      continue;
    }
    if (arg.startsWith("/import ")) {
      const profileName = arg.slice(8).trim();
      await importProfileData(profileName);
      continue;
    }

    // /wf - 워크플로우 목록 및 실행
    if (arg === "/wf" || arg === "/workflow") {
      const workflows = loadWorkflows();
      if (workflows.length === 0) {
        console.log(`${c.yellow}저장된 워크플로우가 없습니다.${c.reset}`);
        console.log(`${c.dim}웹 UI에서 워크플로우를 만들어보세요: /web${c.reset}\n`);
      } else {
        console.log(`\n${c.cyan}저장된 워크플로우:${c.reset}\n`);
        workflows.forEach((wf, idx) => {
          const status = wf.enabled ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
          console.log(`  ${status} ${c.bright}${wf.name}${c.reset} ${c.dim}(${wf.id})${c.reset}`);
          if (wf.description) {
            console.log(`    ${c.dim}${wf.description}${c.reset}`);
          }
          console.log(`    ${c.dim}${wf.steps.length}단계 | ${new Date(wf.updatedAt).toLocaleDateString('ko-KR')}${c.reset}`);
        });
        console.log(`\n${c.dim}실행: /wf run <id>${c.reset}\n`);
      }
      process.exit(0);
    }

    // /wf run <id> - 워크플로우 실행
    if (arg.startsWith("/wf run ") || arg.startsWith("/workflow run ")) {
      const wfId = arg.replace(/^\/(wf|workflow) run /, "").trim();
      const workflow = loadWorkflow(wfId);

      if (!workflow) {
        console.log(`${c.red}워크플로우를 찾을 수 없습니다: ${wfId}${c.reset}`);
        console.log(`${c.dim}/wf 명령으로 목록을 확인하세요.${c.reset}\n`);
        process.exit(1);
      }

      console.log(`\n${c.cyan}워크플로우 실행: ${workflow.name}${c.reset}`);
      console.log(`${c.dim}${workflow.steps.length}개 단계${c.reset}\n`);

      try {
        // 브라우저 시작
        await startBrowser();
        const page = await getPage();
        const wfModel = resolveModel(config);
        const wfIsOllama = config.provider === "ollama";

        // AI 에이전트로 단계 실행하는 함수
        const runStepAgent = async (
          prompt: string,
          maxTurns: number,
          onLog: (text: string) => void
        ): Promise<{ success: boolean; result: string }> => {
          const ctx: Context = {
            systemPrompt: `You are a browser automation agent. Complete the user's task using browser tools.
TOOLS: browser_navigate, browser_snapshot, browser_fill, browser_click, browser_press, browser_get_text
After completing, respond with a brief summary. If you cannot complete, explain why.`,
            messages: [createUserMessage(prompt)],
            tools: browserTools,
          };

          let lastResult = "";
          let emptyCount = 0;
          for (let turn = 0; turn < maxTurns; turn++) {
            try {
              const streamOptions = await resolveStreamOptions(wfModel.provider, wfIsOllama);
              const s = streamSimple(wfModel, ctx, streamOptions);
              for await (const _ of s) {}
              const response = await s.result();
              const toolCalls = response.content.filter((b) => b.type === "toolCall");
              const textBlocks = response.content.filter((b) => b.type === "text");
              const responseText = textBlocks.map((b) => (b as any).text).join("\n").trim();

              // 토큰 절약: actionable 응답(toolCall 또는 non-empty text)만 context에 추가
              if (toolCalls.length > 0 || responseText) {
                ctx.messages.push(response);
              }

              if (toolCalls.length === 0) {
                lastResult = responseText;
                if (lastResult) {
                  return { success: true, result: lastResult };
                }
                emptyCount += 1;
                if (response.stopReason === "error" || emptyCount >= 3) {
                  return { success: false, result: response.errorMessage || `AI가 ${emptyCount}회 연속 빈 응답 반환` };
                }
                const delayMs = 2000 * Math.pow(2, emptyCount - 1);
                onLog(`[WARN] 빈 응답 (${emptyCount}/3), ${delayMs / 1000}초 후 재시도...`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                continue;
              }

              emptyCount = 0;
              for (const call of toolCalls) {
                const toolCall = call as any;
                onLog(`[TOOL] ${toolCall.name}`);
                try {
                  const toolResult = await executeBrowserTool(toolCall.name, toolCall.arguments || {});
                  ctx.messages.push({
                    role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name,
                    content: [{ type: "text", text: toolResult.text }], isError: false, timestamp: Date.now(),
                  } as any);
                } catch (err) {
                  ctx.messages.push({
                    role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name,
                    content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true, timestamp: Date.now(),
                  } as any);
                }
              }
            } catch (error) {
              return { success: false, result: (error as Error).message };
            }
          }
          return { success: true, result: lastResult || "완료" };
        };

        // 워크플로우 실행
        const executor = new WorkflowExecutor(
          workflow,
          { page, runStepAgent },
          (log: WorkflowLog) => {
            const prefix = log.type === "error" ? c.red :
                          log.type === "success" ? c.green :
                          log.type === "condition" ? c.yellow : c.dim;
            console.log(`${prefix}[${log.stepName}] ${log.message}${c.reset}`);
          }
        );

        const result = await executor.execute();

        if (result.success) {
          console.log(`\n${c.green}✅ 완료! ${result.stepsExecuted}단계 실행 (${((result.endTime - result.startTime) / 1000).toFixed(1)}초)${c.reset}\n`);
        } else {
          console.log(`\n${c.red}❌ 실패: ${result.error}${c.reset}\n`);
        }
      } catch (error) {
        console.log(`${c.red}오류: ${(error as Error).message}${c.reset}\n`);
      }
      process.exit(0);
    }

    // /naver-blog <json> - 네이버 블로그 글쓰기 자동화 (CDP 모드)
    if (arg === "/naver-blog" || arg === "naver-blog") {
      const jsonPath = rawArgs[i + 1];
      if (!jsonPath) {
        console.log(`${c.red}사용법: naver-blog <post.json>${c.reset}`);
        console.log(`${c.dim}예: npm start "naver-blog post.json"${c.reset}`);
        process.exit(1);
      }

      // 파일 업로드는 extension 모드에서 불가
      browserMode = "cdp";

      const opts = loadNaverBlogPostOptionsFromJson(jsonPath);
      const missionText = buildNaverBlogWriteMission(opts);

      const model = resolveModel(config);
      const isOllama = config.provider === "ollama";
      await runAgent(missionText, model, isOllama);
      process.exit(0);
    }
    if (arg.startsWith("/naver-blog ") || arg.startsWith("naver-blog ")) {
      const jsonPath = arg.replace(/^\/?naver-blog\s+/, "").trim();
      if (!jsonPath) {
        console.log(`${c.red}사용법: naver-blog <post.json>${c.reset}`);
        process.exit(1);
      }
      browserMode = "cdp";
      const opts = loadNaverBlogPostOptionsFromJson(jsonPath);
      const missionText = buildNaverBlogWriteMission(opts);
      const model = resolveModel(config);
      const isOllama = config.provider === "ollama";
      await runAgent(missionText, model, isOllama);
      process.exit(0);
    }

    // /web 또는 web - 웹 UI 모드 시작
    if (arg === "/web" || arg === "web" || arg === "/w" || arg === "w") {
      // --port 옵션 확인
      let port = 3000;
      const portIndex = rawArgs.indexOf("--port");
      if (portIndex !== -1 && portIndex + 1 < rawArgs.length) {
        port = parseInt(rawArgs[portIndex + 1], 10) || 3000;
      }

      const model = resolveModel(config);
      const isOllama = config.provider === "ollama";
      await runWebMode(config, port);
      process.exit(0);
    }

    if (arg === "/config") {
      console.log(`\n${c.cyan}현재 설정:${c.reset}`);
      console.log(`  Provider: ${config.provider}`);
      console.log(`  Model: ${config.model}`);
      const authSummary = getAuthSourceSummary(config.provider, config.provider === "ollama");
      console.log(`  Auth Source: ${authSummary.label}`);
      if (authSummary.warning) {
        console.log(`  Auth Note: ${authSummary.warning}`);
      }
      if (config.provider === "ollama") {
        console.log(`  Ollama URL: ${config.ollamaUrl || "http://localhost:11434/v1"}`);
      }
      console.log(`  Config: ${CONFIG_PATH}\n`);
      process.exit(0);
    }

    // /login 처리
    if (arg === "/login" || arg === "login") {
      await handleLogin();
      process.exit(0);
    }
    if (arg.startsWith("/login ")) {
      await handleLogin(arg.slice(7).trim());
      process.exit(0);
    }

    // /logout 처리
    if (arg === "/logout" || arg === "logout") {
      handleLogout();
      process.exit(0);
    }
    if (arg.startsWith("/logout ")) {
      handleLogout(arg.slice(8).trim());
      process.exit(0);
    }

    // /auth 처리
    if (arg === "/auth" || arg === "auth") {
      printAuthStatus();
      process.exit(0);
    }

    // /profile 처리 (다음 인자가 프로필 이름)
    if (arg === "/profile" && i + 1 < rawArgs.length) {
      const profileInput = rawArgs[i + 1];
      const profile = findProfileByInput(profileInput);
      if (!profile) {
        console.log(`${c.red}프로필을 찾을 수 없습니다: ${profileInput}${c.reset}`);
        process.exit(1);
      }
      selectedProfile = profile;
      console.log(`${c.green}프로필 선택됨: ${selectedProfile.displayName}${c.reset}`);
      console.log(`${c.dim}주의: 해당 프로필을 사용 중인 Chrome을 먼저 종료하세요!${c.reset}\n`);
      i++; // 프로필 이름 건너뛰기
      continue;
    }

    // /profile <name> 형식 (공백 포함된 단일 인자)
    if (arg.startsWith("/profile ")) {
      const profileInput = arg.slice(9).trim();
      const profile = findProfileByInput(profileInput);
      if (!profile) {
        console.log(`${c.red}프로필을 찾을 수 없습니다: ${profileInput}${c.reset}`);
        process.exit(1);
      }
      selectedProfile = profile;
      console.log(`${c.green}프로필 선택됨: ${selectedProfile.displayName}${c.reset}`);
      console.log(`${c.dim}주의: 해당 프로필을 사용 중인 Chrome을 먼저 종료하세요!${c.reset}\n`);
      continue;
    }

    // /p 또는 /parallel 처리 - 병렬 브라우저 실행
    if (arg === "/parallel" || arg === "/p") {
      console.log(`
${c.bright}병렬 실행${c.reset}

${c.yellow}사용법:${c.reset}  p <개수>  →  작업을 하나씩 입력 (빈 줄로 실행)

${c.dim}예시:${c.reset}
  p 3
  > 구글검색
  > 네이버검색
  >           ← 빈 줄 입력시 실행
`);
      process.exit(0);
    }

    // /p N task1 task2 ... 또는 /parallel N task1 task2 ...
    if (arg.startsWith("/p ") || arg.startsWith("/parallel ")) {
      const startIdx = arg.startsWith("/p ") ? 3 : 10;
      const parallelArgs = arg.slice(startIdx).trim();

      // 숫자만 입력한 경우 - 대화형 모드는 인터랙티브 REPL에서만 지원
      const countOnlyMatch = parallelArgs.match(/^(\d+)$/);
      if (countOnlyMatch) {
        console.log(`${c.yellow}대화형 병렬 실행은 인터랙티브 모드에서 사용하세요:${c.reset}`);
        console.log(`${c.dim}  npm start${c.reset}`);
        console.log(`${c.dim}  > p ${countOnlyMatch[1]}${c.reset}`);
        console.log(`${c.dim}  > 작업1${c.reset}`);
        console.log(`${c.dim}  > 작업2${c.reset}`);
        console.log(`${c.dim}  >        ← 빈 줄로 실행${c.reset}`);
        process.exit(0);
      }

      // 숫자로 시작하면 익명 브라우저 모드
      const countMatch = parallelArgs.match(/^(\d+)\s+(.+)$/);
      if (countMatch) {
        const count = parseInt(countMatch[1], 10);
        const tasksPart = countMatch[2];

        // 따옴표가 있으면 따옴표 기준, 없으면 공백 기준으로 분리
        let tasks: string[];
        const quotedTasks = tasksPart.match(/"[^"]+"/g);
        if (quotedTasks && quotedTasks.length > 0) {
          tasks = quotedTasks.map((t) => t.replace(/"/g, ""));
        } else {
          tasks = tasksPart.split(/\s+/).filter(t => t.length > 0);
        }

        if (tasks.length === 0) {
          console.log(`${c.red}사용법: p 3 작업1 작업2 작업3${c.reset}`);
          process.exit(1);
        }

        console.log(`${c.cyan}익명 브라우저: ${count}개${c.reset}`);
        console.log(`${c.cyan}작업 수: ${tasks.length}${c.reset}\n`);

        try {
          const model = resolveModel(config);
          const isOllama = config.provider === "ollama";

          const browsers = await startAnonymousParallelBrowsers(count);

          if (browsers.length === 0) {
            console.log(`${c.red}브라우저를 시작할 수 없습니다.${c.reset}`);
            process.exit(1);
          }

          await runParallelAgents(browsers, tasks, model, isOllama);
          await stopParallelBrowsers();
        } catch (error) {
          console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
          await stopParallelBrowsers();
        }
        process.exit(0);
      }

      // 프로필 모드: "profiles" "task1" "task2" ...
      const matches = parallelArgs.match(/"[^"]+"/g);

      if (!matches || matches.length < 2) {
        console.log(`${c.red}사용법:${c.reset}`);
        console.log(`  ${c.dim}익명: p 3 "작업1" "작업2"${c.reset}`);
        console.log(`  ${c.dim}프로필: p "Profile1,Profile2" "작업1" "작업2"${c.reset}`);
        process.exit(1);
      }

      const profileStr = matches[0].replace(/"/g, "");
      const profiles = profileStr.split(",").map((p) => p.trim());
      const tasks = matches.slice(1).map((t) => t.replace(/"/g, ""));

      console.log(`${c.cyan}프로필: ${profiles.join(", ")}${c.reset}`);
      console.log(`${c.cyan}작업 수: ${tasks.length}${c.reset}\n`);

      try {
        const model = resolveModel(config);
        const isOllama = config.provider === "ollama";

        const browsers = await startParallelBrowsers(profiles);

        if (browsers.length === 0) {
          console.log(`${c.red}실행 가능한 브라우저가 없습니다.${c.reset}`);
          console.log(`${c.dim}해당 프로필을 사용 중인 Chrome을 종료하세요.${c.reset}`);
          process.exit(1);
        }

        await runParallelAgents(browsers, tasks, model, isOllama);
        await stopParallelBrowsers();
      } catch (error) {
        console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
        await stopParallelBrowsers();
      }
      process.exit(0);
    }

    // /set 처리
    if (arg.startsWith("/set ")) {
      const parts = arg.slice(5).split(" ");
      if (parts.length >= 2) {
        const [provider, ...modelParts] = parts;
        const model = modelParts.join(" ");

        if (provider === "ollama") {
          config.provider = provider;
          config.model = model;
          saveConfig(config);
          console.log(`${c.green}Ollama 모델 설정됨: ${model}${c.reset}`);
          console.log(`${c.dim}URL: ${config.ollamaUrl || "http://localhost:11434/v1"}${c.reset}\n`);
        } else {
          try {
            const fetchedModel = getModel(provider as any, model as any);
            if (!fetchedModel) {
              throw new Error(`모델을 찾을 수 없음: ${provider}/${model}`);
            }
            config.provider = provider;
            config.model = model;
            saveConfig(config);
            console.log(`${c.green}모델 변경됨: ${provider}/${model}${c.reset}\n`);
          } catch (error) {
            console.log(`${c.red}잘못된 모델: ${(error as Error).message}${c.reset}\n`);
          }
        }
      } else {
        console.log(`${c.yellow}사용법: /set <provider> <model>${c.reset}`);
        console.log(`${c.dim}예: /set google ${DEFAULT_MODEL_BY_PROVIDER['google'] || 'gemini-2.5-flash'}${c.reset}`);
        console.log(`${c.dim}예: /set anthropic ${DEFAULT_MODEL_BY_PROVIDER['anthropic'] || 'claude-sonnet-4-5'}${c.reset}`);
        console.log(`${c.dim}예: /set openai ${DEFAULT_MODEL_BY_PROVIDER['openai'] || 'gpt-4o'}${c.reset}`);
        console.log(`${c.dim}예: /set openai-codex ${DEFAULT_MODEL_BY_PROVIDER['openai-codex'] || 'gpt-5.3-codex'}${c.reset}`);
      }
      process.exit(0);
    }

    // /ollama-url 처리
    if (arg.startsWith("/ollama-url ")) {
      const url = arg.slice(12).trim();
      config.ollamaUrl = url;
      saveConfig(config);
      console.log(`${c.green}Ollama URL 설정됨: ${url}${c.reset}\n`);
      process.exit(0);
    }

    if (arg.startsWith("/")) {
      console.log(`${c.red}알 수 없는 명령어: ${arg}${c.reset}`);
      console.log(`${c.dim}/help 로 명령어를 확인하세요.${c.reset}`);
      process.exit(1);
    }

    // 일반 인자는 미션으로 처리
    mission = arg;
  }

  // Extension 모드일 때 서버 시작
  if (browserMode === "extension") {
    console.log(`\n${c.cyan}🔌 Extension 모드${c.reset}`);
    await startExtensionServer();

    // Extension 연결 대기
    console.log(`${c.dim}Extension 연결 대기 중... (Chrome에서 Pi-Browser 확장 프로그램 확인)${c.reset}`);

    // 최대 60초 대기
    for (let i = 0; i < 120; i++) {
      if (extClient) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!extClient) {
      console.log(`${c.red}Extension 연결 타임아웃${c.reset}`);
      console.log(`${c.dim}Chrome에서 Pi-Browser 확장 프로그램을 설치하고 활성화하세요.${c.reset}`);
      console.log(`${c.dim}확장 프로그램 위치: ${path.join(process.cwd(), "extension")}${c.reset}\n`);
      stopExtensionServer();
      process.exit(1);
    }
  }

  // 미션이 있으면 실행
  if (mission) {
    try {
      const model = resolveModel(config);
      const isOllama = config.provider === "ollama";
      await runAgent(mission, model, isOllama);
    } catch (error) {
      console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
    }
    if (browserMode === "extension") {
      stopExtensionServer();
    } else {
      await stopBrowser();
    }
    process.exit(0);
  }

  printBanner(config);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    const status = browser ? `${c.green}●${c.reset}` : `${c.red}○${c.reset}`;
    rl.question(`${status} ${c.cyan}>${c.reset} `, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // 종료
      if (["exit", "quit", "종료", "q"].includes(trimmed.toLowerCase())) {
        console.log(`\n${c.yellow}종료 중...${c.reset}`);
        await stopBrowser();
        rl.close();
        process.exit(0);
      }

      // 모델 목록
      if (trimmed === "/models" || trimmed === "models") {
        printModels();
        prompt();
        return;
      }

      if (
        trimmed === "/tg-selftest" ||
        trimmed === "tg-selftest" ||
        trimmed === "/selftest-tg" ||
        trimmed === "selftest-tg"
      ) {
        runTelegramOutcomeSelfTest();
        prompt();
        return;
      }

      // 텔레그램 모드
      if (trimmed === "/tg" || trimmed === "tg" || trimmed === "/telegram" || trimmed === "telegram") {
        await runTelegramMode(config);
        prompt();
        return;
      }

      // 웹 UI 모드
      if (trimmed === "/web" || trimmed === "web" || trimmed === "/w" || trimmed === "w") {
        await runWebMode(config);
        prompt();
        return;
      }

      // 버전 정보
      if (trimmed === "/version" || trimmed === "version" || trimmed === "-v" || trimmed === "--version") {
        printVersion();
        prompt();
        return;
      }

      // help (슬래시 없이도 가능)
      if (trimmed === "/help" || trimmed === "/?" || trimmed === "help" || trimmed === "?") {
        printHelp();
        prompt();
        return;
      }

      // 병렬 실행 도움말 (슬래시 없이도 가능)
      if (trimmed === "/parallel" || trimmed === "/p" || trimmed === "p" || trimmed === "parallel") {
        console.log(`
${c.bright}병렬 실행${c.reset}

${c.yellow}사용법:${c.reset}  p <개수>  →  작업을 하나씩 입력 (빈 줄로 실행)

${c.dim}예시:${c.reset}
  p 3
  > 구글검색
  > 네이버검색
  > 다음검색
  >           ← 빈 줄 입력시 실행
`);
        prompt();
        return;
      }

      // 병렬 실행 (p, /p, parallel, /parallel)
      if (trimmed.startsWith("/p ") || trimmed.startsWith("/parallel ") ||
          trimmed.startsWith("p ") || trimmed.startsWith("parallel ")) {
        let startIdx = 2;
        if (trimmed.startsWith("/p ")) startIdx = 3;
        else if (trimmed.startsWith("p ")) startIdx = 2;
        else if (trimmed.startsWith("/parallel ")) startIdx = 10;
        else if (trimmed.startsWith("parallel ")) startIdx = 9;
        const parallelArgs = trimmed.slice(startIdx).trim();

        // 숫자만 입력한 경우 대화형 모드
        const countOnlyMatch = parallelArgs.match(/^(\d+)$/);
        if (countOnlyMatch) {
          const count = parseInt(countOnlyMatch[1], 10);
          console.log(`\n${c.bright}🚀 병렬 실행 (브라우저 ${count}개)${c.reset}`);
          console.log(`${c.dim}작업을 하나씩 입력하세요. 빈 줄 입력시 실행됩니다.${c.reset}\n`);

          const tasks: string[] = [];
          const collectTasks = () => {
            rl.question(`${c.yellow}[${tasks.length + 1}]${c.reset} > `, async (taskInput) => {
              const task = taskInput.trim();

              if (!task) {
                // 빈 줄 입력 - 실행
                if (tasks.length === 0) {
                  console.log(`${c.red}작업이 없습니다.${c.reset}\n`);
                  prompt();
                  return;
                }

                console.log(`\n${c.cyan}작업 ${tasks.length}개 실행 시작...${c.reset}\n`);

                try {
                  const model = resolveModel(config);
                  const isOllama = config.provider === "ollama";

                  const browsers = await startAnonymousParallelBrowsers(count);

                  if (browsers.length > 0) {
                    await runParallelAgents(browsers, tasks, model, isOllama);
                  } else {
                    console.log(`${c.red}브라우저를 시작할 수 없습니다.${c.reset}`);
                  }

                  await stopParallelBrowsers();
                } catch (error) {
                  console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
                  await stopParallelBrowsers();
                }
                prompt();
                return;
              }

              tasks.push(task);
              collectTasks();
            });
          };

          collectTasks();
          return;
        }

        // 숫자로 시작하면 익명 브라우저 모드
        const countMatch = parallelArgs.match(/^(\d+)\s+(.+)$/);
        if (countMatch) {
          const count = parseInt(countMatch[1], 10);
          const tasksPart = countMatch[2];

          // 따옴표가 있으면 따옴표 기준, 없으면 공백 기준으로 분리
          let tasks: string[];
          const quotedTasks = tasksPart.match(/"[^"]+"/g);
          if (quotedTasks && quotedTasks.length > 0) {
            tasks = quotedTasks.map((t) => t.replace(/"/g, ""));
          } else {
            tasks = tasksPart.split(/\s+/).filter(t => t.length > 0);
          }

          if (tasks.length === 0) {
            console.log(`${c.red}사용법: p 3 작업1 작업2 작업3${c.reset}`);
            prompt();
            return;
          }

          try {
            const model = resolveModel(config);
            const isOllama = config.provider === "ollama";

            const browsers = await startAnonymousParallelBrowsers(count);

            if (browsers.length > 0) {
              await runParallelAgents(browsers, tasks, model, isOllama);
            } else {
              console.log(`${c.red}브라우저를 시작할 수 없습니다.${c.reset}`);
            }

            await stopParallelBrowsers();
          } catch (error) {
            console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
            await stopParallelBrowsers();
          }
          prompt();
          return;
        }

        // 프로필 모드
        const matches = parallelArgs.match(/"[^"]+"/g);

        if (!matches || matches.length < 2) {
          console.log(`${c.red}사용법:${c.reset}`);
          console.log(`  ${c.dim}익명: p 3  →  작업을 하나씩 입력${c.reset}`);
          console.log(`  ${c.dim}프로필: p "Profile1,Profile2" "작업1"${c.reset}`);
          prompt();
          return;
        }

        const profileStr = matches[0].replace(/"/g, "");
        const profiles = profileStr.split(",").map((p) => p.trim());
        const tasks = matches.slice(1).map((t) => t.replace(/"/g, ""));

        try {
          const model = resolveModel(config);
          const isOllama = config.provider === "ollama";

          const browsers = await startParallelBrowsers(profiles);

          if (browsers.length > 0) {
            await runParallelAgents(browsers, tasks, model, isOllama);
          } else {
            console.log(`${c.red}실행 가능한 브라우저가 없습니다.${c.reset}`);
          }

          await stopParallelBrowsers();
        } catch (error) {
          console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
          await stopParallelBrowsers();
        }
        prompt();
        return;
      }

      // 설정 확인
      if (trimmed === "/config") {
        console.log(`\n${c.cyan}현재 설정:${c.reset}`);
        console.log(`  Provider: ${config.provider}`);
        console.log(`  Model: ${config.model}`);
        const authSummary = getAuthSourceSummary(config.provider, config.provider === "ollama");
        console.log(`  Auth Source: ${authSummary.label}`);
        if (authSummary.warning) {
          console.log(`  Auth Note: ${authSummary.warning}`);
        }
        if (config.provider === "ollama") {
          console.log(`  Ollama URL: ${config.ollamaUrl || "http://localhost:11434/v1"}`);
        }
        console.log(`  Config: ${CONFIG_PATH}\n`);
        prompt();
        return;
      }

      // OAuth 로그인
      if (trimmed === "/login" || trimmed === "login") {
        await handleLogin(undefined, rl);
        prompt();
        return;
      }
      if (trimmed.startsWith("/login ")) {
        await handleLogin(trimmed.slice(7).trim(), rl);
        prompt();
        return;
      }

      // OAuth 로그아웃
      if (trimmed === "/logout" || trimmed === "logout") {
        handleLogout();
        prompt();
        return;
      }
      if (trimmed.startsWith("/logout ")) {
        handleLogout(trimmed.slice(8).trim());
        prompt();
        return;
      }

      // 인증 상태
      if (trimmed === "/auth" || trimmed === "auth") {
        printAuthStatus();
        prompt();
        return;
      }

      // 모델 변경
      if (trimmed.startsWith("/set ")) {
        const parts = trimmed.slice(5).split(" ");
        if (parts.length >= 2) {
          const [provider, ...modelParts] = parts;
          const model = modelParts.join(" ");

          if (provider === "ollama") {
            config.provider = provider;
            config.model = model;
            saveConfig(config);
            console.log(`${c.green}Ollama 모델 설정됨: ${model}${c.reset}\n`);
          } else {
            try {
              const fetchedModel = getModel(provider as any, model as any);
              if (!fetchedModel) {
                throw new Error(`모델을 찾을 수 없음: ${provider}/${model}`);
              }
              config.provider = provider;
              config.model = model;
              saveConfig(config);
              console.log(`${c.green}모델 변경됨: ${provider}/${model}${c.reset}\n`);
            } catch (error) {
              console.log(`${c.red}잘못된 모델: ${(error as Error).message}${c.reset}\n`);
            }
          }
        } else {
          console.log(`${c.yellow}사용법: /set <provider> <model>${c.reset}`);
          console.log(`${c.dim}예: /set ollama ${DEFAULT_MODEL_BY_PROVIDER['ollama'] || 'llama3.2'}${c.reset}`);
          console.log(`${c.dim}예: /set google ${DEFAULT_MODEL_BY_PROVIDER['google'] || 'gemini-2.5-flash'}${c.reset}`);
          console.log(`${c.dim}예: /set anthropic ${DEFAULT_MODEL_BY_PROVIDER['anthropic'] || 'claude-sonnet-4-5'}${c.reset}`);
          console.log(`${c.dim}예: /set openai ${DEFAULT_MODEL_BY_PROVIDER['openai'] || 'gpt-4o'}${c.reset}`);
          console.log(`${c.dim}예: /set openai-codex ${DEFAULT_MODEL_BY_PROVIDER['openai-codex'] || 'gpt-5.3-codex'}${c.reset}\n`);
        }
        prompt();
        return;
      }

      // Ollama URL 설정
      if (trimmed.startsWith("/ollama-url ")) {
        const url = trimmed.slice(12).trim();
        config.ollamaUrl = url;
        saveConfig(config);
        console.log(`${c.green}Ollama URL 설정됨: ${url}${c.reset}\n`);
        prompt();
        return;
      }

      // 도움말
      if (trimmed === "/help" || trimmed === "?") {
        printBanner(config);
        prompt();
        return;
      }

      if (trimmed.startsWith("/")) {
        console.log(`${c.red}알 수 없는 명령어: ${trimmed}${c.reset}`);
        console.log(`${c.dim}/help 로 명령어를 확인하세요.${c.reset}`);
        prompt();
        return;
      }

      // 미션 실행
      try {
        const model = resolveModel(config);
        const isOllama = config.provider === "ollama";
        await runAgent(trimmed, model, isOllama);
      } catch (error) {
        console.log(`${c.red}Error: ${(error as Error).message}${c.reset}`);
      }

      prompt();
    });
  };

  prompt();

  process.on("SIGINT", async () => {
    console.log(`\n${c.yellow}종료 중...${c.reset}`);
    await stopBrowser();
    process.exit(0);
  });
}

main().catch(console.error);
