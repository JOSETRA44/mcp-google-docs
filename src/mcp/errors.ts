import { GoogleApiError } from "../google/errors.js";
import { NotAuthenticatedError } from "../google/clients.js";
import { PreviewUnavailableError } from "../google/capabilities.js";
import { ImageValidationError } from "../core/assets/image-info.js";
import { AddressError } from "../core/address/resolve.js";
import { AuthConfigError } from "../auth/store.js";

/**
 * Shape the MCP SDK expects a tool handler to return.
 *
 * The open index signature is required by the SDK's own result type, which permits arbitrary
 * extra fields alongside `content`.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Turn any thrown value into a tool error the agent can act on.
 *
 * An agent cannot read a stack trace or a raw HTTP status, but it can follow an instruction. So
 * each error kind is translated into a sentence that says what went wrong *and* what to do about
 * it — otherwise the agent's only recovery strategy is to retry the identical call forever.
 */
export function toToolError(error: unknown): ToolResult {
  // These carry messages written for the reader already — an address that matched nothing and
  // lists the near misses, an image that breaks a documented limit, a feature needing enrollment.
  // Wrapping them in further explanation would only bury the part that matters.
  if (
    error instanceof NotAuthenticatedError ||
    error instanceof AuthConfigError ||
    error instanceof PreviewUnavailableError ||
    error instanceof ImageValidationError ||
    error instanceof AddressError
  ) {
    return errorResult(error.message);
  }

  if (error instanceof GoogleApiError) {
    switch (error.kind) {
      case "revision_conflict":
        return errorResult(
          `${error.message}\nThis is recoverable: read the document again and reissue the edit.`,
        );
      case "unauthenticated":
      case "insufficient_scope":
        return errorResult(`${error.message}\nAsk the user to run \`gdocs-native auth\`.`);
      case "permission_denied":
        return errorResult(
          `${error.message}\nThe signed-in account can see this document but cannot edit it. ` +
            `Ask the user for edit access, or work on a copy.`,
        );
      case "not_found":
        return errorResult(
          `${error.message}\nCheck the document ID. A Docs URL looks like ` +
            `https://docs.google.com/document/d/DOCUMENT_ID/edit — the ID is the segment after /d/.`,
        );
      case "api_disabled":
        // Nothing the agent can do about this one, and no amount of retrying will help — the
        // message is written to be relayed to the user verbatim.
        return errorResult(error.message);
      case "preview_required":
        return errorResult(
          `${error.message}\nThis feature needs Google Workspace Developer Preview enrollment: ` +
            `https://developers.google.com/workspace/preview`,
        );
      case "transient":
        return errorResult(`${error.message}\nGoogle is throttling; retry in a few seconds.`);
      default:
        return errorResult(error.message);
    }
  }

  return errorResult(error instanceof Error ? error.message : String(error));
}

/** Wrap a tool handler so no exception escapes into the transport. */
export function guard<Args>(
  handler: (args: Args) => Promise<ToolResult>,
): (args: Args) => Promise<ToolResult> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      return toToolError(error);
    }
  };
}
