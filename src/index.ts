import { Command } from "commander";
import { authorize } from "./auth/oauth.js";
import { clearTokens, loadClientCredentials, loadTokens } from "./auth/store.js";
import { ALL_SCOPES } from "./auth/scopes.js";
import { getGoogleClients, resetGoogleClients } from "./google/clients.js";
import { findDocuments } from "./google/drive.js";
import { stateDir } from "./config/paths.js";

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
  .version("0.1.0");

program
  .command("auth")
  .description("Sign in to Google and store credentials for the MCP server")
  .option("--no-open", "print the authorization URL instead of launching a browser")
  .action(async (options: { open: boolean }) => {
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
