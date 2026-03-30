'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { BUBBLE_CONTENT_HEIGHT } from '@/components/project/console/CommandBubble';
import { modKey } from '@/lib/platform';

// ============================================================================
// Types
// ============================================================================

interface LabelInfo { name: string; count: number; }
interface RelTypeInfo { name: string; count: number; }
interface IndexInfo { name: string; type: string; labelsOrTypes: string[]; properties: string[]; state: string; }
interface ConstraintInfo { name: string; type: string; labelsOrTypes: string[]; properties: string[]; }

interface SchemaData {
  labels: LabelInfo[];
  relationshipTypes: RelTypeInfo[];
  propertyKeys: string[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
}

interface ServerInfo {
  version: string;
  edition: string;
  nodeCount: number;
  relationshipCount: number;
}

interface GraphNode {
  id: string | number;
  labels: string[];
  properties: Record<string, unknown>;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface GraphRel {
  id: string | number;
  type: string;
  startId: string | number;
  endId: string | number;
  properties: Record<string, unknown>;
}

interface CypherResult {
  records: Record<string, unknown>[];
  keys: string[];
  duration: number;
  counters: Record<string, number>;
}

type ActiveTab = 'schema' | 'cypher' | 'graph';

// ============================================================================
// Helpers
// ============================================================================

const LABEL_COLORS = [
  '#4C8BF5', '#E74C3C', '#2ECC71', '#F39C12', '#9B59B6',
  '#1ABC9C', '#E67E22', '#3498DB', '#E91E63', '#00BCD4',
];

function getLabelColor(label: string, allLabels: string[]): string {
  const idx = allLabels.indexOf(label);
  return LABEL_COLORS[idx % LABEL_COLORS.length];
}

async function apiPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function formatTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function extractGraphData(records: Record<string, unknown>[]): { nodes: GraphNode[]; rels: GraphRel[] } {
  const nodesMap = new Map<string | number, GraphNode>();
  const rels: GraphRel[] = [];

  function processValue(val: unknown) {
    if (!val || typeof val !== 'object') return;
    const obj = val as Record<string, unknown>;
    if (obj._type === 'node') {
      const id = obj._id as string | number;
      if (!nodesMap.has(id)) {
        nodesMap.set(id, {
          id,
          labels: (obj._labels as string[]) || [],
          properties: Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_'))),
        });
      }
    } else if (obj._type === 'relationship') {
      rels.push({
        id: obj._id as string | number,
        type: obj._relType as string,
        startId: obj._start as string | number,
        endId: obj._end as string | number,
        properties: Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_'))),
      });
    } else if (obj._type === 'path') {
      const segments = obj.segments as Array<{ start: unknown; relationship: unknown; end: unknown }>;
      segments?.forEach(s => { processValue(s.start); processValue(s.relationship); processValue(s.end); });
    } else if (Array.isArray(val)) {
      val.forEach(processValue);
    }
  }

  records.forEach(record => Object.values(record).forEach(processValue));
  return { nodes: Array.from(nodesMap.values()), rels };
}

function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (obj._type === 'node') {
      const label = (obj._labels as string[])?.[0] || '';
      const name = obj.name || obj.title || obj.id || '';
      return `(${label}${name ? ': ' + name : ''})`;
    }
    if (obj._type === 'relationship') return `[${obj._relType}]`;
    return JSON.stringify(val);
  }
  return String(val);
}

// ============================================================================
// Graph Canvas (d3-force-like, zero deps)
// ============================================================================

function GraphCanvas({ nodes, rels, allLabels }: {
  nodes: GraphNode[]; rels: GraphRel[]; allLabels: string[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const animRef = useRef<number>(0);
  const dragRef = useRef<{ nodeId: string | number; offsetX: number; offsetY: number } | null>(null);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const nodeMapRef = useRef<Map<string | number, GraphNode>>(new Map());
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const hoveredNodeRef = useRef<GraphNode | null>(null);

  // Track container size via ResizeObserver — never resets node positions
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      const prev = sizeRef.current;
      if (width === prev.w && height === prev.h) return;
      // On resize: shift all existing nodes proportionally so they stay centered
      if (prev.w > 0 && prev.h > 0 && nodesRef.current.length > 0) {
        const sx = width / prev.w, sy = height / prev.h;
        nodesRef.current.forEach(n => { n.x = (n.x || 0) * sx; n.y = (n.y || 0) * sy; });
      }
      sizeRef.current = { w: width, h: height };
      // Resize canvas element
      const canvas = canvasRef.current;
      if (canvas) { canvas.width = width; canvas.height = height; }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Initialize nodes only when data changes — not on resize
  useEffect(() => {
    const { w, h } = sizeRef.current;
    const cw = w || containerRef.current?.clientWidth || 600;
    const ch = h || containerRef.current?.clientHeight || 400;
    // Update sizeRef if it was 0 (first mount)
    if (w === 0) sizeRef.current = { w: cw, h: ch };

    nodesRef.current = nodes.map((n, i) => ({
      ...n,
      x: n.x ?? cw / 2 + (Math.cos(i * 2 * Math.PI / nodes.length) * Math.min(cw, ch) * 0.3),
      y: n.y ?? ch / 2 + (Math.sin(i * 2 * Math.PI / nodes.length) * Math.min(cw, ch) * 0.3),
      vx: 0, vy: 0,
    }));
    nodeMapRef.current = new Map(nodesRef.current.map(n => [n.id, n]));
  }, [nodes]);

  // Animation loop — reads sizeRef dynamically each frame
  useEffect(() => {
    const nodeMap = nodeMapRef.current;
    const R = 20;

    function simulate() {
      const { w, h } = sizeRef.current;
      if (w === 0 || h === 0) { animRef.current = requestAnimationFrame(simulate); return; }
      const ns = nodesRef.current;
      // Center gravity
      ns.forEach(n => { n.vx = (n.vx || 0) + (w / 2 - (n.x || 0)) * 0.001; n.vy = (n.vy || 0) + (h / 2 - (n.y || 0)) * 0.001; });
      // Repulsion
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
        const dx = (ns[i].x || 0) - (ns[j].x || 0), dy = (ns[i].y || 0) - (ns[j].y || 0);
        const dist = Math.sqrt(dx * dx + dy * dy) || 1, f = 2000 / (dist * dist);
        const fx = dx / dist * f, fy = dy / dist * f;
        ns[i].vx! += fx; ns[j].vx! -= fx; ns[i].vy! += fy; ns[j].vy! -= fy;
      }
      // Attraction
      rels.forEach(rel => {
        const s = nodeMap.get(rel.startId), t = nodeMap.get(rel.endId);
        if (!s || !t) return;
        const dx = (t.x || 0) - (s.x || 0), dy = (t.y || 0) - (s.y || 0);
        const dist = Math.sqrt(dx * dx + dy * dy) || 1, f = (dist - 100) * 0.01;
        const fx = dx / dist * f, fy = dy / dist * f;
        s.vx! += fx; t.vx! -= fx; s.vy! += fy; t.vy! -= fy;
      });
      // Apply
      ns.forEach(n => {
        if (dragRef.current?.nodeId === n.id) return;
        n.vx = (n.vx || 0) * 0.6; n.vy = (n.vy || 0) * 0.6;
        n.x = Math.max(R, Math.min(w - R, (n.x || 0) + (n.vx || 0) * 0.1));
        n.y = Math.max(R, Math.min(h - R, (n.y || 0) + (n.vy || 0) * 0.1));
      });
      // Draw
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      // Edges
      ctx.lineWidth = 1.5;
      rels.forEach(rel => {
        const s = nodeMap.get(rel.startId), t = nodeMap.get(rel.endId);
        if (!s || !t) return;
        ctx.strokeStyle = '#666'; ctx.beginPath(); ctx.moveTo(s.x!, s.y!); ctx.lineTo(t.x!, t.y!); ctx.stroke();
        const angle = Math.atan2(t.y! - s.y!, t.x! - s.x!);
        const ax = t.x! - Math.cos(angle) * (R + 4), ay = t.y! - Math.sin(angle) * (R + 4);
        ctx.fillStyle = '#666'; ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - 8 * Math.cos(angle - 0.3), ay - 8 * Math.sin(angle - 0.3));
        ctx.lineTo(ax - 8 * Math.cos(angle + 0.3), ay - 8 * Math.sin(angle + 0.3));
        ctx.closePath(); ctx.fill();
        ctx.font = '9px system-ui'; ctx.fillStyle = '#999'; ctx.textAlign = 'center';
        ctx.fillText(rel.type, (s.x! + t.x!) / 2, (s.y! + t.y!) / 2 - 4);
      });
      // Nodes
      ns.forEach(n => {
        const label = n.labels[0] || '', color = label ? getLabelColor(label, allLabels) : '#888';
        ctx.beginPath(); ctx.arc(n.x!, n.y!, R, 0, 2 * Math.PI);
        ctx.fillStyle = color; ctx.fill();
        const isHovered = hoveredNodeRef.current?.id === n.id;
        ctx.strokeStyle = isHovered ? '#fff' : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = isHovered ? 2.5 : 1; ctx.stroke();
        ctx.font = '10px system-ui'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const txt = String(n.properties.name || n.properties.title || n.properties.id || label || n.id);
        ctx.fillText(txt.length > 8 ? txt.slice(0, 7) + '…' : txt, n.x!, n.y!);
      });
      animRef.current = requestAnimationFrame(simulate);
    }
    animRef.current = requestAnimationFrame(simulate);
    return () => cancelAnimationFrame(animRef.current);
  }, [nodes, rels, allLabels]);

  const findNode = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    return nodesRef.current.find(n => { const dx = (n.x || 0) - mx, dy = (n.y || 0) - my; return dx * dx + dy * dy < 400; }) || null;
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full">
      <canvas ref={canvasRef} className="cursor-grab active:cursor-grabbing absolute inset-0"
        onMouseDown={e => { const n = findNode(e); if (n) { const r = canvasRef.current!.getBoundingClientRect(); dragRef.current = { nodeId: n.id, offsetX: e.clientX - r.left - (n.x || 0), offsetY: e.clientY - r.top - (n.y || 0) }; } }}
        onMouseMove={e => { if (dragRef.current) { const r = canvasRef.current!.getBoundingClientRect(); const n = nodesRef.current.find(n => n.id === dragRef.current!.nodeId); if (n) { n.x = e.clientX - r.left - dragRef.current.offsetX; n.y = e.clientY - r.top - dragRef.current.offsetY; n.vx = 0; n.vy = 0; } } else { const found = findNode(e); hoveredNodeRef.current = found; setHoveredNode(found); } }}
        onMouseUp={() => { dragRef.current = null; }}
        onMouseLeave={() => { dragRef.current = null; hoveredNodeRef.current = null; setHoveredNode(null); }}
      />
      {hoveredNode && !dragRef.current && (
        <div className="absolute top-2 left-2 bg-popover text-popover-foreground border border-border rounded px-2 py-1 text-xs max-w-[300px] pointer-events-none">
          <div className="font-medium">{hoveredNode.labels.join(', ')} #{String(hoveredNode.id)}</div>
          {Object.entries(hoveredNode.properties).slice(0, 8).map(([k, v]) => (
            <div key={k} className="truncate"><span className="text-muted-foreground">{k}:</span> {String(v)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Neo4jBubble (following PostgreSQL DatabaseBubble layout)
// ============================================================================

interface Neo4jBubbleProps {
  id: string;
  connectionString: string;
  displayName: string;
  selected: boolean;
  maximized: boolean;
  expandedHeight?: number;
  bubbleContentHeight?: number;
  onSelect: () => void;
  onClose: () => void;
  onToggleMaximize: () => void;
  timestamp?: string;
  onTitleMouseDown?: () => void;
}

export function Neo4jBubble({
  id, connectionString, displayName, selected, maximized,
  expandedHeight, bubbleContentHeight, onSelect, onClose, onToggleMaximize,
  timestamp, onTitleMouseDown,
}: Neo4jBubbleProps) {
  // Connection
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);

  // Schema
  const [schema, setSchema] = useState<SchemaData | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaSection, setSchemaSection] = useState<'labels' | 'relationships' | 'properties' | 'indexes' | 'constraints'>('labels');

  // Cypher
  const [cypher, setCypher] = useState('');
  const [queryResult, setQueryResult] = useState<CypherResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState('');
  const cypherRef = useRef<HTMLTextAreaElement>(null);

  // Graph
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphRels, setGraphRels] = useState<GraphRel[]>([]);


  // UI
  const [activeTab, setActiveTab] = useState<ActiveTab>('schema');

  const TOOLBAR_HEIGHT = 41;
  const contentHeight = maximized && expandedHeight
    ? expandedHeight - TOOLBAR_HEIGHT
    : (bubbleContentHeight ?? BUBBLE_CONTENT_HEIGHT);

  // Connect
  const connect = useCallback(async () => {
    setStatus('connecting');
    try {
      const data = await apiPost('/api/neo4j/connect', { id, connectionString });
      setServerInfo(data);
      setStatus('connected');
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [id, connectionString]);

  useEffect(() => { connect(); }, [connect]);

  // Load schema
  const loadSchema = useCallback(async () => {
    setSchemaLoading(true);
    try {
      const data = await apiPost('/api/neo4j/schema', { id, connectionString });
      setSchema(data);
    } catch { /* ignore */ }
    setSchemaLoading(false);
  }, [id, connectionString]);

  useEffect(() => { if (status === 'connected') loadSchema(); }, [status, loadSchema]);

  // Execute Cypher
  const executeCypher = useCallback(async (query?: string) => {
    const q = query || cypher.trim();
    if (!q) return;
    setQueryLoading(true);
    setQueryError('');
    try {
      const result = await apiPost('/api/neo4j/query', { id, connectionString, cypher: q });
      setQueryResult(result);
      const { nodes, rels } = extractGraphData(result.records);
      if (nodes.length > 0) { setGraphNodes(nodes); setGraphRels(rels); }
    } catch (e: unknown) {
      setQueryError(e instanceof Error ? e.message : String(e));
    }
    setQueryLoading(false);
  }, [id, connectionString, cypher]);

  const queryLabel = useCallback((label: string) => {
    const q = `MATCH (n:\`${label}\`) RETURN n LIMIT 25`;
    setCypher(q); setActiveTab('cypher'); executeCypher(q);
  }, [executeCypher]);

  const queryRelType = useCallback((relType: string) => {
    const q = `MATCH (a)-[r:\`${relType}\`]->(b) RETURN a, r, b LIMIT 25`;
    setCypher(q); setActiveTab('graph'); executeCypher(q);
  }, [executeCypher]);

  return (
    <div className="flex flex-col items-start" onClick={onSelect}>
      <div className={`w-full bg-accent text-foreground relative transition-colors ${selected ? 'ring-1 ring-ring' : ''} rounded-lg overflow-hidden`}>

        {/* ===== Title Bar (matches PostgreSQL bubble) ===== */}
        <div
          data-drag-handle
          onDoubleClick={onToggleMaximize}
          onMouseDown={onTitleMouseDown}
          className="flex items-center gap-2 px-4 py-1.5 border-b border-border cursor-grab active:cursor-grabbing select-none"
        >
          <span className="text-sm flex-shrink-0">⬡</span>
          <span className="text-xs text-foreground truncate font-mono font-medium">{displayName}</span>
          {status === 'connecting' && (
            <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
          )}
          {status === 'connected' && (
            <span className="text-[10px] text-emerald-500 flex-shrink-0">Connected</span>
          )}
          {status === 'error' && (
            <span className="text-[10px] text-destructive flex-shrink-0">Error</span>
          )}
          {timestamp && <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatTime(timestamp)}</span>}
          {status === 'connected' && serverInfo && (
            <span className="text-[10px] text-muted-foreground flex-shrink-0">
              v{serverInfo.version} · {serverInfo.nodeCount.toLocaleString()}n · {serverInfo.relationshipCount.toLocaleString()}r
            </span>
          )}
          <span className="flex-1" />
          {/* Refresh */}
          {status === 'connected' && (
            <button
              onClick={(e) => { e.stopPropagation(); loadSchema(); connect(); }}
              disabled={schemaLoading}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-40"
              title="Refresh"
            >
              <svg className={`w-3.5 h-3.5 ${schemaLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
          {/* Maximize */}
          <button
            onClick={(e) => { e.stopPropagation(); onToggleMaximize(); }}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {maximized
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              }
            </svg>
          </button>
          {/* Close */}
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ===== Body ===== */}
        <div style={{ height: contentHeight }} className="flex flex-col overflow-hidden">

          {/* Connecting */}
          {status === 'connecting' && (
            <div className="flex-1 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin" />
              Connecting...
            </div>
          )}

          {/* Error */}
          {status === 'error' && (
            <div className="flex-1 flex flex-col items-center justify-center text-xs p-4 gap-2">
              <p className="text-destructive">{errorMsg}</p>
              <button onClick={connect} className="px-3 py-1 rounded text-xs bg-brand text-white hover:bg-brand/90 transition-colors">
                Retry
              </button>
            </div>
          )}

          {/* Connected */}
          {status === 'connected' && (
            <>
              {/* Tabs */}
              <div className="flex items-center gap-0 border-b border-border bg-card/30 flex-shrink-0">
                {(['schema', 'cypher', 'graph'] as ActiveTab[]).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 py-1.5 text-xs transition-colors ${
                      activeTab === tab
                        ? 'text-brand border-b-2 border-brand font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {{ schema: 'Schema', cypher: 'Cypher', graph: 'Graph' }[tab]}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-hidden flex">

                {/* ===== Schema Tab ===== */}
                {activeTab === 'schema' && (
                  <>
                    {/* Sidebar */}
                    <div className="w-40 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
                      <div className="flex-1 overflow-y-auto text-xs">
                        {[
                          { key: 'labels' as const, label: 'Labels', count: schema?.labels.length },
                          { key: 'relationships' as const, label: 'Relationships', count: schema?.relationshipTypes.length },
                          { key: 'properties' as const, label: 'Properties', count: schema?.propertyKeys.length },
                          { key: 'indexes' as const, label: 'Indexes', count: schema?.indexes.length },
                          { key: 'constraints' as const, label: 'Constraints', count: schema?.constraints.length },
                        ].map(s => (
                          <div
                            key={s.key}
                            onClick={() => setSchemaSection(s.key)}
                            className={`flex items-center gap-1.5 px-2 py-1.5 cursor-pointer truncate transition-colors ${
                              schemaSection === s.key ? 'bg-brand/10 text-brand' : 'hover:bg-white/10 text-foreground'
                            }`}
                          >
                            <span className="truncate min-w-0 flex-1">{s.label}</span>
                            <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">{s.count ?? 0}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {/* Content */}
                    <div className="flex-1 overflow-y-auto text-xs">
                      {schemaLoading && (
                        <div className="flex items-center justify-center p-4 gap-2 text-muted-foreground">
                          <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin" /> Loading...
                        </div>
                      )}
                      {!schemaLoading && schemaSection === 'labels' && schema?.labels.map(l => (
                        <div key={l.name} onClick={() => queryLabel(l.name)}
                          className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-brand/10 transition-colors">
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: getLabelColor(l.name, schema.labels.map(x => x.name)) }} />
                          <span className="truncate min-w-0 flex-1 font-mono">{l.name}</span>
                          <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">{l.count.toLocaleString()}</span>
                        </div>
                      ))}
                      {!schemaLoading && schemaSection === 'relationships' && schema?.relationshipTypes.map(r => (
                        <div key={r.name} onClick={() => queryRelType(r.name)}
                          className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-brand/10 transition-colors">
                          <span className="text-[10px] text-muted-foreground flex-shrink-0">→</span>
                          <span className="truncate min-w-0 flex-1 font-mono">{r.name}</span>
                          <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">{r.count.toLocaleString()}</span>
                        </div>
                      ))}
                      {!schemaLoading && schemaSection === 'properties' && schema?.propertyKeys.map(p => (
                        <div key={p} className="px-2 py-1 font-mono text-muted-foreground hover:bg-brand/10 transition-colors">{p}</div>
                      ))}
                      {!schemaLoading && schemaSection === 'indexes' && schema?.indexes.map(idx => (
                        <div key={idx.name} className="px-2 py-1 border-b border-border/50 hover:bg-brand/10 transition-colors">
                          <div className="font-mono text-foreground">{idx.name}</div>
                          <div className="text-muted-foreground">{idx.type} · {idx.labelsOrTypes?.join(', ')} · ({idx.properties?.join(', ')}) · {idx.state}</div>
                        </div>
                      ))}
                      {!schemaLoading && schemaSection === 'constraints' && schema?.constraints.map(c => (
                        <div key={c.name} className="px-2 py-1 border-b border-border/50 hover:bg-brand/10 transition-colors">
                          <div className="font-mono text-foreground">{c.name}</div>
                          <div className="text-muted-foreground">{c.type} · {c.labelsOrTypes?.join(', ')} · ({c.properties?.join(', ')})</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* ===== Cypher Tab ===== */}
                {activeTab === 'cypher' && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    {/* Input */}
                    <div className="p-2 border-b border-border flex-shrink-0">
                      <textarea
                        ref={cypherRef}
                        value={cypher}
                        onChange={e => setCypher(e.target.value)}
                        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); executeCypher(); } }}
                        placeholder={`Enter Cypher query (${modKey()}+Enter to run)`}
                        className="w-full h-20 px-2 py-1.5 text-xs font-mono bg-background border border-input rounded resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                        spellCheck={false}
                      />
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[10px] text-muted-foreground">{modKey()}+Enter to execute</span>
                        <button
                          onClick={() => executeCypher()}
                          disabled={queryLoading || !cypher.trim()}
                          className="px-2 py-1 text-xs bg-brand text-white rounded hover:bg-brand/90 disabled:opacity-50 transition-colors"
                        >
                          {queryLoading ? 'Running...' : 'Execute'}
                        </button>
                      </div>
                    </div>
                    {/* Results */}
                    <div className="flex-1 overflow-auto">
                      {queryError && <div className="p-2 text-xs text-destructive">{queryError}</div>}
                      {queryResult && !queryError && (
                        <>
                          <div className="px-2 py-1 text-[10px] text-muted-foreground border-b border-border flex items-center gap-2">
                            <span>{queryResult.records.length} rows</span>
                            <span>{queryResult.duration}ms</span>
                            {Object.entries(queryResult.counters).filter(([, v]) => v > 0).map(([k, v]) => (
                              <span key={k}>{k}: {v}</span>
                            ))}
                          </div>
                          {queryResult.records.length > 0 && (
                            <table className="w-full text-xs border-collapse">
                              <thead className="sticky top-0 bg-card z-[1]">
                                <tr>
                                  {queryResult.keys.map(k => (
                                    <th key={k} className="px-1.5 py-1 text-left text-muted-foreground font-medium border-b border-border whitespace-nowrap font-mono">{k}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {queryResult.records.map((record, i) => (
                                  <tr key={i} className="hover:bg-accent/50">
                                    {queryResult.keys.map(k => (
                                      <td key={k} className="px-1.5 py-0.5 border-b border-border/50 font-mono whitespace-nowrap max-w-[200px] truncate">
                                        {record[k] === null
                                          ? <span className="text-muted-foreground italic">NULL</span>
                                          : formatCellValue(record[k])}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* ===== Graph Tab ===== */}
                {activeTab === 'graph' && (
                  <div className="flex-1 relative">
                    {graphNodes.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full text-xs text-muted-foreground gap-2">
                        <p>Run a Cypher query that returns nodes to visualize</p>
                        <button
                          onClick={() => { const q = 'MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 50'; setCypher(q); executeCypher(q); }}
                          className="px-3 py-1 rounded text-xs bg-brand text-white hover:bg-brand/90 transition-colors"
                        >
                          Load sample graph
                        </button>
                      </div>
                    ) : (
                      <GraphCanvas
                        nodes={graphNodes}
                        rels={graphRels}
                        allLabels={schema?.labels.map(l => l.name) || []}
                      />
                    )}
                  </div>
                )}

              </div>
            </>
          )}
        </div>

          {/* Bottom status bar */}
          {!maximized && (
            <div className="border-t border-border px-4 py-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`inline-block w-2 h-2 rounded-full ${status === 'connected' ? 'bg-green-500' : status === 'error' ? 'bg-red-500' : 'bg-yellow-500 animate-pulse'}`} />
              <span>{{ connecting: 'Connecting', connected: 'Connected', error: 'Error' }[status]}</span>
              {status === 'connected' && serverInfo && (
                <span className="text-muted-foreground/70">{serverInfo.edition}</span>
              )}
              <span className="flex-1" />
              {timestamp && <span className="text-[11px] flex-shrink-0">{formatTime(timestamp)}</span>}
            </div>
          )}
      </div>
    </div>
  );
}
