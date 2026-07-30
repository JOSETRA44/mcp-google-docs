import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Where each MCP client keeps its server configuration.
 *
 * Every client invented its own location and, in two cases, its own key name. Encoding that here
 * is what makes a single `install` command work everywhere instead of asking the user to find and
 * hand-edit a JSON file whose path they have no reason to know.
 */

export interface McpClient {
  id: string;
  /** Name shown to the user. */
  label: string;
  /** Absolute path to the config file, or undefined when the client cannot exist on this OS. */
  configPath: string | undefined;
  /**
   * Key under which servers are listed.
   *
   * Most clients use `mcpServers`; VS Code's native MCP support uses `servers`. Writing the wrong
   * one produces a config file that parses fine and does nothing, which is the most annoying
   * possible failure — so it is part of the client definition rather than an assumption.
   */
  serversKey: "mcpServers" | "servers";
  /** Shown after installing, since most clients only re-read config on restart. */
  restartHint: string;
  /**
   * Prefer the client's own CLI over editing its config file.
   *
   * Set where the config file is shared with live application state, so a read-modify-write from
   * outside could clobber changes the application made in between.
   */
  usesClaudeCli?: boolean;
}

function appData(): string | undefined {
  return process.env.APPDATA ?? undefined;
}

/** VS Code stores user-level config under a per-OS application directory. */
function vscodeUserDir(): string | undefined {
  const home = homedir();
  switch (platform()) {
    case "win32": {
      const base = appData();
      return base ? join(base, "Code", "User") : undefined;
    }
    case "darwin":
      return join(home, "Library", "Application Support", "Code", "User");
    default:
      return join(home, ".config", "Code", "User");
  }
}

function claudeDesktopDir(): string | undefined {
  const home = homedir();
  switch (platform()) {
    case "win32": {
      const base = appData();
      return base ? join(base, "Claude") : undefined;
    }
    case "darwin":
      return join(home, "Library", "Application Support", "Claude");
    default:
      return join(home, ".config", "Claude");
  }
}

export function knownClients(): McpClient[] {
  const home = homedir();
  const claudeDir = claudeDesktopDir();
  const codeDir = vscodeUserDir();

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      // Claude Code keeps global MCP servers in the same file as the rest of its user state.
      configPath: join(home, ".claude.json"),
      serversKey: "mcpServers",
      restartHint: "Run /mcp in Claude Code, or restart it.",
      usesClaudeCli: true,
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: claudeDir ? join(claudeDir, "claude_desktop_config.json") : undefined,
      serversKey: "mcpServers",
      restartHint: "Quit Claude Desktop completely and reopen it.",
    },
    {
      id: "cursor",
      label: "Cursor",
      configPath: join(home, ".cursor", "mcp.json"),
      serversKey: "mcpServers",
      restartHint: "Reload Cursor, or toggle the server in Settings → MCP.",
    },
    {
      id: "windsurf",
      label: "Windsurf",
      configPath: join(home, ".codeium", "windsurf", "mcp_config.json"),
      serversKey: "mcpServers",
      restartHint: "Reload Windsurf, or press Refresh in Settings → MCP.",
    },
    {
      id: "vscode",
      label: "VS Code",
      configPath: codeDir ? join(codeDir, "mcp.json") : undefined,
      serversKey: "servers",
      restartHint: "Reload the VS Code window.",
    },
    {
      id: "cline",
      label: "Cline (VS Code)",
      configPath: codeDir
        ? join(codeDir, "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
        : undefined,
      serversKey: "mcpServers",
      restartHint: "Reload the VS Code window.",
    },
  ];
}

export function findClient(id: string): McpClient | undefined {
  return knownClients().find((c) => c.id === id);
}
