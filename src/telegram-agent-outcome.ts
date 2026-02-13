export type TelegramOutcomeCode =
  | "SUCCESS_TEXT"
  | "ERROR_AI"
  | "ERROR_MAX_TURNS"
  | "ERROR_NO_TOOL"
  | "ERROR_TOOL_ALL_FAILED"
  | "ERROR_EMPTY_RESPONSE";

export interface TelegramAgentOutcomeInput {
  finalResult: string;
  turnsUsed: number;
  maxTurns: number;
  aiErrorCount: number;
  hadToolCall: boolean;
  toolSuccessCount: number;
  toolErrorCount: number;
  blankTextCount: number;
}

export interface TelegramAgentOutcome {
  code: TelegramOutcomeCode;
  isError: boolean;
  resultText: string;
  debugSummary: string;
}

export interface TelegramProfileFallbackInput {
  requestedProfileName: string | null;
  hasDefaultProfile: boolean;
  startErrorMessage?: string;
}

function buildSummary(input: TelegramAgentOutcomeInput): string {
  return [
    `turns=${input.turnsUsed}/${input.maxTurns}`,
    `aiError=${input.aiErrorCount}`,
    `toolUsed=${input.hadToolCall ? "Y" : "N"}`,
    `toolOk=${input.toolSuccessCount}`,
    `toolErr=${input.toolErrorCount}`,
    `blankText=${input.blankTextCount}`,
  ].join(", ");
}

export function evaluateTelegramAgentOutcome(input: TelegramAgentOutcomeInput): TelegramAgentOutcome {
  const normalizedText = input.finalResult.trim();
  const debugSummary = buildSummary(input);

  if (normalizedText.length > 0) {
    return {
      code: "SUCCESS_TEXT",
      isError: false,
      resultText: normalizedText,
      debugSummary,
    };
  }

  if (input.aiErrorCount > 0) {
    return {
      code: "ERROR_AI",
      isError: true,
      resultText: "❌ AI 호출 단계에서 오류가 발생해 작업을 완료하지 못했습니다.",
      debugSummary,
    };
  }

  if (input.turnsUsed >= input.maxTurns) {
    return {
      code: "ERROR_MAX_TURNS",
      isError: true,
      resultText: `❌ 최대 턴(${input.maxTurns})에 도달해 작업을 완료하지 못했습니다.`,
      debugSummary,
    };
  }

  if (!input.hadToolCall) {
    return {
      code: "ERROR_NO_TOOL",
      isError: true,
      resultText: "❌ AI가 브라우저 도구를 호출하지 않아 작업을 진행하지 못했습니다.",
      debugSummary,
    };
  }

  if (input.toolSuccessCount === 0 && input.toolErrorCount > 0) {
    return {
      code: "ERROR_TOOL_ALL_FAILED",
      isError: true,
      resultText: "❌ 브라우저 도구 실행이 모두 실패해 작업을 완료하지 못했습니다.",
      debugSummary,
    };
  }

  return {
    code: "ERROR_EMPTY_RESPONSE",
    isError: true,
    resultText: "❌ 작업 중 응답이 비어 있어 결과를 만들지 못했습니다.",
    debugSummary,
  };
}

export function shouldFallbackToDefaultProfile(input: TelegramProfileFallbackInput): boolean {
  if (!input.requestedProfileName) return false;
  if (input.requestedProfileName === "pi-browser") return false;
  if (!input.hasDefaultProfile) return false;

  // 에러 메시지가 비어도, 커스텀 프로필 실패 시 기본 프로필로 한 번은 폴백 시도
  if (!input.startErrorMessage) return true;

  const msg = input.startErrorMessage.toLowerCase();
  const lockOrLaunchPatterns = [
    "사용 중",
    "실행할 수 없습니다",
    "연결 시간 초과",
    "timeout",
    "timed out",
    "failed",
    "cannot",
  ];
  return lockOrLaunchPatterns.some((p) => msg.includes(p));
}
