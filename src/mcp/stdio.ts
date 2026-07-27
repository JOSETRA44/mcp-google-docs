import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * Run the MCP server over stdio.
 *
 * stdout is the protocol channel: anything written to it that is not a framed MCP message
 * corrupts the stream and the client drops the connection. All diagnostics therefore go to
 * stderr, and any library that might print to stdout must be kept off this path.
 */
export async function runStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error("gdocs-native MCP server ready on stdio");

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void server.close().finally(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    transport.onclose = shutdown;
  });
}
