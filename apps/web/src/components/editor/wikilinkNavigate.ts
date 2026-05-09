import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  isWikilinkAt,
  parseWikilinks,
  type WikilinkMatch,
} from "@t3tools/shared/markdown/wikilink";

export type WikilinkResolutionStatus = "resolved" | "broken";

export interface WikilinkResolution {
  readonly basename: string;
  readonly status: WikilinkResolutionStatus;
  readonly relativePath: string | null;
}

export interface WikilinkNavigateOptions {
  readonly resolveBasename: (basename: string) => Promise<WikilinkResolution>;
  readonly openNote: (input: {
    readonly relativePath: string;
    readonly forceNewTab: boolean;
  }) => Promise<void> | void;
  readonly createNote: (basename: string) => Promise<string | null> | string | null;
}

const RESOLVED_MARK = Decoration.mark({ class: "cm-wikilink" });
const BROKEN_MARK = Decoration.mark({ class: "cm-wikilink cm-wikilink-broken" });
const PENDING_MARK = Decoration.mark({ class: "cm-wikilink" });

interface BasenameState {
  status: "pending" | "resolved" | "broken" | "error";
  relativePath: string | null;
}

function buildDecorations(
  view: EditorView,
  resolutions: ReadonlyMap<string, BasenameState>,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  const matches = parseWikilinks(text);
  for (const match of matches) {
    const state = resolutions.get(match.basename);
    const mark =
      state === undefined || state.status === "pending"
        ? PENDING_MARK
        : state.status === "resolved"
          ? RESOLVED_MARK
          : BROKEN_MARK;
    builder.add(match.span[0], match.span[1], mark);
  }
  return builder.finish();
}

function uniqueBasenames(matches: ReadonlyArray<WikilinkMatch>): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const match of matches) {
    seen.add(match.basename);
  }
  return Array.from(seen);
}

class WikilinkPluginValue {
  decorations: DecorationSet;
  resolutions: Map<string, BasenameState> = new Map();
  destroyed = false;

  constructor(
    public readonly view: EditorView,
    public readonly options: WikilinkNavigateOptions,
  ) {
    this.decorations = buildDecorations(view, this.resolutions);
    this.refreshResolutions();
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      this.refreshResolutions();
    }
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildDecorations(update.view, this.resolutions);
    }
  }

  destroy() {
    this.destroyed = true;
  }

  rebuildDecorations() {
    this.decorations = buildDecorations(this.view, this.resolutions);
    this.view.dispatch({});
  }

  private refreshResolutions() {
    const matches = parseWikilinks(this.view.state.doc.toString());
    const basenames = uniqueBasenames(matches);
    const seen = new Set(basenames);
    for (const key of Array.from(this.resolutions.keys())) {
      if (!seen.has(key)) {
        this.resolutions.delete(key);
      }
    }
    for (const basename of basenames) {
      if (this.resolutions.has(basename)) continue;
      this.resolutions.set(basename, { status: "pending", relativePath: null });
      void this.options
        .resolveBasename(basename)
        .then((resolution) => {
          if (this.destroyed) return;
          this.resolutions.set(basename, {
            status: resolution.status,
            relativePath: resolution.relativePath,
          });
          this.rebuildDecorations();
        })
        .catch(() => {
          if (this.destroyed) return;
          this.resolutions.set(basename, { status: "error", relativePath: null });
        });
    }
  }
}

export function wikilinkNavigate(options: WikilinkNavigateOptions): Extension {
  const plugin = ViewPlugin.define((view) => new WikilinkPluginValue(view, options), {
    decorations: (instance) => instance.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target as HTMLElement | null;
        if (!target) return false;
        const wikilinkEl = target.closest(".cm-wikilink");
        if (!wikilinkEl) return false;
        const isPrimary = event.button === 0;
        if (!isPrimary) return false;
        const offset = view.posAtDOM(wikilinkEl);
        const match = isWikilinkAt(view.state.doc.toString(), offset);
        if (!match) return false;
        event.preventDefault();
        const forceNewTab = event.metaKey || event.ctrlKey;
        const instance = view.plugin(plugin);
        if (!instance) return false;
        const state = instance.resolutions.get(match.basename);
        if (state && state.status === "resolved" && state.relativePath) {
          void options.openNote({ relativePath: state.relativePath, forceNewTab });
          return true;
        }
        if (!state || state.status === "broken" || state.status === "error") {
          void Promise.resolve(options.createNote(match.basename)).then((relativePath) => {
            if (!relativePath) return;
            instance.resolutions.set(match.basename, {
              status: "resolved",
              relativePath,
            });
            instance.rebuildDecorations();
            void options.openNote({ relativePath, forceNewTab });
          });
          return true;
        }
        return false;
      },
    },
  });
  return plugin;
}

export const wikilinkNavigateTheme = EditorView.theme({
  ".cm-wikilink": {
    color: "var(--primary)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    textDecorationStyle: "dotted",
    cursor: "pointer",
  },
  ".cm-wikilink:hover": {
    textDecorationStyle: "solid",
  },
  ".cm-wikilink-broken": {
    color: "var(--destructive)",
    textDecorationStyle: "dashed",
  },
});
