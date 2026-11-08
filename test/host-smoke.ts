// Opt-in real-host validation. Uses a separate HOME/XDG tree and API server;
// never changes the user's configuration, service, sessions, or worktrees.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { Rpc } from "@opencode/plugin/rpc";
import { SYNTHETIC_SUFFIX } from "../src/transport.js";

const root = await mkdtemp("/tmp/opencode/linklet-validation-");
const project = resolve(root, "project");
await mkdir(project);
execFileSync("git", ["--no-pager", "init", project], { stdio: "ignore" });
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const address = socket.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>(done => socket.close(() => done()));
const url = `http://127.0.0.1:${port}`;
await mkdir(resolve(root, "config/opencode"), { recursive: true });
await writeFile(resolve(root, "config/opencode/opencode.json"), JSON.stringify({
  plugins: [{ package: resolve("test/host-plugin"), options: { server: { url,
    usernameEnv: "OPENCODE_SERVER_USERNAME", passwordEnv: "OPENCODE_SERVER_PASSWORD" } } }],
}));
const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: resolve(root, "config"),
  XDG_DATA_HOME: resolve(root, "data"), XDG_STATE_HOME: resolve(root, "state"), XDG_CACHE_HOME: resolve(root, "cache") };
for (const key of Object.keys(env)) if (key.startsWith("OPENCODE")) delete env[key];
env.OPENCODE_SERVER_USERNAME = "opencode";
env.OPENCODE_SERVER_PASSWORD = randomBytes(24).toString("hex");
env.LINKLET_VALIDATION_ENTRY = process.env.LINKLET_VALIDATION_ENTRY ?? resolve("dist/index.js");
let logs = "";
const start = () => {
  const process = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env });
  process.stderr.on("data", chunk => { logs += String(chunk); });
  const ready = new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${logs}`)), 20000);
    process.stdout.on("data", chunk => {
      logs += String(chunk);
      if (String(chunk).includes("http://")) { clearTimeout(timeout); done(); }
    });
    process.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${logs}`)); });
    process.once("error", reject);
  });
  return { process, ready };
};
let server = start();
const client = OpenCode.make({ baseUrl: url, headers: {
  authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
} });
const contract = Rpc.define({ id: "linklet.validation", methods: {
  invoke: { input: { type: "object" }, output: { type: "object" } },
  stored: { input: { type: "object" }, output: {} },
}, events: {} });
const rpc = client.rpc(contract);
try {
  await server.ready;
  const caller = await client.session.create({ location: { directory: project }, agent: "plan", title: "Validation caller" });
  const invoke = async (tool: string, args: object, sessionID = caller.id, agent = "plan") => {
    const result = await rpc.invoke({ tool: `linklet_${tool}`, args, sessionID, agent }, {
      location: { directory: project }, signal: AbortSignal.timeout(15000),
    }) as { content: string };
    return JSON.parse(result.content);
  };
  const projects = await invoke("find_projects", {});
  assert.ok(projects.projects.some((item: { id: string }) => item.id === caller.projectID));
  const idle = await invoke("create_session", { title: "Idle validation", agent: "Plan" });
  assert.equal(idle.status, "created");
  assert.equal((await client.session.get({ sessionID: idle.sessionID })).parentID, undefined);
  const body = " \n\tUTF-8: 😀\r\n  ";
  assert.equal((await invoke("send_message", { sessionID: idle.sessionID, text: body, delivery: "fyi" })).status, "admitted");
  const inbox = await client.session.inbox.list({ sessionID: idle.sessionID });
  const admitted = inbox.find(item => item.type === "synthetic" && item.payload.metadata?.["linklet.v1"]);
  assert.ok(admitted && admitted.type === "synthetic");
  assert.equal(admitted.payload.text.slice(admitted.payload.text.indexOf("\n\n") + 2, -SYNTHETIC_SUFFIX.length), body);
  assert.equal((await client.session.active())[idle.sessionID], undefined, "FYI must not wake an idle session");
  assert.equal((await invoke("send_message", { sessionID: idle.sessionID, text: "😀".repeat(16384), delivery: "fyi" })).status, "admitted");

  // Actual host permission prompt despite default '*' allow; approve once.
  const pendingCreate = invoke("create_session", { agent: "Build", title: "Cross-agent validation" });
  let request;
  for (let attempt = 0; attempt < 100; attempt++) {
    request = (await client.permission.request.list({ location: { directory: project } })).data.find(item => item.action === "linklet.cross_agent");
    if (request) break;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.ok(request, "Expected a real cross-agent approval prompt");
  await client.permission.reply({ sessionID: caller.id, requestID: request.id, decision: "once" });
  const built = await pendingCreate;
  assert.equal(built.status, "created");
  assert.equal((await invoke("send_message", { sessionID: built.sessionID, text: "Follow-up", delivery: "fyi" })).status, "admitted");
  assert.equal((await invoke("send_message", { sessionID: caller.id, text: "Reply", delivery: "fyi" }, built.sessionID, "build")).status, "admitted");
  await client.location.reload();
  assert.equal((await invoke("send_message", { sessionID: built.sessionID, text: "After reload", delivery: "fyi" })).status, "admitted");

  const waitForApproval = async (action: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = (await client.permission.request.list({ location: { directory: project } })).data.find(item => item.action === action);
      if (found) return found;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Expected approval prompt: ${action}`);
  };
  const unrelated = await client.session.create({ location: { directory: project }, agent: "build" });
  const firstSend = invoke("send_message", { sessionID: unrelated.id, text: "Preauthorize", delivery: "fyi" });
  request = await waitForApproval("linklet.cross_agent");
  await client.permission.reply({ sessionID: caller.id, requestID: request.id, decision: "always" });
  assert.equal((await firstSend).status, "admitted");
  const another = await client.session.create({ location: { directory: project }, agent: "build" });
  assert.equal((await invoke("send_message", { sessionID: another.id, text: "Saved approval", delivery: "fyi" })).status, "admitted");

  const otherDirectory = resolve(root, "other-project");
  await mkdir(otherDirectory);
  execFileSync("git", ["--no-pager", "init", otherDirectory], { stdio: "ignore" });
  const foreign = await client.session.create({ location: { directory: otherDirectory }, agent: "build" });
  assert.equal((await invoke("send_message", { sessionID: foreign.id, text: "Known ID across projects", delivery: "fyi" })).status, "admitted");
  const channelKey = `v1/channel/${[caller.id, foreign.id].sort().map(encodeURIComponent).join("/")}`;
  const record = await rpc.stored({ key: channelKey }, { location: { directory: otherDirectory } });
  assert.ok(record, "Channel storage must be visible from both projects");

  await client.session.update({ sessionID: caller.id, permissions: [{ action: "linklet.send_message", resource: built.sessionID, effect: "deny" }] });
  await assert.rejects(invoke("send_message", { sessionID: built.sessionID, text: "Must be denied", delivery: "fyi" }));
  const found = await invoke("find_sessions", {});
  assert.ok(found.sessions.some((item: { sessionID: string }) => item.sessionID === idle.sessionID));
  await client.session.update({ sessionID: caller.id, permissions: [] });
  server.process.kill("SIGTERM");
  await once(server.process, "exit");
  server = start();
  await server.ready;
  assert.equal((await invoke("send_message", { sessionID: built.sessionID, text: "After server restart", delivery: "fyi" })).status, "admitted");
  console.log(`Host validation passed (OpenCode ${(await client.server.info()).version}). Artifacts: ${root}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (server.process.exitCode === null && server.process.signalCode === null) {
    server.process.kill("SIGTERM");
    await once(server.process, "exit");
  }
}
