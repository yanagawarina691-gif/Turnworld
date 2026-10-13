import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import {
  fetchSkyboxImage,
  isAllowedSkyboxImageUrl,
} from "../server/image-proxy.mjs";

// Exercise real HTTP routes with an isolated fake upstream: no paid service calls.
test("routes distinguish invalid input, upstream failure and timeout, and stay alive", async (t) => {
  const realFetch = globalThis.fetch;
  let upstream = async () => {
    throw new TypeError("offline");
  };
  globalThis.fetch = (...args) => upstream(...args);
  process.env.BLOCKADE_API_KEY = "offline-test-placeholder";
  process.env.TRANSLATE_PROMPT = "0";
  const { server } = await import("../server.mjs");
  globalThis.fetch = realFetch;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) =>
    realFetch(base + "/api/skybox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  for (const route of ["/api/skybox/status/1", "/api/skybox/styles"]) {
    const response = await realFetch(base + route);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /上游/);
  }
  assert.equal(
    (await post(JSON.stringify({ prompt: "a mountain" }))).status,
    502,
  );
  assert.equal((await post("{")).status, 400);
  assert.equal((await post("null")).status, 400);
  assert.equal((await post(JSON.stringify({ prompt: 123 }))).status, 400);
  assert.equal(
    (await post(JSON.stringify({ prompt: "a".repeat(70000) }))).status,
    413,
  );
  upstream = async () => {
    throw new DOMException("timeout", "TimeoutError");
  };
  assert.equal((await realFetch(base + "/api/skybox/status/1")).status, 504);
  upstream = async () => new Response("<html>error</html>", { status: 502 });
  assert.equal(
    (await post(JSON.stringify({ prompt: "a mountain" }))).status,
    502,
  );
  upstream = async () => Response.json({ id: 123, status: "pending" });
  const valid = await post(JSON.stringify({ prompt: "a mountain" }));
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).id, 123);
  assert.equal((await realFetch(base + "/health")).status, 200);
});

test("image allowlist rejects lookalikes, unrelated buckets, credentials and redirects", async () => {
  for (const raw of [
    "https://images.notblockadelabs.com/images/a.jpg",
    "https://unrelated.s3.amazonaws.com/imagine/a.jpg",
    "http://images.blockadelabs.com/a.jpg",
    "https://user@images.blockadelabs.com/a.jpg",
    "https://images.blockadelabs.com:444/a.jpg",
  ]) {
    assert.equal(isAllowedSkyboxImageUrl(new URL(raw)), false, raw);
  }
  let requests = 0;
  await assert.rejects(
    fetchSkyboxImage("https://images.blockadelabs.com/a.jpg", {
      fetchImpl: async () => {
        requests++;
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      },
    }),
    (error) => error.status === 403,
  );
  assert.equal(requests, 1);
});

test("image proxy validates content and limits streamed bytes before buffering the full image", async () => {
  const url = "https://images.blockadelabs.com/a.jpg";
  const fake = (type) => async () =>
    new Response("abc", { headers: { "content-type": type } });
  await assert.rejects(
    fetchSkyboxImage(url, { fetchImpl: fake("text/html") }),
    (error) => error.status === 502,
  );
  let cancelled = false;
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchSkyboxImage(url, {
      maxBytes: 5,
      fetchImpl: async () =>
        new Response(oversized, { headers: { "content-type": "image/jpeg" } }),
    }),
    (error) => error.status === 502,
  );
  assert.equal(cancelled, true);
  const image = await fetchSkyboxImage(url, { fetchImpl: fake("image/jpeg") });
  assert.equal(image.buffer.toString(), "abc");
  assert.equal(image.contentType, "image/jpeg");
});
