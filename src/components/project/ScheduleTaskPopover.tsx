'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

// Cron 表达式转中文描述
function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;

  const dowNames: Record<string, string> = { '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' };
  const monthNames: Record<string, string> = { '1': '1月', '2': '2月', '3': '3月', '4': '4月', '5': '5月', '6': '6月', '7': '7月', '8': '8月', '9': '9月', '10': '10月', '11': '11月', '12': '12月' };

  try {
    // 时间部分
    let timeStr = '';
    if (min.includes('/') || hour.includes('/')) {
      if (hour === '*' && min.includes('/')) {
        return `每 ${min.split('/')[1]} 分钟`;
      }
      if (min === '0' && hour.includes('/')) {
        return `每 ${hour.split('/')[1]} 小时整点`;
      }
      return null; // 复杂情况不翻译
    }
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    if (isNaN(h) && hour !== '*') return null;
    if (isNaN(m) && min !== '*') return null;
    if (hour === '*' && min === '*') {
      timeStr = '每分钟';
    } else if (hour === '*') {
      timeStr = `每小时第 ${m} 分`;
    } else if (min === '*') {
      timeStr = `${h} 点每分钟`;
    } else {
      timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // 日期部分
    const parts2: string[] = [];

    // 月份
    if (month !== '*') {
      const months = month.split(',').map(m => monthNames[m] || `${m}月`);
      parts2.push(months.join('、'));
    }

    // 日
    if (dom !== '*') {
      if (dom.includes('-')) {
        const [a, b] = dom.split('-');
        parts2.push(`${a}号到${b}号`);
      } else if (dom.includes(',')) {
        parts2.push(dom.split(',').map(d => `${d}号`).join('、'));
      } else {
        parts2.push(`${dom}号`);
      }
    }

    // 星期
    if (dow !== '*') {
      if (dow === '1-5') {
        parts2.push('工作日');
      } else if (dow === '0,6' || dow === '6,0') {
        parts2.push('周末');
      } else {
        const days = dow.split(',').map(d => {
          if (d.includes('-')) {
            const [a, b] = d.split('-');
            return `周${dowNames[a] || a}到周${dowNames[b] || b}`;
          }
          return `周${dowNames[d] || d}`;
        });
        parts2.push(days.join('、'));
      }
    }

    if (parts2.length === 0 && dom === '*' && month === '*' && dow === '*') {
      return `每天 ${timeStr}`;
    }

    return `${parts2.join(' ')} ${timeStr}`;
  } catch {
    return null;
  }
}

interface ScheduleTaskPopoverProps {
  onClose: () => void;
  onCreate: (params: {
    message: string;
    type: 'once' | 'interval' | 'cron';
    delayMinutes?: number;
    intervalMinutes?: number;
    activeFrom?: string;
    activeTo?: string;
    cron?: string;
  }) => void;
}

// 快捷预设
const PRESETS = {
  once: [
    { label: '5 分钟后', value: 5 },
    { label: '15 分钟后', value: 15 },
    { label: '30 分钟后', value: 30 },
    { label: '1 小时后', value: 60 },
  ],
  interval: [
    { label: '每 15 分钟', value: 15 },
    { label: '每 30 分钟', value: 30 },
    { label: '每 1 小时', value: 60 },
    { label: '每 2 小时', value: 120 },
  ],
  cron: [
    { label: '每天 09:00', value: '0 9 * * *' },
    { label: '每天 18:00', value: '0 18 * * *' },
    { label: '每周一 09:00', value: '0 9 * * 1' },
    { label: '每月 1 号 09:00', value: '0 9 1 * *' },
  ],
};

type TaskType = 'once' | 'interval' | 'cron';

export function ScheduleTaskPopover({ onClose, onCreate }: ScheduleTaskPopoverProps) {
  const [type, setType] = useState<TaskType>('once');
  const [message, setMessage] = useState('');
  const [customMinutes, setCustomMinutes] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [activeFrom, setActiveFrom] = useState('09:00');
  const [activeTo, setActiveTo] = useState('18:00');
  const [useTimeRange, setUseTimeRange] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<number | string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // 自动聚焦
  useEffect(() => {
    messageRef.current?.focus();
  }, []);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleCreate = useCallback(() => {
    if (!message.trim()) return;

    if (type === 'once') {
      const minutes = selectedPreset as number || parseInt(customMinutes, 10);
      if (!minutes || minutes <= 0) return;
      onCreate({ message: message.trim(), type: 'once', delayMinutes: minutes });
    } else if (type === 'interval') {
      const minutes = selectedPreset as number || parseInt(customMinutes, 10);
      if (!minutes || minutes <= 0) return;
      onCreate({
        message: message.trim(),
        type: 'interval',
        intervalMinutes: minutes,
        ...(useTimeRange ? { activeFrom, activeTo } : {}),
      });
    } else if (type === 'cron') {
      const cron = (selectedPreset as string) || customCron.trim();
      if (!cron) return;
      onCreate({ message: message.trim(), type: 'cron', cron });
    }

    onClose();
  }, [message, type, selectedPreset, customMinutes, customCron, useTimeRange, activeFrom, activeTo, onCreate, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleCreate();
    }
  };

  const isValid = () => {
    if (!message.trim()) return false;
    if (type === 'once' || type === 'interval') {
      return !!(selectedPreset || (customMinutes && parseInt(customMinutes, 10) > 0));
    }
    if (type === 'cron') {
      return !!(selectedPreset || customCron.trim());
    }
    return false;
  };

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-0 mb-2 w-80 bg-popover border border-border rounded-lg shadow-lg z-50"
      onKeyDown={handleKeyDown}
    >
      <div className="px-3 py-2 border-b border-border bg-muted/50 rounded-t-lg">
        <span className="text-sm font-medium">创建定时任务</span>
      </div>

      <div className="p-3 space-y-3">
        {/* 消息内容 */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">发送消息</label>
          <textarea
            ref={messageRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="输入要发送的消息..."
            rows={2}
            className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
          />
        </div>

        {/* 类型选择 */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">类型</label>
          <div className="flex gap-1">
            {(['once', 'interval', 'cron'] as const).map((t) => (
              <button
                key={t}
                onClick={() => { setType(t); setSelectedPreset(null); setCustomMinutes(''); setCustomCron(''); }}
                className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                  type === t
                    ? 'bg-brand text-white'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {t === 'once' ? '一次性' : t === 'interval' ? '周期' : 'Cron'}
              </button>
            ))}
          </div>
        </div>

        {/* 快捷预设 */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">快捷选择</label>
          <div className="grid grid-cols-2 gap-1">
            {PRESETS[type].map((preset) => (
              <button
                key={preset.label}
                onClick={() => {
                  setSelectedPreset(preset.value);
                  if (type === 'cron') {
                    setCustomCron(String(preset.value));
                  } else {
                    setCustomMinutes(String(preset.value));
                  }
                }}
                className={`px-2 py-1 text-xs rounded border transition-colors ${
                  selectedPreset === preset.value
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* 自定义输入 */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            {type === 'cron' ? '自定义 Cron 表达式' : '自定义分钟数'}
          </label>
          {type === 'cron' ? (
            <>
              <input
                type="text"
                value={customCron}
                onChange={(e) => { setCustomCron(e.target.value); setSelectedPreset(null); }}
                placeholder="例: 0 9 * * 1-5 (工作日9点)"
                className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
              />
              {customCron.trim() && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {describeCron(customCron.trim()) || <span className="text-destructive">格式：分 时 日 月 星期（如 0 9 * * 1-5）</span>}
                </div>
              )}
            </>
          ) : (
            <input
              type="number"
              value={customMinutes}
              onChange={(e) => { setCustomMinutes(e.target.value); setSelectedPreset(null); }}
              placeholder="分钟数"
              min={1}
              className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          )}
        </div>

        {/* 活跃时间范围（仅周期任务） */}
        {type === 'interval' && (
          <div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1 cursor-pointer">
              <input
                type="checkbox"
                checked={useTimeRange}
                onChange={(e) => setUseTimeRange(e.target.checked)}
                className="rounded border-border"
              />
              限制执行时段
            </label>
            {useTimeRange && (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="time"
                  value={activeFrom}
                  onChange={(e) => setActiveFrom(e.target.value)}
                  className="flex-1 px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <span className="text-xs text-muted-foreground">至</span>
                <input
                  type="time"
                  value={activeTo}
                  onChange={(e) => setActiveTo(e.target.value)}
                  className="flex-1 px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            )}
          </div>
        )}

        {/* 创建按钮 */}
        <button
          onClick={handleCreate}
          disabled={!isValid()}
          className="w-full py-1.5 text-sm font-medium rounded bg-brand text-white hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          创建 (⌘↩)
        </button>
      </div>
    </div>
  );
}
