/**
 * 本地代理：向 Blockade Labs（Skybox AI）转发请求，避免在前端暴露 API Key。
 * 与官方说明一致：https://api-documentation.blockadelabs.com/api/
 * （密钥仅服务端、请求头 x-api-key；进度追踪以前端 Pusher 为主，轮询仅低频兜底。）
 *
 * 环境变量：BLOCKADE_API_KEY（必填）、BLOCKADE_API_SECRET（Webhook 验签，见文档）、
 * SKYBOX_STYLE_ID（可选；默认 102 = M3 Cinematic Realism；设为 none 则只发 prompt 不带风格）、PORT（可选，默认 8787）、
 * BLOCKADE_WEBHOOK_URL（可选，https 时自动附加到生成请求）
 *
 * 本地可在项目根目录放置 .env（已加入 .gitignore），启动时自动加载。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadLocalEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i <= 0) continue;
      const key = s.slice(0, i).trim();
      let val = s.slice(i + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      /* 覆盖「未设置」或「空字符串」，避免 shell 里误 export 了空 KEY 导致读不到 .env */
      const cur = process.env[key];
      if (cur === undefined || cur === "") process.env[key] = val;
    }
  } catch {
    /* 无 .env 时依赖进程环境变量 */
  }
}
loadLocalEnv();

const PUBLIC = path.join(__dirname, "public");
const BLOCKADE = "https://backend.blockadelabs.com/api/v1";
const API_KEY = process.env.BLOCKADE_API_KEY || "";
/** @see GET /skybox/styles?model_version=3 — 「M3 Cinematic Realism」 */
const SKYBOX_STYLE_CINEMATIC_REALISM_M3 = 102;
const styleEnv = (process.env.SKYBOX_STYLE_ID || "").trim();
let DEFAULT_STYLE;
if (styleEnv === "" || styleEnv === "default") {
  DEFAULT_STYLE = SKYBOX_STYLE_CINEMATIC_REALISM_M3;
} else if (styleEnv === "none" || styleEnv === "0") {
  DEFAULT_STYLE = NaN;
} else {
  DEFAULT_STYLE = parseInt(styleEnv, 10);
}
const HAS_DEFAULT_STYLE = Number.isFinite(DEFAULT_STYLE);
const PORT = parseInt(process.env.PORT || "8787", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** 含中日韩等则视为需译成英文再发给 Skybox */
function promptNeedsEnglish(s) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/.test(s);
}

/**
 * 使用 MyMemory 免费接口中译英（无密钥；失败则返回原文）。
 * 可改环境变量禁用：TRANSLATE_PROMPT=0
 */
async function translatePromptToEnglishIfNeeded(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return trimmed;
  const off = (process.env.TRANSLATE_PROMPT || "1").trim();
  if (off === "0" || off === "false") return trimmed;
  if (!promptNeedsEnglish(trimmed)) return trimmed;
  const q = trimmed.length > 450 ? trimmed.slice(0, 450) : trimmed;
  let langpair = "zh-CN|en";
  if (/[\u4e00-\u9fff]/.test(q)) langpair = "zh-CN|en";
  else if (/[\u3040-\u30ff]/.test(q)) langpair = "ja|en";
  else if (/[\uac00-\ud7af]/.test(q)) langpair = "ko|en";
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(langpair)}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return trimmed;
  let j;
  try {
    j = await r.json();
  } catch {
    return trimmed;
  }
  const st = j.responseStatus;
  if (st !== 200 && st !== "200") return trimmed;
  const out = (j.responseData && String(j.responseData.translatedText || "").trim()) || "";
  if (!out || /^MYMEMORY WARNING/i.test(out)) return trimmed;
  return out.length > 2000 ? out.slice(0, 2000) : out;
}

async function blockadeFetch(method, urlPath, jsonBody = null) {
  const url = `${BLOCKADE}${urlPath}`;
  const opts = {
    method,
    headers: {
      "x-api-key": API_KEY,
      Accept: "application/json",
    },
  };
  if (jsonBody != null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(jsonBody);
  }
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _parseError: true, raw: text };
  }
  return { status: r.status, data };
}

/** Blockade 常在 HTTP 200 正文里返回 success:false，需单独识别 */
function blockadeApiFailure(data, fallbackCode = 403) {
  if (!data || typeof data !== "object" || data._parseError) return null;
  if (data.success !== false) return null;
  const code =
    typeof data.error_code === "number" && data.error_code >= 400 && data.error_code < 600
      ? data.error_code
      : fallbackCode;
  const msg =
    data.response || data.error_message || data.message || "Skybox API 拒绝请求";
  return { code, body: { error: msg } };
}

/** 仅允许 Skybox 产出图域名，防止 open proxy */
function isAllowedSkyboxImageUrl(u) {
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  const p = u.pathname;
  const looksLikeAsset =
    p.includes("/imagine/") ||
    p.includes("/thumbs/") ||
    (p.includes("/images/") && /\.(jpe?g|png|webp)(\?|$)/i.test(p));
  if (!looksLikeAsset) return false;
  if (h === "images.blockadelabs.com" || h.endsWith(".images.blockadelabs.com")) return true;
  if (h === "blockade-platform-production.s3.amazonaws.com") return true;
  if (h.endsWith(".s3.amazonaws.com") && (h.includes("blockade") || p.includes("/imagine/")))
    return true;
  if (h.endsWith(".amazonaws.com") && h.includes("blockade")) return true;
  if (h.endsWith(".cloudfront.net") && (h.includes("blockade") || h.includes("blockadelabs")))
    return true;
  if (h.endsWith("blockadelabs.com") && (h.startsWith("images.") || h.startsWith("cdn.")))
    return true;
  return false;
}

/** GET/POST 共用：从 Blockade 拉取二进制并原样返回 */
async function proxySkyboxImageByUrl(res, raw) {
  let target;
  try {
    target = new URL(String(raw).trim());
  } catch {
    sendJson(res, 400, { error: "无效 url" });
    return;
  }
  if (!isAllowedSkyboxImageUrl(target)) {
    sendJson(res, 403, {
      error: `不允许的图片来源: ${target.hostname}（可把完整 file_url 发给开发者加白名单）`,
    });
    return;
  }
  try {
    const r = await fetch(target.toString(), {
      headers: { Accept: "image/*,*/*" },
    });
    if (!r.ok) {
      sendJson(res, 502, {
        error: `图源返回 HTTP ${r.status}（链接可能过期，请重新生成或换 thumb_url）`,
      });
      return;
    }
    const ct = r.headers.get("content-type") || "image/jpeg";
    const MAX_BYTES = 140 * 1024 * 1024;
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAX_BYTES) {
      sendJson(res, 502, { error: "图片过大，请改用 thumb_url 或更低分辨率导出" });
      return;
    }
    const buf = Buffer.from(ab);
    res.writeHead(200, {
      "Content-Type": ct,
      "Content-Length": buf.length,
      "Cache-Control": "private, max-age=300",
    });
    res.end(buf);
  } catch {
    sendJson(res, 502, { error: "图片代理失败" });
  }
}

/** 与静态资源区分，避免 /api/.../ 落入 public 目录返回 404 */
function requestPathname(req) {
  let p = req.url.split("?")[0];
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

function serveStatic(req, res) {
  let urlPath = requestPathname(req);
  if (urlPath.startsWith("/api/")) {
    sendJson(res, 404, { error: `未知接口 ${urlPath}（请确认已重启 Node）` });
    return;
  }
  if (urlPath === "/pimg" || urlPath.startsWith("/pimg/")) {
    sendJson(res, 404, { error: "pimg 应由 Node 处理，请重启服务" });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: `静态文件不支持 ${req.method}，图片请 POST /pimg` });
    return;
  }
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.join(PUBLIC, path.normalize(urlPath));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(file);
    const noCache = ext === ".html" || ext === ".js" || ext === ".css";
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      ...(noCache ? { "Cache-Control": "no-store" } : {}),
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const u = requestPathname(req);

  if (req.method === "GET" && u === "/health") {
    sendJson(res, 200, { ok: true, service: "turnworld" });
    return;
  }

  /**
   * 图片代理置顶：/pimg 为短路径（避免中间层对长路径异常）；/api/skybox/image-proxy 兼容旧版。
   * GET /pimg 无参数时返回健康检查 JSON。
   */
  if (u === "/pimg" || u === "/api/skybox/image-proxy") {
    if (req.method === "GET") {
      const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
      const raw = new URLSearchParams(q).get("url");
      if (!raw) {
        if (u === "/pimg") {
          sendJson(res, 200, { ok: true, pimg: "POST application/json {\"url\":\"https://...\"}" });
        } else {
          sendJson(res, 400, { error: "缺少 url（长链接请 POST /pimg + JSON）" });
        }
        return;
      }
      await proxySkyboxImageByUrl(res, raw);
      return;
    }
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const raw = (body.url || "").trim();
        if (!raw) {
          sendJson(res, 400, { error: "缺少 url" });
          return;
        }
        await proxySkyboxImageByUrl(res, raw);
      } catch {
        sendJson(res, 400, { error: "请求体无效 JSON" });
      }
      return;
    }
    sendJson(res, 405, { error: "图片代理仅支持 GET ?url= 或 POST {url}" });
    return;
  }

  if (req.method === "POST" && u === "/api/skybox") {
    if (!API_KEY) {
      sendJson(res, 500, { error: "服务器未配置 BLOCKADE_API_KEY" });
      return;
    }
    try {
      const body = await readBody(req);
      const promptRaw = (body.prompt || "").trim();
      if (!promptRaw) {
        sendJson(res, 400, { error: "请提供 prompt" });
        return;
      }
      let promptSkybox = promptRaw;
      if (body.translate_prompt !== false) {
        try {
          promptSkybox = await translatePromptToEnglishIfNeeded(promptRaw);
        } catch {
          promptSkybox = promptRaw;
        }
      }
      let skybox_style_id;
      if (typeof body.skybox_style_id === "number" && Number.isFinite(body.skybox_style_id)) {
        skybox_style_id = body.skybox_style_id;
      } else if (HAS_DEFAULT_STYLE) {
        skybox_style_id = DEFAULT_STYLE;
      }
      const payload = { prompt: promptSkybox };
      if (skybox_style_id != null) payload.skybox_style_id = skybox_style_id;
      if (body.negative_text) payload.negative_text = String(body.negative_text).slice(0, 600);
      if (body.enhance_prompt === true) payload.enhance_prompt = true;
      if (typeof body.seed === "number" && body.seed >= 0) payload.seed = body.seed;
      const wh = process.env.BLOCKADE_WEBHOOK_URL;
      if (typeof body.webhook_url === "string" && body.webhook_url.startsWith("https://"))
        payload.webhook_url = body.webhook_url;
      else if (wh && wh.startsWith("https://")) payload.webhook_url = wh;

      const { status, data } = await blockadeFetch("POST", "/skybox", payload);
      const bf = blockadeApiFailure(data);
      if (bf) {
        sendJson(res, bf.code, bf.body);
        return;
      }
      if (status >= 400) {
        sendJson(res, status, typeof data === "object" ? data : { error: String(data) });
        return;
      }
      if (data.id == null || data.id === "") {
        sendJson(res, 502, {
          error:
            data.error_message ||
            data.message ||
            "Skybox 未返回任务 id，请检查订阅或风格权限",
        });
        return;
      }
      const out = { ...data };
      if (promptSkybox !== promptRaw) {
        out.prompt_original = promptRaw;
        out.prompt_sent = promptSkybox;
      }
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 400, { error: "请求体无效 JSON" });
    }
    return;
  }

  if (req.method === "GET" && u.startsWith("/api/skybox/status")) {
    if (!API_KEY) {
      sendJson(res, 500, { error: "服务器未配置 BLOCKADE_API_KEY" });
      return;
    }
    const rest = u.slice("/api/skybox/status".length).replace(/^\/+/, "");
    const id = rest.replace(/[^\d]/g, "");
    if (!id) {
      sendJson(res, 400, { error: "无效 id" });
      return;
    }
    const { status, data } = await blockadeFetch("GET", `/imagine/requests/${id}`);
    const bf = blockadeApiFailure(data);
    if (bf) {
      sendJson(res, bf.code, bf.body);
      return;
    }
    sendJson(res, status >= 400 ? status : 200, data);
    return;
  }

  if (req.method === "GET" && u === "/api/skybox/styles") {
    if (!API_KEY) {
      sendJson(res, 500, { error: "服务器未配置 BLOCKADE_API_KEY" });
      return;
    }
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const { status, data } = await blockadeFetch("GET", `/skybox/styles${qs}`);
    const bf = blockadeApiFailure(data);
    if (bf) {
      sendJson(res, bf.code, bf.body);
      return;
    }
    sendJson(res, status >= 400 ? status : 200, data);
    return;
  }

  serveStatic(req, res);
});

/* 默认仅本机访问；已配置入口保护的容器部署可显式设置 HOST=0.0.0.0。 */
const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`TurnWorld http://${HOST}:${server.address().port}  健康检查: GET /health`);
  if (!API_KEY) console.warn("警告: 未设置 BLOCKADE_API_KEY，生成接口不可用");
  else if (HAS_DEFAULT_STYLE)
    console.log(
      `Skybox 默认风格 id=${DEFAULT_STYLE}（M3 Cinematic Realism=102；SKYBOX_STYLE_ID=none 可只发 prompt）`
    );
  else console.log("Skybox 未带 skybox_style_id（SKYBOX_STYLE_ID=none）");
});
