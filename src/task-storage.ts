import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TASKS_DIR = path.join(os.homedir(), ".pi-browser", "tasks");
const MAX_TASKS = 100;

export interface StoredTask {
  id: string;
  mission: string;
  status: "pending" | "running" | "completed" | "error";
  result?: string;
  logs?: string[];
  createdAt: number;
  completedAt?: number;
  profile?: string;
}

function ensureTasksDir(): void {
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }
}

function getTaskPath(id: string): string {
  return path.join(TASKS_DIR, `${id}.json`);
}

export function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function loadTasks(limit?: number): StoredTask[] {
  ensureTasksDir();

  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json"));
  const tasks: StoredTask[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(TASKS_DIR, file), "utf-8");
      tasks.push(JSON.parse(content) as StoredTask);
    } catch (error) {
      console.error(`Failed to load task from ${file}:`, error);
    }
  }

  const sorted = tasks.sort((a, b) => b.createdAt - a.createdAt);
  return limit ? sorted.slice(0, limit) : sorted;
}

export function loadTask(id: string): StoredTask | null {
  const filePath = getTaskPath(id);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as StoredTask;
  } catch (error) {
    console.error(`Failed to load task ${id}:`, error);
    return null;
  }
}

export function saveTask(task: StoredTask): void {
  ensureTasksDir();
  const filePath = getTaskPath(task.id);
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
  cleanupOldTasks();
}

export function updateTask(id: string, updates: Partial<StoredTask>): StoredTask | null {
  const task = loadTask(id);
  if (!task) return null;

  const updated = { ...task, ...updates };
  saveTask(updated);
  return updated;
}

export function deleteTask(id: string): boolean {
  const filePath = getTaskPath(id);

  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    console.error(`Failed to delete task ${id}:`, error);
    return false;
  }
}

function cleanupOldTasks(): void {
  const tasks = loadTasks();
  if (tasks.length > MAX_TASKS) {
    const toDelete = tasks.slice(MAX_TASKS);
    for (const task of toDelete) {
      deleteTask(task.id);
    }
  }
}
