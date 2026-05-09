import { syntaxTree } from "@codemirror/language";
import { type EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

const HEADING_LEVEL_BY_NODE_NAME: Readonly<Record<string, number>> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
};

const BULLET_GLYPH = "•";

class BulletWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = `${BULLET_GLYPH} `;
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  override eq(other: WidgetType): boolean {
    return other instanceof BulletWidget;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const HIDDEN_MARK = Decoration.replace({});
const BULLET_MARK = Decoration.replace({ widget: new BulletWidget() });
const STRONG_MARK = Decoration.mark({ class: "cm-lp-strong" });
const EMPHASIS_MARK = Decoration.mark({ class: "cm-lp-em" });
const CODE_BLOCK_MARK = Decoration.mark({ class: "cm-lp-codeblock" });

const headingMarkCache = new Map<number, Decoration>();
function headingMark(level: number): Decoration {
  let cached = headingMarkCache.get(level);
  if (!cached) {
    cached = Decoration.mark({
      class: `cm-lp-heading cm-lp-heading-${level}`,
    });
    headingMarkCache.set(level, cached);
  }
  return cached;
}

function linkTextMark(url: string): Decoration {
  return Decoration.mark({
    class: "cm-lp-link",
    attributes: {
      "data-cm-lp-url": url,
      title: url,
    },
  });
}

function selectedLineRange(state: EditorState): { from: number; to: number } {
  const sel = state.selection.main;
  return {
    from: state.doc.lineAt(sel.from).number,
    to: state.doc.lineAt(sel.to).number,
  };
}

function isLineSelected(
  state: EditorState,
  pos: number,
  selected: { from: number; to: number },
): boolean {
  const lineNumber = state.doc.lineAt(pos).number;
  return lineNumber >= selected.from && lineNumber <= selected.to;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const state = view.state;
  const selected = selectedLineRange(state);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (nodeRef) => {
        const name = nodeRef.name;
        const node = nodeRef.node;

        if (name in HEADING_LEVEL_BY_NODE_NAME) {
          const level = HEADING_LEVEL_BY_NODE_NAME[name];
          if (level === undefined) return;
          builder.add(node.from, node.to, headingMark(level));
          if (!isLineSelected(state, node.from, selected)) {
            const headerMark = node.firstChild;
            if (headerMark && headerMark.name === "HeaderMark") {
              const hideEnd = Math.min(node.to, headerMark.to + 1);
              builder.add(node.from, hideEnd, HIDDEN_MARK);
            }
          }
          return;
        }

        if (name === "StrongEmphasis" || name === "Emphasis") {
          if (isLineSelected(state, node.from, selected)) return;
          const open = node.firstChild;
          const close = node.lastChild;
          if (!open || !close || open === close) return;
          if (open.name !== "EmphasisMark" || close.name !== "EmphasisMark") return;
          const innerMark = name === "StrongEmphasis" ? STRONG_MARK : EMPHASIS_MARK;
          builder.add(open.from, open.to, HIDDEN_MARK);
          if (open.to < close.from) {
            builder.add(open.to, close.from, innerMark);
          }
          builder.add(close.from, close.to, HIDDEN_MARK);
          return;
        }

        if (name === "Link") {
          if (isLineSelected(state, node.from, selected)) return;
          // Lezer markdown shape for `[text](url)`:
          //   LinkMark `[` ... LinkMark `]` LinkMark `(` URL LinkMark `)`
          const linkMarks: { from: number; to: number }[] = [];
          let urlNode: { from: number; to: number } | null = null;
          for (let c = node.firstChild; c; c = c.nextSibling) {
            if (c.name === "LinkMark") {
              linkMarks.push({ from: c.from, to: c.to });
            } else if (c.name === "URL") {
              urlNode = { from: c.from, to: c.to };
            }
          }
          if (linkMarks.length < 2) return;
          const openBracket = linkMarks[0];
          const closeBracket = linkMarks[1];
          if (!openBracket || !closeBracket) return;

          builder.add(openBracket.from, openBracket.to, HIDDEN_MARK);
          const url = urlNode !== null ? state.doc.sliceString(urlNode.from, urlNode.to) : "";
          if (openBracket.to < closeBracket.from) {
            builder.add(openBracket.to, closeBracket.from, linkTextMark(url));
          }
          const lastMark = linkMarks[linkMarks.length - 1];
          const hideEnd = lastMark && lastMark.to > closeBracket.to ? lastMark.to : node.to;
          if (closeBracket.from < hideEnd) {
            builder.add(closeBracket.from, hideEnd, HIDDEN_MARK);
          }
          return;
        }

        if (name === "FencedCode") {
          for (let c = node.firstChild; c; c = c.nextSibling) {
            if (c.name === "CodeText" && c.from < c.to) {
              builder.add(c.from, c.to, CODE_BLOCK_MARK);
            }
          }
          return;
        }

        if (name === "ListItem") {
          const parent = node.parent;
          if (!parent || parent.name !== "BulletList") return;
          if (isLineSelected(state, node.from, selected)) return;
          const marker = node.firstChild;
          if (!marker || marker.name !== "ListMark") return;
          const replaceEnd = Math.min(node.to, marker.to + 1);
          if (replaceEnd > marker.from) {
            builder.add(marker.from, replaceEnd, BULLET_MARK);
          }
          return;
        }
      },
    });
  }

  return builder.finish();
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
      if (update.docChanged || update.viewportChanged || update.selectionSet || treeChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (instance) => instance.decorations,
  },
);

const livePreviewTheme = EditorView.theme({
  ".cm-lp-heading": {
    fontWeight: "700",
    lineHeight: "1.25",
  },
  ".cm-lp-heading-1": { fontSize: "1.8em" },
  ".cm-lp-heading-2": { fontSize: "1.5em" },
  ".cm-lp-heading-3": { fontSize: "1.3em" },
  ".cm-lp-heading-4": { fontSize: "1.1em" },
  ".cm-lp-heading-5": {
    fontSize: "1em",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  ".cm-lp-heading-6": {
    fontSize: "0.95em",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--muted-foreground)",
  },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-link": {
    color: "var(--primary)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
  ".cm-lp-link:hover": {
    color: "var(--primary)",
    textDecorationThickness: "2px",
  },
  ".cm-lp-codeblock": {
    backgroundColor: "color-mix(in srgb, var(--muted) 60%, transparent)",
    borderRadius: "2px",
    padding: "0 2px",
  },
  ".cm-lp-bullet": {
    color: "var(--muted-foreground)",
    fontWeight: "700",
    display: "inline-block",
    width: "1.2em",
  },
});

export const livePreviewExtensions = [livePreviewPlugin, livePreviewTheme];
