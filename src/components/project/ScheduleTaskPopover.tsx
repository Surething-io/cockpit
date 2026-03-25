'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n';
import { modKey } from '@/lib/platform';

// Convert cron expression to human-readable description
function describeCron(expr: string): string | null {
  const t = i18n.t;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;

  const dowNames: Record<string, string> = {
    '0': t('cron.dowSun'), '1': t('cron.dowMon'), '2': t('cron.dowTue'),
    '3': t('cron.dowWed'), '4': t('cron.dowThu'), '5': t('cron.dowFri'), '6': t('cron.dowSat')
  };
  const monthNames: Record<string, string> = {
    '1': `1${t('cron.monthPrefix')}`, '2': `2${t('cron.monthPrefix')}`, '3': `3${t('cron.monthPrefix')}`,
    '4': `4${t('cron.monthPrefix')}`, '5': `5${t('cron.monthPrefix')}`, '6': `6${t('cron.monthPrefix')}`,
    '7': `7${t('cron.monthPrefix')}`, '8': `8${t('cron.monthPrefix')}`, '9': `9${t('cron.monthPrefix')}`,
    '10': `10${t('cron.monthPrefix')}`, '11': `11${t('cron.monthPrefix')}`, '12': `12${t('cron.monthPrefix')}`
  };

  try {
    // Time part
    let timeStr = '';
    if (min.includes('/') || hour.includes('/')) {
      if (hour === '*' && min.includes('/')) {
        return t('cron.everyNMinutes', { n: min.split('/')[1] });
      }
      if (min === '0' && hour.includes('/')) {
        return t('cron.everyNHours', { n: hour.split('/')[1] });
      }
      return null; // Complex patterns are not handled
    }
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    if (isNaN(h) && hour !== '*') return null;
    if (isNaN(m) && min !== '*') return null;
    if (hour === '*' && min === '*') {
      timeStr = t('cron.everyMinute');
    } else if (hour === '*') {
      timeStr = t('cron.everyHourAtMin', { m });
    } else if (min === '*') {
      timeStr = t('cron.hourlyEveryMin', { h });
    } else {
      timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // Date part
    const parts2: string[] = [];

    // Month
    if (month !== '*') {
      const months = month.split(',').map(m => monthNames[m] || `${m}${t('cron.monthPrefix')}`);
      parts2.push(months.join(', '));
    }

    // Day of month
    if (dom !== '*') {
      if (dom.includes('-')) {
        const [a, b] = dom.split('-');
        parts2.push(t('cron.dayRange', { a, b }));
      } else if (dom.includes(',')) {
        parts2.push(dom.split(',').map(d => `${d}${t('cron.dayOfMonth')}`).join(', '));
      } else {
        parts2.push(`${dom}${t('cron.dayOfMonth')}`);
      }
    }

    // Day of week
    if (dow !== '*') {
      if (dow === '1-5') {
        parts2.push(t('cron.weekdays'));
      } else if (dow === '0,6' || dow === '6,0') {
        parts2.push(t('cron.weekends'));
      } else {
        const days = dow.split(',').map(d => {
          if (d.includes('-')) {
            const [a, b] = d.split('-');
            return t('cron.weekdayRange', { a: dowNames[a] || a, b: dowNames[b] || b });
          }
          return `${t('cron.weekdayPrefix')}${dowNames[d] || d}`;
        });
        parts2.push(days.join(', '));
      }
    }

    if (parts2.length === 0 && dom === '*' && month === '*' && dow === '*') {
      return t('cron.daily', { time: timeStr });
    }

    return `${parts2.join(' ')} ${timeStr}`;
  } catch {
    return null;
  }
}

interface TaskParams {
  message: string;
  type: 'once' | 'interval' | 'cron';
  delayMinutes?: number;
  intervalMinutes?: number;
  activeFrom?: string;
  activeTo?: string;
  cron?: string;
}

interface ScheduleTaskPopoverProps {
  onClose: () => void;
  onCreate: (params: TaskParams) => void;
  /** Edit mode: pass in existing task data */
  editTask?: {
    id: string;
    message: string;
    type: 'once' | 'interval' | 'cron';
    delayMinutes?: number;
    intervalMinutes?: number;
    activeFrom?: string;
    activeTo?: string;
    cron?: string;
  };
  onUpdate?: (id: string, params: TaskParams) => void;
}

// Quick presets - labels are i18n keys, resolved at render time
const PRESETS = {
  once: [
    { labelKey: 'scheduledTasks.5minLater', value: 5 },
    { labelKey: 'scheduledTasks.15minLater', value: 15 },
    { labelKey: 'scheduledTasks.30minLater', value: 30 },
    { labelKey: 'scheduledTasks.1hourLater', value: 60 },
  ],
  interval: [
    { labelKey: 'scheduledTasks.every15min', value: 15 },
    { labelKey: 'scheduledTasks.every30min', value: 30 },
    { labelKey: 'scheduledTasks.every1hour', value: 60 },
    { labelKey: 'scheduledTasks.every2hours', value: 120 },
  ],
  cron: [
    { labelKey: 'scheduledTasks.daily9am', value: '0 9 * * *' },
    { labelKey: 'scheduledTasks.daily6pm', value: '0 18 * * *' },
    { labelKey: 'scheduledTasks.weeklyMon9am', value: '0 9 * * 1' },
    { labelKey: 'scheduledTasks.monthly1st9am', value: '0 9 1 * *' },
  ],
};

type TaskType = 'once' | 'interval' | 'cron';

export function ScheduleTaskPopover({ onClose, onCreate, editTask, onUpdate }: ScheduleTaskPopoverProps) {
  const { t } = useTranslation();
  const isEdit = !!editTask;
  const [type, setType] = useState<TaskType>(editTask?.type || 'once');
  const [message, setMessage] = useState(editTask?.message || '');
  const [customMinutes, setCustomMinutes] = useState(
    editTask ? String(editTask.delayMinutes || editTask.intervalMinutes || '') : ''
  );
  const [customCron, setCustomCron] = useState(editTask?.cron || '');
  const [activeFrom, setActiveFrom] = useState(editTask?.activeFrom || '09:00');
  const [activeTo, setActiveTo] = useState(editTask?.activeTo || '18:00');
  const [useTimeRange, setUseTimeRange] = useState(!!(editTask?.activeFrom && editTask?.activeTo));
  const [selectedPreset, setSelectedPreset] = useState<number | string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus
  useEffect(() => {
    messageRef.current?.focus();
  }, []);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleSubmit = useCallback(() => {
    if (!message.trim()) return;

    let params: TaskParams | null = null;

    if (type === 'once') {
      const minutes = selectedPreset as number || parseInt(customMinutes, 10);
      if (!minutes || minutes <= 0) return;
      params = { message: message.trim(), type: 'once', delayMinutes: minutes };
    } else if (type === 'interval') {
      const minutes = selectedPreset as number || parseInt(customMinutes, 10);
      if (!minutes || minutes <= 0) return;
      params = {
        message: message.trim(),
        type: 'interval',
        intervalMinutes: minutes,
        ...(useTimeRange ? { activeFrom, activeTo } : {}),
      };
    } else if (type === 'cron') {
      const cron = (selectedPreset as string) || customCron.trim();
      if (!cron) return;
      params = { message: message.trim(), type: 'cron', cron };
    }

    if (!params) return;

    if (isEdit && editTask && onUpdate) {
      onUpdate(editTask.id, params);
    } else {
      onCreate(params);
    }

    onClose();
  }, [message, type, selectedPreset, customMinutes, customCron, useTimeRange, activeFrom, activeTo, onCreate, onClose, isEdit, editTask, onUpdate]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSubmit();
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
      className={`w-80 bg-popover border border-border rounded-lg shadow-lg z-50 ${isEdit ? '' : 'absolute bottom-full left-0 mb-2'}`}
      onKeyDown={handleKeyDown}
    >
      <div className="px-3 py-2 border-b border-border bg-muted/50 rounded-t-lg">
        <span className="text-sm font-medium">{isEdit ? t('scheduledTasks.editTask') : t('scheduledTasks.createTask')}</span>
      </div>

      <div className="p-3 space-y-3">
        {/* Message content */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">{t('scheduledTasks.sendMessage')}</label>
          <textarea
            ref={messageRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('scheduledTasks.messagePlaceholder')}
            rows={2}
            className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
          />
        </div>

        {/* Type selection */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">{t('scheduledTasks.type')}</label>
          <div className="flex gap-1">
            {(['once', 'interval', 'cron'] as const).map((tp) => (
              <button
                key={tp}
                onClick={() => { setType(tp); setSelectedPreset(null); setCustomMinutes(''); setCustomCron(''); }}
                className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                  type === tp
                    ? 'bg-brand text-white'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {tp === 'once' ? t('scheduledTasks.once') : tp === 'interval' ? t('scheduledTasks.interval') : 'Cron'}
              </button>
            ))}
          </div>
        </div>

        {/* Quick presets */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">{t('scheduledTasks.quickSelect')}</label>
          <div className="grid grid-cols-2 gap-1">
            {PRESETS[type].map((preset) => (
              <button
                key={preset.labelKey}
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
                {t(preset.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Custom input */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            {type === 'cron' ? t('scheduledTasks.customCron') : t('scheduledTasks.customMinutes')}
          </label>
          {type === 'cron' ? (
            <>
              <input
                type="text"
                value={customCron}
                onChange={(e) => { setCustomCron(e.target.value); setSelectedPreset(null); }}
                placeholder={t('scheduledTasks.cronPlaceholder')}
                className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
              />
              {customCron.trim() && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {describeCron(customCron.trim()) || <span className="text-destructive">{t('scheduledTasks.cronFormat')}</span>}
                </div>
              )}
            </>
          ) : (
            <input
              type="number"
              value={customMinutes}
              onChange={(e) => { setCustomMinutes(e.target.value); setSelectedPreset(null); }}
              placeholder={t('scheduledTasks.minutesPlaceholder')}
              min={1}
              className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          )}
        </div>

        {/* Active time range (interval tasks only) */}
        {type === 'interval' && (
          <div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1 cursor-pointer">
              <input
                type="checkbox"
                checked={useTimeRange}
                onChange={(e) => setUseTimeRange(e.target.checked)}
                className="rounded border-border"
              />
              {t('scheduledTasks.limitTimeRange')}
            </label>
            {useTimeRange && (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="time"
                  value={activeFrom}
                  onChange={(e) => setActiveFrom(e.target.value)}
                  className="flex-1 px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <span className="text-xs text-muted-foreground">{t('scheduledTasks.to')}</span>
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

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={!isValid()}
          className="w-full py-1.5 text-sm font-medium rounded bg-brand text-white hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isEdit ? t('scheduledTasks.saveBtn', { modKey: modKey() }) : t('scheduledTasks.createBtn', { modKey: modKey() })}
        </button>
      </div>
    </div>
  );
}
