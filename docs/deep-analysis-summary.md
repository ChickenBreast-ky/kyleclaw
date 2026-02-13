# Pi-Browser 심층 분석 정리

작성일: 2026-02-12

## 1) 프로젝트 성격

Pi-Browser는 자연어 입력을 받아 브라우저 자동화를 수행하는 TypeScript 기반 에이전트다. 실행 채널은 CLI, Web UI, Telegram, Workflow Scheduler로 나뉘지만, 실제 실행 코어는 `src/cli.ts`의 공통 에이전트 루프와 브라우저 도구로 수렴한다.

## 2) 핵심 구조

- 오케스트레이션 중심: `src/cli.ts`
  - 브라우저(CDP/Extension), 모델 호출, 도구 실행, 병렬 실행, Telegram/Web 연동까지 집중됨.
- Web 제어면: `src/web-client.ts`
  - 대시보드 HTML/WS 메시징, 설정 저장, 작업 상태 브로드캐스트.
- Telegram 채널: `src/telegram.ts`
  - 사용자 허용 목록, 명령 수신/응답, 메시지 핸들링.
- MCP 서버: `src/mcp-server.ts`
  - MCP 도구 제공, SQLite 연동, 브라우저/파일/DB 도구 노출.
- Workflow 엔진: `src/workflow/*`
  - 타입(`types.ts`), 저장(`storage.ts`), 스케줄(`scheduler.ts`), 실행(`executor.ts`).

## 3) 실행 흐름 요약

1. 입력 채널(CLI/Web/Telegram/Scheduler)에서 미션 수신
2. 모델/브라우저 모드 선택(CDP 또는 Extension)
3. 에이전트 루프에서 `toolCall` 기반 브라우저 도구 반복 실행
4. 결과를 채널별로 반환(터미널/웹소켓/텔레그램)
5. 선택적으로 Notion/DB/워크플로우 상태에 저장

## 4) 상태 및 영속화

- 설정: `~/.pi-browser/settings.json` (`src/web-client.ts`)
- 워크플로우: `~/.pi-browser/workflows/*.json` (`src/workflow/storage.ts`)
- 로컬 DB: `~/.pi-browser/data/pi-browser.db` (`src/mcp-server.ts`)
- 브라우저 프로필: `~/.pi-browser/chrome-profile/`

## 5) 현재 강점

- 채널 다양성: CLI/Web/Telegram/Scheduler가 동일 실행 코어를 공유하여 기능 확장 속도가 빠름
- 워크플로우 구조화: step/condition/retry 지원으로 자동화 시나리오를 선언적으로 관리 가능
- 모델 유연성: 다중 Provider + Ollama 로컬 모델 지원
- 운영 편의성: Web UI 기반 설정/실행/로그 확인 가능

## 6) 주요 리스크 (우선순위)

### Critical

1. Web 제어면 신뢰 경계 취약
- WebSocket 클라이언트 처리와 민감 설정 전달 경계가 약함 (`src/web-client.ts`).
- 결과적으로 비인가 제어/설정 노출 위험이 존재.

2. Extension 신뢰 경계 취약
- 확장 프로그램이 로컬 WS 명령을 신뢰하고, `eval` 경로가 존재 (`extension/background.js`).
- 권한 범위와 명령 검증이 약하면 코드 실행 리스크가 커짐.

3. Workflow 저장 경로 검증 부족
- workflow id 기반 파일 경로 처리에서 경로 오염 가능성이 있음 (`src/workflow/storage.ts`).

### High

4. 전역 런타임 공유
- 브라우저/페이지 상태가 전역 공유되어 채널 간 간섭 가능성 존재 (`src/cli.ts`).

5. 스케줄러 중복 실행 가능성
- `setInterval` 기반 비동기 스케줄 체크에서 single-flight 가드가 부족 (`src/workflow/scheduler.ts`).

6. MCP-Extension 계약 불일치 가능성
- 포트/메시지 계약 차이로 통합 안정성 저하 가능 (`src/mcp-server.ts`, `extension/background.js`).

### Medium

7. 단일 대형 파일 의존
- `src/cli.ts`, `src/web-client.ts`가 매우 커서 변경 영향 반경이 큼.

8. 로깅/관측 표준화 부족
- 콘솔 중심 로그라 운영 환경에서 추적성과 상관분석이 제한적.

## 7) 개선 로드맵 (실행 순서)

### Phase 1 (즉시, 1-2일)

- Web UI/WS 인증 토큰 및 로컬 바인딩 강제
- 민감 정보 마스킹(설정 payload에서 bot token, API key 원문 제거)
- Extension `eval` 제거 및 명령 allowlist 적용
- workflow id 서버측 검증(허용 문자만 통과, `path.resolve` prefix 검증)

### Phase 2 (단기, 1주)

- task dispatcher 또는 profile 단위 mutex 도입으로 실행 격리
- scheduler single-flight + 실패 backoff 적용
- MCP-Extension 공통 메시지 스키마/상수 모듈화

### Phase 3 (중기, 2-4주)

- `src/cli.ts` 기능 단위 분리(브라우저, 채널, 에이전트 루프)
- 구조화 로깅 도입(요청/작업 ID 기반 추적)
- 큐 기반 실행(BullMQ 등) 검토

## 8) 외부 베스트 프랙티스 대비

- Telegram: middleware + webhook + rate limit 패턴 권장
- MCP: 인증/인가 계층(OAuth 또는 최소 세션 토큰) 필수
- Browser automation: context 격리, 신뢰 경계 최소화, 명령 검증
- 실시간 대시보드: WS 재연결/백오프/종료 처리 표준화

## 9) 결론

현재 구조는 기능 구현 속도와 제품 실험에는 매우 유리하다. 다만 보안 신뢰 경계와 전역 런타임 공유로 인해 운영 리스크가 높은 상태다. 가장 효과적인 전략은 "재설계"보다 "경계 하드닝 + 실행 격리"를 선행하고, 이후 점진적으로 모듈 분해하는 방식이다.
