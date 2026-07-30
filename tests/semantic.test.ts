import { describe, expect, it } from "vitest";
import { parseDocument } from "../src/core/document.js";
import { AddressError, findTextMatches, resolveAddress, similarity } from "../src/core/address/resolve.js";
import { renderMarkdown, renderOutline } from "../src/core/markdown/render.js";
import { insertParagraphAfter, replaceRange } from "../src/core/mutate/intents.js";
import { orderRequests, at } from "../src/core/mutate/plan.js";
import { sampleDocument } from "./fixtures/sample-document.js";

const doc = parseDocument(sampleDocument);

describe("block identity", () => {
  it("is stable across re-parses of the same content", () => {
    const again = parseDocument(sampleDocument);
    expect(again.blocks.map((b) => b.id)).toEqual(doc.blocks.map((b) => b.id));
  });

  it("survives content moving to a different index", () => {
    // Simulate a collaborator inserting a paragraph above: every index shifts, no text changes.
    const shifted = structuredClone(sampleDocument);
    const body = shifted.tabs![0]!.documentTab!.body!.content!;
    for (const element of body) {
      if (element.startIndex !== undefined && element.startIndex !== null) element.startIndex += 50;
      if (element.endIndex !== undefined && element.endIndex !== null) element.endIndex += 50;
    }

    const moved = parseDocument(shifted);
    const before = doc.blocks.find((b) => b.text === "Resultados")!;
    const after = moved.blocks.find((b) => b.text === "Resultados")!;

    // The index changed; the identity did not. This is the property the whole design rests on.
    expect(after.range.startIndex).not.toBe(before.range.startIndex);
    expect(after.id).toBe(before.id);
  });

  it("disambiguates identical text by ordinal", () => {
    const ids = doc.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("address resolution", () => {
  it("resolves a block handle to its text range", () => {
    const heading = doc.blocks.find((b) => b.text === "Resultados")!;
    const found = resolveAddress(doc, { kind: "block", id: heading.id });
    expect(found.method).toBe("block-id");
    expect(found.range).toEqual(heading.textRange);
  });

  it("resolves exact text to the precise span, not the whole block", () => {
    const found = resolveAddress(doc, { kind: "text", query: "Ver" });
    expect(found.method).toBe("exact");
    // "Ver" begins the paragraph that starts at index 25.
    expect(found.range.startIndex).toBe(25);
    expect(found.range.endIndex).toBe(28);
  });

  it("refuses to guess when text matches several places", () => {
    // "e" appears throughout; resolving it must fail loudly rather than pick one.
    expect(() => resolveAddress(doc, { kind: "text", query: "e" })).toThrow(AddressError);
    try {
      resolveAddress(doc, { kind: "text", query: "e" });
    } catch (error) {
      expect((error as AddressError).message).toMatch(/appears \d+ times/);
      expect((error as AddressError).candidates.length).toBeGreaterThan(0);
    }
  });

  it("honours an explicit occurrence", () => {
    const matches = findTextMatches(doc, "e");
    expect(matches.length).toBeGreaterThan(1);
    const found = resolveAddress(doc, { kind: "text", query: "e", occurrence: 2 });
    expect(found.range).toEqual(matches[1]!.range);
  });

  it("falls back to fuzzy matching for a paraphrase", () => {
    // Close to "Introducción" but not identical.
    const found = resolveAddress(doc, { kind: "text", query: "Introduccion" });
    expect(found.method).toBe("fuzzy");
    expect(found.block!.text).toBe("Introducción");
    expect(found.confidence).toBeGreaterThan(0.7);
  });

  it("reports a stale block handle as recoverable", () => {
    expect(() => resolveAddress(doc, { kind: "block", id: "zzzz" })).toThrow(/Read the document again/);
  });

  it("resolves a heading by text", () => {
    const found = resolveAddress(doc, { kind: "heading", text: "Resultados" });
    expect(found.method).toBe("heading");
    expect(found.block!.level).toBe(1);
  });

  it("resolves a named anchor", () => {
    const found = resolveAddress(doc, { kind: "anchor", name: "conclusion" });
    expect(found.method).toBe("anchor");
    expect(found.range.startIndex).toBe(14);
  });

  it("scores similarity sensibly", () => {
    expect(similarity("hola mundo", "hola mundo")).toBe(1);
    expect(similarity("hola mundo", "hola mundoo")).toBeGreaterThan(0.8);
    expect(similarity("hola mundo", "adiós planeta")).toBeLessThan(0.3);
  });
});

describe("markdown rendering", () => {
  it("renders headings, lists and tables", () => {
    const markdown = renderMarkdown(doc, { mode: "clean" });
    expect(markdown).toContain("# Introducción");
    expect(markdown).toContain("# Resultados");
    expect(markdown).toContain("- Primero");
    expect(markdown).toContain("| AB | CDE |");
  });

  it("substitutes inline images at their recorded offset", () => {
    const markdown = renderMarkdown(doc, { mode: "clean" });
    expect(markdown).toContain("Ver ![Gráfico de resultados](inline-object:img-1) aquí");
  });

  it("prefixes every block with its handle in addressed mode", () => {
    const markdown = renderMarkdown(doc, { mode: "addressed" });
    const heading = doc.blocks.find((b) => b.text === "Resultados")!;
    expect(markdown).toContain(`# {#${heading.id}} Resultados`);
  });

  it("does not render table cells twice", () => {
    const markdown = renderMarkdown(doc, { mode: "clean" });
    // "AB" must appear only inside the table row, not also as a standalone paragraph.
    expect(markdown.match(/AB/g)).toHaveLength(1);
  });

  it("excludes header segments unless asked", () => {
    expect(renderMarkdown(doc, {})).not.toContain("Encabezado");
    expect(renderMarkdown(doc, { includeSegments: true })).toContain("Encabezado");
  });

  it("produces an outline with handles", () => {
    const outline = renderOutline(doc);
    expect(outline).toContain("Introducción");
    expect(outline).toContain("Resultados");
  });
});

describe("request ordering", () => {
  it("orders requests by descending index so shifts never affect later ones", () => {
    const ordered = orderRequests([
      at(10, { insertText: { text: "a" } }),
      at(100, { insertText: { text: "b" } }),
      at(50, { insertText: { text: "c" } }),
    ]);
    expect(ordered.map((r) => r.insertText!.text)).toEqual(["b", "c", "a"]);
  });

  it("keeps the delete before the insert when both act at one index", () => {
    // A replacement is a delete plus an insert at the same anchor. If the sort reordered them,
    // the new text would be inserted and then immediately deleted again.
    const requests = replaceRange(
      { startIndex: 14, endIndex: 24, segmentId: "", tabId: "tab-main" },
      "Conclusiones",
    );
    const ordered = orderRequests(requests);
    expect(ordered[0]!.deleteContentRange).toBeDefined();
    expect(ordered[1]!.insertText?.text).toBe("Conclusiones");
  });

  it("resets an inserted paragraph so it does not inherit the target's style", () => {
    // Regression: inserting after a heading used to produce another heading. Paragraph style is
    // inherited no matter which side of the paragraph mark the text goes, so it must be reset.
    const heading = doc.blocks.find((b) => b.text === "Resultados")!;
    const requests = insertParagraphAfter(heading, "nuevo párrafo");

    const style = requests.find((r) => r.request.updateParagraphStyle)!;
    expect(style.request.updateParagraphStyle!.paragraphStyle!.namedStyleType).toBe("NORMAL_TEXT");

    // The reset must cover exactly the inserted text: it begins one index past the newline.
    const insertIndex = heading.textRange.endIndex;
    expect(style.request.updateParagraphStyle!.range).toMatchObject({
      startIndex: insertIndex + 1,
      endIndex: insertIndex + 1 + "nuevo párrafo".length,
    });

    // And it must run after the insert that created the text it styles.
    const ordered = orderRequests(requests);
    expect(ordered[0]!.insertText).toBeDefined();
    expect(ordered[1]!.updateParagraphStyle).toBeDefined();
  });

  it("clears bullets only when inserting after a list item", () => {
    const listItem = doc.blocks.find((b) => b.kind === "listItem")!;
    const afterList = insertParagraphAfter(listItem, "texto");
    expect(afterList.some((r) => r.request.deleteParagraphBullets)).toBe(true);

    // A plain paragraph never had bullets, so issuing the request would be dead weight on every
    // ordinary insert.
    const paragraph = doc.blocks.find((b) => b.kind === "paragraph")!;
    const afterParagraph = insertParagraphAfter(paragraph, "texto");
    expect(afterParagraph.some((r) => r.request.deleteParagraphBullets)).toBe(false);
  });

  it("skips the delete when the range is empty", () => {
    const requests = replaceRange({ startIndex: 5, endIndex: 5, segmentId: "", tabId: "t" }, "hi");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request.insertText).toBeDefined();
  });
});
