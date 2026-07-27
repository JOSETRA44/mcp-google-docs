import { describe, expect, it } from "vitest";
import { OBJECT_PLACEHOLDER, walkDocument } from "../src/core/ast/walk.js";
import { normalizeWithMap, toRawRange } from "../src/core/ast/text.js";
import { sampleDocument } from "./fixtures/sample-document.js";

const result = walkDocument(sampleDocument);

describe("walkDocument", () => {
  it("preserves the one-character-per-index invariant on every block", () => {
    // This is the load-bearing property of the whole addressing scheme. If it ever fails, any
    // edit computed from a text offset lands at the wrong document index.
    for (const block of result.blocks) {
      const width = block.textRange.endIndex - block.textRange.startIndex;
      expect(
        block.text.length,
        `block "${block.text.slice(0, 30)}" has ${block.text.length} chars but spans ${width} indices`,
      ).toBe(width);
    }
  });

  it("represents a one-index inline image as exactly one placeholder character", () => {
    const withImage = result.blocks.find((b) => b.inlineObjectIds?.includes("img-1"));
    expect(withImage).toBeDefined();
    expect(withImage!.text).toBe(`Ver ${OBJECT_PLACEHOLDER} aquí`);
    // 4 + 1 + 5 = 10 characters, matching indices 25..35.
    expect(withImage!.text).toHaveLength(10);
    expect(withImage!.textRange).toMatchObject({ startIndex: 25, endIndex: 35 });
  });

  it("excludes the paragraph mark from textRange but keeps it in range", () => {
    const heading = result.blocks.find((b) => b.text === "Resultados")!;
    expect(heading.range).toMatchObject({ startIndex: 14, endIndex: 25 });
    expect(heading.textRange).toMatchObject({ startIndex: 14, endIndex: 24 });
  });

  it("classifies headings with their outline level", () => {
    const title = result.blocks.find((b) => b.text === "Introducción")!;
    expect(title.kind).toBe("heading");
    expect(title.level).toBe(1);
    expect(title.namedStyleType).toBe("TITLE");

    const heading = result.blocks.find((b) => b.text === "Resultados")!;
    expect(heading.level).toBe(1);
    expect(heading.namedStyleType).toBe("HEADING_1");
  });

  it("marks bulleted items as unordered lists", () => {
    const item = result.blocks.find((b) => b.text === "Primero")!;
    expect(item.kind).toBe("listItem");
    expect(item.ordered).toBe(false);
    expect(item.listDepth).toBe(0);
  });

  it("walks header segments under their own segment id", () => {
    const header = result.blocks.find((b) => b.text === "Encabezado")!;
    expect(header.range.segmentId).toBe("header-1");
    // Header indices are a separate space that legitimately starts at 0.
    expect(header.range.startIndex).toBe(0);
  });

  it("walks child tabs after their parent and tags every block with its tab", () => {
    expect(result.tabs.map((t) => t.tabId)).toEqual(["tab-main", "tab-child"]);
    expect(result.tabs[1]).toMatchObject({ depth: 1, parentTabId: "tab-main" });

    const annex = result.blocks.find((b) => b.text === "Anexo")!;
    expect(annex.range.tabId).toBe("tab-child");

    // Every body block of the main tab must carry that tab's id, or edits silently retarget.
    const intro = result.blocks.find((b) => b.text === "Introducción")!;
    expect(intro.range.tabId).toBe("tab-main");
  });

  it("captures table cells as addressable blocks with their grid position", () => {
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0]!;
    expect(table.rows).toBe(1);
    expect(table.columns).toBe(2);

    const [first, second] = table.cells[0]!;
    const firstBlock = result.blocks[first!.blocks[0]!]!;
    const secondBlock = result.blocks[second!.blocks[0]!]!;

    expect(firstBlock.text).toBe("AB");
    expect(secondBlock.text).toBe("CDE");
    expect(firstBlock.path.table).toEqual({ rowIndex: 0, columnIndex: 0 });
    expect(secondBlock.path.table).toEqual({ rowIndex: 0, columnIndex: 1 });
  });

  it("collects named ranges and inline object metadata", () => {
    expect(result.namedRanges.conclusion).toEqual([
      { startIndex: 14, endIndex: 25, segmentId: "", tabId: "tab-main" },
    ]);
    expect(result.inlineObjects["img-1"]).toMatchObject({
      objectId: "img-1",
      altTitle: "Gráfico de resultados",
      widthPt: 300,
      heightPt: 200,
    });
  });
});

describe("offset mapping through normalization", () => {
  it("maps a match found in normalized text back to exact document indices", () => {
    // Docs stores curly quotes; an agent searches with straight ones. The match has to survive
    // that substitution and still yield indices that address the original characters.
    const stored = "Dijo “hola mundo” y se fue";
    const norm = normalizeWithMap(stored);

    const needle = normalizeWithMap('"hola mundo"', {}).text;
    const at = norm.text.indexOf(needle);
    expect(at).toBeGreaterThan(-1);

    const raw = toRawRange(norm, at, at + needle.length);
    expect(stored.slice(raw.start, raw.end)).toBe("“hola mundo”");
  });

  it("keeps offsets exact when a character folds into several", () => {
    // The ellipsis is one stored character but three normalized ones.
    const stored = "fin… y algo";
    const norm = normalizeWithMap(stored);
    expect(norm.text).toBe("fin... y algo");

    const at = norm.text.indexOf("...");
    const raw = toRawRange(norm, at, at + 3);
    expect(stored.slice(raw.start, raw.end)).toBe("…");
  });
});
