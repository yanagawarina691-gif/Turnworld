export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, "请求体过大"));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error();
        resolve(body);
      } catch {
        reject(new HttpError(400, "请求体必须为有效 JSON 对象"));
      }
    });
    req.on("error", reject);
  });
}

export function respondToError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof HttpError)
    sendJson(res, error.status, { error: error.message });
  else {
    console.error("TurnWorld request failed:", error.name);
    sendJson(res, 500, { error: "服务器内部错误" });
  }
}
