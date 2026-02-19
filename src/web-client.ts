/**
 * Pi-Browser Web Client
 * 멀티 브라우저 제어 웹 UI + 텔레그램 설정
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadWorkflows,
  loadWorkflow,
  saveWorkflow,
  deleteWorkflow,
  generateWorkflowId,
  type Workflow,
  type WorkflowStep,
} from "./workflow/index.js";
import { getAuthSourceSummary, type AuthSourceSummary } from "./auth.js";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import {
  loadTasks,
  saveTask,
  deleteTask as deleteStoredTask,
  type StoredTask,
} from "./task-storage.js";

// 설정 파일 경로
const CONFIG_DIR = path.join(os.homedir(), ".pi-browser");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");

export interface Settings {
  telegram?: {
    botToken?: string;
    allowedUsers?: number[];
    enabled?: boolean;
    profile?: string; // 텔레그램에서 사용할 Chrome 프로필 경로
    debugLogs?: boolean; // 레거시 설정 (전역 debugLogs로 마이그레이션)
  };
  debugLogs?: boolean; // 웹/텔레그램 상세 디버그 로그 표시
  ai?: {
    provider?: string;
    model?: string;
    ollamaUrl?: string;
  };
  browser?: {
    mode?: "cdp" | "extension";
    reuseExisting?: boolean;
    multiProfile?: boolean;
    headless?: boolean;
    profilePath?: string;
    selectedProfile?: string; // 프로필 경로
  };
  notion?: {
    enabled?: boolean;
    apiKey?: string;
    databaseId?: string;
  };
}

export interface ChromeProfile {
  name: string;
  path: string;
  displayName: string;
}

export function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

export function saveSettings(settings: Settings): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function sanitizeAiSettings(ai?: Settings["ai"]): Settings["ai"] {
  return {
    provider: ai?.provider,
    model: ai?.model,
    ollamaUrl: ai?.ollamaUrl,
  };
}

// Chrome 프로필 디렉토리 경로
function getChromeProfilesDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  } else if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

// Chrome 프로필 스캔
export function scanChromeProfiles(): ChromeProfile[] {
  const profiles: ChromeProfile[] = [];
  const chromeDir = getChromeProfilesDir();

  // Pi-Browser 전용 프로필
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
        let email = "";

        if (fs.existsSync(prefsPath)) {
          try {
            const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));

            // 이메일 주소 가져오기 (account_info에서)
            if (prefs.account_info && Array.isArray(prefs.account_info) && prefs.account_info.length > 0) {
              email = prefs.account_info[0].email || "";
            }

            // 프로필 이름
            if (prefs.profile?.name) {
              displayName = prefs.profile.name;
            }
          } catch {}
        }

        // 이메일이 있으면 이메일 표시, 없으면 프로필 이름 표시
        const finalDisplayName = email ? `📧 ${email}` : `👤 ${displayName}`;

        profiles.push({
          name: entry.name,
          path: profilePath,
          displayName: finalDisplayName,
        });
      }
    }
  } catch (e) {
    console.error("[WebClient] Chrome 프로필 스캔 오류:", e);
  }

  return profiles;
}

function buildProviderModels(): Record<string, { value: string; label: string }[]> {
  const DISPLAY_PROVIDERS = ['google', 'openai', 'openai-codex', 'anthropic', 'groq'];
  const RECOMMENDED_MODELS: Record<string, string> = {
    'google': 'gemini-2.5-flash',
    'openai': 'gpt-4o',
    'openai-codex': 'gpt-5.3-codex',
    'anthropic': 'claude-sonnet-4-5',
    'groq': 'llama-3.3-70b-versatile',
  };

  const result: Record<string, { value: string; label: string }[]> = {};

  for (const provider of DISPLAY_PROVIDERS) {
    try {
      const models = getModels(provider as any);
      const recommended = RECOMMENDED_MODELS[provider] || '';
      
      result[provider] = models
        .filter(m => !m.id.includes('preview') || m.id.includes('flash'))
        .sort((a, b) => {
          if (a.id === recommended) return -1;
          if (b.id === recommended) return 1;
          if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 12)
        .map(m => ({
          value: m.id,
          label: m.name + (m.reasoning ? ' [R]' : '') + (m.id === recommended ? ' (추천)' : ''),
        }));
    } catch (e) {
      console.warn(`[web-client] Failed to get models for ${provider}:`, e);
      result[provider] = [];
    }
  }

  result['ollama'] = [];
  return result;
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pi-Browser Control</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
  <style>
    /* === Pi-Browser Custom Design System === */
    /* Inspired by Vercel, Linear, Cursor — AI/Agentic aesthetic */

    :root {
      /* Background layers */
      --bg-base: #09090b;
      --bg-surface: #111113;
      --bg-elevated: #18181b;
      --bg-overlay: rgba(0, 0, 0, 0.6);

      /* Glass effect */
      --glass-bg: rgba(255, 255, 255, 0.03);
      --glass-border: rgba(255, 255, 255, 0.06);
      --glass-hover: rgba(255, 255, 255, 0.08);

      /* Text hierarchy */
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #8b8b95;
      --text-disabled: #6b6b76;

      /* Accent */
      --accent: #8b5cf6;
      --accent-hover: #7c3aed;
      --accent-subtle: rgba(139, 92, 246, 0.1);
      --accent-border: rgba(139, 92, 246, 0.3);
      --accent-gradient: linear-gradient(135deg, #8b5cf6, #6366f1, #3b82f6);

      /* Semantic */
      --success: #22c55e;
      --success-subtle: rgba(34, 197, 94, 0.1);
      --success-border: rgba(34, 197, 94, 0.3);
      --warning: #f59e0b;
      --warning-subtle: rgba(245, 158, 11, 0.1);
      --error: #ef4444;
      --error-subtle: rgba(239, 68, 68, 0.1);
      --error-border: rgba(239, 68, 68, 0.3);

      /* Borders & Radius */
      --border: rgba(255, 255, 255, 0.06);
      --border-hover: rgba(255, 255, 255, 0.12);
      --radius-sm: 6px;
      --radius: 8px;
      --radius-lg: 12px;
      --radius-xl: 16px;
      --radius-full: 9999px;

      /* Shadows */
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
      --shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);

      /* Fonts */
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
    }

    /* Animations */
    @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.6;} }
    @keyframes fadeIn { from{opacity:0;transform:translateY(6px);} to{opacity:1;transform:translateY(0);} }
    @keyframes slideUp { from{transform:translateY(16px);opacity:0;} to{transform:translateY(0);opacity:1;} }

    /* === Reset & Base === */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font-sans);
      background: var(--bg-base);
      color: var(--text-primary);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      min-height: 100vh;
    }

    /* === Container === */
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }

    /* === Typography === */
    h1 {
      text-align: center;
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 2rem;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      letter-spacing: -0.02em;
    }
    h2 { font-size: 1.25rem; font-weight: 600; color: var(--text-primary); margin-bottom: 1rem; letter-spacing: -0.01em; }
    h3 { font-size: 1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.75rem; }
    h4 { font-size: 0.875rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 0.5rem; }
    p { color: var(--text-secondary); margin-bottom: 0.75rem; }
    small { font-size: 0.75rem; color: var(--text-muted); }
    label { display: block; font-size: 0.8rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 0.375rem; }
    hr { border: none; border-top: 1px solid var(--border); margin: 1.5rem 0; }

    /* === Tabs === */
    .tabs { margin-bottom: 1.75rem; }
    .tabs [role="group"] {
      display: flex;
      gap: 4px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 4px;
    }
    .tabs [role="group"] > button {
      flex: 1;
      padding: 0.5rem 1rem;
      font-size: 0.8rem;
      font-weight: 500;
      font-family: var(--font-sans);
      color: var(--text-secondary);
      background: transparent;
      border: none;
      border-radius: var(--radius);
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
    }
    .tabs [role="group"] > button:hover {
      color: var(--text-secondary);
      background: var(--glass-hover);
    }
    .tabs [role="group"] > button.active {
      color: var(--text-primary);
      background: var(--accent-gradient);
      font-weight: 600;
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeIn 0.3s ease; }

    /* === Form Elements === */
    input[type="text"], input[type="number"], input[type="password"], input[type="url"],
    input[type="email"], input[type="tel"], input[type="date"], input[type="time"],
    select, textarea {
      width: 100%;
      padding: 0.5rem 0.75rem;
      font-size: 0.85rem;
      font-family: var(--font-sans);
      color: var(--text-primary);
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      -webkit-appearance: none;
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--accent-border);
      box-shadow: 0 0 0 3px var(--accent-subtle);
    }
    input::placeholder, textarea::placeholder { color: var(--text-muted); }
    textarea { min-height: 80px; resize: vertical; line-height: 1.5; }
    select { cursor: pointer; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23a1a1aa' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 0.75rem center; padding-right: 2rem; }
    select option { background: var(--bg-elevated); color: var(--text-primary); }

    /* === Buttons === */
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.375rem;
      padding: 0.5rem 1rem;
      font-size: 0.8rem;
      font-weight: 500;
      font-family: var(--font-sans);
      color: var(--text-primary);
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
      line-height: 1.4;
    }
    button:hover { background: var(--glass-hover); border-color: var(--border-hover); }
    button:active { transform: scale(0.98); }
    button:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

    /* Primary button (gradient) */
    button.primary, button[type="submit"] {
      background: var(--accent-gradient);
      border: none;
      color: #fff;
      font-weight: 600;
    }
    button.primary:hover, button[type="submit"]:hover {
      opacity: 0.9;
      box-shadow: 0 4px 16px rgba(139, 92, 246, 0.3);
    }

    /* Secondary (glass) */
    button.secondary {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }
    button.secondary:hover { background: var(--glass-hover); color: var(--text-primary); }

    /* Danger */
    button.danger {
      background: var(--error-subtle);
      border: 1px solid var(--error-border);
      color: var(--error);
    }
    button.danger:hover { background: rgba(239, 68, 68, 0.2); }

    /* Success */
    button.success {
      background: var(--success-subtle);
      border: 1px solid var(--success-border);
      color: var(--success);
    }
    button.success:hover { background: rgba(34, 197, 94, 0.2); }

    /* Small button */
    .btn-sm { padding: 0.25rem 0.625rem; font-size: 0.7rem; margin-left: 0.5rem; }

    /* === Stats Bar === */
    .stats {
      display: flex;
      align-items: stretch;
      gap: 0;
      margin-bottom: 1.75rem;
      padding: 0.875rem 1.25rem;
      background: var(--glass-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius-lg);
      flex-wrap: wrap;
    }
    .stat {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      padding: 0 1rem;
      border-right: 1px solid var(--border);
      flex: 1;
      min-width: 80px;
    }
    .stat:last-child { border-right: none; }
    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--accent);
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .stat-label {
      font-size: 0.65rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 2px;
    }
    .connected,
    .disconnected {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 1.5rem;
      font-size: 0.8rem;
      line-height: 1;
      width: 100%;
    }
    .connected { color: var(--success); }
    .disconnected { color: var(--error); animation: pulse 1.5s infinite; }

    /* === Input Area === */
    .input-area {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.75rem;
      align-items: stretch;
    }
    .input-area select { width: 200px; margin-bottom: 0; flex-shrink: 0; }
    .input-area input { flex: 1; margin-bottom: 0; }
    .input-area button { margin-bottom: 0; }

    /* === Task Grid === */
    .tasks-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 0.75rem;
    }

    /* === Task Card (Glass) === */
    .task-card, article {
      background: var(--glass-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius-lg);
      padding: 1.25rem;
      margin-bottom: 0;
      transition: border-color 0.2s;
    }
    .task-card:hover, article:hover { border-color: var(--border-hover); }

    .task-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
      padding-bottom: 0.625rem;
      border-bottom: 1px solid var(--border);
    }
    .task-id {
      font-size: 0.7rem;
      color: var(--accent);
      font-family: var(--font-mono);
      opacity: 0.8;
    }

    /* Status badges */
    .task-status {
      display: inline-block;
      padding: 2px 10px;
      font-size: 0.6rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-radius: var(--radius-full);
    }
    .status-pending { background: var(--warning-subtle); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }
    .status-running { background: var(--accent-subtle); color: var(--accent); border: 1px solid var(--accent-border); animation: pulse 1.5s infinite; }
    .status-done { background: var(--success-subtle); color: var(--success); border: 1px solid var(--success-border); }
    .status-error { background: var(--error-subtle); color: var(--error); border: 1px solid var(--error-border); }
    .status-stopped { background: rgba(113, 113, 122, 0.1); color: var(--text-muted); border: 1px solid rgba(113, 113, 122, 0.3); }

    /* Task actions */
    .task-actions { display: flex; align-items: center; gap: 0.375rem; }
    .btn-stop, .btn-delete {
      width: 26px; height: 26px; padding: 0;
      border-radius: var(--radius-sm);
      border: 1px solid; cursor: pointer; font-size: 11px;
      display: inline-flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    .btn-stop { background: var(--error-subtle); border-color: var(--error-border); color: var(--error); }
    .btn-stop:hover { background: rgba(239, 68, 68, 0.25); }
    .btn-delete { background: rgba(113, 113, 122, 0.1); border-color: rgba(113, 113, 122, 0.3); color: var(--text-muted); }
    .btn-delete:hover { background: rgba(113, 113, 122, 0.2); }

    /* Task mission */
    .task-mission {
      font-size: 0.8rem;
      color: var(--text-primary);
      margin-bottom: 0.75rem;
      padding: 0.625rem 0.875rem;
      background: var(--accent-subtle);
      border-left: 2px solid var(--accent);
      border-radius: 0 var(--radius) var(--radius) 0;
    }

    /* Task log (terminal) */
    .task-log {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      line-height: 1.6;
      background: rgba(0, 0, 0, 0.5);
      padding: 0.75rem;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      border-radius: var(--radius);
      color: var(--text-secondary);
      border: 1px solid var(--border);
    }
    .task-log::-webkit-scrollbar { width: 4px; }
    .task-log::-webkit-scrollbar-track { background: transparent; }
    .task-log::-webkit-scrollbar-thumb { background: var(--accent); border-radius: 2px; }

    /* Task result */
    .task-result {
      margin-top: 0.75rem;
      padding: 0.625rem 0.875rem;
      background: var(--success-subtle);
      border: 1px solid var(--success-border);
      border-left: 2px solid var(--success);
      color: var(--success);
      border-radius: 0 var(--radius) var(--radius) 0;
      font-size: 0.8rem;
    }

    /* Log colors */
    .log-tool { color: var(--warning); }
    .log-success { color: var(--success); }
    .log-error { color: var(--error); }

    /* === Settings === */
    .settings-section {
      margin-bottom: 1.5rem;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius-lg);
      padding: 1.25rem;
    }
    .settings-section h3 { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
    .form-group { margin-bottom: 1rem; }
    .form-group label { margin-bottom: 0.375rem; }
    .form-group input, .form-group select { max-width: 500px; }
    .form-group small { display: block; margin-top: 0.25rem; color: var(--text-secondary); font-size: 0.72rem; }

    /* === Toggle Switch === */
    .toggle-group { display: flex; align-items: center; gap: 0.75rem; }
    .toggle { position: relative; width: 44px; height: 24px; display: inline-block; flex-shrink: 0; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute; cursor: pointer; inset: 0;
      background-color: var(--bg-elevated); border: 1px solid var(--border);
      border-radius: var(--radius-full); transition: 0.2s;
    }
    .toggle-slider:before {
      position: absolute; content: ""; height: 18px; width: 18px;
      left: 2px; bottom: 2px; background-color: var(--text-muted);
      border-radius: 50%; transition: 0.2s;
    }
    .toggle input:checked + .toggle-slider { background-color: var(--accent-subtle); border-color: var(--accent-border); }
    .toggle input:checked + .toggle-slider:before { transform: translateX(20px); background-color: var(--accent); }

    /* === Status Badges === */
    .status-badge {
      padding: 2px 10px;
      border-radius: var(--radius-full);
      font-size: 0.7rem;
      font-weight: 500;
    }
    .status-badge.running { background: var(--success-subtle); color: var(--success); border: 1px solid var(--success-border); }
    .status-badge.stopped { background: var(--error-subtle); color: var(--error); border: 1px solid var(--error-border); }
    .status-badge.warning { background: var(--warning-subtle); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }

    /* === Alerts === */
    #settingsAlert {
      position: fixed; bottom: 1.25rem; left: 50%; transform: translateX(-50%);
      z-index: 9999; min-width: 300px; max-width: 500px;
    }
    .alert {
      padding: 0.75rem 1.25rem;
      border-radius: var(--radius-lg);
      font-size: 0.8rem;
      text-align: center;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: var(--shadow-lg);
      animation: slideUp 0.3s ease;
    }
    .alert-success {
      background: rgba(34, 197, 94, 0.08);
      border: 1px solid var(--success-border);
      color: var(--success);
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid var(--error-border);
      color: var(--error);
    }

    /* === Workflows === */
    .workflows-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 0.75rem;
      margin-top: 1rem;
    }
    .workflow-card {
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius-lg);
      padding: 1.25rem;
      margin-bottom: 0;
      transition: border-color 0.2s;
    }
    .workflow-card:hover { border-color: var(--border-hover); }
    .workflow-card.disabled { opacity: 0.45; }
    .workflow-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
    .workflow-name { font-weight: 600; color: var(--accent); font-size: 0.9rem; }
    .workflow-desc { font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.5rem; }
    .workflow-meta { font-size: 0.65rem; color: var(--text-disabled); display: flex; gap: 1rem; }
    .workflow-actions { display: flex; gap: 0.375rem; }
    .workflow-actions button { padding: 0.25rem 0.5rem; font-size: 0.7rem; }

    /* === Step Editor === */
    .step-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 1rem;
      margin-bottom: 0.75rem;
      position: relative;
      transition: border-color 0.2s;
    }
    .step-card:hover { border-color: var(--border-hover); }
    .step-controls { position: absolute; top: 0.5rem; right: 0.5rem; display: flex; gap: 4px; }
    .step-move, .step-delete {
      width: 24px; height: 24px; padding: 0;
      border-radius: var(--radius-sm); cursor: pointer; font-size: 11px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--border); background: transparent; color: var(--text-muted);
      transition: all 0.15s;
    }
    .step-move:hover { background: var(--accent-subtle); color: var(--accent); border-color: var(--accent-border); }
    .step-move:disabled { opacity: 0.3; cursor: not-allowed; }
    .step-delete { border-color: var(--error-border); color: var(--error); }
    .step-delete:hover { background: var(--error-subtle); }
    .step-header {
      display: flex; align-items: center; margin-bottom: 0.75rem;
      padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); padding-right: 5rem;
    }
    .step-number {
      background: var(--accent-gradient);
      color: #fff; width: 24px; height: 24px;
      border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
      font-size: 0.7rem; font-weight: 700; flex-shrink: 0;
    }
    .step-row { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap; align-items: center; }
    .step-row label { min-width: 70px; font-size: 0.75rem; }
    .step-row input, .step-row select { flex: 1; min-width: 150px; margin-bottom: 0; }
    .prompt-container { margin-top: 0.75rem; }
    .prompt-input, .mission-input { resize: vertical; }
    .advanced-options { margin-top: 0.75rem; }
    .advanced-options summary { cursor: pointer; font-size: 0.75rem; color: var(--text-muted); transition: color 0.15s; }
    .advanced-options summary:hover { color: var(--accent); }

    /* === Schedule === */
    .schedule-section {
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 1rem;
      margin-top: 1rem;
      background: var(--bg-surface);
    }
    .schedule-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
    .schedule-row label { min-width: 70px; }
    .schedule-row input, .schedule-row select { margin-bottom: 0; }

    /* === Run Log === */
    .run-log-wf-item {
      display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem;
      margin-bottom: 4px; border-radius: var(--radius);
      border: 1px solid var(--border); cursor: pointer;
      font-size: 0.75rem; transition: all 0.15s; color: var(--text-secondary);
    }
    .run-log-wf-item:hover { background: var(--glass-hover); border-color: var(--border-hover); }
    .run-log-wf-item.active { background: var(--accent-subtle); border-color: var(--accent-border); color: var(--text-primary); cursor: default; }
    .run-log-wf-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* === Misc Sections === */
    .mission-section {
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 1rem;
      background: var(--bg-surface);
    }
    .steps-advanced {
      border: 1px dashed var(--border);
      border-radius: var(--radius-lg);
      padding: 0.75rem 1rem;
    }
    .steps-advanced[open] { border-style: solid; border-color: var(--border-hover); }

    /* === Article (Pico fallback) === */
    article { margin-bottom: 0.75rem; }

    /* === Responsive === */
    @media (max-width: 768px) {
      .container { padding: 1rem; }
      .tasks-grid { grid-template-columns: 1fr; }
      .workflows-grid { grid-template-columns: 1fr; }
      .input-area { flex-direction: column; }
      .input-area select { width: 100%; }
      .stats { padding: 0.75rem; }
      .stat { padding: 0 0.5rem; }
      .stat-value { font-size: 1.25rem; }
    }
  </style>
</head>
<body>
  <main class="container">
    <h1>🤖 Pi-Browser Control</h1>

    <div class="tabs">
      <div role="group">
        <button class="active" onclick="showTab('tasks')">📋 작업</button>
        <button onclick="showTab('workflows')">🔄 워크플로우</button>
        <button onclick="showTab('settings')">⚙️ 설정</button>
      </div>
    </div>

    <!-- 작업 탭 -->
    <div id="tab-tasks" class="tab-content active">
      <div class="stats">
        <div class="stat">
          <div class="stat-value" id="totalTasks">0</div>
          <div class="stat-label">전체</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="runningTasks">0</div>
          <div class="stat-label">실행중</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="doneTasks">0</div>
          <div class="stat-label">완료</div>
        </div>
        <div class="stat">
          <div id="connectionStatus" class="disconnected">● 연결 안됨</div>
          <div class="stat-label">서버</div>
        </div>
        <div class="stat">
          <div id="extensionStatus" class="disconnected">● 꺼짐</div>
          <div class="stat-label">Extension</div>
        </div>
        <div class="stat">
          <div id="telegramStatus" class="disconnected">● 꺼짐</div>
          <div class="stat-label">텔레그램</div>
        </div>
      </div>

      <div class="input-area">
        <select id="taskProfile" style="width:200px;">
          <option value="">🔄 프로필 로딩...</option>
        </select>
        <input type="text" id="taskInput" placeholder="명령 입력 (예: 네이버에서 날씨 알려줘)" autocomplete="off" />
        <button onclick="addTask()">▶ 실행</button>
        <button class="danger" onclick="clearDone()">🗑 완료 삭제</button>
      </div>

      <div class="tasks-grid" id="tasksGrid"></div>
    </div>

    <!-- 워크플로우 탭 -->
    <div id="tab-workflows" class="tab-content">
      <div id="workflowAlert"></div>

      <!-- 워크플로우 목록 -->
      <div id="workflowList" class="settings-section">
        <h3>📁 저장된 워크플로우 <button class="btn-sm" onclick="createNewWorkflow()">+ 새로 만들기</button></h3>
        <div style="margin:15px 0;display:flex;align-items:center;gap:10px;">
          <label style="color:#888;">🖥️ 브라우저:</label>
          <select id="wfProfile" class="" style="max-width:300px;">
            <option value="">로딩 중...</option>
          </select>
        </div>
        <div id="workflowsGrid" class="workflows-grid"></div>
        <div id="noWorkflows" style="color:#666;padding:20px;text-align:center;display:none;">
          저장된 워크플로우가 없습니다. 새로 만들어보세요!
        </div>
      </div>

      <!-- 워크플로우 편집기 (숨김) -->
      <div id="workflowEditor" class="settings-section" style="display:none;">
        <h3 id="editorTitle">✏️ 워크플로우 편집</h3>

        <div class="form-group">
          <label>이름 *</label>
          <input type="text" id="wfName" placeholder="예: 네이버 메일 확인" />
        </div>

        <div class="form-group">
          <label>설명</label>
          <input type="text" id="wfDescription" placeholder="예: 로그인 후 안 읽은 메일 수 확인" />
        </div>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="wfEnabled" checked>
              <span class="toggle-slider"></span>
            </label>
            <span>활성화</span>
          </div>
        </div>

        <h4 style="color:#00d9ff;margin:20px 0 15px;">🤖 미션</h4>
        <div class="mission-section">
          <textarea id="wfMission" class="mission-input" placeholder="AI에게 시킬 작업을 자연어로 작성하세요. AI가 알아서 처리합니다.

예시:
• 쿠팡에 접속해서 최근 주문내역을 가져와줘
• 네이버 메일에 로그인해서 안 읽은 메일이 몇 개인지 알려줘
• 인스타그램에서 내 팔로워 수를 확인해줘
• 아마존에서 장바구니에 뭐가 있는지 알려줘
• 은행 사이트에서 계좌 잔액을 확인해줘"></textarea>
          <div style="display:flex;align-items:center;gap:10px;margin-top:8px;">
            <span style="color:#666;font-size:11px;">최대 턴 수:</span>
            <input type="number" id="wfMaxTurns" value="30" min="5" max="100" style="width:60px;padding:4px 8px;background:#222;border:1px solid #333;border-radius:4px;color:#fff;">
            <span style="color:#666;font-size:11px;">💡 AI가 자동으로 사이트 접속, 로그인 상태 확인, 정보 수집을 처리합니다.</span>
          </div>
        </div>

        <details class="steps-advanced" style="margin-top:20px;">
          <summary style="color:#888;cursor:pointer;">📋 고급: 단계별 실행 (선택사항)</summary>
          <div style="padding:15px 0;">
            <div id="stepsContainer"></div>
            <button class="btn-secondary btn-sm" onclick="addStep()">+ 단계 추가</button>
          </div>
        </details>

        <h4 style="color:#00d9ff;margin:20px 0 15px;">⏰ 스케줄</h4>
        <div class="schedule-section">
          <div class="schedule-row">
            <label class="toggle">
              <input type="checkbox" id="scheduleEnabled" onchange="updateSchedule()">
              <span class="toggle-slider"></span>
            </label>
            <span>자동 실행 활성화</span>
          </div>
          <div id="scheduleOptions" style="display:none;">
            <div class="schedule-row">
              <label>실행 주기</label>
              <select id="scheduleType" onchange="updateScheduleType()">
                <option value="interval">일정 간격</option>
                <option value="daily">매일</option>
                <option value="weekly">매주</option>
              </select>
            </div>
            <div id="intervalOptions" class="schedule-row">
              <label>간격</label>
              <input type="number" id="intervalMinutes" value="60" min="1" max="1440" style="width:80px;" onchange="updateSchedule()">
              <span>분마다</span>
            </div>
            <div id="dailyOptions" class="schedule-row" style="display:none;">
              <label>시간</label>
              <input type="time" id="scheduleTime" value="09:00" onchange="updateSchedule()">
            </div>
            <div id="weeklyOptions" class="schedule-row" style="display:none;">
              <label>요일</label>
              <select id="scheduleDayOfWeek" onchange="updateSchedule()">
                <option value="0">일요일</option>
                <option value="1">월요일</option>
                <option value="2">화요일</option>
                <option value="3">수요일</option>
                <option value="4">목요일</option>
                <option value="5">금요일</option>
                <option value="6">토요일</option>
              </select>
              <input type="time" id="scheduleTimeWeekly" value="09:00" onchange="updateSchedule()">
            </div>
          </div>
        </div>

        <div style="margin-top:20px;padding-top:20px;border-top:1px solid rgba(0,217,255,0.2);">
          <button class="" onclick="saveCurrentWorkflow()">💾 저장</button>
          <button class="success" onclick="testCurrentWorkflow()">▶ 테스트 실행</button>
          <button class="secondary" onclick="cancelEdit()">취소</button>
        </div>
      </div>

      <!-- 워크플로우 실행 로그 -->
      <div id="workflowRunLog" class="settings-section" style="display:none;">
        <div style="display:flex;gap:20px;">
          <!-- 왼쪽: 워크플로우 목록 -->
          <div style="min-width:200px;border-right:1px solid rgba(0,217,255,0.2);padding-right:15px;">
            <h4 style="color:#00d9ff;margin-bottom:10px;">📁 워크플로우</h4>
            <div id="runLogWorkflowList"></div>
            <button class="btn-secondary btn-sm" onclick="closeRunLog()" style="margin-top:15px;width:100%;">← 목록으로</button>
          </div>
          <!-- 오른쪽: 실행 로그 -->
          <div style="flex:1;">
            <h3 id="runLogTitle">📜 실행 로그</h3>
            <div id="runLogContent" class="task-log" style="max-height:500px;"></div>
            <div id="runLogResult" style="margin-top:15px;"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 설정 탭 -->
    <div id="tab-settings" class="tab-content">
      <div id="settingsAlert"></div>

      <div class="settings-section">
        <h3>🤖 텔레그램 봇</h3>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="telegramEnabled" onchange="updateTelegramToggle()">
              <span class="toggle-slider"></span>
            </label>
            <span>텔레그램 봇 활성화</span>
            <span id="telegramStatusBadge" class="status-badge stopped">중지됨</span>
          </div>
        </div>

        <div class="form-group">
          <label>Bot Token</label>
          <input type="text" id="telegramToken" placeholder="123456789:ABCdefGHI..." autocomplete="off" data-lpignore="true" style="-webkit-text-security:disc;" />
          <small>@BotFather에서 받은 토큰</small>
        </div>

        <div class="form-group">
          <label>허용된 사용자 ID (선택)</label>
          <input type="text" id="telegramUsers" placeholder="123456789, 987654321" />
          <small>⚠️ 필수! 비워두면 아무도 사용 불가. 여러 ID는 쉼표로 구분</small>
        </div>

        <div class="form-group">
          <label>Chrome 프로필 <button class="btn-sm" onclick="refreshProfiles()">🔄</button></label>
          <select id="telegramProfile" class="" style="max-width:500px;width:100%;">
            <option value="">🔄 로딩...</option>
          </select>
          <small>텔레그램에서 실행할 때 사용할 Chrome 프로필</small>
        </div>

        <button class="" onclick="saveTelegramSettings()">💾 저장</button>
        <button class="secondary" onclick="testTelegram()">🧪 테스트</button>
      </div>

      <div class="settings-section">
        <h3>🧠 AI 모델 <span id="aiStatusBadge" class="status-badge" style="display:none;"></span></h3>

        <div class="form-group">
          <label>Provider</label>
          <select id="aiProvider" class="" style="max-width:500px;width:100%;" onchange="toggleOllamaSettings(); requestAuthSourcePreview();">
            <option value="google">Google (Gemini)</option>
            <option value="openai">OpenAI (GPT)</option>
            <option value="openai-codex">OpenAI Codex (ChatGPT OAuth)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="groq">Groq</option>
            <option value="ollama">Ollama (로컬)</option>
          </select>
        </div>

        <div class="form-group">
          <label>Model</label>
          <select id="aiModel" class="" style="max-width:500px;width:100%;">
            <option value="gemini-2.0-flash">gemini-2.0-flash</option>
          </select>
        </div>

        <div class="form-group">
          <label>인증 소스</label>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span id="aiAuthSourceBadge" class="status-badge stopped">확인 필요</span>
            <span id="aiAuthSourceText" style="font-size:13px;color:#bbb;">저장된 설정 기준으로 자동 판별</span>
          </div>
          <small id="aiAuthSourceHint">Provider 기준으로 자동으로 인증 소스를 선택합니다.</small>
        </div>

        <div id="ollamaSettings" style="display:none;">
          <div class="form-group" style="background:rgba(255,165,0,0.2);padding:20px;border-radius:8px;margin-bottom:16px;border:2px solid #f90;">
            <h4 style="color:#f90;margin-bottom:15px;">🦙 Ollama 로컬 AI</h4>
            <div style="display:flex;align-items:center;gap:15px;margin-bottom:15px;flex-wrap:wrap;">
              <span id="ollamaStatusIcon" style="font-size:24px;">⚪</span>
              <span id="ollamaStatusText" style="color:#888;font-size:14px;">연결 상태 확인 필요</span>
              <button class="" onclick="testOllama()" style="padding:10px 20px;">🔌 연결 테스트</button>
            </div>
            <div style="margin-bottom:15px;">
              <label style="display:block;margin-bottom:5px;color:#aaa;">Ollama 서버 URL</label>
              <input type="text" id="ollamaUrl" value="http://localhost:11434" style="width:100%;max-width:400px;" />
            </div>
            <div>
              <label style="display:block;margin-bottom:5px;color:#aaa;">설치된 모델</label>
              <select id="ollamaModels" class="" style="max-width:400px;width:100%;" onchange="selectOllamaModel()">
                <option value="">🔌 연결 테스트를 먼저 하세요</option>
              </select>
            </div>
          </div>
        </div>

        <button class="" onclick="saveAISettings()">💾 저장</button>
      </div>

      <div class="settings-section">
        <h3>🌐 브라우저</h3>

        <div class="form-group">
          <label>실행 모드</label>
          <select id="browserMode" class="">
            <option value="cdp">🖥️ CDP 모드 (새 Chrome 실행)</option>
            <option value="extension">🔌 Extension 모드 (기존 Chrome 연결)</option>
          </select>
          <small>CDP: 새 브라우저 창 / Extension: 기존 브라우저에 확장 연결</small>
        </div>

        <div class="form-group">
          <label>Chrome 프로필 <button class="btn-sm" onclick="refreshProfiles()">🔄 새로고침</button></label>
          <select id="browserProfile" class="">
            <option value="">로딩 중...</option>
          </select>
          <small>로그인 상태, 쿠키, 확장 프로그램이 유지되는 프로필 선택</small>
        </div>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="browserReuse">
              <span class="toggle-slider"></span>
            </label>
            <span>기존 브라우저 재사용</span>
          </div>
          <small>활성화 시 이미 실행 중인 브라우저를 재사용합니다</small>
        </div>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="browserHeadless">
              <span class="toggle-slider"></span>
            </label>
            <span>Headless 모드</span>
          </div>
          <small>브라우저 창 없이 백그라운드 실행 (CDP 모드만)</small>
        </div>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="browserMultiProfile">
              <span class="toggle-slider"></span>
            </label>
            <span>멀티 프로필</span>
          </div>
          <small>각 작업마다 독립적인 프로필 사용</small>
        </div>

        <div class="form-group">
          <label>프로필 경로 (선택)</label>
          <input type="text" id="browserProfilePath" placeholder="~/.pi-browser/chrome-profile" />
          <small>Chrome 프로필 저장 위치 (로그인 상태 유지)</small>
        </div>

        <button class="" onclick="saveBrowserSettings()">💾 저장</button>
      </div>

      <div class="settings-section">
        <h3>🐞 디버깅</h3>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="debugLogs" onchange="updateDebugBadge()">
              <span class="toggle-slider"></span>
            </label>
            <span>상세 디버그 로그 (웹/텔레그램 공통)</span>
            <span id="debugBadge" class="status-badge stopped">OFF</span>
          </div>
          <small>[DEBUG] 로그를 작업 카드에 표시합니다.</small>
        </div>

        <button class="" onclick="saveDebugSettings()">💾 저장</button>
      </div>

      <div class="settings-section">
        <h3>📝 Notion 연동</h3>

        <div class="form-group">
          <div class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="notionEnabled" onchange="updateNotionToggle()">
              <span class="toggle-slider"></span>
            </label>
            <span>Notion 저장 활성화</span>
            <span id="notionStatusBadge" class="status-badge stopped">비활성</span>
          </div>
        </div>

        <div class="form-group">
          <label>Integration Token (API Key)</label>
          <input type="text" id="notionApiKey" placeholder="secret_xxxxxxxxxxxx..." autocomplete="off" data-lpignore="true" style="-webkit-text-security:disc;" />
          <small><a href="https://www.notion.so/my-integrations" target="_blank" style="color:#00d9ff;">notion.so/my-integrations</a>에서 발급</small>
        </div>

        <div class="form-group">
          <label>Database ID</label>
          <input type="text" id="notionDatabaseId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" />
          <small>노션 데이터베이스 URL에서 복사 (예: notion.so/[Database ID]?v=...)</small>
        </div>

        <button class="" onclick="saveNotionSettings()">💾 저장</button>
        <button class="secondary" onclick="testNotion()">🧪 연결 테스트</button>
        <button class="success" onclick="openNotion()">🔗 Notion 열기</button>
      </div>
    </div>
  </main>  <script>
    let ws;
    let tasks = new Map();
    let taskIdCounter = 0;
    let settings = {};
    let authSource = null;

    function showTab(tabId) {
      const btns = document.querySelectorAll('.tabs [role="group"] > button');
      btns.forEach(b => {
        if (b.getAttribute('onclick')?.includes(tabId)) {
          b.classList.add('active');
        } else {
          b.classList.remove('active');
        }
      });
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-' + tabId).classList.add('active');
    }

    function connect() {
      ws = new WebSocket('ws://' + location.host + '/ws');

      ws.onopen = () => {
        document.getElementById('connectionStatus').className = 'connected';
        document.getElementById('connectionStatus').textContent = '● 연결됨';
        ws.send(JSON.stringify({ type: 'getSettings' }));
        ws.send(JSON.stringify({ type: 'getProfiles' }));
        ws.send(JSON.stringify({ type: 'getTaskHistory', limit: 50 }));
        // 초기 모델 목록 표시
        toggleOllamaSettings();
      };

      ws.onclose = () => {
        document.getElementById('connectionStatus').className = 'disconnected';
        document.getElementById('connectionStatus').textContent = '● 연결 안됨';
        setTimeout(connect, 3000);
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      };
    }

    let profiles = [];

    function handleMessage(msg) {
      console.log('handleMessage:', msg.type);
      if (msg.type === 'settings') {
        settings = msg.settings || {};
        authSource = msg.authSource || null;
        applySettings();
        return;
      }

      if (msg.type === 'authSource') {
        authSource = msg.authSource || null;
        updateAuthSourceView(authSource);
        return;
      }

      if (msg.type === 'profiles') {
        profiles = msg.profiles || [];
        updateProfileSelect();
        return;
      }

      if (msg.type === 'taskHistory') {
        const historyTasks = msg.tasks || [];
        historyTasks.forEach((t) => {
          tasks.set(t.id, {
            id: t.id,
            mission: t.mission,
            source: 'web',
            status: t.status === 'completed' ? 'done' : t.status,
            logs: t.logs || [],
            result: t.result || null,
            profile: t.profile
          });
        });
        renderAllTaskCards();
        updateStats();
        return;
      }

      if (msg.type === 'telegramStatus') {
        updateTelegramStatus(msg.running);
        return;
      }

      if (msg.type === 'extensionStatus') {
        updateExtensionStatus(msg.connected);
        return;
      }

      if (msg.type === 'alert') {
        showAlert(msg.success, msg.message);
        return;
      }

      if (msg.type === 'ollamaStatus') {
        updateOllamaStatus(msg.connected, msg.message);
        if (msg.connected && msg.models) {
          updateOllamaModels(msg.models);
          showAlert(true, '✅ Ollama 연결 성공! ' + msg.models.length + '개 모델');
        } else if (!msg.connected) {
          showAlert(false, '❌ Ollama: ' + msg.message);
        }
        return;
      }

      // 텔레그램에서 새 작업 생성
      if (msg.type === 'newTask') {
        const task = {
          id: msg.taskId,
          mission: msg.mission,
          source: msg.source || 'telegram',
          status: 'running',
          logs: [],
          result: null
        };
        tasks.set(msg.taskId, task);
        renderTaskCard(task);
        updateStats();
        return;
      }

      const task = tasks.get(msg.taskId);
      if (!task) return;

      if (msg.type === 'log') {
        task.logs.push(msg.text);
        updateTaskCard(msg.taskId);
      } else if (msg.type === 'status') {
        task.status = msg.status;
        updateTaskCard(msg.taskId);
        updateStats();
      } else if (msg.type === 'result') {
        task.result = msg.text;
        task.status = 'done';
        updateTaskCard(msg.taskId);
        updateStats();
      } else if (msg.type === 'error') {
        task.logs.push('[ERROR] ' + msg.text);
        task.result = '❌ ' + msg.text;
        task.status = 'error';
        updateTaskCard(msg.taskId);
        updateStats();
      }
    }

    function applySettings() {
      const tgSettings = settings.telegram || {};
      document.getElementById('telegramEnabled').checked = tgSettings.enabled || false;
      document.getElementById('telegramToken').value = tgSettings.botToken || '';
      document.getElementById('telegramUsers').value = (tgSettings.allowedUsers || []).join(', ');
      const legacyTelegramDebugEnabled = tgSettings.debugLogs === true;
      const debugEnabled = settings.debugLogs === true || (settings.debugLogs === undefined && legacyTelegramDebugEnabled);
      document.getElementById('debugLogs').checked = debugEnabled;
      updateDebugBadge();

      if (tgSettings.profile) {
        setTimeout(() => {
          document.getElementById('telegramProfile').value = tgSettings.profile;
        }, 100);
      }

      if (settings.ai) {
        document.getElementById('aiProvider').value = settings.ai.provider || 'google';
        document.getElementById('ollamaUrl').value = settings.ai.ollamaUrl || 'http://localhost:11434';
        // 모델 목록 업데이트 후 값 설정
        toggleOllamaSettings();
        if (settings.ai.provider === 'ollama') {
          // Ollama는 연결 후 모델 목록 가져옴
          setTimeout(() => fetchOllamaModels(), 200);
        } else {
          // 다른 프로바이더는 저장된 모델이 유효한 경우에만 선택
          setTimeout(() => {
            const modelSelect = document.getElementById('aiModel');
            const savedModel = settings.ai.model;
            // 저장된 모델이 현재 프로바이더의 모델 목록에 있는지 확인
            if (savedModel && Array.from(modelSelect.options).some(o => o.value === savedModel)) {
              modelSelect.value = savedModel;
            }
            // 없으면 첫 번째 모델이 자동 선택됨
          }, 50);
        }
      }
      updateAuthSourceView(authSource);
      if (settings.browser) {
        document.getElementById('browserMode').value = settings.browser.mode || 'cdp';
        document.getElementById('browserReuse').checked = settings.browser.reuseExisting || false;
        document.getElementById('browserHeadless').checked = settings.browser.headless || false;
        document.getElementById('browserMultiProfile').checked = settings.browser.multiProfile || false;
        document.getElementById('browserProfilePath').value = settings.browser.profilePath || '';
        // 프로필 선택 (프로필 목록이 로드된 후 적용)
        if (settings.browser.selectedProfile) {
          setTimeout(() => {
            document.getElementById('browserProfile').value = settings.browser.selectedProfile;
          }, 100);
        }
      }
      if (settings.notion) {
        document.getElementById('notionEnabled').checked = settings.notion.enabled || false;
        document.getElementById('notionApiKey').value = settings.notion.apiKey || '';
        document.getElementById('notionDatabaseId').value = settings.notion.databaseId || '';
        updateNotionToggle();
      }
    }

    function updateProfileSelect() {
      // 설정 탭의 브라우저 프로필
      const browserSelect = document.getElementById('browserProfile');
      browserSelect.innerHTML = '';
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.displayName;
        browserSelect.appendChild(opt);
      });

      // 작업 탭의 프로필 선택기
      const taskSelect = document.getElementById('taskProfile');
      taskSelect.innerHTML = '';
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.displayName;
        taskSelect.appendChild(opt);
      });

      // 텔레그램 프로필 선택기
      const telegramSelect = document.getElementById('telegramProfile');
      telegramSelect.innerHTML = '';
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.displayName;
        telegramSelect.appendChild(opt);
      });

      // 워크플로우 프로필 선택기
      const wfSelect = document.getElementById('wfProfile');
      if (wfSelect) {
        wfSelect.innerHTML = '';
        profiles.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.path;
          opt.textContent = p.displayName;
          wfSelect.appendChild(opt);
        });
      }

      // 저장된 프로필 적용
      if (settings.browser?.selectedProfile) {
        browserSelect.value = settings.browser.selectedProfile;
        taskSelect.value = settings.browser.selectedProfile;
        if (wfSelect) wfSelect.value = settings.browser.selectedProfile;
      }
      if (settings.telegram?.profile) {
        telegramSelect.value = settings.telegram.profile;
      }
    }

    function refreshProfiles() {
      ws.send(JSON.stringify({ type: 'getProfiles' }));
    }

    function updateTelegramStatus(running) {
      const el = document.getElementById('telegramStatus');
      const badge = document.getElementById('telegramStatusBadge');
      if (running) {
        el.className = 'connected';
        el.textContent = '● 실행중';
        badge.className = 'status-badge running';
        badge.textContent = '실행중';
      } else {
        el.className = 'disconnected';
        el.textContent = '● 꺼짐';
        badge.className = 'status-badge stopped';
        badge.textContent = '중지됨';
      }
    }

    function updateDebugBadge() {
      const enabled = document.getElementById('debugLogs').checked;
      const badge = document.getElementById('debugBadge');
      badge.textContent = enabled ? 'ON' : 'OFF';
      badge.className = 'status-badge ' + (enabled ? 'running' : 'stopped');
    }

    function updateExtensionStatus(connected) {
      const el = document.getElementById('extensionStatus');
      if (connected) {
        el.className = 'connected';
        el.textContent = '● 연결됨';
      } else {
        el.className = 'disconnected';
        el.textContent = '● 꺼짐';
      }
    }

    function updateTelegramToggle() {
      const enabled = document.getElementById('telegramEnabled').checked;
      ws.send(JSON.stringify({ type: 'toggleTelegram', enabled }));
    }

    function saveTelegramSettings() {
      const token = document.getElementById('telegramToken').value.trim();
      const usersStr = document.getElementById('telegramUsers').value.trim();
      const users = usersStr ? usersStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [];
      const enabled = document.getElementById('telegramEnabled').checked;
      const profile = document.getElementById('telegramProfile').value;

      ws.send(JSON.stringify({
        type: 'saveTelegram',
        settings: { botToken: token, allowedUsers: users, enabled, profile }
      }));
    }

    function saveDebugSettings() {
      const enabled = document.getElementById('debugLogs').checked;
      ws.send(JSON.stringify({ type: 'saveDebug', enabled }));
    }

    function testTelegram() {
      const token = document.getElementById('telegramToken').value.trim();
      ws.send(JSON.stringify({ type: 'testTelegram', token }));
    }

    function saveAISettings() {
      const provider = document.getElementById('aiProvider').value;
      const model = document.getElementById('aiModel').value;
      const ollamaUrl = document.getElementById('ollamaUrl').value.trim() || 'http://localhost:11434';

      ws.send(JSON.stringify({
        type: 'saveAI',
        settings: { provider, model, ollamaUrl }
      }));
    }

    function requestAuthSourcePreview() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const provider = document.getElementById('aiProvider')?.value || settings.ai?.provider || 'google';
      ws.send(JSON.stringify({ type: 'getAuthSource', provider }));
    }

    function updateAuthSourceView(summary) {
      const badge = document.getElementById('aiAuthSourceBadge');
      const text = document.getElementById('aiAuthSourceText');
      const hint = document.getElementById('aiAuthSourceHint');
      if (!badge || !text || !hint) return;

      if (!summary) {
        badge.className = 'status-badge stopped';
        badge.textContent = '확인 필요';
        text.textContent = '인증 상태를 확인할 수 없습니다.';
        hint.textContent = 'Provider 기준으로 자동으로 인증 소스를 선택합니다.';
        return;
      }

      const statusClass = summary.status === 'ok' ? 'running' : (summary.status === 'warn' ? 'warning' : 'stopped');
      badge.className = 'status-badge ' + statusClass;
      badge.textContent = summary.source === 'none' ? '인증 필요' : '사용 중';
      text.textContent = summary.label || '인증 소스 미확인';
      hint.textContent = summary.warning || summary.detail || 'Provider 기준 자동 선택';
    }

    let providerModels = {};

    async function loadProviderModels() {
      try {
        const res = await fetch('/api/models');
        providerModels = await res.json();
        const provider = document.getElementById('aiProvider').value;
        if (provider && provider !== 'ollama') {
          updateModelDropdown(provider);
        }
      } catch (e) {
        console.error('모델 목록 로드 실패:', e);
      }
    }

    function updateModelDropdown(provider) {
      const modelSelect = document.getElementById('aiModel');
      const models = providerModels[provider] || [];
      const currentValue = modelSelect.value;
      modelSelect.innerHTML = '';
      models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      });
      if (currentValue && Array.from(modelSelect.options).some(o => o.value === currentValue)) {
        modelSelect.value = currentValue;
      }
    }

    loadProviderModels();

    function toggleOllamaSettings() {
      const provider = document.getElementById('aiProvider').value;
      const ollamaSettings = document.getElementById('ollamaSettings');
      const modelSelect = document.getElementById('aiModel');

      if (provider === 'ollama') {
        ollamaSettings.style.display = 'block';
        testOllama();
        modelSelect.innerHTML = '<option value="">🔌 Ollama 연결 후 선택...</option>';
      } else {
        ollamaSettings.style.display = 'none';
        updateModelDropdown(provider);
      }
    }

    function updateOllamaStatus(connected, message) {
      const icon = document.getElementById('ollamaStatusIcon');
      const text = document.getElementById('ollamaStatusText');
      if (connected) {
        icon.textContent = '🟢';
        text.textContent = message || '연결됨';
        text.style.color = '#2ecc71';
      } else {
        icon.textContent = '🔴';
        text.textContent = message || '연결 안됨';
        text.style.color = '#e74c3c';
      }
    }

    function testOllama() {
      const url = document.getElementById('ollamaUrl').value.trim() || 'http://localhost:11434';
      const icon = document.getElementById('ollamaStatusIcon');
      const text = document.getElementById('ollamaStatusText');

      icon.textContent = '🟡';
      text.textContent = '연결 중...';
      text.style.color = '#f39c12';

      ws.send(JSON.stringify({ type: 'testOllama', url }));
    }

    function updateOllamaModels(models) {
      const select = document.getElementById('ollamaModels');
      const modelSelect = document.getElementById('aiModel');
      const currentModel = settings.ai?.model || '';

      select.innerHTML = '';
      modelSelect.innerHTML = '';

      if (!models || models.length === 0) {
        select.innerHTML = '<option value="">설치된 모델 없음</option>';
        modelSelect.innerHTML = '<option value="">설치된 모델 없음</option>';
      } else {
        models.forEach(m => {
          // Ollama 모델 드롭다운
          const opt1 = document.createElement('option');
          opt1.value = m.name;
          opt1.textContent = m.name + (m.size ? ' (' + m.size + ')' : '');
          select.appendChild(opt1);

          // 메인 모델 드롭다운
          const opt2 = document.createElement('option');
          opt2.value = m.name;
          opt2.textContent = m.name + (m.size ? ' (' + m.size + ')' : '');
          modelSelect.appendChild(opt2);
        });

        // 현재 설정된 모델 선택
        if (currentModel && Array.from(select.options).some(o => o.value === currentModel)) {
          select.value = currentModel;
          modelSelect.value = currentModel;
        }
      }
    }

    function fetchOllamaModels() {
      testOllama();
    }

    function selectOllamaModel() {
      const modelSelect = document.getElementById('ollamaModels');
      const modelInput = document.getElementById('aiModel');
      if (modelSelect.value) {
        modelInput.value = modelSelect.value;
      }
    }

    function saveBrowserSettings() {
      const mode = document.getElementById('browserMode').value;
      const reuseExisting = document.getElementById('browserReuse').checked;
      const headless = document.getElementById('browserHeadless').checked;
      const multiProfile = document.getElementById('browserMultiProfile').checked;
      const profilePath = document.getElementById('browserProfilePath').value.trim();
      const selectedProfile = document.getElementById('browserProfile').value;

      ws.send(JSON.stringify({
        type: 'saveBrowser',
        settings: { mode, reuseExisting, headless, multiProfile, profilePath, selectedProfile }
      }));
    }

    function updateNotionToggle() {
      const enabled = document.getElementById('notionEnabled').checked;
      const badge = document.getElementById('notionStatusBadge');
      badge.textContent = enabled ? '활성' : '비활성';
      badge.className = 'status-badge ' + (enabled ? 'running' : 'stopped');
    }

    function saveNotionSettings() {
      const enabled = document.getElementById('notionEnabled').checked;
      const apiKey = document.getElementById('notionApiKey').value.trim();
      const databaseId = document.getElementById('notionDatabaseId').value.trim();

      if (enabled && (!apiKey || !databaseId)) {
        showAlert(false, 'API Key와 Database ID를 모두 입력하세요.');
        return;
      }

      ws.send(JSON.stringify({
        type: 'saveNotion',
        settings: { enabled, apiKey, databaseId }
      }));
    }

    function testNotion() {
      const apiKey = document.getElementById('notionApiKey').value.trim();
      const databaseId = document.getElementById('notionDatabaseId').value.trim();

      if (!apiKey || !databaseId) {
        showAlert(false, 'API Key와 Database ID를 입력하세요.');
        return;
      }

      ws.send(JSON.stringify({ type: 'testNotion', apiKey, databaseId }));
    }

    function openNotion() {
      const databaseId = document.getElementById('notionDatabaseId').value.trim();
      if (!databaseId) {
        showAlert(false, 'Database ID를 입력하세요.');
        return;
      }
      window.open('https://www.notion.so/' + databaseId.replace(/-/g, ''), '_blank');
    }

    function showAlert(success, message) {
      const el = document.getElementById('settingsAlert');
      el.innerHTML = \`<div class="alert \${success ? 'alert-success' : 'alert-error'}">\${message}</div>\`;
      setTimeout(() => el.innerHTML = '', 5000);
    }

    function addTask() {
      const input = document.getElementById('taskInput');
      const mission = input.value.trim();
      if (!mission) return;

      const profileSelect = document.getElementById('taskProfile');
      const selectedProfile = profileSelect.value;
      const profileName = profileSelect.options[profileSelect.selectedIndex]?.text || '';

      const taskId = 'task-' + (++taskIdCounter);
      const task = {
        id: taskId,
        mission: mission,
        profile: profileName,
        status: 'pending',
        logs: [],
        result: null
      };

      tasks.set(taskId, task);
      renderTaskCard(task);
      updateStats();

      ws.send(JSON.stringify({ type: 'run', taskId, mission, profile: selectedProfile }));
      input.value = '';
    }

    function renderTaskCard(task) {
      const grid = document.getElementById('tasksGrid');
      const card = document.createElement('div');
      card.className = 'task-card';
      card.id = 'card-' + task.id;
      card.innerHTML = getTaskCardHTML(task);
      grid.prepend(card);
    }

    function renderAllTaskCards() {
      const grid = document.getElementById('tasksGrid');
      grid.innerHTML = '';
      const sortedTasks = Array.from(tasks.values()).sort((a, b) => {
        const aTime = a.createdAt || 0;
        const bTime = b.createdAt || 0;
        return bTime - aTime;
      });
      sortedTasks.forEach(task => {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.id = 'card-' + task.id;
        card.innerHTML = getTaskCardHTML(task);
        grid.appendChild(card);
      });
    }

    function updateTaskCard(taskId) {
      const task = tasks.get(taskId);
      const card = document.getElementById('card-' + taskId);
      if (card && task) {
        card.innerHTML = getTaskCardHTML(task);
        const logEl = card.querySelector('.task-log');
        if (logEl && (task.status === 'running' || task.status === 'pending')) {
          requestAnimationFrame(() => {
            logEl.scrollTop = logEl.scrollHeight;
          });
        }
      }
    }

    function getTaskCardHTML(task) {
      const statusClass = 'status-' + task.status;
      const statusText = {pending:'대기중',running:'실행중',done:'완료',error:'에러',stopped:'중지됨'}[task.status] || task.status;
      const logs = task.logs.slice(-10).map(l => {
        if (l.includes('[TOOL]')) return '<span class="log-tool">' + escapeHtml(l) + '</span>';
        if (l.includes('[SUCCESS]')) return '<span class="log-success">' + escapeHtml(l) + '</span>';
        if (l.includes('[ERROR]')) return '<span class="log-error">' + escapeHtml(l) + '</span>';
        return escapeHtml(l);
      }).join('\\n');

      const isRunning = task.status === 'running' || task.status === 'pending';
      const isDone = task.status === 'done' || task.status === 'error' || task.status === 'stopped';
      const sourceIcon = task.source === 'telegram' ? '📱' : '🖥️';
      const profileBadge = task.profile ? \`<span style="color:#888;font-size:10px;margin-left:8px;">📁 \${task.profile}</span>\` : '';

      let html = \`
        <div class="task-header">
          <span class="task-id">\${sourceIcon} \${task.id}\${profileBadge}</span>
          <div class="task-actions">
            \${isRunning ? \`<button class="btn-stop" onclick="stopTask('\${task.id}')" title="중지">⏹</button>\` : ''}
            \${isDone ? \`<button class="btn-delete" onclick="deleteTask('\${task.id}')" title="삭제">🗑</button>\` : ''}
            <span class="task-status \${statusClass}">\${statusText}</span>
          </div>
        </div>
        <div class="task-mission">\${escapeHtml(task.mission)}</div>
        <div class="task-log">\${logs || '...'}</div>
      \`;

      if (task.result) {
        html += \`<div class="task-result">\${escapeHtml(task.result)}</div>\`;
      }

      return html;
    }

    function stopTask(taskId) {
      ws.send(JSON.stringify({ type: 'stopTask', taskId }));
      const task = tasks.get(taskId);
      if (task) {
        task.status = 'stopped';
        task.logs.push('[STOPPED] 사용자가 작업을 중지했습니다.');
        updateTaskCard(taskId);
        updateStats();
      }
    }

    function deleteTask(taskId) {
      ws.send(JSON.stringify({ type: 'deleteTask', taskId }));
      tasks.delete(taskId);
      const card = document.getElementById('card-' + taskId);
      if (card) card.remove();
      updateStats();
    }

    function escapeHtml(text) {
      return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function updateStats() {
      let total = 0, running = 0, done = 0;
      tasks.forEach(t => {
        total++;
        if (t.status === 'running' || t.status === 'pending') running++;
        if (t.status === 'done') done++;
      });
      document.getElementById('totalTasks').textContent = total;
      document.getElementById('runningTasks').textContent = running;
      document.getElementById('doneTasks').textContent = done;
    }

    function clearDone() {
      const toRemove = [];
      tasks.forEach((t, id) => {
        if (t.status === 'done' || t.status === 'error') {
          toRemove.push(id);
        }
      });
      toRemove.forEach(id => {
        tasks.delete(id);
        const card = document.getElementById('card-' + id);
        if (card) card.remove();
      });
      updateStats();
    }

    document.getElementById('taskInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') addTask();
    });

    // ============ 워크플로우 관련 ============
    let workflows = [];
    let currentWorkflow = null;
    let stepCounter = 0;

    function loadWorkflowList() {
      ws.send(JSON.stringify({ type: 'getWorkflows' }));
    }

    function renderWorkflows() {
      const grid = document.getElementById('workflowsGrid');
      const noWf = document.getElementById('noWorkflows');

      if (workflows.length === 0) {
        grid.innerHTML = '';
        noWf.style.display = 'block';
        return;
      }

      noWf.style.display = 'none';
      grid.innerHTML = workflows.map(wf => \`
        <div class="workflow-card \${wf.enabled ? '' : 'disabled'}">
          <div class="workflow-header">
            <span class="workflow-name">\${wf.enabled ? '●' : '○'} \${escapeHtml(wf.name)}</span>
            <div class="workflow-actions">
              <button class="" onclick="runWorkflow('\${wf.id}')" title="실행">▶</button>
              <button class="secondary" onclick="editWorkflow('\${wf.id}')" title="편집">✏️</button>
              <button class="danger" onclick="deleteWorkflowConfirm('\${wf.id}')" title="삭제">🗑</button>
            </div>
          </div>
          \${wf.description ? \`<div class="workflow-desc">\${escapeHtml(wf.description)}</div>\` : ''}
          <div class="workflow-meta">
            <span>📋 \${wf.steps?.length || 0}단계</span>
            <span>📅 \${new Date(wf.updatedAt).toLocaleDateString('ko-KR')}</span>
          </div>
        </div>
      \`).join('');
    }

    function createNewWorkflow() {
      currentWorkflow = {
        id: '',
        name: '',
        description: '',
        enabled: true,
        steps: []
      };
      stepCounter = 0;
      showEditor();
    }

    function editWorkflow(id) {
      const wf = workflows.find(w => w.id === id);
      if (!wf) return;
      currentWorkflow = JSON.parse(JSON.stringify(wf)); // Deep clone
      stepCounter = currentWorkflow.steps.length;
      showEditor();
    }

    function showEditor() {
      document.getElementById('workflowList').style.display = 'none';
      document.getElementById('workflowEditor').style.display = 'block';
      document.getElementById('workflowRunLog').style.display = 'none';

      document.getElementById('editorTitle').textContent = currentWorkflow.id ? '✏️ 워크플로우 편집' : '✨ 새 워크플로우';
      document.getElementById('wfName').value = currentWorkflow.name || '';
      document.getElementById('wfDescription').value = currentWorkflow.description || '';
      document.getElementById('wfEnabled').checked = currentWorkflow.enabled !== false;

      // 미션 로드
      document.getElementById('wfMission').value = currentWorkflow.mission || '';
      document.getElementById('wfMaxTurns').value = currentWorkflow.maxTurns || 30;

      // 스케줄 설정 로드
      const schedule = currentWorkflow.schedule || {};
      document.getElementById('scheduleEnabled').checked = schedule.enabled || false;
      document.getElementById('scheduleOptions').style.display = schedule.enabled ? 'block' : 'none';
      document.getElementById('scheduleType').value = schedule.type || 'interval';
      document.getElementById('intervalMinutes').value = schedule.intervalMinutes || 60;
      document.getElementById('scheduleTime').value = schedule.time || '09:00';
      document.getElementById('scheduleTimeWeekly').value = schedule.time || '09:00';
      document.getElementById('scheduleDayOfWeek').value = schedule.dayOfWeek || 1;
      updateScheduleType();

      renderSteps();
    }

    function cancelEdit() {
      currentWorkflow = null;
      document.getElementById('workflowList').style.display = 'block';
      document.getElementById('workflowEditor').style.display = 'none';
    }

    function updateSchedule() {
      const enabled = document.getElementById('scheduleEnabled').checked;
      document.getElementById('scheduleOptions').style.display = enabled ? 'block' : 'none';

      if (!currentWorkflow.schedule) currentWorkflow.schedule = {};
      currentWorkflow.schedule.enabled = enabled;
      currentWorkflow.schedule.type = document.getElementById('scheduleType').value;
      currentWorkflow.schedule.intervalMinutes = parseInt(document.getElementById('intervalMinutes').value) || 60;

      const scheduleType = currentWorkflow.schedule.type;
      if (scheduleType === 'daily') {
        currentWorkflow.schedule.time = document.getElementById('scheduleTime').value;
      } else if (scheduleType === 'weekly') {
        currentWorkflow.schedule.time = document.getElementById('scheduleTimeWeekly').value;
        currentWorkflow.schedule.dayOfWeek = parseInt(document.getElementById('scheduleDayOfWeek').value);
      }
    }

    function updateScheduleType() {
      const type = document.getElementById('scheduleType').value;
      document.getElementById('intervalOptions').style.display = type === 'interval' ? 'flex' : 'none';
      document.getElementById('dailyOptions').style.display = type === 'daily' ? 'flex' : 'none';
      document.getElementById('weeklyOptions').style.display = type === 'weekly' ? 'flex' : 'none';
      updateSchedule();
    }

    function renderSteps() {
      const container = document.getElementById('stepsContainer');
      if (!currentWorkflow.steps || currentWorkflow.steps.length === 0) {
        container.innerHTML = '<div style="color:#666;padding:15px;text-align:center;">단계가 없습니다. 아래 버튼을 눌러 추가하세요.</div>';
        return;
      }

      container.innerHTML = currentWorkflow.steps.map((step, idx) => {
        const stepOptions = getStepOptions(idx);
        const isFirst = idx === 0;
        const isLast = idx === currentWorkflow.steps.length - 1;
        return \`
          <div class="step-card" data-step-idx="\${idx}">
            <div class="step-controls">
              <button class="step-move" onclick="moveStep(\${idx}, -1)" \${isFirst ? 'disabled' : ''} title="위로">▲</button>
              <button class="step-move" onclick="moveStep(\${idx}, 1)" \${isLast ? 'disabled' : ''} title="아래로">▼</button>
              <button class="step-delete" onclick="deleteStep(\${idx})" title="삭제">×</button>
            </div>
            <div class="step-header">
              <span class="step-number">\${idx + 1}</span>
              <input type="text" value="\${escapeHtml(step.name || '')}" placeholder="단계 이름"
                     onchange="updateStep(\${idx}, 'name', this.value)" style="flex:1;margin-left:10px;font-weight:bold;" />
            </div>

            <div class="prompt-container">
              <textarea class="prompt-input" placeholder="AI에게 시킬 작업을 자연어로 작성하세요.

예시:
• https://naver.com 에 접속해
• 검색창에 '오늘 날씨'를 입력하고 검색 버튼을 클릭해
• 로그인 버튼을 찾아서 클릭해
• 페이지에서 가격 정보를 찾아서 알려줘
• 스크롤을 내려서 더보기 버튼을 클릭해"
                        onchange="updateStep(\${idx}, 'prompt', this.value)">\${escapeHtml(step.prompt || '')}</textarea>
            </div>

            <details class="advanced-options">
              <summary>고급 옵션</summary>
              <div class="step-row">
                <label>성공 시</label>
                <select onchange="updateStep(\${idx}, 'onSuccess', this.value)">
                  <option value="next" \${step.onSuccess === 'next' ? 'selected' : ''}>다음 단계로</option>
                  <option value="end" \${step.onSuccess === 'end' ? 'selected' : ''}>워크플로우 종료</option>
                  \${stepOptions}
                </select>
              </div>
              <div class="step-row">
                <label>실패 시</label>
                <select onchange="updateStep(\${idx}, 'onFailure', this.value)">
                  <option value="end" \${step.onFailure === 'end' ? 'selected' : ''}>워크플로우 종료</option>
                  <option value="retry" \${step.onFailure === 'retry' ? 'selected' : ''}>재시도</option>
                  <option value="next" \${step.onFailure === 'next' ? 'selected' : ''}>다음 단계로</option>
                  \${stepOptions}
                </select>
                \${step.onFailure === 'retry' ? \`
                  <input type="number" value="\${step.retryCount || 2}" min="1" max="5" style="width:50px;margin-left:5px;"
                         onchange="updateStep(\${idx}, 'retryCount', parseInt(this.value))" title="재시도 횟수" />회
                \` : ''}
              </div>
            </details>
          </div>
        \`;
      }).join('');
    }

    function getStepOptions(currentIdx) {
      return currentWorkflow.steps.map((s, i) => {
        if (i === currentIdx) return '';
        const selected = currentWorkflow.steps[currentIdx]?.onSuccess === s.id ||
                        currentWorkflow.steps[currentIdx]?.onFailure === s.id ? 'selected' : '';
        return \`<option value="\${s.id}" \${selected}>→ \${i + 1}. \${escapeHtml(s.name || '(이름없음)')}</option>\`;
      }).join('');
    }

    function addStep() {
      if (!currentWorkflow.steps) currentWorkflow.steps = [];
      const newStep = {
        id: 'step-' + Date.now() + '-' + (++stepCounter),
        name: '단계 ' + (currentWorkflow.steps.length + 1),
        prompt: '',
        onSuccess: 'next',
        onFailure: 'end'
      };
      currentWorkflow.steps.push(newStep);
      renderSteps();
    }

    function deleteStep(idx) {
      if (confirm('이 단계를 삭제하시겠습니까?')) {
        currentWorkflow.steps.splice(idx, 1);
        renderSteps();
      }
    }

    function moveStep(idx, direction) {
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= currentWorkflow.steps.length) return;
      const temp = currentWorkflow.steps[idx];
      currentWorkflow.steps[idx] = currentWorkflow.steps[newIdx];
      currentWorkflow.steps[newIdx] = temp;
      renderSteps();
    }

    function updateStep(idx, field, value) {
      currentWorkflow.steps[idx][field] = value;
    }

    function saveCurrentWorkflow() {
      const name = document.getElementById('wfName').value.trim();
      if (!name) {
        showWorkflowAlert(false, '이름을 입력하세요.');
        return;
      }

      currentWorkflow.name = name;
      currentWorkflow.description = document.getElementById('wfDescription').value.trim();
      currentWorkflow.enabled = document.getElementById('wfEnabled').checked;
      currentWorkflow.mission = document.getElementById('wfMission').value.trim();
      currentWorkflow.maxTurns = parseInt(document.getElementById('wfMaxTurns').value) || 30;

      ws.send(JSON.stringify({
        type: 'saveWorkflow',
        workflow: currentWorkflow
      }));
    }

    function testCurrentWorkflow() {
      const mission = document.getElementById('wfMission').value.trim();
      const hasSteps = currentWorkflow && currentWorkflow.steps && currentWorkflow.steps.length > 0;

      if (!mission && !hasSteps) {
        showWorkflowAlert(false, '미션 또는 단계를 입력하세요.');
        return;
      }

      // 먼저 저장
      const name = document.getElementById('wfName').value.trim();
      if (!name) {
        showWorkflowAlert(false, '이름을 입력하고 저장 후 실행하세요.');
        return;
      }

      currentWorkflow.name = name;
      currentWorkflow.description = document.getElementById('wfDescription').value.trim();
      currentWorkflow.enabled = document.getElementById('wfEnabled').checked;
      currentWorkflow.mission = mission;
      currentWorkflow.maxTurns = parseInt(document.getElementById('wfMaxTurns').value) || 30;

      // 저장 후 실행
      ws.send(JSON.stringify({
        type: 'saveWorkflow',
        workflow: currentWorkflow,
        runAfterSave: true
      }));
    }

    let runningWorkflowId = null;

    function runWorkflow(id) {
      const profileSelect = document.getElementById('wfProfile');
      const profile = profileSelect ? profileSelect.value : '';

      runningWorkflowId = id;
      const wf = workflows.find(w => w.id === id);

      document.getElementById('workflowList').style.display = 'none';
      document.getElementById('workflowEditor').style.display = 'none';
      document.getElementById('workflowRunLog').style.display = 'block';
      document.getElementById('runLogTitle').textContent = '📜 ' + (wf?.name || '실행 로그');
      document.getElementById('runLogContent').innerHTML = '워크플로우 실행 중...\\n';
      document.getElementById('runLogResult').innerHTML = '';

      // 왼쪽 워크플로우 목록 업데이트
      updateRunLogWorkflowList();

      ws.send(JSON.stringify({ type: 'runWorkflow', workflowId: id, profile: profile }));
    }

    function updateRunLogWorkflowList() {
      const container = document.getElementById('runLogWorkflowList');
      if (!container) return;

      container.innerHTML = workflows.map(wf => {
        const isRunning = wf.id === runningWorkflowId;
        return \`
          <div class="run-log-wf-item \${isRunning ? 'active' : ''}" onclick="\${isRunning ? '' : 'runWorkflow(\\'' + wf.id + '\\')'}">
            <span class="run-log-wf-status">\${isRunning ? '🔄' : '▶'}</span>
            <span class="run-log-wf-name">\${escapeHtml(wf.name)}</span>
          </div>
        \`;
      }).join('');
    }

    function closeRunLog() {
      runningWorkflowId = null;
      document.getElementById('workflowRunLog').style.display = 'none';
      document.getElementById('workflowList').style.display = 'block';
    }

    function deleteWorkflowConfirm(id) {
      if (confirm('이 워크플로우를 삭제하시겠습니까?')) {
        ws.send(JSON.stringify({ type: 'deleteWorkflow', workflowId: id }));
      }
    }

    function showWorkflowAlert(success, message) {
      const el = document.getElementById('workflowAlert');
      el.innerHTML = \`<div class="alert \${success ? 'alert-success' : 'alert-error'}">\${message}</div>\`;
      setTimeout(() => el.innerHTML = '', 5000);
    }

    // 워크플로우 메시지 핸들러 확장
    const origHandleMessage = handleMessage;
    handleMessage = function(msg) {
      if (msg.type === 'workflows') {
        workflows = msg.workflows || [];
        renderWorkflows();
        return;
      }
      if (msg.type === 'workflowSaved') {
        showWorkflowAlert(true, '워크플로우가 저장되었습니다.');
        if (msg.workflow) {
          currentWorkflow = msg.workflow;
        }
        loadWorkflowList();
        if (msg.runAfterSave && currentWorkflow?.id) {
          runWorkflow(currentWorkflow.id);
        }
        return;
      }
      if (msg.type === 'workflowDeleted') {
        showWorkflowAlert(true, '워크플로우가 삭제되었습니다.');
        loadWorkflowList();
        return;
      }
      if (msg.type === 'workflowLog') {
        const logEl = document.getElementById('runLogContent');
        const typeClass = msg.logType === 'error' ? 'log-error' : msg.logType === 'success' ? 'log-success' : '';
        logEl.innerHTML += \`<span class="\${typeClass}">[\${msg.stepName || 'workflow'}] \${escapeHtml(msg.message)}</span>\\n\`;
        logEl.scrollTop = logEl.scrollHeight;
        return;
      }
      if (msg.type === 'workflowResult') {
        runningWorkflowId = null;
        updateRunLogWorkflowList();
        const resultEl = document.getElementById('runLogResult');
        if (msg.success) {
          resultEl.innerHTML = \`<div class="task-result">✅ 완료! \${msg.stepsExecuted}단계 실행 (\${((msg.endTime - msg.startTime) / 1000).toFixed(1)}초)</div>\`;
        } else {
          resultEl.innerHTML = \`<div class="task-result" style="background:rgba(231,76,60,0.1);border-color:rgba(231,76,60,0.3);color:#e74c3c;">❌ 실패: \${escapeHtml(msg.error || '알 수 없는 오류')}</div>\`;
        }
        return;
      }
      if (msg.type === 'workflowError') {
        showWorkflowAlert(false, msg.message);
        return;
      }
      origHandleMessage(msg);
    };

    // 탭 변경 시 워크플로우 로드
    const origShowTab = showTab;
    showTab = function(tabId) {
      origShowTab(tabId);
      if (tabId === 'workflows') {
        loadWorkflowList();
      }
    };

    connect();
  </script>
</body>
</html>`;

export interface WebClientConfig {
  port: number;
  onTask: (taskId: string, mission: string, send: (msg: any) => void, profile?: string) => Promise<void>;
  onTelegramStart?: (token: string, allowedUsers: number[]) => Promise<void>;
  onTelegramStop?: () => void;
  onSettingsChange?: (settings: Settings) => void;
  getProfiles?: () => ChromeProfile[];
  isExtensionConnected?: () => boolean;
  onWorkflowRun?: (workflow: Workflow, send: (msg: any) => void, profile?: string) => Promise<void>;
}

// 중지된 작업 추적
export const stoppedTasks = new Set<string>();

// 연결된 WebSocket 클라이언트들
let connectedClients: Set<WebSocket> = new Set();

// 모든 클라이언트에게 브로드캐스트
export function broadcastToClients(msg: any): void {
  const data = JSON.stringify(msg);
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Notion에 결과 저장
export async function saveResultToNotion(
  taskId: string,
  mission: string,
  result: string
): Promise<{ success: boolean; message: string }> {
  const settings = loadSettings();

  if (!settings.notion?.enabled) {
    return { success: false, message: "Notion 저장이 비활성화되어 있습니다" };
  }

  const { apiKey, databaseId } = settings.notion;
  if (!apiKey || !databaseId) {
    return { success: false, message: "Notion API Key 또는 Database ID가 없습니다" };
  }

  try {
    // 먼저 데이터베이스 스키마 가져오기
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28"
      }
    });

    if (!dbRes.ok) {
      const err = await dbRes.json() as { message?: string };
      return { success: false, message: `데이터베이스 조회 실패: ${err.message || dbRes.status}` };
    }

    const dbData = await dbRes.json() as { properties?: Record<string, unknown> };
    const properties = dbData.properties || {};

    // title 타입 속성 찾기
    let titlePropName = "Name";
    for (const [name, prop] of Object.entries(properties)) {
      if ((prop as any).type === "title") {
        titlePropName = name;
        break;
      }
    }

    // 페이지 속성 구성 (제목만 필수, 나머지는 있으면 추가)
    const pageProps: Record<string, any> = {
      [titlePropName]: {
        title: [{ text: { content: `[${taskId}] ${mission.slice(0, 80)}` } }]
      }
    };

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: pageProps,
        children: [
          {
            object: "block",
            type: "heading_2",
            heading_2: {
              rich_text: [{ text: { content: "📋 작업" } }]
            }
          },
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ text: { content: mission } }]
            }
          },
          {
            object: "block",
            type: "heading_2",
            heading_2: {
              rich_text: [{ text: { content: "✅ 결과" } }]
            }
          },
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ text: { content: result.slice(0, 2000) } }]
            }
          },
          {
            object: "block",
            type: "divider",
            divider: {}
          },
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ text: { content: `⏰ ${new Date().toLocaleString("ko-KR")}` } }]
            }
          }
        ]
      })
    });

    if (res.ok) {
      console.log(`[Notion] 결과 저장 완료: ${taskId}`);
      return { success: true, message: "Notion에 저장되었습니다" };
    } else {
      const err = await res.json() as { message?: string };
      console.error(`[Notion] 저장 실패:`, err);
      return { success: false, message: `Notion 저장 실패: ${err.message || res.status}` };
    }
  } catch (e) {
    console.error(`[Notion] 저장 오류:`, e);
    return { success: false, message: `Notion 저장 오류: ${(e as Error).message}` };
  }
}

export function startWebClient(config: WebClientConfig): Promise<{ settings: Settings; port: number }> {
  return new Promise((resolve, reject) => {
    const { port, onTask, onTelegramStart, onTelegramStop, onSettingsChange, getProfiles, isExtensionConnected } = config;
    let settings = loadSettings();
    settings.ai = sanitizeAiSettings(settings.ai);
    saveSettings(settings);
    let telegramRunning = false;

    const getActiveProvider = (overrideProvider?: string): string => {
      return overrideProvider || settings.ai?.provider || "google";
    };

    const getActiveAuthSource = (overrideProvider?: string): AuthSourceSummary => {
      const provider = getActiveProvider(overrideProvider);
      return getAuthSourceSummary(provider, provider === "ollama");
    };

    const sendSettingsMessage = (target: WebSocket): void => {
      if (target.readyState !== WebSocket.OPEN) return;
      target.send(JSON.stringify({
        type: "settings",
        settings,
        authSource: getActiveAuthSource(),
      }));
    };

    const server = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HTML_PAGE);
      } else if (req.url === "/api/models") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(buildProviderModels()));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    const wss = new WebSocketServer({ server, path: "/ws" });

    wss.on("connection", (ws) => {
      console.log("[WebClient] 클라이언트 연결됨");
      connectedClients.add(ws);

      // 초기 설정 전송
      sendSettingsMessage(ws);
      ws.send(JSON.stringify({ type: "telegramStatus", running: telegramRunning }));
      if (isExtensionConnected) {
        ws.send(JSON.stringify({ type: "extensionStatus", connected: isExtensionConnected() }));
      }

      ws.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === "getSettings") {
            sendSettingsMessage(ws);
            ws.send(JSON.stringify({ type: "telegramStatus", running: telegramRunning }));
          }

          else if (msg.type === "getAuthSource") {
            const provider = typeof msg.provider === "string" ? msg.provider : undefined;
            ws.send(JSON.stringify({
              type: "authSource",
              authSource: getActiveAuthSource(provider),
            }));
          }

          else if (msg.type === "getProfiles") {
            const profiles = getProfiles?.() || [];
            ws.send(JSON.stringify({ type: "profiles", profiles }));
          }

          else if (msg.type === "getTaskHistory") {
            const limit = typeof msg.limit === "number" ? msg.limit : 50;
            const tasks = loadTasks(limit);
            ws.send(JSON.stringify({ type: "taskHistory", tasks }));
          }

          else if (msg.type === "saveTelegram") {
            const incomingTelegram = msg.settings || {};
            const { debugLogs: legacyDebugLogs, ...telegramSettings } = incomingTelegram;
            settings.telegram = telegramSettings;
            if (settings.debugLogs === undefined && typeof legacyDebugLogs === "boolean") {
              settings.debugLogs = legacyDebugLogs;
            }
            saveSettings(settings);
            onSettingsChange?.(settings);
            sendSettingsMessage(ws);
            ws.send(JSON.stringify({ type: "alert", success: true, message: "텔레그램 설정이 저장되었습니다." }));
          }

          else if (msg.type === "saveDebug") {
            settings.debugLogs = msg.enabled === true;
            saveSettings(settings);
            onSettingsChange?.(settings);
            sendSettingsMessage(ws);
            ws.send(JSON.stringify({ type: "alert", success: true, message: "디버그 설정이 저장되었습니다." }));
          }

          else if (msg.type === "toggleTelegram") {
            const enabled = msg.enabled;
            if (enabled && settings.telegram?.botToken) {
              try {
                await onTelegramStart?.(
                  settings.telegram.botToken,
                  settings.telegram.allowedUsers || []
                );
                telegramRunning = true;
                settings.telegram.enabled = true;
                saveSettings(settings);
              } catch (err) {
                ws.send(JSON.stringify({ type: "alert", success: false, message: `텔레그램 시작 실패: ${(err as Error).message}` }));
                telegramRunning = false;
              }
            } else if (!enabled) {
              onTelegramStop?.();
              telegramRunning = false;
              if (settings.telegram) {
                settings.telegram.enabled = false;
                saveSettings(settings);
              }
            } else {
              ws.send(JSON.stringify({ type: "alert", success: false, message: "Bot Token을 먼저 설정하세요." }));
            }
            // 상태 브로드캐스트
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: "telegramStatus", running: telegramRunning }));
              }
            });
          }

          else if (msg.type === "testTelegram") {
            const testToken = msg.token || settings.telegram?.botToken;
            if (!testToken) {
              ws.send(JSON.stringify({ type: "alert", success: false, message: "Bot Token을 입력하세요." }));
            } else {
              try {
                const res = await fetch(`https://api.telegram.org/bot${testToken}/getMe`);
                const data = await res.json() as {
                  ok?: boolean;
                  result?: { username?: string };
                  description?: string;
                };
                if (data.ok) {
                  const username = data.result?.username || "unknown";
                  ws.send(JSON.stringify({ type: "alert", success: true, message: `✅ 연결 성공! 봇: @${username}` }));
                } else {
                  ws.send(JSON.stringify({ type: "alert", success: false, message: `❌ 연결 실패: ${data.description}` }));
                }
              } catch (err) {
                ws.send(JSON.stringify({ type: "alert", success: false, message: `❌ 연결 실패: ${(err as Error).message}` }));
              }
            }
          }

          else if (msg.type === "testOllama") {
            const url = msg.url || "http://localhost:11434";
            try {
              const res = await fetch(url + "/api/tags");
              if (res.ok) {
                const data = await res.json() as { models?: Array<{ name?: string; size?: number }> };
                const models = Array.isArray(data.models) ? data.models : [];
                ws.send(JSON.stringify({
                  type: "ollamaStatus",
                  connected: true,
                  models: models.map((m) => ({
                    name: m.name,
                    size: m.size ? (m.size / 1024 / 1024 / 1024).toFixed(1) + "GB" : ""
                  })),
                  message: `연결됨 (${models.length}개 모델)`
                }));
              } else {
                ws.send(JSON.stringify({ type: "ollamaStatus", connected: false, message: "응답 오류: " + res.status }));
              }
            } catch (err) {
              ws.send(JSON.stringify({ type: "ollamaStatus", connected: false, message: "연결 실패: " + (err as Error).message }));
            }
          }

          else if (msg.type === "saveAI") {
            settings.ai = sanitizeAiSettings(msg.settings);
            saveSettings(settings);
            onSettingsChange?.(settings);
            sendSettingsMessage(ws);
            ws.send(JSON.stringify({ type: "alert", success: true, message: "AI 설정이 저장되었습니다." }));
          }

          else if (msg.type === "saveBrowser") {
            settings.browser = msg.settings;
            saveSettings(settings);
            onSettingsChange?.(settings);
            sendSettingsMessage(ws);
            ws.send(JSON.stringify({ type: "alert", success: true, message: "브라우저 설정이 저장되었습니다." }));
          }

          else if (msg.type === "saveNotion") {
            settings.notion = msg.settings;
            saveSettings(settings);
            onSettingsChange?.(settings);
            sendSettingsMessage(ws);
            ws.send(JSON.stringify({ type: "alert", success: true, message: "Notion 설정이 저장되었습니다." }));
          }

          else if (msg.type === "testNotion") {
            const { apiKey, databaseId } = msg;
            try {
              const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
                method: "GET",
                headers: {
                  "Authorization": `Bearer ${apiKey}`,
                  "Notion-Version": "2022-06-28"
                }
              });
              if (res.ok) {
                const data = await res.json() as { title?: Array<{ plain_text?: string }> };
                ws.send(JSON.stringify({
                  type: "alert",
                  success: true,
                  message: `Notion 연결 성공! 데이터베이스: ${data.title?.[0]?.plain_text || databaseId}`
                }));
              } else {
                const err = await res.json() as { message?: string };
                ws.send(JSON.stringify({
                  type: "alert",
                  success: false,
                  message: `Notion 연결 실패: ${err.message || res.status}`
                }));
              }
            } catch (e) {
              ws.send(JSON.stringify({ type: "alert", success: false, message: `Notion 연결 오류: ${(e as Error).message}` }));
            }
          }

          else if (msg.type === "stopTask") {
            const { taskId } = msg;
            console.log(`[WebClient] 작업 중지: ${taskId}`);
            stoppedTasks.add(taskId);
          }

          else if (msg.type === "deleteTask") {
            const { taskId } = msg;
            console.log(`[WebClient] 작업 삭제: ${taskId}`);
            stoppedTasks.delete(taskId);
            deleteStoredTask(taskId);
          }

          else if (msg.type === "run") {
            const { taskId, mission, profile } = msg;
            console.log(`[WebClient] 작업 시작: ${taskId} - ${mission} (프로필: ${profile || '기본'})`);

            saveTask({
              id: taskId,
              mission,
              status: "running",
              profile,
              createdAt: Date.now(),
            });

            const send = (m: any) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ taskId, ...m }));
              }
              if (m.type === "status" && m.status === "completed") {
                saveTask({
                  id: taskId,
                  mission,
                  status: "completed",
                  profile,
                  createdAt: Date.now(),
                  completedAt: Date.now(),
                  result: m.result,
                });
              } else if (m.type === "error") {
                saveTask({
                  id: taskId,
                  mission,
                  status: "error",
                  profile,
                  createdAt: Date.now(),
                  completedAt: Date.now(),
                  result: m.text,
                });
              }
            };

            send({ type: "status", status: "running" });

            try {
              await onTask(taskId, mission, send, profile);
            } catch (error) {
              send({ type: "error", text: (error as Error).message });
            }
          }

          // ============ 워크플로우 핸들러 ============
          else if (msg.type === "getWorkflows") {
            const workflows = loadWorkflows();
            ws.send(JSON.stringify({ type: "workflows", workflows }));
          }

          else if (msg.type === "saveWorkflow") {
            const wfData = msg.workflow as Workflow;
            if (!wfData.id) {
              wfData.id = generateWorkflowId();
              wfData.createdAt = Date.now();
            }
            wfData.updatedAt = Date.now();
            saveWorkflow(wfData);
            ws.send(JSON.stringify({
              type: "workflowSaved",
              workflow: wfData,
              runAfterSave: msg.runAfterSave
            }));
          }

          else if (msg.type === "deleteWorkflow") {
            const { workflowId } = msg;
            const deleted = deleteWorkflow(workflowId);
            if (deleted) {
              ws.send(JSON.stringify({ type: "workflowDeleted", workflowId }));
            } else {
              ws.send(JSON.stringify({ type: "workflowError", message: "워크플로우를 삭제할 수 없습니다." }));
            }
          }

          else if (msg.type === "runWorkflow") {
            const { workflowId, profile } = msg;
            const workflow = loadWorkflow(workflowId);

            if (!workflow) {
              ws.send(JSON.stringify({ type: "workflowError", message: "워크플로우를 찾을 수 없습니다." }));
              return;
            }

            console.log(`[WebClient] 워크플로우 실행: ${workflow.name} (${workflowId}) 프로필: ${profile || '기본'}`);

            const send = (m: any) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(m));
              }
            };

            if (config.onWorkflowRun) {
              try {
                await config.onWorkflowRun(workflow, send, profile);
              } catch (error) {
                send({
                  type: "workflowResult",
                  success: false,
                  error: (error as Error).message,
                  stepsExecuted: 0,
                  startTime: Date.now(),
                  endTime: Date.now()
                });
              }
            } else {
              send({ type: "workflowError", message: "워크플로우 실행 기능이 설정되지 않았습니다." });
            }
          }
        } catch (e) {
          console.error("[WebClient] 메시지 처리 에러:", e);
        }
      });

      ws.on("close", () => {
        console.log("[WebClient] 클라이언트 연결 해제");
        connectedClients.delete(ws);
      });
    });

    const startServer = (listenPort: number, allowFallback: boolean): void => {
      const onListenError = (error: NodeJS.ErrnoException): void => {
        server.off("error", onListenError);

        if (error.code === "EADDRINUSE" && allowFallback) {
          console.warn(`[WebClient] 포트 ${listenPort} 사용 중, 다른 포트로 재시도합니다.`);
          startServer(0, false);
          return;
        }

        reject(error);
      };

      server.once("error", onListenError);

      server.listen(listenPort, async () => {
        server.off("error", onListenError);

        const address = server.address();
        const actualPort = typeof address === "object" && address ? address.port : listenPort;
        console.log(`[WebClient] 웹 UI: http://localhost:${actualPort}`);

        // 설정에서 텔레그램이 활성화되어 있으면 자동 시작
        if (settings.telegram?.enabled && settings.telegram?.botToken && onTelegramStart) {
          try {
            console.log("[WebClient] 텔레그램 봇 자동 시작 중...");
            await onTelegramStart(settings.telegram.botToken, settings.telegram.allowedUsers || []);
            telegramRunning = true;
            console.log("[WebClient] 텔레그램 봇 시작됨");
          } catch (err) {
            console.error("[WebClient] 텔레그램 봇 시작 실패:", (err as Error).message);
          }
        }

        resolve({ settings, port: actualPort });
      });
    };

    startServer(port, true);
  });
}

// 직접 실행 시 서버 시작
if (import.meta.url === `file://${process.argv[1]}`) {
  startWebClient({
    port: 3000,
    onTask: async () => {},
    getProfiles: () => scanChromeProfiles(),
    isExtensionConnected: () => false,
  }).catch(console.error);
}
