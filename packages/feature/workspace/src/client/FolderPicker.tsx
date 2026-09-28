'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { listDirs, type DirEntry, type DirListing } from './effect/workspaceClient';

/**
 * In-page folder picker for "Open Folder". It replaced the OS-native dialog
 * (see the header of server/api/dirs.ts for why).
 *
 * The input is an address bar with completion: everything up to the last
 * separator is the directory being listed, the rest filters it. Typing,
 * pasting and Backspace therefore all navigate with no extra state. The client
 * never builds paths itself beyond appending `sep`; `segments`/`roots` come
 * from the server.
 */

interface FolderPickerProps {
  onPick: (path: string) => void;
}

const ROW_HEIGHT = 30;

const withSep = (path: string, sep: string) => (path.endsWith(sep) ? path : path + sep);

/** "…/Work/co" → list "…/Work/", filter by "co". A bare "~" lists home. */
const splitInput = (text: string, sep: string) => {
  const cut =
    sep === '\\' ? Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) : text.lastIndexOf('/');
  const base = text.slice(0, cut + 1);
  const prefix = text.slice(cut + 1);
  return base === '' && prefix === '~' ? { base: '~', prefix: '' } : { base, prefix };
};

interface FolderRowProps {
  entry: DirEntry;
  index: number;
  highlighted: boolean;
  top: number;
  onEnter: (path: string) => void;
  onPick: (path: string) => void;
  onHover: (index: number) => void;
}

const FolderRow = memo(function FolderRow({ entry, index, highlighted, top, onEnter, onPick, onHover }: FolderRowProps) {
  return (
    <div
      role="option"
      aria-selected={highlighted}
      onClick={() => onEnter(entry.path)}
      onDoubleClick={() => onPick(entry.path)}
      onMouseMove={() => onHover(index)}
      style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_HEIGHT }}
      className={`flex items-center gap-2 px-3 text-xs cursor-pointer select-none ${
        highlighted ? 'bg-hover text-foreground' : 'text-foreground'
      } ${entry.hidden ? 'opacity-60' : ''}`}
    >
      <svg className="w-4 h-4 shrink-0 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
      <span className="flex-1 truncate">{entry.name}</span>
      {entry.git && <span className="shrink-0 text-[10px] text-muted-foreground border border-border rounded px-1">git</span>}
    </div>
  );
});

export function FolderPicker({ onPick }: FolderPickerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [listedBase, setListedBase] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  const sep = listing?.sep ?? '/';
  const { base, prefix } = splitInput(text, sep);

  // Seed the address bar with home once the server has told us where that is.
  useEffect(() => {
    const seq = ++requestSeq.current;
    BrowserRuntime.runPromiseExit(listDirs('')).then((exit) => {
      if (exit._tag !== 'Success' || seq !== requestSeq.current) return;
      setListing(exit.value);
      setListedBase(withSep(exit.value.path, exit.value.sep));
      setText(withSep(exit.value.path, exit.value.sep));
    });
    inputRef.current?.focus();
  }, []);

  // Re-list whenever the directory part changes; the filter part is local.
  useEffect(() => {
    if (listedBase === null || base === listedBase) return;
    const timer = setTimeout(() => {
      const seq = ++requestSeq.current;
      BrowserRuntime.runPromiseExit(listDirs(base)).then((exit) => {
        if (exit._tag !== 'Success' || seq !== requestSeq.current) return;
        setListing(exit.value);
        setListedBase(base);
      });
    }, 60);
    return () => clearTimeout(timer);
  }, [base, listedBase]);

  const stale = listedBase !== base;

  const visible = useMemo(() => {
    if (!listing) return [];
    const needle = prefix.toLowerCase();
    // Typing a leading "." is asking for hidden dirs, toggle or not.
    const dirs = listing.dirs.filter((d) => showHidden || !d.hidden || needle.startsWith('.'));
    if (!needle) return dirs;
    const starts = dirs.filter((d) => d.name.toLowerCase().startsWith(needle));
    const contains = dirs.filter(
      (d) => !d.name.toLowerCase().startsWith(needle) && d.name.toLowerCase().includes(needle)
    );
    return [...starts, ...contains];
  }, [listing, prefix, showHidden]);

  useEffect(() => {
    setHighlight(prefix && visible.length > 0 ? 0 : -1);
  }, [prefix, visible]);

  // What "Open" acts on: the listed dir, or the entry the filter names exactly.
  const target = useMemo(() => {
    if (!listing || listing.error || stale) return null;
    if (!prefix) return listing.path;
    return visible.find((d) => d.name.toLowerCase() === prefix.toLowerCase())?.path ?? null;
  }, [listing, prefix, visible, stale]);

  const enter = useCallback(
    (path: string) => {
      setText(withSep(path, sep));
      inputRef.current?.focus();
    },
    [sep]
  );

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  useEffect(() => {
    if (highlight >= 0) virtualizer.scrollToIndex(highlight);
  }, [highlight, virtualizer]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (target) onPick(target);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      const entry = visible[highlight];
      if (entry) {
        e.preventDefault();
        enter(entry.path);
      } else if (e.key === 'Tab') {
        e.preventDefault();
      }
    }
  };

  const errorText = listing?.error && !stale ? t(`folderPicker.${listing.error}`) : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('folderPicker.placeholder')}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
        />
        <button
          onClick={() => target && onPick(target)}
          disabled={!target}
          data-tooltip={target ?? undefined}
          className="shrink-0 px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('folderPicker.open')}
        </button>
      </div>

      <div className="flex items-center gap-0.5 min-h-6 overflow-x-auto text-xs text-muted-foreground whitespace-nowrap">
        {listing?.segments.map((seg, i) => (
          <span key={seg.path} className="flex items-center">
            {i > 1 && <span className="px-0.5 text-foreground-subtle">›</span>}
            <button
              onClick={() => enter(seg.path)}
              className="px-1 py-0.5 rounded hover:bg-hover hover:text-foreground transition-colors"
            >
              {seg.name}
            </button>
          </span>
        ))}
      </div>

      <div
        ref={scrollRef}
        role="listbox"
        className={`flex-1 min-h-0 overflow-y-auto border border-border rounded transition-opacity ${stale ? 'opacity-60' : ''}`}
      >
        {errorText ? (
          <div className="p-3 text-xs text-red-11">{errorText}</div>
        ) : listing && visible.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">
            {prefix ? t('folderPicker.noMatch') : t('folderPicker.empty')}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => (
              <FolderRow
                key={visible[item.index].path}
                entry={visible[item.index]}
                index={item.index}
                highlighted={item.index === highlight}
                top={item.start}
                onEnter={enter}
                onPick={onPick}
                onHover={setHighlight}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <div className="flex items-center gap-1">
          {listing && (
            <button
              onClick={() => enter(listing.home)}
              className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-hover transition-colors"
            >
              ~
            </button>
          )}
          {listing?.roots.map((root) => (
            <button
              key={root}
              onClick={() => enter(root)}
              className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-hover transition-colors font-mono"
            >
              {root}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-muted-foreground cursor-pointer select-none">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          {t('folderPicker.showHidden')}
        </label>
        <span className="hidden md:inline text-foreground-subtle">{t('folderPicker.hint')}</span>
      </div>
    </div>
  );
}
