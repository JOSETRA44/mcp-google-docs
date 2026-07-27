import type { docs_v1 } from "googleapis";

/**
 * A hand-built document exercising the structures that break naive walkers.
 *
 * Indices are written out explicitly rather than computed, so that a regression in the walk
 * shows up as a mismatch against numbers a human checked, not against numbers the walk itself
 * produced.
 *
 * Layout of the body (index: content):
 *
 * ```
 *   1..14   "Introducción\n"        TITLE
 *  14..25   "Resultados\n"          HEADING_1
 *  25..36   "Ver [img] aquí\n"      normal, with a 1-index inline image
 *  36..44   "Primero\n"             bulleted list item
 *  44..52   "Segundo\n"             bulleted list item
 *  52..62   table, 1 row x 2 columns
 * ```
 */

function textRun(content: string, startIndex: number): docs_v1.Schema$ParagraphElement {
  return {
    startIndex,
    endIndex: startIndex + content.length,
    textRun: { content, textStyle: {} },
  };
}

function paragraph(
  startIndex: number,
  endIndex: number,
  elements: docs_v1.Schema$ParagraphElement[],
  style?: docs_v1.Schema$ParagraphStyle,
  bullet?: docs_v1.Schema$Bullet,
): docs_v1.Schema$StructuralElement {
  return {
    startIndex,
    endIndex,
    paragraph: {
      elements,
      paragraphStyle: style ?? { namedStyleType: "NORMAL_TEXT" },
      ...(bullet ? { bullet } : {}),
    },
  };
}

const bodyContent: docs_v1.Schema$StructuralElement[] = [
  paragraph(1, 14, [textRun("Introducción\n", 1)], { namedStyleType: "TITLE" }),
  paragraph(14, 25, [textRun("Resultados\n", 14)], { namedStyleType: "HEADING_1" }),

  // The interesting one: an inline image sits between two text runs. It occupies exactly one
  // index and contributes no readable characters.
  paragraph(25, 36, [
    textRun("Ver ", 25),
    { startIndex: 29, endIndex: 30, inlineObjectElement: { inlineObjectId: "img-1" } },
    textRun(" aquí\n", 30),
  ]),

  paragraph(36, 44, [textRun("Primero\n", 36)], undefined, { listId: "list-bullet", nestingLevel: 0 }),
  paragraph(44, 52, [textRun("Segundo\n", 44)], undefined, { listId: "list-bullet", nestingLevel: 0 }),

  {
    startIndex: 52,
    endIndex: 62,
    table: {
      rows: 1,
      columns: 2,
      tableRows: [
        {
          startIndex: 53,
          endIndex: 61,
          tableCells: [
            { startIndex: 54, endIndex: 57, content: [paragraph(54, 57, [textRun("AB\n", 54)])] },
            { startIndex: 57, endIndex: 61, content: [paragraph(57, 61, [textRun("CDE\n", 57)])] },
          ],
        },
      ],
    },
  },
];

/** A document with a single tab, a header segment, a list definition and one inline image. */
export const sampleDocument: docs_v1.Schema$Document = {
  documentId: "doc-sample",
  title: "Documento de prueba",
  revisionId: "rev-1",
  tabs: [
    {
      tabProperties: { tabId: "tab-main", title: "Principal", index: 0 },
      documentTab: {
        body: { content: bodyContent },
        headers: {
          "header-1": {
            headerId: "header-1",
            content: [paragraph(0, 11, [textRun("Encabezado\n", 0)])],
          },
        },
        lists: {
          "list-bullet": {
            listProperties: {
              // No glyphType means a symbol bullet, i.e. an unordered list.
              nestingLevels: [{ glyphSymbol: "●" }],
            },
          },
          "list-number": {
            listProperties: {
              nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0." }],
            },
          },
        },
        inlineObjects: {
          "img-1": {
            objectId: "img-1",
            inlineObjectProperties: {
              embeddedObject: {
                title: "Gráfico de resultados",
                imageProperties: { contentUri: "https://lh3.googleusercontent.com/fake" },
                size: { width: { magnitude: 300, unit: "PT" }, height: { magnitude: 200, unit: "PT" } },
              },
            },
          },
        },
        namedRanges: {
          conclusion: {
            name: "conclusion",
            namedRanges: [
              {
                namedRangeId: "nr-1",
                name: "conclusion",
                ranges: [{ startIndex: 14, endIndex: 25, segmentId: "", tabId: "tab-main" }],
              },
            ],
          },
        },
      },
      childTabs: [
        {
          tabProperties: { tabId: "tab-child", title: "Anexo", index: 0, parentTabId: "tab-main" },
          documentTab: {
            body: { content: [paragraph(1, 7, [textRun("Anexo\n", 1)], { namedStyleType: "HEADING_2" })] },
          },
        },
      ],
    },
  ],
};
