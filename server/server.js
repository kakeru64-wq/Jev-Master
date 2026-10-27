// Jev 広告判定の中継サーバー（依存なし / Node 18+）
// APIキーはこのプロセスだけが保持し、拡張機能には渡さない。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 8787;
const HOST = "127.0.0.1";
const API_BASE = "https://api.typesafe.ai";
const MODEL = process.env.JEV_MODEL || "jev-latest";
const CONCURRENCY = 8;
const MAX_RETRIES = 2;
const MAX_ITEMS = 20;
const MAX_TEXT = 2000;
const CACHE_SIZE = 5000;

const QUESTIONS = {
  is_ad: {
    type: "noul",
    instructions:
      "Is this web page element an advertisement, sponsored/PR content, or promotional banner " +
      "rather than the page's own content or navigation?",
  },
};

// .env はキー名にドットを含む（jev.api_key）ため自前でパースする
function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

const env = loadEnv(path.join(__dirname, "..", ".env"));
const API_KEY = env["jev.api_key"] || env.TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY;
if (!API_KEY) {
  console.error("APIキーが見つかりません。../.env に jev.api_key=... を設定してください。");
  process.exit(1);
}

// --- LRU キャッシュ（Map の挿入順を利用） ---
const cache = new Map();
function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v);
  return v;
}
function cacheSet(key, v) {
  cache.set(key, v);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
}

// --- 同時実行数制限 ---
let active = 0;
const queue = [];
function limit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        active--;
        if (queue.length) queue.shift()();
      }
    };
    active < CONCURRENCY ? run() : queue.push(run);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callJev(state) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_BASE}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
    });
    if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
      await sleep(500 * 2 ** attempt + Math.random() * 250);
      continue;
    }
    const reqId = res.headers.get("x-typesafe-request-id");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jev ${res.status} (req ${reqId}): ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const p = data?.answers?.is_ad?.noul;
    console.log(`[jev] ${data.model} req=${reqId} ad=${typeof p === "number" ? p.toFixed(3) : p}`);
    return typeof p === "number" ? p : null;
  }
}

async function classify(text) {
  const state = String(text).slice(0, MAX_TEXT);
  const key = crypto.createHash("sha1").update(state).digest("hex");
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const p = await limit(() => callJev(state));
  if (p !== null) cacheSet(key, p);
  return p;
}

// --- HTTP ---
function send(res, status, obj, origin) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (origin && origin.startsWith("chrome-extension://")) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
  }
  res.writeHead(status, headers);
  res.end(obj === undefined ? "" : JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  // ブラウザからの直接アクセスは拡張機能オリジンのみ許可（curl 等 Origin なしは許可）
  if (origin && !origin.startsWith("chrome-extension://")) return send(res, 403, { error: "forbidden" });
  if (req.method === "OPTIONS") return send(res, 204, undefined, origin);

  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(
        `Jev Ad Filter 中継サーバーは起動しています（model=${MODEL}）\n` +
          `Jev API への接続確認: http://${HOST}:${PORT}/health\n` +
          `判定キャッシュ件数: ${cache.size}\n`
      );
    }

    if (req.method === "GET" && req.url === "/health") {
      const r = await fetch(`${API_BASE}/v1/models`, { headers: { Authorization: `Bearer ${API_KEY}` } });
      return send(res, r.ok ? 200 : 502, { ok: r.ok, upstreamStatus: r.status, model: MODEL }, origin);
    }

    if (req.method === "POST" && req.url === "/classify") {
      const { host, items } = JSON.parse(await readBody(req));
      if (!Array.isArray(items)) return send(res, 400, { error: "items must be an array" }, origin);
      const batch = items.slice(0, MAX_ITEMS);
      const results = await Promise.all(
        batch.map(async ({ id, text }) => {
          try {
            return { id, ad: await classify(text) };
          } catch (e) {
            console.error(`[jev] error (${host}):`, e.message);
            return { id, ad: null };
          }
        })
      );
      return send(res, 200, { results }, origin);
    }

    send(res, 404, { error: "not found" }, origin);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message }, origin);
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`ポート ${PORT} は使用中です。すでに中継サーバーが起動していないか確認してください。`);
    console.error(`別のポートで起動する場合: $env:PORT=8788; npm start（拡張側の SERVER も合わせて変更が必要）`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`Jev ad filter server: http://${HOST}:${PORT} (model=${MODEL})`);
});
