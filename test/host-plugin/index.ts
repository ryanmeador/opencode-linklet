// Isolated validation harness only. This RPC is never included in the package.
import { Plugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";
const linklet: typeof import("../../src/index.js")["default"] =
  (await import(process.env.LINKLET_VALIDATION_ENTRY!)).default;

const contract = Rpc.define({ id: "linklet.validation", methods: {
  invoke: { input: { type: "object" }, output: { type: "object" } },
  stored: { input: { type: "object" }, output: {} },
}, events: {} });
export default Plugin.define({ id: "linklet", async setup(ctx) {
  await linklet.setup(ctx);
  await ctx.rpc.register(contract, {
    invoke: async (value) => {
      const input = value as { tool: string; args: unknown; sessionID: string; agent: string };
      const tool = (await ctx.tool.list()).find(tool => tool.id === input.tool);
      if (!tool) throw new Error(`Tool not registered: ${input.tool}`);
      const context = { sessionID: input.sessionID, agent: input.agent, messageID: "msg_validation", id: "call_validation",
        signal: AbortSignal.timeout(15000), progress: async () => {} };
      return tool.execute(input.args, context as unknown as Parameters<typeof tool.execute>[1]);
    },
    stored: async (value) => (await ctx.storage.get((value as { key: string }).key)) ?? null,
  });
} });
