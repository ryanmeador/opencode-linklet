import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";

/** Discover only; never start a server from inside a plugin. */
export async function connect(options: Record<string, unknown>): Promise<OpenCodeClient> {
  const server = options.server as { url?: string; tokenEnv?: string; usernameEnv?: string; passwordEnv?: string } | undefined;
  let client: OpenCodeClient;
  if (server?.url) {
    if (server.tokenEnv && server.passwordEnv) throw new Error("Choose one server sign-in method: tokenEnv for a Bearer token, or passwordEnv (with optional usernameEnv) for Basic authentication. Remove the other setting.");
    const token = server.tokenEnv ? process.env[server.tokenEnv] : undefined;
    if (server.tokenEnv && !token) throw new Error(`Environment variable ${server.tokenEnv} is not set in the OpenCode server process. Make it available there, or change options.server.tokenEnv in the plugin configuration.`);
    const password = server.passwordEnv ? process.env[server.passwordEnv] : undefined;
    if (server.passwordEnv && !password) throw new Error(`Environment variable ${server.passwordEnv} is not set in the OpenCode server process. Make it available there, or change options.server.passwordEnv in the plugin configuration.`);
    const username = server.usernameEnv ? process.env[server.usernameEnv] : "opencode";
    if (server.usernameEnv && !username) throw new Error(`Environment variable ${server.usernameEnv} is not set in the OpenCode server process. Set it there, or omit options.server.usernameEnv to use the username opencode.`);
    const authorization = token ? `Bearer ${token}` : password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : undefined;
    client = OpenCode.make({ baseUrl: server.url, headers: authorization ? { authorization } : undefined });
  } else {
    const endpoint = await Service.discover();
    if (!endpoint) throw new Error("Linklet could not find a managed OpenCode server. If you use opencode serve or --standalone, set options.server.url in the plugin configuration to the URL of the server running this session. Linklet did not start another server.");
    client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  }
  let info;
  try { info = await client.server.info({ signal: AbortSignal.timeout(5000) }); }
  catch (error) {
    throw new Error("Linklet could not verify the OpenCode server. Make sure that server is running, and check the URL and authentication settings under options.server in the plugin configuration.", { cause: error });
  }
  if (info.pid !== process.pid)
    throw new Error("Linklet found a different OpenCode server, so it did not connect. Set options.server.url in the plugin configuration to the server running this session. No sessions were created or messages sent by this call.");
  return client;
}
