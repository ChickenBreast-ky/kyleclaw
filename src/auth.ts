/**
 * Pi-Browser OAuth 인증 관리
 *
 * ~/.pi-browser/auth.json 에 OAuth 자격증명 저장/로드/갱신
 * pi-ai 라이브러리의 OAuth 모듈을 래핑
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import {
  getOAuthApiKey,
  getOAuthProviders,
  getEnvApiKey,
  loginAnthropic,
  loginGitHubCopilot,
  loginGeminiCli,
  loginAntigravity,
  loginOpenAICodex,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";

// ============================================================
// 경로 & 색상
// ============================================================
const AUTH_DIR = path.join(os.homedir(), ".pi-browser");
const AUTH_PATH = path.join(AUTH_DIR, "auth.json");

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

// ============================================================
// 자격증명 저장/로드
// ============================================================
type AuthStore = Record<string, { type: "oauth" } & OAuthCredentials>;
export type AuthMode = "auto" | "api" | "oauth";

export function loadAuth(): AuthStore {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      return JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

export function saveAuth(auth: AuthStore): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
}

function isPlaceholderApiKey(apiKey: string): boolean {
  const key = apiKey.trim().toLowerCase();
  return (
    key.startsWith("your-") ||
    key.startsWith("your_") ||
    key === "your_api_key" ||
    key.includes("replace-with") ||
    key.includes("replace_me") ||
    key.includes("example")
  );
}

function isUsableApiKey(apiKey: string | undefined): apiKey is string {
  if (!apiKey) return false;
  if (!apiKey.trim()) return false;
  return !isPlaceholderApiKey(apiKey);
}

// ============================================================
// API 키 해석 (authMode: auto | api | oauth)
// ============================================================

/**
 * provider에 맞는 API 키를 반환한다.
 * 1. Ollama → "ollama"
 * 2. authMode=api: .env 유효 API 키만 사용
 * 3. authMode=oauth: OAuth 토큰만 사용
 * 4. authMode=auto: API 키 우선, 없으면 OAuth
 * 5. 둘 다 없으면 undefined (pi-ai가 내부적으로 처리)
 */
export async function resolveStreamOptions(
  provider: string,
  isOllama: boolean,
  authMode: AuthMode = "auto",
): Promise<{ apiKey: string } | undefined> {
  if (isOllama) return { apiKey: "ollama" };

  // OAuth 시도
  const auth = loadAuth();
  // pi-ai provider 이름 → OAuth provider 후보 ID 매핑
  const providerOAuthCandidates: Record<string, OAuthProvider[]> = {
    // 표준 provider 이름 (web/cli 모델 선택)
    "openai": ["openai-codex"],
    "google": ["google-gemini-cli", "google-antigravity"],
    "anthropic": ["anthropic"],

    // OAuth provider ID 직접 입력 시
    "openai-codex": ["openai-codex"],
    "google-gemini-cli": ["google-gemini-cli"],
    "google-antigravity": ["google-antigravity"],
    "github-copilot": ["github-copilot"],

    // 별칭
    "antigravity": ["google-antigravity"],
  };

  const oauthCandidates = providerOAuthCandidates[provider] ?? [];

  const tryOAuthCandidates = async (): Promise<{ apiKey: string } | undefined> => {
    for (const oauthId of oauthCandidates) {
      if (!auth[oauthId]) continue;

      try {
        const result = await getOAuthApiKey(oauthId, auth as Record<string, OAuthCredentials>);
        if (result) {
          // 갱신된 자격증명 저장
          auth[oauthId] = { type: "oauth", ...result.newCredentials };
          saveAuth(auth);
          return { apiKey: result.apiKey };
        }
      } catch (e) {
        console.log(`${c.yellow}⚠️ OAuth 토큰 갱신 실패 (${oauthId}): ${(e as Error).message}${c.reset}`);
        console.log(`${c.dim}  .env 환경변수로 폴백합니다. /login ${oauthId} 로 재로그인하세요.${c.reset}`);
      }
    }

    return undefined;
  };

  // API 우선 모드
  const envApiKey = getEnvApiKey(provider);
  if (authMode === "api") {
    if (isUsableApiKey(envApiKey)) {
      return { apiKey: envApiKey };
    }
    return undefined;
  }

  // OAuth 우선 모드
  if (authMode === "oauth") {
    const oauthResult = await tryOAuthCandidates();
    if (oauthResult) return oauthResult;
    return undefined;
  }

  // 기본(auto): 유효한 API 키 우선, 없으면 OAuth
  if (isUsableApiKey(envApiKey)) {
    return { apiKey: envApiKey };
  }

  const oauthResult = await tryOAuthCandidates();
  if (oauthResult) return oauthResult;

  // .env 폴백 — pi-ai가 자동으로 읽으므로 undefined 반환
  return undefined;
}

// ============================================================
// 로그인 플로우
// ============================================================

const OAUTH_PROVIDER_NAMES: Record<OAuthProvider, string> = {
  "anthropic": "Anthropic (Claude Pro/Max)",
  "github-copilot": "GitHub Copilot",
  "google-gemini-cli": "Google Gemini CLI (무료 티어 있음)",
  "google-antigravity": "Antigravity (무료 Gemini 3, Claude, GPT-OSS)",
  "openai-codex": "OpenAI Codex (ChatGPT Plus/Pro)",
};

function createPromptFn(rl: readline.Interface) {
  return (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));
}

export async function handleLogin(
  providerArg?: string,
  existingRl?: readline.Interface,
): Promise<void> {
  const providers = getOAuthProviders();
  const providerIds = providers.map((p) => p.id) as OAuthProvider[];

  let providerId: OAuthProvider;

  if (providerArg && providerIds.includes(providerArg as OAuthProvider)) {
    providerId = providerArg as OAuthProvider;
  } else if (providerArg) {
    console.log(`${c.red}알 수 없는 OAuth 프로바이더: ${providerArg}${c.reset}`);
    console.log(`${c.dim}사용 가능: ${providerIds.join(", ")}${c.reset}`);
    return;
  } else {
    // 대화형 선택
    const rl = existingRl || readline.createInterface({ input: process.stdin, output: process.stdout });
    const promptFn = createPromptFn(rl);

    console.log(`\n${c.cyan}OAuth 로그인${c.reset}\n`);
    for (let i = 0; i < providerIds.length; i++) {
      const id = providerIds[i];
      const auth = loadAuth();
      const status = auth[id] ? `${c.green}● 로그인됨${c.reset}` : `${c.dim}○ 미로그인${c.reset}`;
      console.log(`  ${i + 1}. ${OAUTH_PROVIDER_NAMES[id]} ${status}`);
    }
    console.log();

    const choice = await promptFn(`${c.cyan}번호 선택 (1-${providerIds.length}):${c.reset} `);
    if (!existingRl) rl.close();

    const index = parseInt(choice, 10) - 1;
    if (index < 0 || index >= providerIds.length) {
      console.log(`${c.red}잘못된 선택${c.reset}`);
      return;
    }
    providerId = providerIds[index];
  }

  console.log(`\n${c.cyan}${OAUTH_PROVIDER_NAMES[providerId]} 로그인 중...${c.reset}\n`);

  const rl = existingRl || readline.createInterface({ input: process.stdin, output: process.stdout });
  const promptFn = createPromptFn(rl);

  try {
    let credentials: OAuthCredentials;

    switch (providerId) {
      case "anthropic":
        credentials = await loginAnthropic(
          (url) => {
            console.log(`\n${c.bright}브라우저에서 열어주세요:${c.reset}`);
            console.log(`${c.blue}${url}${c.reset}\n`);
          },
          () => promptFn(`${c.cyan}인증 코드를 입력하세요:${c.reset} `),
        );
        break;

      case "github-copilot":
        credentials = await loginGitHubCopilot({
          onAuth: (url, instructions) => {
            console.log(`\n${c.bright}브라우저에서 열어주세요:${c.reset}`);
            console.log(`${c.blue}${url}${c.reset}`);
            if (instructions) console.log(`${c.dim}${instructions}${c.reset}`);
            console.log();
          },
          onPrompt: (prompt) =>
            promptFn(`${c.cyan}${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}:${c.reset} `),
          onProgress: (msg) => console.log(`${c.dim}${msg}${c.reset}`),
        });
        break;

      case "google-gemini-cli":
        credentials = await loginGeminiCli(
          (info) => {
            console.log(`\n${c.bright}브라우저에서 열어주세요:${c.reset}`);
            console.log(`${c.blue}${info.url}${c.reset}`);
            if (info.instructions) console.log(`${c.dim}${info.instructions}${c.reset}`);
            console.log();
          },
          (msg) => console.log(`${c.dim}${msg}${c.reset}`),
        );
        break;

      case "google-antigravity":
        credentials = await loginAntigravity(
          (info) => {
            console.log(`\n${c.bright}브라우저에서 열어주세요:${c.reset}`);
            console.log(`${c.blue}${info.url}${c.reset}`);
            if (info.instructions) console.log(`${c.dim}${info.instructions}${c.reset}`);
            console.log();
          },
          (msg) => console.log(`${c.dim}${msg}${c.reset}`),
        );
        break;

      case "openai-codex":
        credentials = await loginOpenAICodex({
          onAuth: (info) => {
            console.log(`\n${c.bright}브라우저에서 열어주세요:${c.reset}`);
            console.log(`${c.blue}${info.url}${c.reset}`);
            if (info.instructions) console.log(`${c.dim}${info.instructions}${c.reset}`);
            console.log();
          },
          onPrompt: (prompt) =>
            promptFn(`${c.cyan}${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}:${c.reset} `),
          onProgress: (msg) => console.log(`${c.dim}${msg}${c.reset}`),
        });
        break;
    }

    // 저장
    const auth = loadAuth();
    auth[providerId] = { type: "oauth", ...credentials };
    saveAuth(auth);

    console.log(`\n${c.green}✅ ${OAUTH_PROVIDER_NAMES[providerId]} 로그인 완료!${c.reset}`);
    console.log(`${c.dim}  자격증명 저장: ${AUTH_PATH}${c.reset}\n`);
  } catch (e) {
    console.log(`${c.red}로그인 실패: ${(e as Error).message}${c.reset}`);
  } finally {
    if (!existingRl) rl.close();
  }
}

// ============================================================
// 로그아웃
// ============================================================
export function handleLogout(providerArg?: string): void {
  const auth = loadAuth();

  if (providerArg) {
    if (auth[providerArg]) {
      delete auth[providerArg];
      saveAuth(auth);
      console.log(`${c.green}✅ ${providerArg} 로그아웃 완료${c.reset}`);
    } else {
      console.log(`${c.yellow}${providerArg}는 로그인되어 있지 않습니다.${c.reset}`);
    }
    return;
  }

  // 전체 로그아웃
  const loggedIn = Object.keys(auth);
  if (loggedIn.length === 0) {
    console.log(`${c.dim}로그인된 OAuth 프로바이더가 없습니다.${c.reset}`);
    return;
  }

  for (const id of loggedIn) {
    delete auth[id];
  }
  saveAuth(auth);
  console.log(`${c.green}✅ 전체 로그아웃 완료 (${loggedIn.join(", ")})${c.reset}`);
}

// ============================================================
// 인증 상태 표시
// ============================================================
export function printAuthStatus(): void {
  const auth = loadAuth();
  const providers = getOAuthProviders();

  console.log(`\n${c.cyan}인증 상태${c.reset}\n`);

  console.log(`${c.bright}[OAuth 프로바이더]${c.reset}`);
  for (const p of providers) {
    const id = p.id as OAuthProvider;
    const cred = auth[id];
    if (cred) {
      const expiresIn = Math.max(0, Math.floor((cred.expires - Date.now()) / 1000 / 60));
      const status = cred.expires > Date.now()
        ? `${c.green}● 활성${c.reset} (${expiresIn}분 남음)`
        : `${c.yellow}● 만료${c.reset} (자동 갱신됨)`;
      console.log(`  ${OAUTH_PROVIDER_NAMES[id]}: ${status}`);
    } else {
      console.log(`  ${OAUTH_PROVIDER_NAMES[id]}: ${c.dim}○ 미로그인${c.reset}`);
    }
  }

  console.log(`\n${c.bright}[API 키 (.env)]${c.reset}`);
  const envProviders: Array<{ name: string; provider: string }> = [
    { name: "OpenAI", provider: "openai" },
    { name: "Anthropic", provider: "anthropic" },
    { name: "Google (Gemini)", provider: "google" },
    { name: "Mistral", provider: "mistral" },
    { name: "Groq", provider: "groq" },
    { name: "xAI", provider: "xai" },
    { name: "OpenRouter", provider: "openrouter" },
  ];

  for (const { name, provider } of envProviders) {
    const key = getEnvApiKey(provider);
    if (key) {
      const masked = key.slice(0, 8) + "..." + key.slice(-4);
      console.log(`  ${name}: ${c.green}● 설정됨${c.reset} (${masked})`);
    } else {
      console.log(`  ${name}: ${c.dim}○ 미설정${c.reset}`);
    }
  }

  console.log(`\n${c.dim}  OAuth 파일: ${AUTH_PATH}${c.reset}`);
  console.log(`${c.dim}  로그인: /login [provider]  |  로그아웃: /logout [provider]${c.reset}\n`);
}
