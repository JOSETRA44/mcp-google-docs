import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { AddressInfo } from "node:net";
import { OAuth2Client } from "google-auth-library";
import { ALL_SCOPES } from "./scopes.js";
import { loadClientCredentials, loadTokens, saveTokens } from "./store.js";

/**
 * OAuth 2.0 authorization-code flow with PKCE over a loopback redirect.
 *
 * This is the flow Google prescribes for installed applications. It is used rather than a
 * device-code or service-account flow for two reasons:
 *
 *   - Documents belong to a *person*. A service account would act as a separate identity that
 *     has to be granted access to every document individually, and whose edits show up in the
 *     revision history as a robot nobody recognizes.
 *   - Desktop OAuth clients may redirect to any loopback port, so no redirect URI has to be
 *     pre-registered and no public callback host is needed.
 */

const LOOPBACK_HOST = "127.0.0.1";

/** How long to wait for the user to finish consenting in the browser before giving up. */
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

export class AuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthFlowError";
  }
}

/** PKCE verifier/challenge pair. */
function createPkcePair(): { verifier: string; challenge: string } {
  // 32 random bytes base64url-encoded lands comfortably inside the 43-128 char range RFC 7636
  // requires for a verifier.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function renderResultPage(title: string, detail: string, ok: boolean): string {
  const accent = ok ? "#188038" : "#c5221f";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0; color: #202124; }
  .card { max-width: 26rem; padding: 2.5rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; color: ${accent}; }
  p { margin: 0; color: #5f6368; }
  @media (prefers-color-scheme: dark) {
    body { background: #1f1f1f; color: #e8eaed; } p { color: #9aa0a6; }
  }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

/**
 * Run the interactive login and persist the resulting tokens.
 *
 * Returns the authenticated client so callers can immediately verify the session rather than
 * assuming success.
 */
export async function authorize(options: { openBrowser?: boolean } = {}): Promise<OAuth2Client> {
  const { openBrowser = true } = options;
  const { clientId, clientSecret } = await loadClientCredentials();
  const { verifier, challenge } = createPkcePair();
  // Guards against a hostile page on localhost racing our callback with a forged code.
  const expectedState = randomBytes(16).toString("hex");

  // Bind to port 0 so the OS assigns a free port; the redirect URI is only known after listen.
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });

  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://${LOOPBACK_HOST}:${port}/callback`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });

  const authUrl = client.generateAuthUrl({
    // Without offline access Google returns no refresh token and the session dies in an hour.
    access_type: "offline",
    scope: [...ALL_SCOPES],
    code_challenge_method: "S256" as never,
    code_challenge: challenge,
    state: expectedState,
    // Google only re-issues a refresh token when consent is actually shown. Forcing the prompt
    // means re-running `auth` reliably repairs a session with a lost or revoked refresh token.
    prompt: "consent",
  });

  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AuthFlowError(`Timed out after ${CONSENT_TIMEOUT_MS / 1000}s waiting for consent.`));
    }, CONSENT_TIMEOUT_MS);

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const finish = (status: number, page: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page);
        clearTimeout(timer);
      };

      const error = url.searchParams.get("error");
      if (error) {
        finish(400, renderResultPage("Authorization declined", error, false));
        reject(new AuthFlowError(`Authorization declined: ${error}`));
        return;
      }

      if (url.searchParams.get("state") !== expectedState) {
        finish(400, renderResultPage("Authorization failed", "State mismatch.", false));
        reject(new AuthFlowError("State mismatch — the callback did not originate from this login."));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        finish(400, renderResultPage("Authorization failed", "No authorization code.", false));
        reject(new AuthFlowError("Callback carried no authorization code."));
        return;
      }

      finish(200, renderResultPage("Signed in", "You can close this tab and return to the terminal.", true));
      resolve(code);
    });
  });

  console.error(`\nOpen this URL to authorize:\n\n  ${authUrl}\n`);
  if (openBrowser) {
    // Dynamic import keeps `open` off the startup path of the MCP server, which never logs in.
    const { default: open } = await import("open");
    await open(authUrl).catch(() => {
      console.error("Could not launch a browser automatically — open the URL above manually.");
    });
  }

  try {
    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier: verifier });
    if (!tokens.refresh_token) {
      throw new AuthFlowError(
        "Google returned no refresh token, so the session would expire within the hour. " +
          "Revoke this app at https://myaccount.google.com/permissions and run `auth` again.",
      );
    }
    client.setCredentials(tokens);
    await saveTokens(tokens);
    return client;
  } finally {
    server.close();
  }
}

/**
 * Build a client from stored tokens for non-interactive use.
 *
 * Returns null rather than throwing when there is no session, so callers can distinguish "not
 * logged in yet" from "logged in but broken" and give the user the right instruction.
 */
export async function loadAuthorizedClient(): Promise<OAuth2Client | null> {
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) return null;

  const { clientId, clientSecret } = await loadClientCredentials();
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(tokens);

  // google-auth-library refreshes the access token on demand and emits the new credentials.
  // Persisting them here means a long-running server never re-does the interactive flow.
  client.on("tokens", (fresh) => {
    void saveTokens(fresh);
  });

  return client;
}
