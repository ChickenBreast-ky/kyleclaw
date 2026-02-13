# 빈 응답 재시도 시 토큰 낭비 방지

## 문제

AI가 빈 응답(`content: []`)을 반환할 때 재시도 로직에서 토큰이 급속히 소진됨.

### 원인 3가지

1. **딜레이 없음** — `continue` 즉시 다음 API 호출 (0ms)
2. **빈 assistant 응답이 context에 쌓임** — `ctx.messages.push(response)` 가 content 비어도 실행됨
3. **"재시도" user 메시지도 매번 추가** — context 크기가 재시도마다 ~50 토큰씩 증가

### 토큰 소모 예시

context 5,000 토큰 기준:

| Turn | input 토큰 | output | 딜레이 |
|------|-----------|--------|--------|
| 1 | ~5,000 | 0 | 0ms |
| 2 | ~5,050 | 0 | 0ms |
| 3 | ~5,100 → 중단 | 0 | 0ms |
| **합계** | **~15,150** | **0** | **< 3초** |

---

## 수정 대상: 4곳

### 1. `src/cli.ts` — onTask 핸들러 (웹 UI)

**위치**: `const maxTurns = 20;` 블록 내부, 빈 응답 처리 경로

**현재 코드** (~line 2222, 2273-2278):
```typescript
// 문제 1: 빈 응답도 context에 push됨
ctx.messages.push(response);  // ← line 2222

// 문제 2: 딜레이 없이 즉시 재시도
send({ type: "log", text: "[WARN] 도구 호출도 텍스트도 없어 재시도합니다." });
ctx.messages.push({
  role: "user",
  content: "직전 응답이 비어 있습니다...",
});
continue;  // ← 즉시 다음 턴
```

**수정**:

(a) `ctx.messages.push(response)` 를 빈 응답일 때 건너뛰도록 조건 추가:
```typescript
// 빈 응답은 context에 추가하지 않음 (토큰 절약)
if (response.content.length > 0) {
  ctx.messages.push(response);
}
```

(b) 재시도 전 지수 백오프 딜레이 추가:
```typescript
const delayMs = 2000 * Math.pow(2, consecutiveEmptyResponses - 1); // 2s, 4s
send({ type: "log", text: `[WARN] 빈 응답 (${consecutiveEmptyResponses}/3) — ${delayMs / 1000}초 후 재시도합니다.` });
await new Promise(resolve => setTimeout(resolve, delayMs));
ctx.messages.push({
  role: "user",
  content: "직전 응답이 비어 있습니다. 반드시 toolCall 또는 text를 반환하세요. 요소가 안 보이면 browser_snapshot으로 다시 확인하고 진행하세요.",
});
continue;
```

### 2. `src/cli.ts` — CLI 대화형 모드

**위치**: `async function runAgent(...)` 내부, `const maxTurns = 100;` 블록

**현재 코드** (~line 1696-1722):
```typescript
ctx.messages.push(response);  // ← 빈 응답도 push됨

// ...
console.log(`${c.yellow}⚠️ 빈 응답... 다시 시도...${c.reset}`);
ctx.messages.push({ role: "user", content: "도구를 사용해서..." });
continue;  // ← 딜레이 없음
```

**수정**: onTask와 동일한 패턴 적용
- `response.content.length > 0` 체크 후 push
- 딜레이 추가 (console.log로 대기 표시)

### 3. `src/cli.ts` — Scheduler runStepAgent

**위치**: `onWorkflowRun` 콜백 내부의 `runStepAgent` 함수

**현재 코드** (~line 2372-2394):
```typescript
ctx.messages.push(response);  // ← 빈 응답도 push
// ...
onLog(`[WARN] 빈 응답 (${emptyCount}/3), 재시도...`);
continue;  // ← 딜레이 없음
```

**수정**: 동일 패턴

### 4. `src/cli.ts` — CLI Workflow runStepAgent

**위치**: `/wf run` 명령 핸들러 내부의 `runStepAgent` 함수

**현재 코드** (~line 3171-3197):
```typescript
ctx.messages.push(response);  // ← 빈 응답도 push
// ...
onLog(`[WARN] 빈 응답 (${emptyCount}/3), 재시도...`);
continue;  // ← 딜레이 없음
```

**수정**: 동일 패턴

---

## 수정 패턴 (공통)

모든 4곳에 동일한 2가지 변경 적용:

### 변경 A: 빈 응답 context push 방지

```typescript
// BEFORE
ctx.messages.push(response);

// AFTER
if (response.content.length > 0) {
  ctx.messages.push(response);
}
```

### 변경 B: 지수 백오프 딜레이

```typescript
// BEFORE
continue;

// AFTER
const delayMs = 2000 * Math.pow(2, consecutiveEmptyResponses - 1); // 2s, 4s
// (로그 출력 후)
await new Promise(resolve => setTimeout(resolve, delayMs));
continue;
```

### 수정 후 토큰 소모 예상

| Turn | input 토큰 | output | 딜레이 |
|------|-----------|--------|--------|
| 1 | ~5,000 | 0 | **2초** |
| 2 | ~5,050 | 0 | **4초** |
| 3 | 중단 | 0 | - |
| **합계** | **~10,050** | **0** | **6초** |

기존 대비 input 토큰 **~33% 절약**, 총 소요시간 6초로 급발진 방지.

---

## 체크리스트

- [ ] onTask 핸들러: 변경 A + B 적용
- [ ] CLI 대화형 (runAgent): 변경 A + B 적용
- [ ] Scheduler runStepAgent: 변경 A + B 적용
- [ ] CLI Workflow runStepAgent: 변경 A + B 적용
- [ ] `lsp_diagnostics` 클린 확인 (pre-existing 에러 제외)
- [ ] 수동 테스트: 빈 응답 모델로 재시도 딜레이 확인
