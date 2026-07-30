import { mkdir, readFile, writeFile, copyFile, access } from "node:fs/promises";
import { dirname } from "node:path";
import { knownClients, type McpClient } from "./clients.js";

/**
 * Registering this server with whichever MCP clients are installed.
 *
 * The whole point is that a user should not have to learn where six different applications keep
 * their JSON, nor hand-merge a stanza into a file that already matters to them. The rules that
 * make this safe to run unattended:
 *
 *   - **Never clobber.** Existing config is read, the one entry is merged in, everything else is
 *     written back untouched.
 *   - **Never guess at damaged input.** A config file that does not parse is reported and skipped,
 *     never overwritten — it is far more likely to be a file worth keeping than a file worth
 *     replacing.
 *   - **Back up before writing**, so a mistake is always one `cp` from undone.
 */

/** Name the server appears under in the client's UI. */
export const SERVER_NAME = "gdocs-native";

export interface ServerEntry {
  command: string;
  args: string[];
}

/**
 * The command a client will run.
 *
 * `npx -y <package> mcp` rather than an absolute path to a local build: it keeps working after the
 * package updates, needs no global install, and does not embed a path that breaks the moment the
 * user moves the folder.
 */
export function defaultEntry(packageSpec = SERVER_NAME): ServerEntry {
  return { command: "npx", args: ["-y", packageSpec, "mcp"] };
}

export type InstallStatus =
  | "installed"
  | "updated"
  | "unchanged"
  | "removed"
  | "absent"
  | "unparsable"
  | "failed";

export interface InstallOutcome {
  client: McpClient;
  status: InstallStatus;
  detail?: string;
  backupPath?: string;
}

/**
 * Register with Claude Code through its own CLI rather than by editing its config file.
 *
 * `~/.claude.json` holds far more than MCP servers and is written by Claude Code while it runs —
 * quite possibly while this command runs, since the two are often used together. Rewriting the
 * whole file from a snapshot read moments earlier would silently drop anything the application
 * wrote in between. Delegating to `claude mcp add-json` hands the update to the process that owns
 * the file.
 *
 * Returns null when the CLI is unavailable, so the caller can fall back to editing the file.
 */
async function installViaClaudeCli(entry: ServerEntry, dryRun: boolean): Promise<InstallStatus | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const invoke = (args: string[]) =>
    run("claude", args, { shell: process.platform === "win32", windowsHide: true });

  try {
    await invoke(["mcp", "get", SERVER_NAME]);
    // Already registered. Re-adding would fail, and there is no way to tell from the CLI whether
    // the stored command matches, so it is refreshed rather than assumed correct.
    if (dryRun) return "updated";
    await invoke(["mcp", "remove", SERVER_NAME, "--scope", "user"]).catch(() => undefined);
  } catch {
    if (dryRun) return "installed";
  }

  try {
    await invoke([
      "mcp",
      "add-json",
      SERVER_NAME,
      JSON.stringify({ type: "stdio", command: entry.command, args: entry.args }),
      "--scope",
      "user",
    ]);
    return "installed";
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface LoadedConfig {
  data: Record<string, unknown>;
  existed: boolean;
}

async function loadConfig(path: string): Promise<LoadedConfig | "unparsable"> {
  if (!(await exists(path))) return { data: {}, existed: false };

  const raw = await readFile(path, "utf8");
  if (raw.trim().length === 0) return { data: {}, existed: true };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unparsable";
    return { data: parsed as Record<string, unknown>, existed: true };
  } catch {
    // Some clients tolerate comments in their config. Rewriting such a file would strip them
    // along with anything else we failed to understand, so it is left alone.
    return "unparsable";
  }
}

async function backup(path: string): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  const backupPath = `${path}.gdocs-native-backup`;
  await copyFile(path, backupPath);
  return backupPath;
}

function sameEntry(a: unknown, b: ServerEntry): boolean {
  if (typeof a !== "object" || a === null) return false;
  const entry = a as Partial<ServerEntry>;
  return (
    entry.command === b.command &&
    Array.isArray(entry.args) &&
    entry.args.length === b.args.length &&
    entry.args.every((value, index) => value === b.args[index])
  );
}

/** Add or update this server in one client's config. */
export async function installInto(
  client: McpClient,
  entry: ServerEntry,
  options: { dryRun?: boolean; createMissing?: boolean } = {},
): Promise<InstallOutcome> {
  const { dryRun = false, createMissing = false } = options;

  if (!client.configPath) {
    return { client, status: "absent", detail: "not available on this operating system" };
  }

  if (client.usesClaudeCli) {
    const status = await installViaClaudeCli(entry, dryRun);
    if (status) return { client, status, detail: "via claude CLI" };
    // The CLI is missing or refused; editing the file directly is still better than nothing.
  }

  const configExists = await exists(client.configPath);
  // A client whose config file has never been created is almost always a client that is not
  // installed. Creating the file anyway would litter the home directory with configuration for
  // applications the user does not have.
  if (!configExists && !createMissing) {
    return { client, status: "absent", detail: "not detected" };
  }

  const loaded = await loadConfig(client.configPath);
  if (loaded === "unparsable") {
    return {
      client,
      status: "unparsable",
      detail: `${client.configPath} is not valid JSON — left untouched. Add the entry by hand.`,
    };
  }

  const servers = (loaded.data[client.serversKey] ?? {}) as Record<string, unknown>;
  const current = servers[SERVER_NAME];

  if (sameEntry(current, entry)) {
    return { client, status: "unchanged" };
  }

  if (dryRun) {
    return { client, status: current ? "updated" : "installed", detail: "(dry run)" };
  }

  try {
    const backupPath = await backup(client.configPath);
    await mkdir(dirname(client.configPath), { recursive: true });

    const next = {
      ...loaded.data,
      [client.serversKey]: { ...servers, [SERVER_NAME]: entry },
    };
    await writeFile(client.configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

    return {
      client,
      status: current ? "updated" : "installed",
      ...(backupPath ? { backupPath } : {}),
    };
  } catch (error) {
    return {
      client,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Remove this server from one client's config. */
export async function uninstallFrom(
  client: McpClient,
  options: { dryRun?: boolean } = {},
): Promise<InstallOutcome> {
  if (!client.configPath || !(await exists(client.configPath))) {
    return { client, status: "absent" };
  }

  const loaded = await loadConfig(client.configPath);
  if (loaded === "unparsable") {
    return { client, status: "unparsable", detail: `${client.configPath} is not valid JSON` };
  }

  const servers = (loaded.data[client.serversKey] ?? {}) as Record<string, unknown>;
  if (!(SERVER_NAME in servers)) return { client, status: "unchanged" };
  if (options.dryRun) return { client, status: "removed", detail: "(dry run)" };

  try {
    const backupPath = await backup(client.configPath);
    const { [SERVER_NAME]: _removed, ...rest } = servers;
    await writeFile(
      client.configPath,
      `${JSON.stringify({ ...loaded.data, [client.serversKey]: rest }, null, 2)}\n`,
      "utf8",
    );
    return { client, status: "removed", ...(backupPath ? { backupPath } : {}) };
  } catch (error) {
    return {
      client,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Install into every detected client, or into the ones named. */
export async function installAll(options: {
  clientIds?: string[];
  entry?: ServerEntry;
  dryRun?: boolean;
}): Promise<InstallOutcome[]> {
  const entry = options.entry ?? defaultEntry();
  const targets = options.clientIds?.length
    ? knownClients().filter((c) => options.clientIds!.includes(c.id))
    : knownClients();

  return Promise.all(
    targets.map((client) =>
      installInto(client, entry, {
        dryRun: options.dryRun ?? false,
        // Naming a client explicitly is a statement that it is installed, so its config is
        // created if missing. A blanket install only touches what it can see.
        createMissing: Boolean(options.clientIds?.length),
      }),
    ),
  );
}

export async function uninstallAll(options: { dryRun?: boolean } = {}): Promise<InstallOutcome[]> {
  return Promise.all(knownClients().map((client) => uninstallFrom(client, options)));
}
