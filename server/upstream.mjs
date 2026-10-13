import { HttpError } from "./http.mjs";

export function upstreamError(error) {
  if (error instanceof HttpError) return error;
  if (error.name === "TimeoutError" || error.name === "AbortError")
    return new HttpError(504, "上游服务响应超时，请稍后重试");
  return new HttpError(502, "无法连接上游服务，请稍后重试");
}

export function createSkyboxClient({
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 30000,
}) {
  return async function blockadeFetch(method, urlPath, jsonBody = null) {
    try {
      const response = await fetchImpl(
        `https://backend.blockadelabs.com/api/v1${urlPath}`,
        {
          method,
          headers: {
            "x-api-key": apiKey,
            Accept: "application/json",
            ...(jsonBody === null
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(jsonBody === null ? {} : { body: JSON.stringify(jsonBody) }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (error.name === "TimeoutError" || error.name === "AbortError")
          throw error;
        throw new HttpError(502, "上游服务返回了无效 JSON");
      }
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new HttpError(502, "上游服务返回了无效数据");
      return { status: response.status, data };
    } catch (error) {
      throw upstreamError(error);
    }
  };
}
