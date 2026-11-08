import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { connect } from "../src/connection.js";

test("missing credential errors name the server environment and the setting to fix", async () => {
  const variable = `LINKLET_TEST_UNSET_${randomUUID().replaceAll("-", "")}`;
  for (const setting of ["tokenEnv", "passwordEnv", "usernameEnv"]) {
    await assert.rejects(connect({ server: { url: "http://127.0.0.1:0", [setting]: variable } }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not set in the OpenCode server process/);
      assert.ok(error.message.includes(variable));
      assert.ok(error.message.includes(`options.server.${setting}`));
      return true;
    });
  }
});

test("conflicting authentication settings say which alternatives to choose, before requesting secrets", async () => {
  await assert.rejects(connect({ server: { url: "http://127.0.0.1:0", tokenEnv: "unused-token", passwordEnv: "unused-password" } }),
    /Choose one server sign-in method.*Remove the other setting/);
});

test("server verification errors explain the remedy without exposing authentication details", async t => {
  let status = 401;
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 401 ? { _tag: "UnauthorizedError", message: "Authentication required" } : {
      version: "2.2.6", pid: process.pid + 1, hostname: "test", urls: [], paths: { tmp: "/tmp/opencode" },
      capabilities: { persistentPty: false },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const serverOptions = { url: `http://127.0.0.1:${address.port}` };
  await assert.rejects(connect({ server: serverOptions }), /Make sure that server is running.*URL and authentication settings under options.server/);
  status = 200;
  await assert.rejects(connect({ server: serverOptions }), /different OpenCode server.*options.server.url.*No sessions were created or messages sent/);
});
