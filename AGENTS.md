# Repository Guidelines

## Project Structure & Module Organization
- `src/cli.ts`: main entry for command mode and web-mode orchestration.
- `src/auth.ts`: OAuth credential storage, token refresh, `resolveStreamOptions()` helper, login/logout handlers.
- `src/web-client.ts`: Web UI server, WebSocket messaging, settings persistence.
- `src/telegram.ts`: Telegram bot startup, authorization, and message handling.
- `src/mcp-server.ts`: MCP tool server for browser and file operations.
- `src/workflow/*`: workflow types, storage, scheduler, and executor logic.
- `extension/*`: Chrome extension files (`manifest.json`, background/popup scripts, icons).
- `examples/*`: sample input files for real-world automation flows.
- Root config: `.env.example`, `mcp-config.json`, `tsconfig.json`, `package.json`.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm start '네이버에서 오늘 날씨 알려줘'`: run CLI task mode.
- `npm run web`: start Web UI mode (`http://localhost:3000`).
- `npm run dev`: same runtime as start, used for iterative local runs.
- `npm run mcp`: launch MCP server mode.
- `npm start /help`: quick smoke check that CLI boots correctly.

Note: scripts already include `NODE_OPTIONS=--no-network-family-autoselection` for this repo’s network environment.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM, `strict: true` in `tsconfig.json`).
- Indentation: 2 spaces; keep semicolons and existing import ordering style.
- Naming: `camelCase` for variables/functions, `PascalCase` for types/interfaces, kebab-case filenames (for multi-word files).
- Keep user-facing Korean strings clear and consistent with existing tone.
- Prefer explicit error messages over silent failures.

## Testing Guidelines
- No formal test framework is configured yet.
- Use manual smoke tests before PR:
  - `npm start /help`
  - `npm run web` and verify dashboard loads
  - validate changed flow end-to-end (e.g., browser tool, Telegram toggle, workflow run)
- In PR description, include reproduction steps and expected/actual outcomes.

## Commit & Pull Request Guidelines
- Follow existing commit style: `feat:`, `fix:`, `docs:`, `chore:` (seen in history).
- Keep commit subjects short, imperative, and scoped (example: `fix: Extension 서버 중복 시작 방지`).
- PRs should include:
  - what changed and why
  - impacted modules/paths
  - manual test evidence (commands + results)
  - screenshots/log snippets for Web UI changes
  - linked issue/ticket when applicable

## Security & Configuration Tips
- Never commit secrets (`.env`, API tokens, chat IDs, `auth.json`).
- Copy `.env.example` to `.env` for local setup.
- When sharing logs, redact tokens and personal identifiers.

## Authentication Architecture

### 개요
API 키 인증(.env)과 OAuth CLI 로그인을 모두 지원하는 하이브리드 인증 구조.
인증 방식은 `provider` 기준으로 자동 선택한다.

### 관련 파일
- `src/auth.ts`: OAuth 자격증명 저장/로드/갱신, `resolveStreamOptions()` 헬퍼, 로그인/로그아웃 핸들러.
- `~/.pi-browser/auth.json`: OAuth 토큰 저장 파일 (커밋 금지).
- `.env`: 기존 API 키 저장 (ANTHROPIC_API_KEY, OPENAI_API_KEY 등).
- `~/.pi-browser/settings.json`: Web UI 설정 (AI 모델 선택, 브라우저 모드 등 — API 키 없음).

### 인증 흐름
```
streamSimple 호출 시 → resolveStreamOptions(provider, isOllama)
  1. Ollama → { apiKey: "ollama" }
  2. .env 유효 API 키가 있으면 API 키 우선 사용
  3. API 키가 없으면 provider와 호환되는 OAuth 토큰 사용
  4. 둘 다 없음 → undefined 반환 → pi-ai 라이브러리가 process.env에서 자동 읽음
```

주의: `openai-codex` OAuth 토큰은 `openai`(api.openai.com) provider와 직접 호환되지 않는다. OAuth 사용 시 provider/model도 `openai-codex` 계열로 선택해야 한다.

### 지원 OAuth 프로바이더 (pi-ai 내장)
| ID | 서비스 | 인증 방식 |
|----|--------|----------|
| `anthropic` | Anthropic Claude Pro/Max | Device Code Flow |
| `openai-codex` | OpenAI Codex (ChatGPT Plus/Pro) | OAuth + PKCE |
| `github-copilot` | GitHub Copilot | Device Code Flow |
| `google-gemini-cli` | Google Gemini CLI (무료 티어 있음) | OAuth + Callback Server |
| `google-antigravity` | Antigravity (무료 Gemini 3, Claude, GPT-OSS) | OAuth + Callback Server |

### CLI 커맨드
```bash
npm start /login                   # 대화형 프로바이더 선택
npm start /login anthropic         # 특정 프로바이더 로그인
npm start /logout                  # 전체 로그아웃
npm start /logout anthropic        # 특정 프로바이더 로그아웃
npm start /auth                    # 인증 상태 확인 (OAuth + .env 모두 표시)
```
인터랙티브 모드에서도 동일 커맨드 사용 가능 (슬래시 없이도 됨).

### 수정 시 주의사항
- `cli.ts`의 `streamSimple()` 호출은 모두 `resolveStreamOptions()`를 거친다 (7곳).
- 새로운 `streamSimple` 호출을 추가할 때도 반드시 `resolveStreamOptions()` 사용할 것.
- `auth.json`은 `.gitignore`에 추가되어 있지 않으면 추가 필요.
- pi-ai 라이브러리(`@mariozechner/pi-ai`)에 OAuth 모듈이 내장되어 있음 (`utils/oauth/`).
