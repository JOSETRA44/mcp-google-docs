import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultEntry,
  installInto,
  SERVER_NAME,
  uninstallFrom,
} from "../src/install/install.js";
import type { McpClient } from "../src/install/clients.js";

let dir: string;

function client(overrides: Partial<McpClient> = {}): McpClient {
  return {
    id: "test",
    label: "Test Client",
    configPath: join(dir, "config.json"),
    serversKey: "mcpServers",
    restartHint: "restart",
    ...overrides,
  };
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gdocs-install-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("installing into a client config", () => {
  it("reports a client as absent rather than creating config for software that is not installed", async () => {
    const outcome = await installInto(client(), defaultEntry());
    expect(outcome.status).toBe("absent");
    expect(existsSync(join(dir, "config.json"))).toBe(false);
  });

  it("adds the server to an existing config", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));

    const outcome = await installInto(client(), defaultEntry());
    expect(outcome.status).toBe("installed");
    expect(read(path).mcpServers[SERVER_NAME]).toEqual({
      command: "npx",
      args: ["-y", "gdocs-native", "mcp"],
    });
  });

  it("preserves every other server and every unrelated key", async () => {
    // The single most important property: these files hold configuration the user cares about,
    // and an installer that flattens them is worse than no installer.
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        theme: "dark",
        mcpServers: { other: { command: "node", args: ["other.js"] } },
        somethingElse: { nested: [1, 2, 3] },
      }),
    );

    await installInto(client(), defaultEntry());
    const result = read(path);

    expect(result.theme).toBe("dark");
    expect(result.somethingElse).toEqual({ nested: [1, 2, 3] });
    expect(result.mcpServers.other).toEqual({ command: "node", args: ["other.js"] });
    expect(result.mcpServers[SERVER_NAME]).toBeDefined();
  });

  it("is idempotent", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));

    expect((await installInto(client(), defaultEntry())).status).toBe("installed");
    expect((await installInto(client(), defaultEntry())).status).toBe("unchanged");
  });

  it("updates an entry whose command changed", async () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: "old", args: [] } } }),
    );

    const outcome = await installInto(client(), defaultEntry());
    expect(outcome.status).toBe("updated");
    expect(read(path).mcpServers[SERVER_NAME].command).toBe("npx");
  });

  it("refuses to touch a config it cannot parse", async () => {
    // Several clients tolerate comments in their config. Rewriting such a file would silently
    // strip them, so a file we do not fully understand is reported and left exactly as it is.
    const path = join(dir, "config.json");
    const original = '{ // a comment\n  "mcpServers": {} }';
    writeFileSync(path, original);

    const outcome = await installInto(client(), defaultEntry());
    expect(outcome.status).toBe("unparsable");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("backs up the previous config before writing", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: {}, keepMe: true }));

    const outcome = await installInto(client(), defaultEntry());
    expect(outcome.backupPath).toBeDefined();
    expect(read(outcome.backupPath!).keepMe).toBe(true);
    expect(read(outcome.backupPath!).mcpServers[SERVER_NAME]).toBeUndefined();
  });

  it("writes under the servers key the client actually uses", async () => {
    // VS Code uses `servers`; writing `mcpServers` there produces a file that parses fine and
    // does nothing at all.
    const path = join(dir, "vscode.json");
    writeFileSync(path, JSON.stringify({ servers: {} }));

    await installInto(client({ configPath: path, serversKey: "servers" }), defaultEntry());
    const result = read(path);
    expect(result.servers[SERVER_NAME]).toBeDefined();
    expect(result.mcpServers).toBeUndefined();
  });

  it("creates the config when the client was named explicitly", async () => {
    const path = join(dir, "nested", "deep", "config.json");
    const outcome = await installInto(client({ configPath: path }), defaultEntry(), {
      createMissing: true,
    });
    expect(outcome.status).toBe("installed");
    expect(read(path).mcpServers[SERVER_NAME]).toBeDefined();
  });

  it("changes nothing on a dry run", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));

    const outcome = await installInto(client(), defaultEntry(), { dryRun: true });
    expect(outcome.status).toBe("installed");
    expect(read(path).mcpServers[SERVER_NAME]).toBeUndefined();
  });

  it("treats an empty file as empty config rather than as damaged", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, "");

    const outcome = await installInto(client(), defaultEntry());
    expect(outcome.status).toBe("installed");
  });
});

describe("uninstalling", () => {
  it("removes only this server", async () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          [SERVER_NAME]: { command: "npx", args: [] },
          other: { command: "node", args: [] },
        },
      }),
    );

    const outcome = await uninstallFrom(client());
    expect(outcome.status).toBe("removed");

    const result = read(path);
    expect(result.mcpServers[SERVER_NAME]).toBeUndefined();
    expect(result.mcpServers.other).toBeDefined();
  });

  it("does nothing when the server was never installed", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { other: {} } }));
    expect((await uninstallFrom(client())).status).toBe("unchanged");
  });
});
