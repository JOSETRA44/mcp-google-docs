import { readFile, writeFile, rm, chmod } from "node:fs/promises";
import type { Credentials } from "google-auth-library";
import { credentialsPath, ensureStateDir, tokensPath } from "../config/paths.js";

/**
 * Persistence for OAuth client credentials and user tokens.
 *
 * The MCP server runs as a stdio subprocess: it has no terminal, cannot prompt, and cannot open
 * a browser mid-conversation without wrecking the transport. So authentication is a separate,
 * explicit CLI step (`gdocs-native auth`) and everything it produces must survive on disk for
 * the server to pick up silently.
 */

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** The shape Google Cloud Console hands you when you download an OAuth client. */
interface GoogleCredentialsFile {
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
  client_id?: string;
  client_secret?: string;
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/**
 * Resolve OAuth client credentials.
 *
 * Environment wins over file so that containerized and CI deployments need no filesystem setup.
 * The file branch accepts the console's download verbatim — asking a user to hand-edit JSON they
 * just downloaded is a needless step that invites typos.
 */
export async function loadClientCredentials(): Promise<OAuthClientCredentials> {
  const envId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const envSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }

  const path = credentialsPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new AuthConfigError(
      `No OAuth client credentials found.\n\n` +
        `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, or save your OAuth client to:\n` +
        `  ${path}\n\n` +
        `To create one: Google Cloud Console -> APIs & Services -> Credentials ->\n` +
        `Create credentials -> OAuth client ID -> Application type: "Desktop app".\n` +
        `Desktop clients permit loopback redirects on any port, which is what this CLI uses.\n` +
        `Enable the "Google Docs API" and "Google Drive API" for the same project.`,
    );
  }

  let parsed: GoogleCredentialsFile;
  try {
    parsed = JSON.parse(raw) as GoogleCredentialsFile;
  } catch (cause) {
    throw new AuthConfigError(`Credentials file at ${path} is not valid JSON: ${String(cause)}`);
  }

  const block = parsed.installed ?? parsed.web ?? parsed;
  const clientId = block.client_id;
  const clientSecret = block.client_secret;

  if (!clientId || !clientSecret) {
    throw new AuthConfigError(
      `Credentials file at ${path} is missing client_id or client_secret. ` +
        `Expected either the file downloaded from Google Cloud Console, or ` +
        `{"client_id": "...", "client_secret": "..."}.`,
    );
  }

  return { clientId, clientSecret };
}

/** Read stored tokens, or null when the user has never authenticated. */
export async function loadTokens(): Promise<Credentials | null> {
  try {
    const raw = await readFile(tokensPath(), "utf8");
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

/**
 * Persist tokens with owner-only permissions.
 *
 * Google omits `refresh_token` from every token response after the first, so a naive overwrite
 * silently discards it and forces re-authentication once the access token expires. Merging
 * against what is already on disk is what makes the session durable.
 */
export async function saveTokens(tokens: Credentials): Promise<void> {
  await ensureStateDir();
  const existing = await loadTokens();
  const merged: Credentials = {
    ...existing,
    ...tokens,
    refresh_token: tokens.refresh_token ?? existing?.refresh_token,
  };

  const path = tokensPath();
  await writeFile(path, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
  // writeFile's mode is ignored when the file already exists, so the permissions are reasserted.
  await chmod(path, 0o600).catch(() => {});
}

/** Forget the current session. */
export async function clearTokens(): Promise<void> {
  await rm(tokensPath(), { force: true });
}
