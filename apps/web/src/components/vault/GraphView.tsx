import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type VaultGetGraphResult,
} from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";

import { readEnvironmentConnection } from "../../environments/runtime";
import { Kbd } from "../ui/kbd";

interface GraphViewProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

interface GraphState {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly data: VaultGetGraphResult | null;
  readonly error?: string;
}

interface RenderNode {
  id: string;
  title: string;
  isOrphan: boolean;
}

interface RenderLink {
  source: string;
  target: string;
  resolved: boolean;
}

function basenameTitle(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last.endsWith(".md") ? last.slice(0, -".md".length) : last;
}

export const GraphView = memo(function GraphView({
  open,
  onOpenChange,
  threadId,
  environmentId,
  projectId,
}: GraphViewProps) {
  if (!open) return null;
  return (
    <GraphDialog
      threadId={threadId}
      environmentId={environmentId}
      projectId={projectId}
      onClose={() => onOpenChange(false)}
    />
  );
});

interface GraphDialogProps {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onClose: () => void;
}

function GraphDialog({ threadId, environmentId, projectId, onClose }: GraphDialogProps) {
  const connection = readEnvironmentConnection(environmentId);
  const [state, setState] = useState<GraphState>({ status: "idle", data: null });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphMethods<RenderNode, RenderLink> | undefined>(undefined);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    setState({ status: "loading", data: null });
    void (async () => {
      try {
        const result = await connection.client.vault.getGraph({ projectId });
        if (cancelled) return;
        setState({ status: "loaded", data: result });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          data: null,
          error: error instanceof Error ? error.message : "Failed to load graph",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, projectId]);

  const graphData = useMemo<{ nodes: RenderNode[]; links: RenderLink[] }>(() => {
    if (!state.data) return { nodes: [], links: [] };
    const nodeMap = new Map<string, RenderNode>();
    for (const node of state.data.nodes) {
      nodeMap.set(node.id, { id: node.id, title: node.title, isOrphan: false });
    }
    const links: RenderLink[] = [];
    for (const edge of state.data.edges) {
      if (!nodeMap.has(edge.source)) {
        nodeMap.set(edge.source, {
          id: edge.source,
          title: basenameTitle(edge.source),
          isOrphan: true,
        });
      }
      if (!nodeMap.has(edge.target)) {
        nodeMap.set(edge.target, {
          id: edge.target,
          title: basenameTitle(edge.target),
          isOrphan: !edge.resolved,
        });
      }
      links.push({ source: edge.source, target: edge.target, resolved: edge.resolved });
    }
    return { nodes: Array.from(nodeMap.values()), links };
  }, [state.data]);

  const handleNodeClick = useCallback(
    (node: RenderNode) => {
      if (!connection) return;
      if (node.isOrphan) return;
      void connection.client.tabs.openNoteTab({
        threadId,
        vaultId: projectId,
        relativePath: node.id,
      });
      onClose();
    },
    [connection, threadId, projectId, onClose],
  );

  const renderNode = useCallback(
    (node: RenderNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const radius = node.isOrphan ? 3 : 4.5;
      const cx = (node as { x?: number }).x ?? 0;
      const cy = (node as { y?: number }).y ?? 0;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI, false);
      ctx.fillStyle = node.isOrphan ? "#6b7280" : "#7c9cff";
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 0.6;
      ctx.stroke();

      const fontSize = Math.max(2.5, 11 / globalScale);
      if (globalScale >= 1.2) {
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(229, 231, 235, 0.92)";
        ctx.fillText(node.title, cx, cy + radius + 1);
      }
    },
    [],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Graph view"
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-[5vh]"
    >
      <button
        type="button"
        aria-label="Close graph view"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[1px]"
      />
      <div className="relative flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl shadow-black/30">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <NetworkIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">Graph view</div>
            <div className="text-xs text-muted-foreground">
              {state.status === "loaded" && state.data
                ? `${graphData.nodes.length} notes · ${graphData.links.length} links`
                : "Loading vault graph…"}
            </div>
          </div>
          <Kbd className="text-[10px]">Esc</Kbd>
        </div>
        <div ref={containerRef} className="relative flex-1 bg-[#0b0e14]">
          {state.status === "loading" ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : null}
          {state.status === "error" ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive">
              {state.error ?? "Failed to load graph."}
            </div>
          ) : null}
          {state.status === "loaded" && graphData.nodes.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
              <div>No notes in this vault yet.</div>
              <div className="text-xs">Create a note to see it on the graph.</div>
            </div>
          ) : null}
          {state.status === "loaded" && graphData.nodes.length > 0 && size.width > 0 ? (
            <ForceGraph2D
              ref={graphRef}
              graphData={graphData}
              width={size.width}
              height={size.height}
              backgroundColor="#0b0e14"
              nodeId="id"
              nodeLabel={(node) => (node as RenderNode).title}
              linkColor={(link) =>
                (link as RenderLink).resolved
                  ? "rgba(124, 156, 255, 0.45)"
                  : "rgba(120, 120, 120, 0.3)"
              }
              linkDirectionalParticles={0}
              linkWidth={0.7}
              cooldownTicks={120}
              warmupTicks={20}
              nodeCanvasObject={renderNode}
              nodePointerAreaPaint={(node, color, ctx) => {
                const cx = (node as { x?: number }).x ?? 0;
                const cy = (node as { y?: number }).y ?? 0;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(cx, cy, 6, 0, 2 * Math.PI, false);
                ctx.fill();
              }}
              onNodeClick={handleNodeClick}
              enableZoomInteraction
              enablePanInteraction
            />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-between border-t border-border bg-card/40 px-4 py-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-full bg-[#7c9cff]" aria-hidden="true" />
              <span>note</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-full bg-[#6b7280]" aria-hidden="true" />
              <span>unresolved link</span>
            </span>
          </div>
          <span className="text-muted-foreground/70">click a node to open</span>
        </div>
      </div>
    </div>
  );
}
