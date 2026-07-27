import { z } from "zod";
import type { Address } from "../core/address/resolve.js";
import { AddressError } from "../core/address/resolve.js";

/**
 * The agent-facing way of saying "this part of the document".
 *
 * Deliberately flat rather than a discriminated union: an agent filling in a JSON schema handles
 * `{block_id: "a3f1"}` or `{find: "some sentence"}` far more reliably than a nested
 * `{kind: "block", value: {...}}`. Exactly one field is expected, and supplying none or several
 * is an error rather than a precedence puzzle.
 */
export const addressFields = {
  block_id: z
    .string()
    .optional()
    .describe(
      "Block handle from a previous addressed read, e.g. 'a3f1'. The most precise way to point " +
        "at a block, and unaffected by edits elsewhere in the document.",
    ),
  find: z
    .string()
    .optional()
    .describe(
      "Text to locate. Matches the document even if it uses curly quotes or different spacing. " +
        "If nothing matches literally, the closest paragraph is used.",
    ),
  heading: z
    .string()
    .optional()
    .describe("Locate a heading by its text."),
  anchor: z
    .string()
    .optional()
    .describe("Name of a previously created anchor (named range)."),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Which match to use when 'find' appears more than once, counting from 1."),
} as const;

export interface AddressArgs {
  block_id?: string | undefined;
  find?: string | undefined;
  heading?: string | undefined;
  anchor?: string | undefined;
  occurrence?: number | undefined;
}

/** Build an `Address` from the flat tool arguments, rejecting ambiguous combinations. */
export function buildAddress(args: AddressArgs): Address {
  const supplied = [
    args.block_id !== undefined && "block_id",
    args.find !== undefined && "find",
    args.heading !== undefined && "heading",
    args.anchor !== undefined && "anchor",
  ].filter((v): v is string => Boolean(v));

  if (supplied.length === 0) {
    throw new AddressError(
      "No target given. Pass exactly one of: block_id, find, heading, or anchor.",
    );
  }
  if (supplied.length > 1) {
    throw new AddressError(
      `Pass exactly one target, but received ${supplied.join(" and ")}. ` +
        `Combining them is ambiguous.`,
    );
  }

  if (args.block_id !== undefined) return { kind: "block", id: args.block_id };
  if (args.heading !== undefined) return { kind: "heading", text: args.heading };
  if (args.anchor !== undefined) return { kind: "anchor", name: args.anchor };
  return {
    kind: "text",
    query: args.find!,
    ...(args.occurrence !== undefined ? { occurrence: args.occurrence } : {}),
  };
}
