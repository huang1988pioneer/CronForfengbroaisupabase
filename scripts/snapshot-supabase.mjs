import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPABASE_URL = requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const SCHEMA = process.env.SUPABASE_SCHEMA || "public";
const TABLES = parseTableList(process.env.SUPABASE_TABLES);
const PAGE_SIZE = Number.parseInt(process.env.SNAPSHOT_PAGE_SIZE || "1000", 10);
const RETENTION_DAYS = Number.parseInt(process.env.SNAPSHOT_RETENTION_DAYS || "30", 10);

if (!SUPABASE_KEY) {
  throw new Error(
    "Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY environment variable.",
  );
}

if (!Number.isInteger(PAGE_SIZE) || PAGE_SIZE < 1) {
  throw new Error("SNAPSHOT_PAGE_SIZE must be a positive integer.");
}

if (!Number.isInteger(RETENTION_DAYS) || RETENTION_DAYS < 1) {
  throw new Error("SNAPSHOT_RETENTION_DAYS must be a positive integer.");
}

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Accept-Profile": SCHEMA,
};

const startedAt = new Date();
const runId = startedAt.toISOString().replace(/[:.]/g, "-");
const latestDir = path.join("snapshots", "latest");
const runDir = path.join("snapshots", "runs", runId);

await mkdir("snapshots", { recursive: true });
await rm(latestDir, { recursive: true, force: true });
await mkdir(latestDir, { recursive: true });
await mkdir(runDir, { recursive: true });

const tables = TABLES.length ? TABLES : await discoverTables();

if (!tables.length) {
  throw new Error(
    "No Supabase tables found. Set SUPABASE_TABLES to a comma-separated table list if automatic discovery is unavailable.",
  );
}

const summary = {
  sourceRepository: "huang1988pioneer/fengbroaisupabase",
  schema: SCHEMA,
  startedAt: startedAt.toISOString(),
  finishedAt: null,
  tableCount: tables.length,
  totalRows: 0,
  tables: [],
};

for (const table of tables) {
  console.log(`Reading ${table}...`);
  const result = await fetchTable(table);
  summary.totalRows += result.count;
  summary.tables.push({
    name: table,
    count: result.count,
    fetchedRows: result.rows.length,
    file: `${safeFileName(table)}.json`,
  });

  const payload = {
    table,
    schema: SCHEMA,
    count: result.count,
    fetchedRows: result.rows.length,
    capturedAt: new Date().toISOString(),
    rows: redactSensitiveData(result.rows),
  };

  await writeJson(path.join(latestDir, `${safeFileName(table)}.json`), payload);
}

summary.finishedAt = new Date().toISOString();
await writeJson(path.join(latestDir, "summary.json"), summary);
await writeJson(path.join(runDir, "summary.json"), summary);
await pruneOldRuns(startedAt);

console.log(
  `Captured ${summary.tableCount} tables with ${summary.totalRows} total rows.`,
);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }
  return value;
}

function parseTableList(value) {
  if (!value) {
    return [];
  }

  return [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
}

async function discoverTables() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: {
      ...headers,
      Accept: "application/openapi+json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Unable to discover Supabase tables from OpenAPI (${response.status}): ${body}`,
    );
  }

  const openApi = await response.json();
  const definitions = openApi.definitions || openApi.components?.schemas || {};

  return Object.keys(definitions)
    .filter((name) => !name.startsWith("rpc/"))
    .sort((a, b) => a.localeCompare(b));
}

async function fetchTable(table) {
  const count = await fetchCount(table);
  const rows = [];

  for (let from = 0; from < count || (count === 0 && from === 0); from += PAGE_SIZE) {
    if (count === 0) {
      break;
    }

    const to = Math.min(from + PAGE_SIZE - 1, count - 1);
    const page = await requestTablePage(table, from, to);
    rows.push(...page);

    if (page.length < PAGE_SIZE) {
      break;
    }
  }

  return { count, rows };
}

async function fetchCount(table) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}`);
  url.searchParams.set("select", "*");

  const response = await fetch(url, {
    headers: {
      ...headers,
      Range: "0-0",
      Prefer: "count=exact",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Unable to count ${table} (${response.status}): ${body}`);
  }

  const contentRange = response.headers.get("content-range") || "";
  const match = contentRange.match(/\/(\d+|\*)$/);
  if (match && match[1] !== "*") {
    return Number.parseInt(match[1], 10);
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function requestTablePage(table, from, to) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}`);
  url.searchParams.set("select", "*");

  const response = await fetch(url, {
    headers: {
      ...headers,
      Range: `${from}-${to}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Unable to read ${table} rows ${from}-${to} (${response.status}): ${body}`,
    );
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected response for ${table}: expected an array.`);
  }

  return rows;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function pruneOldRuns(now) {
  const runsDir = path.join("snapshots", "runs");
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let entries = [];
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runDate = parseRunIdDate(entry.name);
    if (!runDate || runDate.getTime() >= cutoff) {
      continue;
    }

    await rm(path.join(runsDir, entry.name), { recursive: true, force: true });
    console.log(`Pruned old snapshot run ${entry.name}`);
  }
}

function parseRunIdDate(runId) {
  const match = runId.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
  );

  if (!match) {
    return null;
  }

  return new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
}

function safeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function redactSensitiveData(value, key = "") {
  if (value === null || value === undefined) {
    return value;
  }

  if (isSensitiveKey(key)) {
    return "[REDACTED_FIELD]";
  }

  if (typeof value === "string") {
    return redactSensitiveString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitiveData(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

function isSensitiveKey(key) {
  return /(?:api[_-]?key|authorization|bearer|openai|password|secret|service[_-]?role|token)/i.test(
    key,
  );
}

function redactSensitiveString(value) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/gh[opsu]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]");
}
