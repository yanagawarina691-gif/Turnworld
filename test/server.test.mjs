import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";

// Start the real server without a paid API key; only exercise local routes.
test("a fresh checkout serves the frontend and keeps private files inaccessible", { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", BLOCKADE_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  });
  const base = await new Promise((resolve, reject) => {
    let output = "";
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`server exited before startup: ${code}`)));
    child.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
  });
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /src="\/app\.js"/);
  for (const [path, type] of [["/app.js", "javascript"], ["/styles.css", "css"]]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), new RegExp(type));
  }
  assert.equal((await fetch(base + "/health")).status, 200);
  for (const path of ["/.env", "/server.mjs", "/package.json"]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});
