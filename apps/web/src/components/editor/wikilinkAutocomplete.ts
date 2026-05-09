import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";

const NOTE_FILE_EXTENSION = ".md";

export interface WikilinkAutocompleteOptions {
  readonly loadBasenames: () => Promise<ReadonlyArray<string>>;
}

interface BasenameCache {
  status: "idle" | "loading" | "ready" | "error";
  basenames: ReadonlyArray<string>;
  loadedAt: number;
  inFlight: Promise<ReadonlyArray<string>> | null;
}

const CACHE_TTL_MS = 5_000;

function stripMdExtension(name: string): string {
  return name.toLowerCase().endsWith(NOTE_FILE_EXTENSION)
    ? name.slice(0, -NOTE_FILE_EXTENSION.length)
    : name;
}

function findOpenWikilink(
  text: string,
  caret: number,
): { readonly bracketStart: number; readonly query: string } | null {
  let cursor = caret;
  while (cursor > 0) {
    const ch = text[cursor - 1];
    if (ch === undefined) break;
    if (ch === "\n") return null;
    if (ch === "]") return null;
    if (ch === "[" && cursor >= 2 && text[cursor - 2] === "[") {
      const bracketStart = cursor - 2;
      if (bracketStart > 0 && text[bracketStart - 1] === "!") return null;
      return { bracketStart, query: text.slice(cursor, caret) };
    }
    cursor -= 1;
  }
  return null;
}

function buildCompletions(
  basenames: ReadonlyArray<string>,
  caret: number,
  bracketStart: number,
): ReadonlyArray<Completion> {
  return basenames.map((basename) => ({
    label: basename,
    type: "file",
    apply: (view) => {
      const insert = `[[${basename}]]`;
      view.dispatch({
        changes: { from: bracketStart, to: caret, insert },
        selection: { anchor: bracketStart + insert.length },
      });
    },
  }));
}

export function wikilinkAutocomplete(options: WikilinkAutocompleteOptions): Extension {
  const cache: BasenameCache = {
    status: "idle",
    basenames: [],
    loadedAt: 0,
    inFlight: null,
  };

  const ensureFresh = (): Promise<ReadonlyArray<string>> | null => {
    const now = Date.now();
    if (cache.status === "ready" && now - cache.loadedAt < CACHE_TTL_MS) {
      return null;
    }
    if (cache.inFlight) return cache.inFlight;
    cache.status = "loading";
    const promise = options
      .loadBasenames()
      .then((basenames) => {
        cache.basenames = basenames.map((entry) => stripMdExtension(entry));
        cache.status = "ready";
        cache.loadedAt = Date.now();
        cache.inFlight = null;
        return cache.basenames;
      })
      .catch((error: unknown) => {
        cache.status = "error";
        cache.inFlight = null;
        throw error;
      });
    cache.inFlight = promise;
    return promise;
  };

  const wikilinkSource = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const text = context.state.doc.toString();
    const caret = context.pos;
    const open = findOpenWikilink(text, caret);
    if (!open) return null;

    const pending = ensureFresh();
    if (pending && cache.status !== "ready") {
      try {
        await pending;
      } catch {
        return null;
      }
    }

    const filtered =
      open.query.length === 0
        ? cache.basenames
        : cache.basenames.filter((basename) =>
            basename.toLowerCase().includes(open.query.toLowerCase()),
          );

    if (filtered.length === 0) return null;

    return {
      from: open.bracketStart,
      to: caret,
      options: buildCompletions(filtered, caret, open.bracketStart),
      filter: false,
    };
  };

  return autocompletion({
    override: [wikilinkSource],
    activateOnTyping: true,
    closeOnBlur: true,
  });
}
