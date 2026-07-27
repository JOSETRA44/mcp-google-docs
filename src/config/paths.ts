import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * Filesystem locations for everything the server persists between runs.
 *
 * All state lives under a single directory so that "log out and forget me" is one `rm -rf`, and
 * so the MCP server — which runs as a stdio subprocess with no controlling terminal — has a
 * predictable place to find credentials it cannot interactively ask for.
 */

/** Root of all persisted state. Overridable for tests and for sandboxed deployments. */
export function stateDir(): string {
  return process.env.GDOCS_NATIVE_HOME ?? join(homedir(), ".gdocs-native");
}

/** OAuth refresh/access tokens. Written with owner-only permissions. */
export function tokensPath(): string {
  return join(stateDir(), "tokens.json");
}

/** OAuth client id/secret, when supplied via file rather than environment. */
export function credentialsPath(): string {
  return join(stateDir(), "credentials.json");
}

/**
 * Cached results of runtime capability probes (e.g. whether this account has Developer Preview
 * access to comment and suggestion requests). Cached so we probe once rather than on every call.
 */
export function capabilitiesPath(): string {
  return join(stateDir(), "capabilities.json");
}

/**
 * Append-only record of every mutation: document, timestamp, the revision before the write and
 * the revision after. Because the default write mode is direct rather than suggestion-based,
 * this log is what makes an edit traceable back to a concrete restore point in Google's own
 * version history.
 */
export function mutationLogPath(): string {
  return join(stateDir(), "mutations.jsonl");
}

/** Create the state directory if absent. Safe to call repeatedly. */
export async function ensureStateDir(): Promise<string> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
