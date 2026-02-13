/**
 * Pi-Browser Telegram Bot
 * 텔레그램에서 명령을 받아 브라우저 작업 실행
 */

import { Bot, Context } from "grammy";

export interface TelegramBotConfig {
  token: string;
  allowedUsers?: number[]; // 허용된 사용자 ID 목록
  onMessage: (text: string, ctx: MessageContext) => Promise<string>;
}

export interface MessageContext {
  chatId: number;
  userId: number;
  username?: string;
  replyTo: (text: string) => Promise<void>;
}

let bot: Bot | null = null;

const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

function normalizeTelegramReply(text: string | undefined | null): string {
  const trimmed = (text ?? "").trim();
  return trimmed.length > 0 ? trimmed : "✅ 작업은 완료됐지만 응답 내용이 비어 있습니다.";
}

function splitTelegramMessage(text: string, maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);

    // 너무 기계적으로 잘리지 않게 줄바꿈/공백 기준으로 분할
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      const space = text.lastIndexOf(" ", end);
      const splitAt = Math.max(newline, space);
      if (splitAt > start + 200) {
        end = splitAt;
      }
    }

    chunks.push(text.slice(start, end).trim());
    start = end;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

async function safeReply(ctx: Context, text: string, useHtml: boolean = true): Promise<void> {
  const normalized = normalizeTelegramReply(text);
  const chunks = splitTelegramMessage(normalized);

  for (const chunk of chunks) {
    if (useHtml) {
      try {
        await ctx.reply(chunk, { parse_mode: "HTML" });
        continue;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.warn(`[Telegram] HTML 응답 전송 실패, 일반 텍스트로 재시도: ${errMsg}`);
      }
    }
    await ctx.reply(chunk);
  }
}

export async function startTelegramBot(config: TelegramBotConfig): Promise<Bot> {
  const { token, allowedUsers, onMessage } = config;

  bot = new Bot(token);

  // 에러 핸들러
  bot.catch((err) => {
    console.error("[Telegram] 에러:", err.message);
  });

  // 메시지 핸들러
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const username = ctx.from?.username;

    // 허용된 사용자 체크 (비어있으면 아무도 허용 안함)
    if (!allowedUsers || allowedUsers.length === 0) {
      await ctx.reply(
        `⛔ <b>허용된 사용자가 설정되지 않았습니다</b>\n\n` +
        `📋 <b>당신의 ID:</b>\n<code>${userId}</code>\n\n` +
        `👆 위 숫자를 복사해서 웹 설정에 추가하세요\n` +
        `(설정 → 텔레그램 봇 → 허용된 사용자 ID)`,
        { parse_mode: "HTML" }
      );
      return;
    }
    if (!userId || !allowedUsers.includes(userId)) {
      await ctx.reply(
        `⛔ <b>권한이 없습니다</b>\n\n` +
        `📋 <b>당신의 ID:</b>\n<code>${userId}</code>\n\n` +
        `관리자에게 위 ID를 전달하세요.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    console.log(`[Telegram] 메시지: ${text} (from: ${username || userId})`);

    const messageCtx: MessageContext = {
      chatId,
      userId: userId!,
      username,
      replyTo: async (reply: string) => {
        await safeReply(ctx, reply, true);
      },
    };

    try {
      const response = await onMessage(text, messageCtx);
      await safeReply(ctx, response, true);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      try {
        await safeReply(ctx, `❌ 에러: ${errMsg}`, false);
      } catch (replyError) {
        const replyErrMsg = replyError instanceof Error ? replyError.message : String(replyError);
        console.error("[Telegram] 에러 응답 전송 실패:", replyErrMsg);
      }
    }
  });

  // 시작
  console.log("[Telegram] 봇 시작 중...");
  bot.start({
    onStart: (botInfo) => {
      console.log(`[Telegram] 봇 시작됨: @${botInfo.username}`);
    },
  });

  return bot;
}

export function stopTelegramBot(): void {
  if (bot) {
    bot.stop();
    bot = null;
    console.log("[Telegram] 봇 종료됨");
  }
}

// 메시지 전송 헬퍼
export async function sendTelegramMessage(
  token: string,
  chatId: number | string,
  text: string
): Promise<void> {
  const tempBot = new Bot(token);
  await tempBot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
}
