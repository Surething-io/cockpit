'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';

interface TokenStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Claude API official pricing ($/MTok) — 2026.03
const MODEL_PRICING: Record<string, { label: string; input: number; output: number; cacheRead: number; cacheWrite: number; color: string }> = {
  'claude-opus-4-6':            { label: 'Opus 4.6',   input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25, color: '#f97316' },
  'claude-opus-4-5-20251101':   { label: 'Opus 4.5',   input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25, color: '#fb923c' },
  'claude-sonnet-4-6':          { label: 'Sonnet 4.6',  input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75, color: '#3b82f6' },
  'claude-sonnet-4-5-20250929': { label: 'Sonnet 4.5',  input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75, color: '#60a5fa' },
  'claude-haiku-4-5-20251001':  { label: 'Haiku 4.5',   input: 1,  output: 5,  cacheRead: 0.10, cacheWrite: 1.25, color: '#22c55e' },
};

const DEFAULT_PRICING = { label: '', input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75, color: '#94a3b8' };

function getPricing(modelId: string) {
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];
  const lower = modelId.toLowerCase();
  if (lower.includes('opus')) return { ...DEFAULT_PRICING, input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25, color: '#f97316' };
  if (lower.includes('haiku')) return { ...DEFAULT_PRICING, input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25, color: '#22c55e' };
  return DEFAULT_PRICING;
}

function getLabel(modelId: string) {
  const p = MODEL_PRICING[modelId];
  if (p) return p.label;
  return modelId.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function getColor(modelId: string) {
  return (MODEL_PRICING[modelId] ?? getPricing(modelId)).color;
}

function calcCost(modelId: string, usage: ModelUsage): number {
  const p = getPricing(modelId);
  const M = 1_000_000;
  return (
    (usage.inputTokens / M) * p.input +
    (usage.outputTokens / M) * p.output +
    (usage.cacheReadInputTokens / M) * p.cacheRead +
    (usage.cacheCreationInputTokens / M) * p.cacheWrite
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(n: number): string {
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 100) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
}

interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

interface StatsData {
  modelUsage?: Record<string, ModelUsage>;
  dailyActivity?: DailyActivity[];
  dailyModelTokens?: DailyModelTokens[];
  hourCounts?: Record<string, number>;
  totalSessions?: number;
  totalMessages?: number;
  longestSession?: { duration: number };
  firstSessionDate?: string;
}

type TimeRange = 'day' | 'week' | 'month';

// ─── Aggregation utilities ───

/** Aggregate by week, returns { label: 'MM-DD', ... } */
function aggregateByWeek(dailyActivity: DailyActivity[], dailyModelTokens: DailyModelTokens[]) {
  const weekMap = new Map<string, { label: string; messages: number; sessions: number; tools: number; tokensByModel: Record<string, number> }>();

  for (const d of dailyActivity) {
    const dt = new Date(d.date);
    const weekStart = new Date(dt);
    weekStart.setDate(dt.getDate() - dt.getDay()); // Sunday start
    const key = weekStart.toISOString().slice(0, 10);
    const label = key.slice(5);
    if (!weekMap.has(key)) weekMap.set(key, { label, messages: 0, sessions: 0, tools: 0, tokensByModel: {} });
    const w = weekMap.get(key)!;
    w.messages += d.messageCount;
    w.sessions += d.sessionCount;
    w.tools += d.toolCallCount;
  }

  for (const d of dailyModelTokens) {
    const dt = new Date(d.date);
    const weekStart = new Date(dt);
    weekStart.setDate(dt.getDate() - dt.getDay());
    const key = weekStart.toISOString().slice(0, 10);
    if (!weekMap.has(key)) weekMap.set(key, { label: key.slice(5), messages: 0, sessions: 0, tools: 0, tokensByModel: {} });
    const w = weekMap.get(key)!;
    for (const [model, tokens] of Object.entries(d.tokensByModel)) {
      w.tokensByModel[model] = (w.tokensByModel[model] || 0) + tokens;
    }
  }

  return Array.from(weekMap.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function aggregateByMonth(dailyActivity: DailyActivity[], dailyModelTokens: DailyModelTokens[]) {
  const monthMap = new Map<string, { label: string; messages: number; sessions: number; tools: number; tokensByModel: Record<string, number> }>();

  for (const d of dailyActivity) {
    const key = d.date.slice(0, 7); // YYYY-MM
    const label = key;
    if (!monthMap.has(key)) monthMap.set(key, { label, messages: 0, sessions: 0, tools: 0, tokensByModel: {} });
    const m = monthMap.get(key)!;
    m.messages += d.messageCount;
    m.sessions += d.sessionCount;
    m.tools += d.toolCallCount;
  }

  for (const d of dailyModelTokens) {
    const key = d.date.slice(0, 7);
    if (!monthMap.has(key)) monthMap.set(key, { label: key, messages: 0, sessions: 0, tools: 0, tokensByModel: {} });
    const m = monthMap.get(key)!;
    for (const [model, tokens] of Object.entries(d.tokensByModel)) {
      m.tokensByModel[model] = (m.tokensByModel[model] || 0) + tokens;
    }
  }

  return Array.from(monthMap.values()).sort((a, b) => a.label.localeCompare(b.label));
}

// ─── Canvas bar chart ───

interface BarChartData {
  labels: string[];
  datasets: { label: string; data: number[]; color: string }[];
}

function BarChart({ data, height = 200, formatValue = fmtTokens }: { data: BarChartData; height?: number; formatValue?: (n: number) => string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null);
  const barsRef = useRef<{ x: number; y: number; w: number; h: number; label: string; value: number; dataset: string; color: string }[]>([]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const { labels, datasets } = data;
    if (labels.length === 0) return;

    const paddingLeft = 50;
    const paddingRight = 12;
    const paddingTop = 8;
    const paddingBottom = 28;
    const chartW = width - paddingLeft - paddingRight;
    const chartH = height - paddingTop - paddingBottom;

    // Compute total max per group (stacked)
    const groupTotals = labels.map((_, i) => datasets.reduce((s, ds) => s + ds.data[i], 0));
    const maxVal = Math.max(1, ...groupTotals);

    // Y-axis ticks
    const niceMax = getNiceMax(maxVal);
    const tickCount = 4;
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('color') || '#888';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= tickCount; i++) {
      const val = (niceMax / tickCount) * i;
      const y = paddingTop + chartH - (val / niceMax) * chartH;
      ctx.fillText(formatValue(val), paddingLeft - 6, y);
      // grid line
      ctx.strokeStyle = getCssVar(canvas, '--border') || '#333';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(paddingLeft, y);
      ctx.lineTo(paddingLeft + chartW, y);
      ctx.stroke();
    }

    // Bars
    const groupW = chartW / labels.length;
    const barW = Math.max(4, Math.min(groupW * 0.6, 32));
    const bars: typeof barsRef.current = [];

    labels.forEach((label, i) => {
      const x = paddingLeft + i * groupW + (groupW - barW) / 2;
      let cumY = 0;

      datasets.forEach(ds => {
        const val = ds.data[i];
        if (val <= 0) return;
        const barH = (val / niceMax) * chartH;
        const y = paddingTop + chartH - cumY - barH;

        ctx.fillStyle = ds.color;
        roundRect(ctx, x, y, barW, barH, 2);

        bars.push({ x, y, w: barW, h: barH, label, value: val, dataset: ds.label, color: ds.color });
        cumY += barH;
      });

      // X label
      ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('color') || '#888';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      // Show every Nth label when there are too many
      const step = labels.length > 20 ? Math.ceil(labels.length / 15) : 1;
      if (i % step === 0) {
        ctx.fillText(label, x + barW / 2, paddingTop + chartH + 6);
      }
    });

    barsRef.current = bars;
  }, [data, height, formatValue]);

  useEffect(() => {
    draw();
    const obs = new ResizeObserver(() => draw());
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [draw]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Find bar under mouse
    const hit = barsRef.current.find(b => mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h);
    if (hit) {
      setTooltip({ x: e.clientX - rect.left, y: hit.y - 4, content: `${hit.dataset}: ${formatValue(hit.value)}` });
    } else {
      setTooltip(null);
    }
  }, [formatValue]);

  return (
    <div ref={containerRef} className="relative w-full text-muted-foreground">
      <canvas
        ref={canvasRef}
        className="w-full"
        style={{ height }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
      />
      {tooltip && (
        <div
          className="absolute pointer-events-none bg-popover text-popover-foreground text-[10px] px-2 py-1 rounded shadow-lg border border-border whitespace-nowrap z-10"
          style={{ left: tooltip.x, top: tooltip.y, transform: 'translate(-50%, -100%)' }}
        >
          {tooltip.content}
        </div>
      )}
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (h < 1) return;
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.fill();
}

function getNiceMax(val: number): number {
  if (val <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(val)));
  const norm = val / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

function getCssVar(el: HTMLElement, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

// ─── Hourly activity heatmap bar ───

function HourHeatmap({ hourCounts }: { hourCounts: Record<string, number> }) {
  const max = Math.max(1, ...Object.values(hourCounts));
  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div>
      <h3 className="text-xs font-medium text-muted-foreground mb-2">活跃时段分布</h3>
      <div className="flex gap-[2px] items-end h-16">
        {hours.map(h => {
          const count = hourCounts[String(h)] || 0;
          const ratio = count / max;
          return (
            <div key={h} className="flex-1 flex flex-col items-center gap-0.5" title={`${h}:00 — ${count} 次会话`}>
              <div
                className="w-full rounded-sm transition-all"
                style={{
                  height: `${Math.max(2, ratio * 48)}px`,
                  backgroundColor: ratio > 0 ? `rgba(59, 130, 246, ${0.2 + ratio * 0.8})` : 'var(--muted)',
                }}
              />
              {h % 3 === 0 && (
                <span className="text-[8px] text-muted-foreground">{h}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───

export function TokenStatsModal({ isOpen, onClose }: TokenStatsModalProps) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<TimeRange>('day');
  const [tokenChartMode, setTokenChartMode] = useState<'tokens' | 'cost'>('tokens');

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    fetch('/api/claude-stats')
      .then(r => r.json())
      .then(data => { if (!data.error) setStats(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen]);

  // Model cost breakdown table
  const modelRows = useMemo(() => {
    if (!stats?.modelUsage) return [];
    return Object.entries(stats.modelUsage)
      .filter(([id]) => !id.startsWith('<'))  // skip <synthetic> etc.
      .map(([id, usage]) => ({
        id,
        label: getLabel(id),
        color: getColor(id),
        usage,
        cost: calcCost(id, usage),
        totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
      }))
      .sort((a, b) => b.cost - a.cost);
  }, [stats]);

  const totalCost = useMemo(() => modelRows.reduce((s, r) => s + r.cost, 0), [modelRows]);

  // All encountered model IDs (sorted by cost)
  const allModelIds = useMemo(() => modelRows.map(r => r.id), [modelRows]);

  // Average $/token per model (based on total usage ratio)
  const costPerToken = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of modelRows) {
      map[r.id] = r.totalTokens > 0 ? r.cost / r.totalTokens : 0;
    }
    return map;
  }, [modelRows]);

  // Activity trend and token trend (aggregated by timeRange)
  const { activityChart, tokenChart, costChart } = useMemo(() => {
    const daily = stats?.dailyActivity || [];
    const dailyTokens = stats?.dailyModelTokens || [];

    if (timeRange === 'day') {
      // Day view — last 60 days
      const slicedActivity = daily.slice(-60);
      const slicedTokens = dailyTokens.slice(-60);
      const labels = slicedActivity.map(d => d.date.slice(5)); // MM-DD

      const activityChart: BarChartData = {
        labels,
        datasets: [
          { label: '消息', data: slicedActivity.map(d => d.messageCount), color: '#3b82f6' },
          { label: '工具调用', data: slicedActivity.map(d => d.toolCallCount), color: '#22c55e' },
        ],
      };

      // Token chart: stacked by model
      const tokenLabels = slicedTokens.map(d => d.date.slice(5));
      const tokenChart: BarChartData = {
        labels: tokenLabels,
        datasets: allModelIds.map(id => ({
          label: getLabel(id),
          data: slicedTokens.map(d => d.tokensByModel[id] || 0),
          color: getColor(id),
        })),
      };

      // Cost chart: tokens * avg $/token per model
      const costChart: BarChartData = {
        labels: tokenLabels,
        datasets: allModelIds.map(id => ({
          label: getLabel(id),
          data: slicedTokens.map(d => (d.tokensByModel[id] || 0) * (costPerToken[id] || 0)),
          color: getColor(id),
        })),
      };

      return { activityChart, tokenChart, costChart };
    }

    if (timeRange === 'week') {
      const weeks = aggregateByWeek(daily, dailyTokens);
      const labels = weeks.map(w => w.label);

      const activityChart: BarChartData = {
        labels,
        datasets: [
          { label: '消息', data: weeks.map(w => w.messages), color: '#3b82f6' },
          { label: '工具调用', data: weeks.map(w => w.tools), color: '#22c55e' },
        ],
      };

      const tokenChart: BarChartData = {
        labels,
        datasets: allModelIds.map(id => ({
          label: getLabel(id),
          data: weeks.map(w => w.tokensByModel[id] || 0),
          color: getColor(id),
        })),
      };

      const costChart: BarChartData = {
        labels,
        datasets: allModelIds.map(id => ({
          label: getLabel(id),
          data: weeks.map(w => (w.tokensByModel[id] || 0) * (costPerToken[id] || 0)),
          color: getColor(id),
        })),
      };

      return { activityChart, tokenChart, costChart };
    }

    // month
    const months = aggregateByMonth(daily, dailyTokens);
    const labels = months.map(m => m.label);

    const activityChart: BarChartData = {
      labels,
      datasets: [
        { label: '消息', data: months.map(m => m.messages), color: '#3b82f6' },
        { label: '工具调用', data: months.map(m => m.tools), color: '#22c55e' },
      ],
    };

    const tokenChart: BarChartData = {
      labels,
      datasets: allModelIds.map(id => ({
        label: getLabel(id),
        data: months.map(m => m.tokensByModel[id] || 0),
        color: getColor(id),
      })),
    };

    const costChart: BarChartData = {
      labels,
      datasets: allModelIds.map(id => ({
        label: getLabel(id),
        data: months.map(m => (m.tokensByModel[id] || 0) * (costPerToken[id] || 0)),
        color: getColor(id),
      })),
    };

    return { activityChart, tokenChart, costChart };
  }, [stats, timeRange, allModelIds, costPerToken]);

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const rangeButtons: { key: TimeRange; label: string }[] = [
    { key: 'day', label: '日' },
    { key: 'week', label: '周' },
    { key: 'month', label: '月' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-xl shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium text-foreground">Claude Code Token 统计</h2>
            {/* Time range toggle */}
            <div className="flex bg-muted rounded-md p-0.5">
              {rangeButtons.map(b => (
                <button
                  key={b.key}
                  className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${
                    timeRange === b.key
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setTimeRange(b.key)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {loading ? (
            <div className="text-center text-muted-foreground py-12">加载中...</div>
          ) : !stats ? (
            <div className="text-center text-muted-foreground py-12">未找到 ~/.claude/stats-cache.json</div>
          ) : (
            <>
              {/* A: Overview cards */}
              <div className="grid grid-cols-5 gap-3">
                <StatCard label="总会话" value={String(stats.totalSessions ?? 0)} />
                <StatCard label="总消息" value={fmtTokens(stats.totalMessages ?? 0)} />
                <StatCard label="等效 API 费用" value={fmtCost(totalCost)} highlight />
                <StatCard
                  label="最长会话"
                  value={stats.longestSession ? formatDuration(stats.longestSession.duration) : '-'}
                />
                <StatCard
                  label="首次使用"
                  value={stats.firstSessionDate ? stats.firstSessionDate.slice(0, 10) : '-'}
                />
              </div>

              {/* B: Activity trend chart */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-muted-foreground">活动趋势</h3>
                  <div className="flex items-center gap-3 text-[10px]">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#3b82f6' }} />
                      消息
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#22c55e' }} />
                      工具调用
                    </span>
                  </div>
                </div>
                <div className="border border-border rounded-lg p-3 bg-muted/20">
                  <BarChart data={activityChart} height={180} />
                </div>
              </div>

              {/* C: Token usage / cost chart (stacked by model) */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-medium text-muted-foreground">按模型</h3>
                    <div className="flex bg-muted rounded-md p-0.5">
                      <button
                        className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${
                          tokenChartMode === 'tokens'
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                        onClick={() => setTokenChartMode('tokens')}
                      >Token 用量</button>
                      <button
                        className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${
                          tokenChartMode === 'cost'
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                        onClick={() => setTokenChartMode('cost')}
                      >等效费用</button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] flex-wrap">
                    {modelRows.map(r => (
                      <span key={r.id} className="flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: r.color }} />
                        {r.label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="border border-border rounded-lg p-3 bg-muted/20">
                  <BarChart
                    data={tokenChartMode === 'tokens' ? tokenChart : costChart}
                    height={180}
                    formatValue={tokenChartMode === 'tokens' ? fmtTokens : fmtCost}
                  />
                </div>
              </div>

              {/* D: Model cost breakdown table */}
              <div>
                <h3 className="text-xs font-medium text-muted-foreground mb-2">模型费用明细</h3>
                <div className="border border-border rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/50 text-muted-foreground">
                        <th className="text-left px-3 py-2 font-medium">模型</th>
                        <th className="text-right px-3 py-2 font-medium">Input</th>
                        <th className="text-right px-3 py-2 font-medium">Output</th>
                        <th className="text-right px-3 py-2 font-medium">Cache Read</th>
                        <th className="text-right px-3 py-2 font-medium">Cache Write</th>
                        <th className="text-right px-3 py-2 font-medium">占比</th>
                        <th className="text-right px-3 py-2 font-medium">等效费用</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modelRows.map(row => (
                        <tr key={row.id} className="border-t border-border">
                          <td className="px-3 py-2 font-mono text-foreground">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: row.color }} />
                              {row.label}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(row.usage.inputTokens)}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(row.usage.outputTokens)}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(row.usage.cacheReadInputTokens)}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(row.usage.cacheCreationInputTokens)}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">
                            {totalCost > 0 ? `${((row.cost / totalCost) * 100).toFixed(1)}%` : '-'}
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-foreground">{fmtCost(row.cost)}</td>
                        </tr>
                      ))}
                      <tr className="border-t-2 border-border bg-muted/30">
                        <td className="px-3 py-2 font-medium text-foreground">合计</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(modelRows.reduce((s, r) => s + r.usage.inputTokens, 0))}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(modelRows.reduce((s, r) => s + r.usage.outputTokens, 0))}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(modelRows.reduce((s, r) => s + r.usage.cacheReadInputTokens, 0))}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(modelRows.reduce((s, r) => s + r.usage.cacheCreationInputTokens, 0))}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">100%</td>
                        <td className="px-3 py-2 text-right font-bold text-foreground">{fmtCost(totalCost)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* E: Active hour heatmap bar */}
              {stats.hourCounts && Object.keys(stats.hourCounts).length > 0 && (
                <div className="border border-border rounded-lg p-3 bg-muted/20">
                  <HourHeatmap hourCounts={stats.hourCounts} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-muted/30 rounded-lg px-3 py-2.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold mt-0.5 ${highlight ? 'text-brand' : 'text-foreground'}`}>{value}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
