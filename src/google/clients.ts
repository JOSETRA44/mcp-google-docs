import { google, type docs_v1, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { loadAuthorizedClient } from "../auth/oauth.js";

/**
 * The single point at which this process talks to Google.
 *
 * Everything above this module works against `GoogleClients`, never against `googleapis`
 * directly. That is the one seam worth having: it is what lets the entire semantic layer be
 * tested against recorded document fixtures with no network, and it keeps credential handling
 * from leaking into business logic.
 */

export interface GoogleClients {
  docs: docs_v1.Docs;
  drive: drive_v3.Drive;
  auth: OAuth2Client;
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super(
      "Not signed in. Run `gdocs-native auth` to authorize access to your Google account.\n" +
        "The MCP server cannot open a browser on its own, so this is a one-time manual step.",
    );
    this.name = "NotAuthenticatedError";
  }
}

/**
 * Build authenticated clients from the stored session.
 *
 * Throws rather than returning null: every caller needs a session, and a distinct error type
 * gives the MCP layer something specific to translate into an actionable tool error.
 */
export async function createGoogleClients(): Promise<GoogleClients> {
  const auth = await loadAuthorizedClient();
  if (!auth) throw new NotAuthenticatedError();

  return {
    auth,
    docs: google.docs({ version: "v1", auth }),
    drive: google.drive({ version: "v3", auth }),
  };
}

let cached: Promise<GoogleClients> | undefined;

/**
 * Process-wide clients, created once.
 *
 * Caching the promise rather than the resolved value means concurrent tool calls during startup
 * share one initialization instead of racing to build competing clients.
 */
export function getGoogleClients(): Promise<GoogleClients> {
  cached ??= createGoogleClients();
  return cached;
}

/** Drop the cached clients, forcing the next call to rebuild them. Used after re-authentication. */
export function resetGoogleClients(): void {
  cached = undefined;
}
