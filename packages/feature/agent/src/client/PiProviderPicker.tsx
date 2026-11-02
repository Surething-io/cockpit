'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal, usePanelPortalTarget } from '@cockpit/shared-ui';
import { ENGINE_MENU_CLASS, ENGINE_MENU_ROW_SELECTED, EngineCheck, EnginePickerTrigger } from './engineAccents';

const PROVIDERS = [
  { id: 'ollama', label: 'Pi · Ollama' },
  { id: 'deepseek', label: 'Pi · DeepSeek' },
  { id: 'kimi', label: 'Pi · Kimi' },
  { id: 'glm', label: 'Pi · GLM' },
] as const;
type Provider = typeof PROVIDERS[number]['id'];

/** Panel-local provider menu using the same primitives as the model pickers. */
export function PiProviderPicker({ value, disabled, onChange }: {
  value: Provider;
  disabled: boolean;
  onChange: (value: Provider) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const panel = usePanelPortalTarget();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 176, maxHeight: 200 });
  const visible = open && !disabled;
  const selected = PROVIDERS.find((provider) => provider.id === value)!;

  const position = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const bounds = panel?.getBoundingClientRect();
    const left = bounds?.left ?? 0;
    const top = bounds?.top ?? 0;
    const right = bounds?.right ?? window.innerWidth;
    const bottom = bounds?.bottom ?? window.innerHeight;
    const width = Math.min(176, Math.max(0, right - left - 16));
    const below = bottom - rect.bottom - 8;
    const above = rect.top - top - 8;
    const height = Math.min(200, Math.max(0, Math.max(below, above)));
    setPos({
      left: Math.max(8, Math.min(rect.left - left, right - left - width - 8)),
      top: below >= Math.min(200, above) ? rect.bottom - top + 4 : Math.max(8, rect.top - top - height - 4),
      width, maxHeight: height,
    });
  }, [panel]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!visible) return;
    position();
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [visible, position]);

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    const rows = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % rows.length
      : event.key === 'ArrowUp' ? (current - 1 + rows.length) % rows.length : undefined;
    if (index !== undefined) { event.preventDefault(); rows[index]?.focus(); }
  };

  return <>
    <EnginePickerTrigger
      buttonRef={trigger} label={selected.label} title={t('chat.piProvider', { defaultValue: 'Pi provider' })}
      disabled={disabled} aria-label={t('chat.piProvider', { defaultValue: 'Pi provider' })}
      aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined}
      onClick={() => { position(); setOpen(!open); }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); position(); setOpen(true); }
      }}
    />
    {visible && <Portal>
      <div ref={menu} id={id} role="menu" aria-label={t('chat.piProvider', { defaultValue: 'Pi provider' })}
        className={ENGINE_MENU_CLASS} style={pos} onKeyDown={navigate}>
        {PROVIDERS.map((provider) => <button
          key={provider.id} type="button" role="menuitemradio" aria-checked={provider.id === value} tabIndex={-1}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${provider.id === value ? ENGINE_MENU_ROW_SELECTED : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}
          onClick={() => { if (!disabled) onChange(provider.id); close(true); }}
        ><EngineCheck selected={provider.id === value} /><span>{provider.label}</span></button>)}
      </div>
    </Portal>}
  </>;
}
