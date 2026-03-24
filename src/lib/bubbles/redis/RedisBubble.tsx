'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { BUBBLE_CONTENT_HEIGHT } from '@/components/project/console/CommandBubble';
import { useToast } from '@/components/shared/Toast';
import { modKey } from '@/lib/platform';

// ============================================================================
// Types
// ============================================================================

interface RedisKeyInfo {
  key: string;
  type: string;
}

interface KeyValue {
  type: string;
  value: unknown;
  ttl: number;
  size: number | null;
}

interface CliEntry {
  command: string;
  result: unknown;
  duration: number;
  isError: boolean;
}

type ActiveTab = 'data' | 'info' | 'cli';

// ============================================================================
// Helpers
// ============================================================================

const TOOLBAR_HEIGHT = 41;

function formatTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

function formatTTL(ttl: number): string {
  if (ttl === -1) return '永不过期';
  if (ttl === -2) return '已过期';
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m${ttl % 60 > 0 ? ` ${ttl % 60}s` : ''}`;
  const h = Math.floor(ttl / 3600);
  const m = Math.floor((ttl % 3600) / 60);
  return `${h}h${m > 0 ? ` ${m}m` : ''}`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/** 格式化 Redis 命令结果用于 CLI 显示 */
function formatResult(result: unknown, indent: number = 0): string {
  const pad = ' '.repeat(indent);
  if (result === null) return `${pad}(nil)`;
  if (typeof result === 'number') return `${pad}(integer) ${result}`;
  if (typeof result === 'string') return `${pad}"${result}"`;
  if (Array.isArray(result)) {
    if (result.length === 0) return `${pad}(empty array)`;
    return result.map((item, i) => `${pad}${i + 1}) ${formatResult(item, 0)}`).join('\n');
  }
  return `${pad}${String(result)}`;
}

// ============================================================================
// Type Badge
// ============================================================================

const TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  string:  { label: 'S',   color: 'text-emerald-500 bg-emerald-500/10' },
  hash:    { label: 'H',   color: 'text-blue-500 bg-blue-500/10' },
  list:    { label: 'L',   color: 'text-orange-500 bg-orange-500/10' },
  set:     { label: 'SET', color: 'text-teal-500 bg-teal-500/10' },
  zset:    { label: 'Z',   color: 'text-purple-500 bg-purple-500/10' },
  stream:  { label: 'STR', color: 'text-pink-500 bg-pink-500/10' },
};

function TypeBadge({ type }: { type: string }) {
  const cfg = TYPE_CONFIG[type] || { label: '?', color: 'text-muted-foreground bg-muted' };
  return (
    <span className={`inline-block text-[9px] font-mono font-bold leading-none px-1 py-0.5 rounded flex-shrink-0 ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

// ============================================================================
// CellTooltip — 悬浮提示
// ============================================================================

function CellTooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0, above: true });
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const handleEnter = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const el = wrapRef.current;
      if (!el || el.scrollWidth <= el.clientWidth) return;
      const rect = el.getBoundingClientRect();
      const above = rect.top > window.innerHeight / 2;
      setPos({ x: rect.left, y: above ? rect.top - 4 : rect.bottom + 4, above });
      setShow(true);
    }, 350);
  }, []);

  const handleLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setShow(false);
  }, []);

  return (
    <span ref={wrapRef} className="block truncate" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {text}
      {show && createPortal(
        <div
          className="fixed z-[9999] max-w-[500px] max-h-[200px] overflow-y-auto px-2 py-1.5 text-xs font-mono bg-popover text-popover-foreground border border-border rounded shadow-lg whitespace-pre-wrap break-all select-text"
          style={{ left: pos.x, top: pos.y, transform: pos.above ? 'translateY(-100%)' : undefined }}
        >
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

// ============================================================================
// RedisBubble
// ============================================================================

interface RedisBubbleProps {
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

export function RedisBubble({
  id,
  connectionString,
  displayName,
  selected,
  maximized,
  expandedHeight,
  bubbleContentHeight,
  onSelect,
  onClose,
  onToggleMaximize,
  timestamp,
  onTitleMouseDown,
}: RedisBubbleProps) {
  const { showToast } = useToast();

  // Connection state
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [serverInfo, setServerInfo] = useState<{ version: string; mode: string; dbSize: number; memory: string } | null>(null);

  // Key browser
  const [keys, setKeys] = useState<RedisKeyInfo[]>([]);
  const [scanCursor, setScanCursor] = useState('0');
  const [hasMoreKeys, setHasMoreKeys] = useState(false);
  const [keyPattern, setKeyPattern] = useState('*');
  const [keysLoading, setKeysLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState<KeyValue | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);

  // Editing
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Tabs
  const [activeTab, setActiveTab] = useState<ActiveTab>('data');

  // Info tab
  const [infoText, setInfoText] = useState('');

  // CLI tab
  const [cliInput, setCliInput] = useState('');
  const [cliHistory, setCliHistory] = useState<CliEntry[]>([]);
  const [cliLoading, setCliLoading] = useState(false);
  const cliEndRef = useRef<HTMLDivElement>(null);
  const cliInputRef = useRef<HTMLInputElement>(null);

  // ---- Connect on mount ----
  const connect = useCallback(async () => {
    setStatus('connecting');
    setErrorMsg('');
    try {
      const data = await apiPost('/api/redis/connect', { id, connectionString });
      setServerInfo(data);
      setStatus('connected');
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [id, connectionString]);

  useEffect(() => { connect(); }, [connect]);

  // ---- Load keys ----
  const loadKeys = useCallback(async (pattern: string, cursor: string, append: boolean) => {
    setKeysLoading(true);
    try {
      const data = await apiPost('/api/redis/keys', { id, connectionString, pattern, cursor, count: 200 });
      setKeys(prev => append ? [...prev, ...data.keys] : data.keys);
      setScanCursor(data.cursor);
      setHasMoreKeys(data.hasMore);
    } catch { /* ignore */ }
    setKeysLoading(false);
  }, [id, connectionString]);

  // Initial key load after connect
  useEffect(() => {
    if (status === 'connected') {
      loadKeys(keyPattern, '0', false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // ---- Search keys ----
  const handleSearch = useCallback(() => {
    setSelectedKey(null);
    setKeyValue(null);
    loadKeys(keyPattern, '0', false);
  }, [keyPattern, loadKeys]);

  // ---- Select key ----
  const selectKey = useCallback(async (key: string) => {
    setSelectedKey(key);
    setKeyLoading(true);
    setEditingValue(null);
    setConfirmingDelete(false);
    try {
      const data = await apiPost('/api/redis/get', { id, connectionString, key });
      setKeyValue(data);
    } catch (e: unknown) {
      setKeyValue(null);
      showToast(e instanceof Error ? e.message : '加载失败');
    }
    setKeyLoading(false);
  }, [id, connectionString, showToast]);

  // ---- Delete key ----
  const deleteKey = useCallback(async () => {
    if (!selectedKey) return;
    try {
      await apiPost('/api/redis/delete', { id, connectionString, keys: [selectedKey] });
      setSelectedKey(null);
      setKeyValue(null);
      setConfirmingDelete(false);
      // Refresh key list
      loadKeys(keyPattern, '0', false);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '删除失败');
    }
  }, [selectedKey, id, connectionString, keyPattern, loadKeys, showToast]);

  // ---- Save string value ----
  const saveStringValue = useCallback(async () => {
    if (!selectedKey || editingValue === null) return;
    try {
      await apiPost('/api/redis/set', { id, connectionString, key: selectedKey, value: editingValue, type: 'string' });
      setEditingValue(null);
      selectKey(selectedKey); // refresh
      showToast('已保存');
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '保存失败');
    }
  }, [selectedKey, editingValue, id, connectionString, selectKey, showToast]);

  // ---- Load INFO ----
  const loadInfo = useCallback(async () => {
    try {
      const data = await apiPost('/api/redis/command', { id, connectionString, command: 'INFO' });
      setInfoText(typeof data.result === 'string' ? data.result : String(data.result));
    } catch { /* ignore */ }
  }, [id, connectionString]);

  useEffect(() => {
    if (status === 'connected' && activeTab === 'info') {
      loadInfo();
    }
  }, [status, activeTab, loadInfo]);

  // ---- Execute CLI command ----
  const executeCli = useCallback(async () => {
    const input = cliInput.trim();
    if (!input) return;
    setCliLoading(true);
    setCliInput('');

    // 解析命令：第一个词是命令名，后续是参数（支持引号包裹）
    const parts: string[] = [];
    const re = /(?:"([^"]*)")|(?:'([^']*)')|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      parts.push(m[1] ?? m[2] ?? m[3]);
    }
    const command = parts[0] || '';
    const args = parts.slice(1);

    try {
      const data = await apiPost('/api/redis/command', { id, connectionString, command, args });
      setCliHistory(prev => [...prev, { command: input, result: data.result, duration: data.duration, isError: false }]);
    } catch (e: unknown) {
      setCliHistory(prev => [...prev, { command: input, result: e instanceof Error ? e.message : String(e), duration: 0, isError: true }]);
    }
    setCliLoading(false);
  }, [cliInput, id, connectionString]);

  // Auto-scroll CLI
  useEffect(() => {
    cliEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [cliHistory]);

  // ---- Height calc ----
  const contentHeight = maximized && expandedHeight
    ? expandedHeight - TOOLBAR_HEIGHT
    : (bubbleContentHeight ?? BUBBLE_CONTENT_HEIGHT);

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="flex flex-col items-start">
      <div
        className={`w-full bg-accent text-foreground
          relative transition-colors cursor-pointer
          ${maximized ? 'rounded-none overflow-visible border-0' : 'border overflow-hidden rounded-2xl rounded-bl-md rounded-br-md'}
          ${maximized ? '' : selected ? 'border-brand' : 'border-brand/30'}`}
        onClick={maximized ? undefined : onSelect}
      >
        {/* ---- Title Bar ---- */}
        <div
          data-drag-handle
          onDoubleClick={onToggleMaximize}
          onMouseDown={onTitleMouseDown}
          className={`flex items-center gap-2 px-4 py-1.5 border-b border-border ${maximized ? 'bg-card' : 'bg-card/50'}`}
          style={maximized ? { height: TOOLBAR_HEIGHT } : undefined}
        >
          <span className="text-sm flex-shrink-0">♦</span>
          <span className="text-xs text-foreground truncate font-mono font-medium">{displayName}</span>
          {status === 'connecting' && (
            <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
          )}
          {status === 'error' && (
            <span className="text-[10px] text-destructive flex-shrink-0">连接失败</span>
          )}
          {status === 'connected' && serverInfo && (
            <span className="text-[10px] text-red-500 flex-shrink-0">
              v{serverInfo.version} · {serverInfo.dbSize} keys · {serverInfo.memory}
            </span>
          )}
          <span className="flex-1" />
          {timestamp && (
            <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatTime(timestamp)}</span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onToggleMaximize(); }}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
            title={maximized ? `退出最大化 (${modKey()}M)` : `最大化 (${modKey()}M)`}
          >
            {maximized ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            )}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
            title="关闭"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ---- Body ---- */}
        <div style={{ height: contentHeight }} className="flex overflow-hidden">
          {status === 'connecting' && (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin mr-2" />
              连接中...
            </div>
          )}
          {status === 'error' && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4">
              <span className="text-sm text-destructive text-center break-all">{errorMsg}</span>
              <button
                onClick={connect}
                className="px-3 py-1.5 text-xs bg-brand text-white rounded-md hover:bg-brand/90 transition-colors"
              >
                重试
              </button>
            </div>
          )}
          {status === 'connected' && (
            <>
              {/* Left sidebar — key list */}
              <div className="w-52 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
                {/* Search bar */}
                <div className="p-1.5 border-b border-border flex items-center gap-1">
                  <input
                    type="text"
                    value={keyPattern}
                    onChange={(e) => setKeyPattern(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
                    placeholder="SCAN 模式..."
                    className="flex-1 min-w-0 text-xs bg-background border border-input rounded px-1.5 py-1 font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    onClick={handleSearch}
                    className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent active:bg-accent/50 transition-colors"
                    title="搜索 (SCAN)"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="6.5" cy="6.5" r="4.5" /><path d="M10 10l4 4" />
                    </svg>
                  </button>
                  <button
                    onClick={() => loadKeys(keyPattern, '0', false)}
                    className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent active:bg-accent/50 transition-colors"
                    title="刷新"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 1v5h5" /><path d="M15 15v-5h-5" />
                      <path d="M13.5 6A6 6 0 0 0 3.2 3.2L1 6" /><path d="M2.5 10a6 6 0 0 0 10.3 2.8L15 10" />
                    </svg>
                  </button>
                </div>

                {/* Key list */}
                <div className="flex-1 overflow-y-auto text-xs">
                  {keys.map((k) => (
                    <div
                      key={k.key}
                      onClick={() => selectKey(k.key)}
                      className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors ${
                        selectedKey === k.key ? 'bg-brand/10 text-brand' : 'hover:bg-accent text-foreground'
                      }`}
                    >
                      <TypeBadge type={k.type} />
                      <span className="truncate min-w-0 flex-1 font-mono"><CellTooltip text={k.key} /></span>
                    </div>
                  ))}
                  {keys.length === 0 && !keysLoading && (
                    <div className="p-2 text-muted-foreground text-center">无 key</div>
                  )}
                  {keysLoading && (
                    <div className="p-2 flex items-center justify-center">
                      <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  {hasMoreKeys && !keysLoading && (
                    <button
                      onClick={() => loadKeys(keyPattern, scanCursor, true)}
                      className="w-full py-1.5 text-[10px] text-brand hover:text-brand/80 transition-colors"
                    >
                      加载更多...
                    </button>
                  )}
                </div>

                {/* Key count */}
                <div className="px-2 py-1 border-t border-border text-[10px] text-muted-foreground">
                  {keys.length} keys{hasMoreKeys ? '+' : ''}{serverInfo ? ` / ${serverInfo.dbSize} total` : ''}
                </div>
              </div>

              {/* Right main area */}
              <div className="flex-1 flex flex-col overflow-hidden min-w-0">
                {/* Tabs */}
                <div className="flex items-center gap-0 border-b border-border bg-card/30 flex-shrink-0">
                  {(['data', 'info', 'cli'] as ActiveTab[]).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`px-3 py-1.5 text-xs transition-colors ${
                        activeTab === tab
                          ? 'text-brand border-b-2 border-brand font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {{ data: '数据', info: '信息', cli: 'CLI' }[tab]}
                    </button>
                  ))}
                  {/* Key actions */}
                  {selectedKey && activeTab === 'data' && (
                    <div className="ml-auto flex items-center gap-1 pr-2">
                      {keyValue && (
                        <span className="text-[10px] text-muted-foreground">
                          TTL: {formatTTL(keyValue.ttl)}
                          {keyValue.size !== null ? ` · ${formatBytes(keyValue.size)}` : ''}
                        </span>
                      )}
                      {!confirmingDelete ? (
                        <button
                          onClick={() => setConfirmingDelete(true)}
                          className="px-1.5 py-0.5 text-[10px] text-destructive hover:text-destructive/80 bg-destructive/10 rounded transition-colors"
                        >
                          删除
                        </button>
                      ) : (
                        <>
                          <span className="text-[10px] text-destructive">确认?</span>
                          <button
                            onClick={deleteKey}
                            className="px-1.5 py-0.5 text-[10px] text-white bg-destructive rounded transition-colors hover:bg-destructive/80"
                          >
                            确认
                          </button>
                          <button
                            onClick={() => setConfirmingDelete(false)}
                            className="px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground bg-muted rounded transition-colors"
                          >
                            取消
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Tab content */}
                <div className="flex-1 overflow-auto">
                  {activeTab === 'data' ? (
                    <DataTabContent
                      selectedKey={selectedKey}
                      keyValue={keyValue}
                      keyLoading={keyLoading}
                      editingValue={editingValue}
                      onStartEdit={(v) => setEditingValue(v)}
                      onEditChange={setEditingValue}
                      onSaveEdit={saveStringValue}
                      onCancelEdit={() => setEditingValue(null)}
                      onCellCopy={(text) => { navigator.clipboard.writeText(text); showToast('已复制'); }}
                    />
                  ) : activeTab === 'info' ? (
                    <InfoTabContent infoText={infoText} onRefresh={loadInfo} />
                  ) : (
                    <CliTabContent
                      cliInput={cliInput}
                      onInputChange={setCliInput}
                      onExecute={executeCli}
                      history={cliHistory}
                      loading={cliLoading}
                      endRef={cliEndRef}
                      inputRef={cliInputRef}
                    />
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// DataTabContent — 根据 key 类型展示值
// ============================================================================

function DataTabContent({
  selectedKey, keyValue, keyLoading,
  editingValue, onStartEdit, onEditChange, onSaveEdit, onCancelEdit,
  onCellCopy,
}: {
  selectedKey: string | null;
  keyValue: KeyValue | null;
  keyLoading: boolean;
  editingValue: string | null;
  onStartEdit: (val: string) => void;
  onEditChange: (val: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onCellCopy: (text: string) => void;
}) {
  if (!selectedKey) {
    return <div className="flex items-center justify-center h-full text-sm text-muted-foreground">选择左侧 Key</div>;
  }
  if (keyLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!keyValue) {
    return <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Key 不存在</div>;
  }

  const { type, value } = keyValue;

  // String
  if (type === 'string') {
    const strVal = String(value ?? '');
    const isEditing = editingValue !== null;
    return (
      <div className="p-3 h-full flex flex-col">
        <div className="flex items-center gap-2 mb-2">
          <TypeBadge type="string" />
          <span className="text-xs font-mono text-muted-foreground truncate">{selectedKey}</span>
          <span className="flex-1" />
          {!isEditing ? (
            <button
              onClick={() => onStartEdit(strVal)}
              className="px-2 py-0.5 text-[10px] text-brand hover:text-brand/80 bg-brand/10 rounded transition-colors"
            >
              编辑
            </button>
          ) : (
            <div className="flex gap-1">
              <button onClick={onSaveEdit} className="px-2 py-0.5 text-[10px] text-white bg-brand rounded hover:bg-brand/90">保存</button>
              <button onClick={onCancelEdit} className="px-2 py-0.5 text-[10px] text-muted-foreground bg-muted rounded hover:text-foreground">取消</button>
            </div>
          )}
        </div>
        {isEditing ? (
          <textarea
            value={editingValue}
            onChange={(e) => onEditChange(e.target.value)}
            className="flex-1 w-full px-2 py-1.5 text-xs font-mono bg-background border border-input rounded resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            spellCheck={false}
          />
        ) : (
          <pre
            className="flex-1 overflow-auto text-xs font-mono bg-muted/30 rounded p-2 whitespace-pre-wrap break-all select-text cursor-text"
            onContextMenu={(e) => { e.preventDefault(); onCellCopy(strVal); }}
          >
            {strVal}
          </pre>
        )}
      </div>
    );
  }

  // Hash
  if (type === 'hash') {
    const entries = Object.entries((value as Record<string, string>) || {});
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
          <TypeBadge type="hash" />
          <span className="text-xs font-mono text-muted-foreground truncate">{selectedKey}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">{entries.length} fields</span>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-card z-[1]">
              <tr>
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b border-border w-1/3">Field</th>
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b border-border">Value</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([field, val]) => (
                <tr key={field} className="hover:bg-accent/50">
                  <td
                    className="px-2 py-0.5 border-b border-border/50 font-mono truncate max-w-[150px]"
                    onContextMenu={(e) => { e.preventDefault(); onCellCopy(field); }}
                  >
                    <CellTooltip text={field} />
                  </td>
                  <td
                    className="px-2 py-0.5 border-b border-border/50 font-mono truncate max-w-[300px]"
                    onContextMenu={(e) => { e.preventDefault(); onCellCopy(val); }}
                  >
                    <CellTooltip text={val} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // List
  if (type === 'list') {
    const data = value as { items: string[]; total: number } | null;
    const items = data?.items || [];
    const total = data?.total || 0;
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
          <TypeBadge type="list" />
          <span className="text-xs font-mono text-muted-foreground truncate">{selectedKey}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">{total} items{items.length < total ? ` (显示 ${items.length})` : ''}</span>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-card z-[1]">
              <tr>
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b border-border w-16">#</th>
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b border-border">Value</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} className="hover:bg-accent/50">
                  <td className="px-2 py-0.5 border-b border-border/50 text-muted-foreground">{i}</td>
                  <td
                    className="px-2 py-0.5 border-b border-border/50 font-mono truncate max-w-[300px]"
                    onContextMenu={(e) => { e.preventDefault(); onCellCopy(item); }}
                  >
                    <CellTooltip text={item} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Set
  if (type === 'set') {
    const data = value as { items: string[]; total: number } | null;
    const items = data?.items || [];
    const total = data?.total || 0;
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
          <TypeBadge type="set" />
          <span className="text-xs font-mono text-muted-foreground truncate">{selectedKey}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">{total} members{items.length < total ? ` (显示 ${items.length})` : ''}</span>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-card z-[1]">
              <tr>
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b border-border">Member</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} className="hover:bg-accent/50">
                  <td
                    className="px-2 py-0.5 border-b border-border/50 font-mono truncate max-w-[400px]"
                    onContextMenu={(e) => { e.preventDefault(); onCellCopy(item); }}
                  >
                    <CellTooltip text={item} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Sorted Set
  if (type === 'zset') {
    const data = value as { items: { member: string; score: string }[]; total: number } | null;
    const items = data?.items || [];
    const total = data?.total || 0;
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
          <TypeBadge type="zset" />
          <span className="text-xs font-mono text-muted-foreground truncate">{selectedKey}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">{total} members{items.length < total ? ` (显示 ${items.length})` : ''}</span>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-card z-[1]">
              <tr>
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b border-border">Member</th>
                <th className="px-2 py-1 text-right text-muted-foreground font-medium border-b border-border w-28">Score</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} className="hover:bg-accent/50">
                  <td
                    className="px-2 py-0.5 border-b border-border/50 font-mono truncate max-w-[300px]"
                    onContextMenu={(e) => { e.preventDefault(); onCellCopy(item.member); }}
                  >
                    <CellTooltip text={item.member} />
                  </td>
                  <td className="px-2 py-0.5 border-b border-border/50 font-mono text-right text-muted-foreground">
                    {item.score}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Stream
  if (type === 'stream') {
    const data = value as { entries: [string, string[]][]; total: number } | null;
    const entries = data?.entries || [];
    const total = data?.total || 0;
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
          <TypeBadge type="stream" />
          <span className="text-xs font-mono text-muted-foreground truncate">{selectedKey}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">{total} entries{entries.length < total ? ` (显示 ${entries.length})` : ''}</span>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-card z-[1]">
              <tr>
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b border-border w-40">ID</th>
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b border-border">Fields</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([entryId, fields]) => {
                // fields is [key1, val1, key2, val2, ...]
                const pairs: string[] = [];
                for (let i = 0; i < fields.length; i += 2) {
                  pairs.push(`${fields[i]}: ${fields[i + 1]}`);
                }
                return (
                  <tr key={entryId} className="hover:bg-accent/50">
                    <td className="px-2 py-0.5 border-b border-border/50 font-mono text-muted-foreground">{entryId}</td>
                    <td className="px-2 py-0.5 border-b border-border/50 font-mono truncate max-w-[300px]">
                      <CellTooltip text={pairs.join(', ')} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Unknown type
  return (
    <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
      不支持的类型: {type}
    </div>
  );
}

// ============================================================================
// InfoTabContent — Redis INFO 信息展示
// ============================================================================

function InfoTabContent({ infoText, onRefresh }: { infoText: string; onRefresh: () => void }) {
  if (!infoText) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 解析 INFO 文本为分段
  const sections: { title: string; items: { key: string; value: string }[] }[] = [];
  let current: { title: string; items: { key: string; value: string }[] } | null = null;
  for (const line of infoText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      current = { title: trimmed.replace(/^#\s*/, ''), items: [] };
      sections.push(current);
    } else if (current && trimmed.includes(':')) {
      const idx = trimmed.indexOf(':');
      current.items.push({ key: trimmed.slice(0, idx), value: trimmed.slice(idx + 1) });
    }
  }

  return (
    <div className="p-2 space-y-3 overflow-auto h-full">
      <div className="flex justify-end">
        <button
          onClick={onRefresh}
          className="px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground bg-muted rounded transition-colors"
        >
          刷新
        </button>
      </div>
      {sections.map((section) => (
        <div key={section.title}>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide px-1 mb-1 font-medium">{section.title}</div>
          <div className="space-y-0">
            {section.items.map(({ key, value }) => (
              <div key={key} className="flex items-start gap-2 px-1.5 py-0.5 text-xs hover:bg-accent/50 rounded">
                <span className="text-muted-foreground font-mono flex-shrink-0 w-48 truncate">{key}</span>
                <span className="font-mono text-foreground break-all">{value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// CliTabContent — Redis CLI
// ============================================================================

function CliTabContent({
  cliInput, onInputChange, onExecute, history, loading, endRef, inputRef,
}: {
  cliInput: string;
  onInputChange: (val: string) => void;
  onExecute: () => void;
  history: CliEntry[];
  loading: boolean;
  endRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="flex flex-col h-full">
      {/* History */}
      <div className="flex-1 overflow-auto p-2 font-mono text-xs space-y-2" onClick={() => inputRef.current?.focus()}>
        {history.length === 0 && (
          <div className="text-muted-foreground text-center py-4">输入 Redis 命令，如 PING, GET key, KEYS *</div>
        )}
        {history.map((entry, i) => (
          <div key={i}>
            <div className="text-brand">
              <span className="text-muted-foreground mr-1">&gt;</span>
              {entry.command}
              {entry.duration > 0 && <span className="text-muted-foreground/50 ml-2">({entry.duration}ms)</span>}
            </div>
            <pre className={`whitespace-pre-wrap break-all mt-0.5 ${entry.isError ? 'text-destructive' : 'text-foreground'}`}>
              {entry.isError ? `(error) ${entry.result}` : formatResult(entry.result)}
            </pre>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border bg-card/30 flex-shrink-0">
        <span className="text-xs text-brand font-mono flex-shrink-0">&gt;</span>
        <input
          ref={inputRef}
          type="text"
          value={cliInput}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !loading) onExecute(); }}
          placeholder="输入命令..."
          className="flex-1 min-w-0 text-xs font-mono bg-transparent border-0 focus:outline-none"
          autoComplete="off"
          spellCheck={false}
          disabled={loading}
        />
        {loading && (
          <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
        )}
      </div>
    </div>
  );
}
