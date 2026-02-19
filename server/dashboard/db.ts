import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { DashboardData, SourceStatus } from "./types";
import { seedData } from "./seed";

const dbPath = path.join(process.cwd(), "data", "dashboard.db");
let sqlite: Database.Database;

const EMPTY: DashboardData = {
  tasks: [], metrics: [], properties: [], rehab: [], occupancy: [], kpis: [], debt: [], growth: [], activity: [], freshness: [], diagnostics: [],
};

function init() {
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS store (table_name TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_status (
      source TEXT PRIMARY KEY,
      last_success_at TEXT,
      last_error TEXT,
      row_count INTEGER DEFAULT 0
    );
  `);

  const count = sqlite.prepare("SELECT COUNT(*) c FROM store").get() as { c: number };
  if (!count.c) {
    // Seed with real portfolio data on first run
    const insert = sqlite.prepare("INSERT INTO store (table_name, payload) VALUES (?, ?)");
    for (const [k, v] of Object.entries(seedData)) {
      if (k !== "freshness" && k !== "diagnostics") {
        insert.run(k, JSON.stringify(v));
      }
    }
    // Seed source status
    sqlite.prepare(`INSERT INTO source_status (source, last_success_at, row_count) VALUES ('seed', ?, ?)`).run(
      new Date().toISOString(),
      seedData.properties.length + seedData.metrics.length
    );
  }
}
init();

type TableName = keyof DashboardData;

export function getDashboardData(): DashboardData {
  const rows = sqlite.prepare("SELECT table_name, payload FROM store").all() as { table_name: TableName; payload: string }[];
  const out = { ...EMPTY } as DashboardData;
  for (const r of rows) (out as any)[r.table_name] = JSON.parse(r.payload);

  const statusRows = sqlite.prepare("SELECT * FROM source_status").all() as { source: "xlsx" | "github"; last_success_at?: string; last_error?: string; row_count: number }[];
  out.diagnostics = statusRows.map((s) => ({ source: s.source, lastSuccessAt: s.last_success_at, lastError: s.last_error, rowCount: s.row_count }));
  out.freshness = statusRows.filter((s) => s.last_success_at).map((s) => ({ label: s.source.toUpperCase(), at: s.last_success_at!, source: s.source }));
  return out;
}

export function updateTable<T>(table: TableName, data: T) {
  sqlite.prepare(`INSERT INTO store (table_name,payload) VALUES (?,?) ON CONFLICT(table_name) DO UPDATE SET payload=excluded.payload`).run(table, JSON.stringify(data));
}

export function appendActivity(entry: { actor: string; action: string; entityType: string; entityId: string; detail: string }) {
  const data = getDashboardData();
  data.activity.unshift({ id: `a_${Date.now()}`, ts: new Date().toISOString(), ...entry });
  updateTable("activity", data.activity.slice(0, 500));
}

export function upsertSourceStatus(status: SourceStatus & { lastError?: string }) {
  sqlite.prepare(`INSERT INTO source_status (source,last_success_at,last_error,row_count)
    VALUES (@source,@lastSuccessAt,@lastError,@rowCount)
    ON CONFLICT(source) DO UPDATE SET last_success_at=excluded.last_success_at,last_error=excluded.last_error,row_count=excluded.row_count`).run({
    source: status.source,
    lastSuccessAt: status.lastSuccessAt || null,
    lastError: status.lastError || null,
    rowCount: status.rowCount,
  });
}
