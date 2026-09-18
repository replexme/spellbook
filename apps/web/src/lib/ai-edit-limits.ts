import capabilities from "../../../../contracts/native-edit-capabilities.json";

/*
 * What AI cannot change in a file, said before the file is opened. Each
 * limit rests on the document worker's element graph and on what the editor
 * engine reported it can do. Without an engine report only the limits that
 * hold on every engine are listed.
 */

export type AiEditLimitKind = "ole" | "linked_chart" | "diagram" | "table";

export type AiEditLimit = {
  kind: AiEditLimitKind;
  /** Elements of this kind in the file. */
  count: number;
  /** 0-based slide positions, in order. */
  slides: number[];
};

/** The editor engine as its observations reported it. */
export type EditorEngineFacts = {
  patchLevel: string | null;
  supportedOperations: string[];
};

type GraphElement = { graphicKind?: unknown; externalData?: unknown };
type GraphSlide = { slideIndex: number; elements?: GraphElement[] };

const operations = capabilities.mutationModel.operations as Record<
  string,
  { minEnginePatch?: number }
>;

function patchNumber(patchLevel: string | null) {
  const match = /^(?:browser-)?undo-v([1-9][0-9]*)$/.exec(patchLevel ?? "");
  return match ? Number(match[1]) : 0;
}

/** Same rule the AI connector applies before it sends an edit. */
export function engineSupports(engine: EditorEngineFacts, operation: string) {
  const contract = operations[operation];
  if (!contract) return false;
  return (
    (contract.minEnginePatch ?? 0) <= patchNumber(engine.patchLevel) ||
    engine.supportedOperations.includes(operation)
  );
}

export function aiEditLimits(
  slides: GraphSlide[],
  engine: EditorEngineFacts | null,
): AiEditLimit[] {
  const found = new Map<AiEditLimitKind, { count: number; slides: Set<number> }>();
  const add = (kind: AiEditLimitKind, slideIndex: number) => {
    const entry = found.get(kind) ?? { count: 0, slides: new Set<number>() };
    entry.count += 1;
    entry.slides.add(slideIndex);
    found.set(kind, entry);
  };
  for (const slide of slides)
    for (const element of slide.elements ?? []) {
      const kind = element.graphicKind;
      // Embedded objects from other programs have no edit operation at all.
      if (kind === "ole") add("ole", slide.slideIndex);
      // Chart data edits refuse charts whose data lives in another file.
      else if (kind === "chart" && element.externalData === true)
        add("linked_chart", slide.slideIndex);
      else if (kind === "diagram" && engine && !engineSupports(engine, "set_smartart_node"))
        add("diagram", slide.slideIndex);
      else if (kind === "table" && engine && !engineSupports(engine, "set_table_cell"))
        add("table", slide.slideIndex);
    }
  const order: AiEditLimitKind[] = ["diagram", "table", "linked_chart", "ole"];
  return order
    .filter((kind) => found.has(kind))
    .map((kind) => ({
      kind,
      count: found.get(kind)!.count,
      slides: [...found.get(kind)!.slides].sort((left, right) => left - right),
    }));
}
