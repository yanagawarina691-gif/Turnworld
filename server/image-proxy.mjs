import { HttpError } from "./http.mjs";
import { upstreamError } from "./upstream.mjs";

const IMAGE_HOSTS = new Set([
  "images.blockadelabs.com",
  "blockade-platform-production.s3.amazonaws.com",
]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export function isAllowedSkyboxImageUrl(url) {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (!url.port || url.port === "443") &&
    (IMAGE_HOSTS.has(url.hostname) ||
      url.hostname.endsWith(".images.blockadelabs.com"))
  );
}

function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "无效图片 URL");
  }
  if (!isAllowedSkyboxImageUrl(url))
    throw new HttpError(403, "不允许的图片来源");
  return url;
}

export async function fetchSkyboxImage(
  raw,
  { fetchImpl = fetch, maxBytes = 140 * 1024 * 1024, timeoutMs = 30000 } = {},
) {
  let target = validateUrl(raw);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(target.href, {
        redirect: "manual",
        signal,
        headers: { Accept: "image/jpeg,image/png,image/webp" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 3)
          throw new HttpError(502, "图片重定向无效或次数过多");
        target = validateUrl(new URL(location, target).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(502, `图源返回 HTTP ${response.status}`);
      }
      const contentType = (response.headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!IMAGE_TYPES.has(contentType)) {
        await response.body?.cancel();
        throw new HttpError(502, "图源返回了不支持的图片类型");
      }
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw new HttpError(502, "图片过大，请使用预览图");
      }
      if (!response.body) throw new HttpError(502, "图片内容为空");
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes)
            throw new HttpError(502, "图片过大，请使用预览图");
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return { buffer: Buffer.concat(chunks, bytes), contentType };
    }
  } catch (error) {
    throw upstreamError(error);
  }
}
