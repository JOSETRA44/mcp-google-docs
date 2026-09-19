import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { authorize } from "./auth/oauth.js";
import {
  defaultEntry,
  installAll,
  SERVER_NAME,
  uninstallAll,
  type InstallOutcome,
} from "./install/install.js";
import { clearTokens, loadClientCredentials, loadTokens } from "./auth/store.js";
import { ALL_SCOPES } from "./auth/scopes.js";
import { getGoogleClients, resetGoogleClients } from "./google/clients.js";
import { findDocuments } from "./google/drive.js";
import { credentialsPath, ensureStateDir, stateDir } from "./config/paths.js";

/**
 * Command-line entry point.
 *
 * Authentication is a CLI command rather than something the MCP server does on demand, because
 * the server speaks MCP over stdio: it has no terminal to print a URL to and no way to block on
 * a browser round-trip without stalling the transport.
 */

const program = new Command()
  .name("gdocs-native")
  .description("Semantic MCP server for Google Docs — edit by intent, not by index")
  .version("0.3.0");

program
  .command("auth")
  .description("Sign in to Google and store credentials for the MCP server")
  .option("--no-open", "print the authorization URL instead of launching a browser")
  .option(
    "-c, --credentials <path>",
    "path to the OAuth client JSON downloaded from Google Cloud Console",
  )
  .action(async (options: { open: boolean; credentials?: string }) => {
    // Accepting the downloaded file wherever it landed removes the one step users reliably get
    // wrong: knowing that it belongs at a specific path under a dot-directory they have never
    // opened.
    if (options.credentials) {
      const { copyFile } = await import("node:fs/promises");
      await ensureStateDir();
      await copyFile(options.credentials, credentialsPath());
      console.log(`Stored OAuth client from ${options.credentials}`);
    }

    await authorize({ openBrowser: options.open });
    resetGoogleClients();
    const { drive } = await getGoogleClients();
    const about = await drive.about.get({ fields: "user(displayName,emailAddress)" });
    const user = about.data.user;
    console.log(`\nSigned in as ${user?.displayName ?? "unknown"} <${user?.emailAddress ?? "?"}>`);
    console.log(`Credentials stored in ${stateDir()}`);
  });

program
  .command("logout")
  .description("Delete the stored session")
  .action(async () => {
    await clearTokens();
    resetGoogleClients();
    console.log("Session cleared.");
  });

program
  .command("doctor")
  .description("Diagnose configuration, credentials and API reachability")
  .action(async () => {
    let failures = 0;
    const pass = (label: string, detail = "") => console.log(`  ok    ${label}${detail && ` — ${detail}`}`);
    const fail = (label: string, detail: string) => {
      failures++;
      console.log(`  FAIL  ${label} — ${detail}`);
    };

    console.log(`\nState directory: ${stateDir()}\n`);

    try {
      const { clientId } = await loadClientCredentials();
      pass("OAuth client credentials", `${clientId.slice(0, 24)}…`);
    } catch (error) {
      fail("OAuth client credentials", error instanceof Error ? error.message : String(error));
      console.log(`\n${failures} check(s) failed.`);
      process.exitCode = 1;
      return;
    }

    const tokens = await loadTokens();
    if (!tokens?.refresh_token) {
      fail("Stored session", "not signed in — run `gdocs-native auth`");
      console.log(`\n${failures} check(s) failed.`);
      process.exitCode = 1;
      return;
    }
    pass("Stored session", "refresh token present");

    // A granted scope set narrower than what we request means some tools will fail later with a
    // confusing 403; surfacing it here turns that into one clear instruction now.
    const granted = new Set((tokens.scope ?? "").split(" ").filter(Boolean));
    const missing = ALL_SCOPES.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      fail("Granted scopes", `missing ${missing.join(", ")} — re-run \`gdocs-native auth\``);
    } else {
      pass("Granted scopes", `${ALL_SCOPES.length} of ${ALL_SCOPES.length}`);
    }

    try {
      const { drive } = await getGoogleClients();
      const about = await drive.about.get({ fields: "user(displayName,emailAddress)" });
      pass("Drive API", `${about.data.user?.emailAddress ?? "reachable"}`);
    } catch (error) {
      fail("Drive API", error instanceof Error ? error.message : String(error));
    }

    try {
      const docs = await findDocuments(undefined, 1);
      pass("Docs discovery", `${docs.length} document(s) visible`);
    } catch (error) {
      fail("Docs discovery", error instanceof Error ? error.message : String(error));
    }

    // Drive and Docs are separate APIs that must each be enabled. Drive alone is enough to sign
    // in and list files, so a project with only Drive enabled passes every check above and then
    // fails on the first real edit. Reading a document is the cheapest way to prove Docs works.
    try {
      const [sample] = await findDocuments(undefined, 1);
      if (!sample) {
        console.log("  skip  Docs API — no document available to test against");
      } else {
        const { getDocument } = await import("./google/docs.js");
        await getDocument(sample.id);
        pass("Docs API", "reachable and enabled");
      }
    } catch (error) {
      fail("Docs API", error instanceof Error ? error.message : String(error));
    }

    console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
    if (failures > 0) process.exitCode = 1;
  });

program
  .command("ls")
  .description("List or search your Google Docs")
  .argument("[query]", "filter by name")
  .option("-n, --limit <count>", "maximum results", "20")
  .action(async (query: string | undefined, options: { limit: string }) => {
    const results = await findDocuments(query, Number(options.limit));
    if (results.length === 0) {
      console.log("No documents found.");
      return;
    }
    for (const doc of results) {
      const when = doc.modifiedTime?.slice(0, 10) ?? "          ";
      console.log(`${when}  ${doc.id}  ${doc.name}`);
    }
  });

const STATUS_LABEL: Record<string, string> = {
  installed: "added",
  updated: "updated",
  unchanged: "already configured",
  removed: "removed",
  absent: "not detected",
  unparsable: "SKIPPED",
  failed: "FAILED",
};

function reportOutcomes(outcomes: InstallOutcome[]): number {
  let changed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "absent") continue;
    const label = STATUS_LABEL[outcome.status] ?? outcome.status;
    console.log(`  ${label.padEnd(18)} ${outcome.client.label}`);
    if (outcome.detail) console.log(`  ${"".padEnd(18)} ${outcome.detail}`);
    if (["installed", "updated", "removed"].includes(outcome.status)) changed++;
  }

  const undetected = outcomes.filter((o) => o.status === "absent");
  if (undetected.length > 0) {
    console.log(`\n  Not detected: ${undetected.map((o) => o.client.label).join(", ")}`);
    console.log(`  Install into one anyway with: gdocs-native install --client <id>`);
  }
  return changed;
}

program
  .command("install")
  .description("Register this server with every MCP client found on this machine")
  .option("-c, --client <ids...>", "only these clients (claude-code, claude-desktop, cursor, windsurf, vscode, cline)")
  .option("--local", "point clients at this checkout instead of the published package")
  .option("--dry-run", "show what would change without writing anything")
  .action(async (options: { client?: string[]; local?: boolean; dryRun?: boolean }) => {
    // A local checkout is registered by absolute path to its built entry point, which is what a
    // contributor testing their own changes needs; everyone else gets the published package.
    const entry = options.local
      ? { command: process.execPath, args: [fileURLToPath(new URL("index.js", import.meta.url)), "mcp"] }
      : defaultEntry();

    console.log(`\nRegistering "${SERVER_NAME}" as: ${entry.command} ${entry.args.join(" ")}\n`);

    const outcomes = await installAll({
      ...(options.client ? { clientIds: options.client } : {}),
      entry,
      dryRun: options.dryRun ?? false,
    });
    const changed = reportOutcomes(outcomes);

    if (options.dryRun) {
      console.log("\nDry run — nothing was written.\n");
      return;
    }

    if (changed > 0) {
      console.log("\nRestart the affected clients to pick this up:");
      for (const outcome of outcomes) {
        if (["installed", "updated"].includes(outcome.status)) {
          console.log(`  ${outcome.client.label}: ${outcome.client.restartHint}`);
        }
      }
    }

    const tokens = await loadTokens();
    console.log(
      tokens?.refresh_token
        ? "\nAlready signed in. You're ready to go.\n"
        : "\nNext: run `gdocs-native auth` to connect your Google account.\n",
    );
  });

program
  .command("uninstall")
  .description("Remove this server from every MCP client config")
  .option("--dry-run", "show what would change without writing anything")
  .action(async (options: { dryRun?: boolean }) => {
    console.log("");
    reportOutcomes(await uninstallAll({ dryRun: options.dryRun ?? false }));
    console.log("");
  });

program
  .command("setup")
  .description("Do everything at once: register with MCP clients, then sign in to Google")
  .action(async () => {
    console.log(`\nRegistering "${SERVER_NAME}" with detected MCP clients...\n`);
    reportOutcomes(await installAll({ entry: defaultEntry() }));

    const tokens = await loadTokens();
    if (tokens?.refresh_token) {
      console.log("\nAlready signed in to Google.\n");
    } else {
      console.log("\nOpening your browser to sign in to Google...\n");
      await authorize({ openBrowser: true });
      resetGoogleClients();
    }

    const { drive } = await getGoogleClients();
    const about = await drive.about.get({ fields: "user(emailAddress)" });
    console.log(`\nReady. Signed in as ${about.data.user?.emailAddress ?? "unknown"}.`);
    console.log("Restart your MCP client and ask it to list your Google Docs.\n");
  });

program
  .command("mcp")
  .description("Run the MCP server over stdio")
  .action(async () => {
    const { runStdioServer } = await import("./mcp/stdio.js");
    await runStdioServer();
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
