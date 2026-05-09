import { type EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

interface FrontmatterRange {
  readonly from: number;
  readonly to: number;
  readonly keyCount: number;
}

const FRONTMATTER_FENCE = "---";

function detectFrontmatterRange(state: EditorState): FrontmatterRange | null {
  const totalLines = state.doc.lines;
  if (totalLines < 2) return null;

  const firstLine = state.doc.line(1);
  if (firstLine.text !== FRONTMATTER_FENCE) return null;

  let closingLineNumber = -1;
  for (let lineNumber = 2; lineNumber <= totalLines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (line.text === FRONTMATTER_FENCE) {
      closingLineNumber = lineNumber;
      break;
    }
  }
  if (closingLineNumber < 0) return null;

  let keyCount = 0;
  for (let lineNumber = 2; lineNumber < closingLineNumber; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const trimmed = line.text.trimStart();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    // Top-level YAML keys start at column 0 and contain `:`.
    if (line.text.startsWith(" ") || line.text.startsWith("\t")) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex <= 0) continue;
    keyCount += 1;
  }

  const closingLine = state.doc.line(closingLineNumber);
  return { from: firstLine.from, to: closingLine.to, keyCount };
}

function isCursorInsideRange(state: EditorState, range: FrontmatterRange): boolean {
  for (const sel of state.selection.ranges) {
    if (sel.from <= range.to && sel.to >= range.from) return true;
  }
  return false;
}

const setCollapsedEffect = StateEffect.define<boolean>();

const collapsedField = StateField.define<boolean>({
  create: () => true,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setCollapsedEffect)) next = effect.value;
    }
    return next;
  },
});

class FrontmatterSummaryWidget extends WidgetType {
  constructor(
    private readonly keyCount: number,
    private readonly onExpand: () => void,
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-frontmatter-summary";
    const keyLabel = this.keyCount === 1 ? "1 key" : `${this.keyCount} keys`;
    button.textContent = `Frontmatter (${keyLabel})`;
    button.title = "Show frontmatter";
    button.setAttribute("aria-label", `Expand frontmatter (${keyLabel})`);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.onExpand();
    });
    return button;
  }

  override eq(other: WidgetType): boolean {
    return other instanceof FrontmatterSummaryWidget && other.keyCount === this.keyCount;
  }

  override ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown";
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const range = detectFrontmatterRange(view.state);
  if (!range) return Decoration.none;

  const collapsedPreference = view.state.field(collapsedField);
  const cursorInside = isCursorInsideRange(view.state, range);
  const effectiveCollapsed = collapsedPreference && !cursorInside;

  const builder = new RangeSetBuilder<Decoration>();
  if (effectiveCollapsed) {
    builder.add(
      range.from,
      range.to,
      Decoration.replace({
        widget: new FrontmatterSummaryWidget(range.keyCount, () => {
          view.dispatch({ effects: setCollapsedEffect.of(false) });
        }),
        block: true,
      }),
    );
  } else {
    builder.add(
      range.from,
      range.to,
      Decoration.mark({
        class: "cm-frontmatter-block",
        attributes: { "data-frontmatter": "true" },
      }),
    );
  }
  return builder.finish();
}

const frontmatterPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      const collapsedChanged =
        update.startState.field(collapsedField, false) !==
        update.state.field(collapsedField, false);
      if (update.docChanged || update.viewportChanged || update.selectionSet || collapsedChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (instance) => instance.decorations,
  },
);

const frontmatterTheme = EditorView.theme({
  ".cm-frontmatter-block": {
    backgroundColor: "color-mix(in srgb, var(--muted) 35%, transparent)",
    borderLeft: "2px solid color-mix(in srgb, var(--muted-foreground) 35%, transparent)",
    paddingLeft: "4px",
  },
  ".cm-frontmatter-summary": {
    display: "block",
    width: "100%",
    margin: "2px 0",
    padding: "4px 8px",
    fontSize: "0.85em",
    fontWeight: "600",
    color: "var(--muted-foreground)",
    backgroundColor: "color-mix(in srgb, var(--muted) 50%, transparent)",
    border: "1px solid color-mix(in srgb, var(--muted-foreground) 25%, transparent)",
    borderRadius: "4px",
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  ".cm-frontmatter-summary:hover": {
    color: "var(--foreground)",
    backgroundColor: "color-mix(in srgb, var(--muted) 70%, transparent)",
  },
});

export const frontmatterExtensions = [collapsedField, frontmatterPlugin, frontmatterTheme];
