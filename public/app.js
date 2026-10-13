import * as THREE from "three";
import Pusher from "pusher-js";

/**
 * Blockade Labs 文档公开的 Pusher 客户端参数（用于订阅生成进度，避免高频轮询触发限流）
 * @see https://api-documentation.blockadelabs.com/api/
 */
const PUSHER_KEY = "a6a7b7662238ce4494d5";
const PUSHER_CLUSTER = "mt1";
const POLL_FALLBACK_MS = 12000;
const GENERATION_TIMEOUT_MS = 240000;

const DEFAULT_PANO =
  "https://threejs.org/examples/textures/2294472375_24a3b8ef46_o.jpg";

const FOV = 72;
const AUTO_ROTATE_SPEED = 0.12;
const DRAG_SENS = 0.0045;
const GYRO_SENS = 0.018;
const MAX_LAT = 0.52;
const MIN_LAT = -0.52;

let lon = 0;
let lat = 0;
let targetLon = 0;
let targetLat = 0;
let autoRotate = true;
let dragging = false;
let lastX = 0;
let lastY = 0;
let gyroBase = null;
let gyroActive = false;

const wrap = document.getElementById("canvas-wrap");
const form = document.getElementById("prompt-form");
const input = document.getElementById("prompt");
const submitBtn = document.getElementById("submit");
const statusEl = document.getElementById("status");
const gyroBtn = document.getElementById("btn-gyro");
const testPanoBtn = document.getElementById("btn-test-pano");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  FOV,
  window.innerWidth / window.innerHeight,
  0.1,
  2000
);
camera.position.set(0, 0, 0.01);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x050508, 1);
/* LDR 全景：ACES 等色调映射会把球幕压成近乎全黑 */
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
wrap.appendChild(renderer.domElement);

renderer.domElement.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  setStatus("WebGL 中断，请刷新页面");
});

/* 不用「内球壳 + BackSide」贴图：部分 Mac / Safari 上会整屏黑；改用官方背景等距柱路径 */
scene.background = null;
scene.environment = null;

const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");

function setStatus(t) {
  statusEl.textContent = t || "";
}

/** TextureLoader 失败时常传入 DOM Event，直接当 Error 用会变成 [object Event] */
function humanError(err) {
  if (err == null) return "未知错误";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || "错误";
  const m = err.message;
  if (typeof m === "string" && m.trim()) return m;
  if (err.error && typeof err.error === "string") return err.error;
  if (err.type && err.target && err.target.src)
    return `无法加载图片（${err.type}）`;
  return "图片加载失败";
}

/** 需走代理时返回内部标记串；实际请求用 POST 拉取，避免超长 GET 导致 404 */
const SKYBOX_PROXY_PREFIX = "__tw_img_proxy__:";

/** Skybox 图域名无 CORS 时 WebGL 贴图会全黑，改走同源代理 */
function panoUrlForLoader(remoteUrl) {
  if (!remoteUrl) return remoteUrl;
  try {
    const u = new URL(remoteUrl);
    if (u.protocol !== "https:") return remoteUrl;
    const h = u.hostname.toLowerCase();
    const p = u.pathname;
    const assetPath =
      p.includes("/imagine/") ||
      p.includes("/thumbs/") ||
      (p.includes("/images/") && /\.(jpe?g|png|webp)(\?|$)/i.test(p));
    if (!assetPath) return remoteUrl;
    const needProxy =
      h === "images.blockadelabs.com" ||
      h.endsWith(".images.blockadelabs.com") ||
      h === "blockade-platform-production.s3.amazonaws.com" ||
      (h.endsWith(".s3.amazonaws.com") && (h.includes("blockade") || p.includes("/imagine/"))) ||
      (h.endsWith(".amazonaws.com") && h.includes("blockade")) ||
      (h.endsWith(".cloudfront.net") &&
        (h.includes("blockade") || h.includes("blockadelabs"))) ||
      (h.endsWith("blockadelabs.com") && (h.startsWith("images.") || h.startsWith("cdn.")));
    if (!needProxy) return remoteUrl;
    return `${SKYBOX_PROXY_PREFIX}${remoteUrl}`;
  } catch {
    return remoteUrl;
  }
}

/**
 * 超过 maxTextureSize 时许多设备会静默上传失败 → 全黑画面
 */
function clampTextureToGpuLimit(tex) {
  const cap = renderer.capabilities.maxTextureSize;
  const img = tex.image;
  if (!img || !(img.width > 0) || !(img.height > 0)) return tex;
  const w = img.width;
  const h = img.height;
  if (w <= cap && h <= cap) return tex;
  const s = Math.min(cap / w, cap / h, 1);
  const nw = Math.max(2, Math.floor(w * s));
  const nh = Math.max(2, Math.floor(h * s));
  const canvas = document.createElement("canvas");
  canvas.width = nw;
  canvas.height = nh;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, nw, nh);
  tex.dispose();
  const next = new THREE.CanvasTexture(canvas);
  return next;
}

function applyPanoramaTexture(tex) {
  const prev = scene.background;
  if (prev instanceof THREE.Texture) prev.dispose();

  let t = clampTextureToGpuLimit(tex);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  /* Mac / 当前管线下需 true，否则天地颠倒 */
  t.flipY = true;

  scene.background = t;
  if ("backgroundIntensity" in scene) scene.backgroundIntensity = 1;
  if ("backgroundBlurriness" in scene) scene.backgroundBlurriness = 0;
}

async function loadTextureOnce(src) {
  if (typeof src === "string" && src.startsWith(SKYBOX_PROXY_PREFIX)) {
    const remote = src.slice(SKYBOX_PROXY_PREFIX.length);
    const proxyUrl = new URL("/pimg", window.location.origin).href;
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: remote }),
      cache: "no-store",
    });
    if (!res.ok) {
      const t = await res.text();
      let msg = `图片代理 HTTP ${res.status}`;
      try {
        const j = JSON.parse(t);
        if (j.error) msg = j.error;
      } catch {
        if (t && t.trim()) msg = `${msg}: ${t.trim().slice(0, 300)}`;
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    try {
      return await loader.loadAsync(objUrl);
    } catch (e) {
      throw new Error(humanError(e));
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  }
  try {
    return await loader.loadAsync(src);
  } catch (e) {
    throw new Error(humanError(e));
  }
}

/**
 * @param {string} fileUrl 高清 equirectangular
 * @param {string} [thumbUrl] 若有则优先显示缩略全景（省流量、少爆显存），再在后台换高清
 */
async function loadPanorama(fileUrl, thumbUrl = "") {
  const sequence = [];
  if (thumbUrl && fileUrl && thumbUrl !== fileUrl) {
    sequence.push({ url: thumbUrl, thenTryHd: true });
  }
  if (fileUrl) sequence.push({ url: fileUrl, thenTryHd: false });

  if (sequence.length === 0) throw new Error("没有可用的全景地址");

  let lastErr;
  for (const step of sequence) {
    try {
      applyPanoramaTexture(await loadTextureOnce(panoUrlForLoader(step.url)));
      if (step.thenTryHd && fileUrl) {
        setStatus("预览已显示，正在加载高清…");
        loadTextureOnce(panoUrlForLoader(fileUrl))
          .then((tex) => {
            applyPanoramaTexture(tex);
            setStatus("高清就绪 · 滑动或陀螺仪探索");
          })
          .catch(() => {
            setStatus("高清未载入，当前为预览 · 可滑动探索");
          });
      } else {
        setStatus("滑动屏幕或开启陀螺仪探索");
      }
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(humanError(lastErr));
}

function updateCamera() {
  if (autoRotate && !dragging && !gyroActive) {
    targetLon += AUTO_ROTATE_SPEED * 0.016;
  }
  lon += (targetLon - lon) * 0.08;
  lat += (targetLat - lat) * 0.08;
  lat = Math.max(MIN_LAT, Math.min(MAX_LAT, lat));

  const phi = Math.PI / 2 - lat;
  const theta = lon;
  const c = new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  );
  camera.lookAt(c);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onPointerDown(e) {
  dragging = true;
  autoRotate = false;
  lastX = e.clientX;
  lastY = e.clientY;
}

function onPointerMove(e) {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  targetLon -= dx * DRAG_SENS;
  targetLat -= dy * DRAG_SENS;
  targetLat = Math.max(MIN_LAT, Math.min(MAX_LAT, targetLat));
}

function onPointerUp() {
  dragging = false;
}

function onDeviceOrientation(e) {
  if (!gyroActive || e.alpha == null) return;
  if (!gyroBase) {
    gyroBase = { a: e.alpha, b: e.beta, g: e.gamma };
    return;
  }
  const da = THREE.MathUtils.degToRad(e.alpha - gyroBase.a);
  const db = THREE.MathUtils.degToRad(e.beta - gyroBase.b);
  const dg = THREE.MathUtils.degToRad(e.gamma - gyroBase.g);
  targetLon = -da * GYRO_SENS * 2 + dg * GYRO_SENS;
  targetLat = -db * GYRO_SENS;
  targetLat = Math.max(MIN_LAT, Math.min(MAX_LAT, targetLat));
}

async function enableGyro() {
  /* 手机用 http://局域网IP 打开时 isSecureContext 为 false，Safari/Chrome 通常不允许设备方向 API */
  if (!window.isSecureContext) {
    setStatus(
      "陀螺仪需 HTTPS：用 IP 的 HTTP 无法授权。请用手指滑动；或用 ngrok / cloudflared 把本机 8787 暴露为 HTTPS 再试。"
    );
    return;
  }
  if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) {
    try {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== "granted") {
        setStatus(
          "未获得陀螺仪权限（可能点了不允许）。可到系统设置里为该浏览器开启「动作与方向」/ 站点权限后重试。"
        );
        return;
      }
    } catch {
      setStatus("陀螺仪不可用");
      return;
    }
  }
  gyroActive = true;
  autoRotate = false;
  gyroBase = null;
  window.addEventListener("deviceorientation", onDeviceOrientation, true);
  gyroBtn.hidden = true;
  setStatus("陀螺仪已开启，缓慢转动手机探索");
}

if (window.DeviceOrientationEvent) {
  gyroBtn.hidden = false;
  if (!window.isSecureContext) {
    gyroBtn.title = "当前为 HTTP，陀螺仪需 HTTPS；仍可点击看说明";
  }
}
gyroBtn.addEventListener("click", () => enableGyro());

/** 不走 Skybox API，只验证 WebGL + 纹理（不扣生成费） */
testPanoBtn.addEventListener("click", async () => {
  autoRotate = false;
  setStatus("加载测试全景（官方示例图，不扣费）…");
  try {
    await loadPanorama(DEFAULT_PANO, "");
    setStatus("测试成功：能看见球幕再点「生成」");
  } catch (e) {
    setStatus(humanError(e));
  }
});

window.addEventListener("resize", onResize);
renderer.domElement.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", onPointerUp);

function tick() {
  requestAnimationFrame(tick);
  updateCamera();
  renderer.render(scene, camera);
}

function statusFromSkyboxPayload(p) {
  if (!p || !p.status) return "生成中…";
  const st = p.status;
  const q = p.queue_position;
  if (st === "processing") return "绘制世界中…";
  if (st === "dispatched") return "已派发，绘制即将开始…";
  if (st === "pending" && q != null) return `队列中 · 位置 ${q}`;
  if (st === "pending") return "排队中…";
  return "生成中…";
}

/**
 * 官方推荐：用返回的 pusher_channel / pusher_event 收进度；轮询仅低频兜底。
 */
function waitForSkyboxFileUrl(id, startPayload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer;
    let timeoutId;
    let pusherInst;
    let subscribedChannel;

    const cleanup = () => {
      clearInterval(pollTimer);
      clearTimeout(timeoutId);
      if (pusherInst && subscribedChannel) {
        try {
          pusherInst.unsubscribe(subscribedChannel);
          pusherInst.disconnect();
        } catch (_) {}
        pusherInst = undefined;
      }
    };

    const finishOk = (assets) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof assets === "string") {
        resolve({ file_url: assets, thumb_url: "" });
        return;
      }
      resolve({
        file_url: assets.file_url,
        thumb_url: assets.thumb_url || "",
      });
    };

    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const handleUpdate = (payload) => {
      if (!payload || settled) return;
      setStatus(statusFromSkyboxPayload(payload));
      const st = payload.status;
      if (st === "complete" && payload.file_url)
        finishOk({ file_url: payload.file_url, thumb_url: payload.thumb_url || "" });
      else if (st === "error" || st === "abort")
        finishErr(new Error(payload.error_message || "生成失败"));
    };

    if (startPayload?.status === "complete" && startPayload.file_url) {
      finishOk({
        file_url: startPayload.file_url,
        thumb_url: startPayload.thumb_url || "",
      });
      return;
    }
    if (startPayload?.status === "error" || startPayload?.status === "abort") {
      finishErr(new Error(startPayload.error_message || "生成失败"));
      return;
    }
    handleUpdate(startPayload);

    const ch = startPayload.pusher_channel;
    const ev = startPayload.pusher_event;
    if (ch && ev) {
      try {
        pusherInst = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER });
        subscribedChannel = ch;
        const channel = pusherInst.subscribe(ch);
        channel.bind(ev, handleUpdate);
      } catch (_) {
        pusherInst = undefined;
        subscribedChannel = undefined;
      }
    }

    pollTimer = setInterval(async () => {
      if (settled) return;
      try {
        const r = await fetch(`/api/skybox/status/${id}`);
        const j = await r.json();
        handleUpdate(j.request || j);
      } catch (_) {}
    }, POLL_FALLBACK_MS);

    timeoutId = setTimeout(() => {
      finishErr(new Error("等待超时，请稍后在 Skybox 后台查看"));
    }, GENERATION_TIMEOUT_MS);
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = input.value.trim();
  if (!prompt) return;
  submitBtn.disabled = true;
  autoRotate = false;
  setStatus("提交到 Skybox AI…");
  try {
    const res = await fetch("/api/skybox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        data.error || data.response || data.message || `HTTP ${res.status}`
      );
    }
    const id = data.id ?? data.request?.id;
    if (id == null || id === "") {
      throw new Error(data.error || "未返回任务 id");
    }
    if (data.prompt_sent && data.prompt_original && data.prompt_sent !== data.prompt_original) {
      const show = data.prompt_sent.length > 90 ? data.prompt_sent.slice(0, 90) + "…" : data.prompt_sent;
      setStatus(`已译为英文提交：${show}`);
      await new Promise((r) => setTimeout(r, 800));
    }
    setStatus("已提交 · 等待 Skybox 进度…");
    const assets = await waitForSkyboxFileUrl(id, data);
    setStatus("加载全景…");
    await loadPanorama(assets.file_url, assets.thumb_url);
    input.blur();
  } catch (err) {
    setStatus(humanError(err));
  } finally {
    submitBtn.disabled = false;
  }
});

loadPanorama(DEFAULT_PANO)
  .then(() => setStatus("首页自动旋转 · 输入一句话生成你的世界"))
  .catch(() => setStatus("默认全景加载失败，请检查网络"));

tick();
