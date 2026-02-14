/**
 * Pi-Browser MCP Server
 * Model Context Protocol 서버로 브라우저 자동화 + 파일시스템 + 데이터베이스 도구 제공
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import Database from "better-sqlite3";

// ============================================================
// 설정
// ============================================================
const DATA_DIR = path.join(process.env.HOME || "~", ".pi-browser", "data");
const DB_PATH = path.join(DATA_DIR, "pi-browser.db");
const FILES_DIR = path.join(DATA_DIR, "files");

// 데이터 디렉토리 생성
await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(FILES_DIR, { recursive: true });

// ============================================================
// SQLite 데이터베이스
// ============================================================
const db = new Database(DB_PATH);

// 기본 테이블 생성
db.exec(`
  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT,
    result TEXT,
    url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT,
    filename TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS custom_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ============================================================
// 브라우저 상태
// ============================================================
let lastScreenshot: string | null = null;
let lastSnapshot: string | null = null;
let lastPageText: string | null = null;
let lastUrl: string = "";
let lastTitle: string = "";

// ============================================================
// Extension 연결
// ============================================================
let extWs: any = null;
const EXT_PORT = 9876;

async function connectExtension(): Promise<void> {
  const { WebSocketServer } = await import("ws");

  const wss = new WebSocketServer({ port: EXT_PORT });
  console.error(`[MCP] Extension 서버 시작됨 (ws://localhost:${EXT_PORT})`);

  wss.on("connection", (ws: any) => {
    extWs = ws;
    console.error("[MCP] Extension 연결됨");

    ws.on("close", () => {
      extWs = null;
      console.error("[MCP] Extension 연결 해제");
    });
  });
}

async function sendExtCommand(action: string, params: Record<string, unknown>): Promise<any> {
  if (!extWs) {
    throw new Error("Extension이 연결되지 않았습니다. Chrome에서 Pi-Browser 확장을 실행하세요.");
  }

  return new Promise((resolve, reject) => {
    const id = Date.now().toString();
    const timeout = setTimeout(() => reject(new Error("Extension 응답 시간 초과")), 30000);

    const handler = (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          extWs.off("message", handler);
          if (msg.error) {
            reject(new Error(msg.error));
          } else {
            resolve(msg.result);
          }
        }
      } catch {}
    };

    extWs.on("message", handler);
    extWs.send(JSON.stringify({ id, command: action, params }));
  });
}

// ============================================================
// MCP 서버 생성
// ============================================================
const server = new Server(
  {
    name: "pi-browser",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ============================================================
// 도구 목록
// ============================================================
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // === 브라우저 도구 ===
      {
        name: "browser_navigate",
        description: "웹페이지로 이동합니다",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "이동할 URL" },
          },
          required: ["url"],
        },
      },
      {
        name: "browser_click",
        description: "요소를 클릭합니다",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS 선택자 또는 텍스트 선택자" },
          },
          required: ["selector"],
        },
      },
      {
        name: "browser_fill",
        description: "입력 필드에 텍스트를 입력합니다",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS 선택자" },
            text: { type: "string", description: "입력할 텍스트" },
          },
          required: ["selector", "text"],
        },
      },
      {
        name: "browser_press",
        description: "키보드 키를 누릅니다",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "Enter, Tab, Escape 등" },
          },
          required: ["key"],
        },
      },
      {
        name: "browser_screenshot",
        description: "현재 페이지 스크린샷을 찍습니다",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "browser_snapshot",
        description: "페이지의 인터랙티브 요소 목록을 가져옵니다",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "browser_get_text",
        description: "페이지의 텍스트 내용을 가져옵니다",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS 선택자 (비어있으면 전체 페이지)" },
          },
        },
      },
      {
        name: "browser_scroll",
        description: "페이지를 스크롤합니다",
        inputSchema: {
          type: "object",
          properties: {
            direction: { type: "string", description: "up 또는 down" },
          },
          required: ["direction"],
        },
      },

      // === 파일시스템 도구 ===
      {
        name: "file_write",
        description: "파일에 내용을 저장합니다",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "파일명 (예: result.txt, data.json)" },
            content: { type: "string", description: "저장할 내용" },
            append: { type: "boolean", description: "기존 내용에 추가할지 (기본: false)" },
          },
          required: ["filename", "content"],
        },
      },
      {
        name: "file_read",
        description: "파일 내용을 읽습니다",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "파일명" },
          },
          required: ["filename"],
        },
      },
      {
        name: "file_list",
        description: "저장된 파일 목록을 조회합니다",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "file_delete",
        description: "파일을 삭제합니다",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "삭제할 파일명" },
          },
          required: ["filename"],
        },
      },
      {
        name: "screenshot_save",
        description: "마지막 스크린샷을 파일로 저장합니다",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "파일명 (예: screenshot.png)" },
          },
          required: ["filename"],
        },
      },

      // === 데이터베이스 도구 ===
      {
        name: "db_save_result",
        description: "작업 결과를 데이터베이스에 저장합니다",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "작업 내용" },
            result: { type: "string", description: "결과" },
            url: { type: "string", description: "관련 URL (선택)" },
          },
          required: ["task", "result"],
        },
      },
      {
        name: "db_get_results",
        description: "저장된 결과를 조회합니다",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "최대 개수 (기본: 10)" },
            search: { type: "string", description: "검색어 (선택)" },
          },
        },
      },
      {
        name: "db_set",
        description: "키-값 데이터를 저장합니다",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "키" },
            value: { type: "string", description: "값 (JSON 문자열 가능)" },
          },
          required: ["key", "value"],
        },
      },
      {
        name: "db_get",
        description: "키로 데이터를 조회합니다",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "키" },
          },
          required: ["key"],
        },
      },
      {
        name: "db_query",
        description: "SQL 쿼리를 실행합니다 (SELECT만 가능)",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string", description: "SQL SELECT 쿼리" },
          },
          required: ["sql"],
        },
      },
    ],
  };
});

// ============================================================
// 도구 실행
// ============================================================
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // === 브라우저 도구 ===
    if (name === "browser_navigate") {
      const result = await sendExtCommand("navigate", { url: args?.url });
      lastUrl = result.url;
      lastTitle = result.title;
      return {
        content: [{ type: "text", text: `✅ ${result.url}로 이동했습니다.\n제목: ${result.title}` }],
      };
    }

    if (name === "browser_click") {
      await sendExtCommand("click", { selector: args?.selector });
      return { content: [{ type: "text", text: `✅ "${args?.selector}" 클릭 완료` }] };
    }

    if (name === "browser_fill") {
      await sendExtCommand("fill", { selector: args?.selector, value: args?.text });
      return { content: [{ type: "text", text: `✅ "${args?.selector}"에 "${args?.text}" 입력 완료` }] };
    }

    if (name === "browser_press") {
      await sendExtCommand("press", { key: args?.key });
      return { content: [{ type: "text", text: `✅ ${args?.key} 키 입력 완료` }] };
    }

    if (name === "browser_screenshot") {
      const result = await sendExtCommand("screenshot", {});
      const dataUrl = result.image as string;
      lastScreenshot = dataUrl.replace(/^data:image\/\w+;base64,/, "");
      return {
        content: [
          { type: "text", text: "✅ 스크린샷 촬영 완료" },
          { type: "image", data: lastScreenshot, mimeType: "image/png" },
        ],
      };
    }

    if (name === "browser_snapshot") {
      const result = await sendExtCommand("snapshot", {});
      const elements = result.elements as Array<{ ref: string; tag: string; text: string; selector: string }>;
      const lines = elements.slice(0, 30).map((el, i) => `[${i + 1}] ${el.tag} "${el.text.slice(0, 50)}" → ${el.selector}`);
      lastSnapshot = lines.join("\n");
      return { content: [{ type: "text", text: `📋 페이지 요소 (${elements.length}개):\n\n${lastSnapshot}` }] };
    }

    if (name === "browser_get_text") {
      const result = await sendExtCommand("getText", {});
      lastPageText = (result.text as string).slice(0, 10000);
      return { content: [{ type: "text", text: `📄 페이지 텍스트:\n\n${lastPageText}` }] };
    }

    if (name === "browser_scroll") {
      await sendExtCommand("scroll", { direction: args?.direction, amount: 500 });
      return { content: [{ type: "text", text: `✅ ${args?.direction} 방향으로 스크롤 완료` }] };
    }

    // === 파일시스템 도구 ===
    if (name === "file_write") {
      const filename = String(args?.filename || "").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filepath = path.join(FILES_DIR, filename);
      const content = String(args?.content || "");

      if (args?.append) {
        await fs.appendFile(filepath, content + "\n", "utf-8");
      } else {
        await fs.writeFile(filepath, content, "utf-8");
      }

      return { content: [{ type: "text", text: `✅ 파일 저장됨: ${filepath}` }] };
    }

    if (name === "file_read") {
      const filename = String(args?.filename || "").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filepath = path.join(FILES_DIR, filename);
      const content = await fs.readFile(filepath, "utf-8");
      return { content: [{ type: "text", text: `📄 ${filename}:\n\n${content}` }] };
    }

    if (name === "file_list") {
      const files = await fs.readdir(FILES_DIR);
      const fileInfos = await Promise.all(
        files.map(async (f) => {
          const stat = await fs.stat(path.join(FILES_DIR, f));
          return `${f} (${(stat.size / 1024).toFixed(1)}KB, ${stat.mtime.toLocaleString()})`;
        })
      );
      return { content: [{ type: "text", text: `📁 저장된 파일 (${files.length}개):\n\n${fileInfos.join("\n")}` }] };
    }

    if (name === "file_delete") {
      const filename = String(args?.filename || "").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filepath = path.join(FILES_DIR, filename);
      await fs.unlink(filepath);
      return { content: [{ type: "text", text: `✅ 파일 삭제됨: ${filename}` }] };
    }

    if (name === "screenshot_save") {
      if (!lastScreenshot) {
        return { content: [{ type: "text", text: "❌ 저장할 스크린샷이 없습니다. browser_screenshot을 먼저 실행하세요." }], isError: true };
      }
      const filename = String(args?.filename || "screenshot.png").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filepath = path.join(FILES_DIR, filename);
      await fs.writeFile(filepath, Buffer.from(lastScreenshot, "base64"));

      // DB에도 기록
      db.prepare("INSERT INTO screenshots (task, filename) VALUES (?, ?)").run(lastTitle || lastUrl, filename);

      return { content: [{ type: "text", text: `✅ 스크린샷 저장됨: ${filepath}` }] };
    }

    // === 데이터베이스 도구 ===
    if (name === "db_save_result") {
      const stmt = db.prepare("INSERT INTO results (task, result, url) VALUES (?, ?, ?)");
      const info = stmt.run(args?.task, args?.result, args?.url || null);
      return { content: [{ type: "text", text: `✅ 결과 저장됨 (ID: ${info.lastInsertRowid})` }] };
    }

    if (name === "db_get_results") {
      const limit = Number(args?.limit) || 10;
      const search = args?.search ? `%${args.search}%` : null;

      let rows;
      if (search) {
        rows = db.prepare("SELECT * FROM results WHERE task LIKE ? OR result LIKE ? ORDER BY created_at DESC LIMIT ?").all(search, search, limit);
      } else {
        rows = db.prepare("SELECT * FROM results ORDER BY created_at DESC LIMIT ?").all(limit);
      }

      const text = (rows as any[]).map((r: any) =>
        `[${r.id}] ${r.created_at}\n작업: ${r.task}\n결과: ${r.result.slice(0, 200)}${r.result.length > 200 ? "..." : ""}\n`
      ).join("\n---\n");

      return { content: [{ type: "text", text: `📊 저장된 결과 (${(rows as any[]).length}개):\n\n${text}` }] };
    }

    if (name === "db_set") {
      const stmt = db.prepare(`
        INSERT INTO custom_data (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
      `);
      stmt.run(args?.key, args?.value, args?.value);
      return { content: [{ type: "text", text: `✅ 저장됨: ${args?.key}` }] };
    }

    if (name === "db_get") {
      const row = db.prepare("SELECT * FROM custom_data WHERE key = ?").get(args?.key) as any;
      if (!row) {
        return { content: [{ type: "text", text: `❌ 키를 찾을 수 없음: ${args?.key}` }], isError: true };
      }
      return { content: [{ type: "text", text: `📦 ${args?.key}: ${row.value}` }] };
    }

    if (name === "db_query") {
      const sql = String(args?.sql || "").trim().toLowerCase();
      if (!sql.startsWith("select")) {
        return { content: [{ type: "text", text: "❌ SELECT 쿼리만 허용됩니다" }], isError: true };
      }
      const rows = db.prepare(String(args?.sql)).all();
      return { content: [{ type: "text", text: `📊 쿼리 결과 (${(rows as any[]).length}개):\n\n${JSON.stringify(rows, null, 2)}` }] };
    }

    return { content: [{ type: "text", text: `❌ 알 수 없는 도구: ${name}` }], isError: true };
  } catch (error) {
    return { content: [{ type: "text", text: `❌ 에러: ${(error as Error).message}` }], isError: true };
  }
});

// ============================================================
// 리소스 목록
// ============================================================
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      { uri: "browser://screenshot", name: "현재 페이지 스크린샷", mimeType: "image/png" },
      { uri: "browser://snapshot", name: "페이지 요소 목록", mimeType: "text/plain" },
      { uri: "browser://text", name: "페이지 텍스트", mimeType: "text/plain" },
      { uri: "browser://info", name: "현재 페이지 정보", mimeType: "application/json" },
      { uri: "file://list", name: "저장된 파일 목록", mimeType: "application/json" },
      { uri: "db://results", name: "저장된 결과 목록", mimeType: "application/json" },
    ],
  };
});

// ============================================================
// 리소스 읽기
// ============================================================
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "browser://screenshot") {
    if (!lastScreenshot) {
      return { contents: [{ uri, mimeType: "text/plain", text: "스크린샷 없음" }] };
    }
    return { contents: [{ uri, mimeType: "image/png", blob: lastScreenshot }] };
  }

  if (uri === "browser://snapshot") {
    return { contents: [{ uri, mimeType: "text/plain", text: lastSnapshot || "스냅샷 없음" }] };
  }

  if (uri === "browser://text") {
    return { contents: [{ uri, mimeType: "text/plain", text: lastPageText || "텍스트 없음" }] };
  }

  if (uri === "browser://info") {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ url: lastUrl, title: lastTitle }, null, 2) }] };
  }

  if (uri === "file://list") {
    const files = await fs.readdir(FILES_DIR);
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(files, null, 2) }] };
  }

  if (uri === "db://results") {
    const rows = db.prepare("SELECT * FROM results ORDER BY created_at DESC LIMIT 100").all();
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(rows, null, 2) }] };
  }

  throw new Error(`알 수 없는 리소스: ${uri}`);
});

// ============================================================
// 서버 시작
// ============================================================
async function main() {
  await connectExtension();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Pi-Browser MCP 서버가 시작되었습니다");
  console.error(`[MCP] 데이터 디렉토리: ${DATA_DIR}`);
  console.error(`[MCP] 파일 저장소: ${FILES_DIR}`);
  console.error(`[MCP] 데이터베이스: ${DB_PATH}`);
}

main().catch(console.error);
