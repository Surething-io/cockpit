'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { XtermRenderer, type XtermSearchHandle } from './XtermRenderer';
import { openTerminalPreview } from './TerminalWsManager';
import type { RunningTerminal } from './effect/consoleClient';

interface TerminalPreviewProps {
  terminal: RunningTerminal;
  /** Header second line: the command / sub-directory context from the row. */
  subtitle: string;
  onOpenTerminal: () => void;
}

/**
 * Right-hand pane of the terminals board: a read-only, live view of one running
 * command — the buffered output replayed, then new output as it streams.
 *
 * Input: PTY terminals take keystrokes once the user clicks into the terminal
 * (xterm only receives keys while focused), sent over the preview's own socket.
 * Pipe-mode terminals stay read-only — nothing echoes there, so typing would be
 * blind. No `onResize` ever: the real PTY keeps the size the Console gave it. A PTY is rendered at exactly its own size
 * (`fixedSize`, reported on attach), not fitted to this pane: its output — a
 * progress bar redrawn with `\r`, a full-screen TUI — was laid out for those
 * columns, and re-wrapping it to another width garbles it. Larger than the
 * pane, it scrolls. "Open terminal" is the way to interact with it.
 *
 * Mount with `key={commandId}`: the xterm buffer and the socket belong to one
 * command, so switching rows remounts rather than resetting in place.
 */
export function TerminalPreview({ terminal, subtitle, onOpenTerminal }: TerminalPreviewProps) {
  const { t } = useTranslation();
  const { projectCwd, commandId, usePty } = terminal;
  const xtermRef = useRef<XtermSearchHandle>(null);
  const [ended, setEnded] = useState(false);
  // The PTY's own size, from the attach reply. Fixed for the life of this
  // preview: while the board is open the Console bubble cannot be maximized or
  // restored, and re-selecting the row remounts and re-reads it.
  const [ptySize, setPtySize] = useState<{ cols: number; rows: number } | undefined>(undefined);
  // PTY output that arrived before the terminal took the PTY's size. The size
  // comes in the attach reply, right ahead of the replay — but applying it
  // takes a render, while writes land at once. Written early, the replay would
  // be laid out at the fitted width; held here, it is flushed after the resize.
  // null = nothing held back any more (size applied, or none to wait for).
  const heldRef = useRef<string[] | null>(usePty ? [] : null);
  // Keystrokes go back over the preview's own socket (openTerminalPreview).
  const sendInputRef = useRef<((data: string) => void) | null>(null);

  useEffect(() => {
    let isReplay = true;
    const tap = openTerminalPreview({
      projectCwd,
      commandId,
      onAttached: (size) => {
        if (size) setPtySize(size);
        else flushHeld(); // size unknown: render fitted, nothing to wait for
      },
      onOutput: (data) => {
        if (usePty) {
          // PTY output already carries its own line discipline.
          if (heldRef.current) heldRef.current.push(data);
          else xtermRef.current?.write(data);
          return;
        }
        // Pipe-mode output is plain lines; xterm needs CRLF or it staircases.
        // The first chunk is the server's replay — `outputLines.join('\n')`, no
        // trailing newline — so terminate it, or the first live line glues onto
        // the last replayed one. (Misplaces only a replay that ended mid-line.)
        let text = data.replace(/\r?\n/g, '\r\n');
        if (isReplay && text && !text.endsWith('\n')) text += '\r\n';
        isReplay = false;
        xtermRef.current?.write(text);
      },
      onEnd: () => setEnded(true),
    });
    sendInputRef.current = tap.sendInput;
    return () => {
      sendInputRef.current = null;
      tap.close();
    };

    function flushHeld() {
      const held = heldRef.current;
      heldRef.current = null;
      if (held?.length) xtermRef.current?.write(held.join(''));
    }
  }, [projectCwd, commandId, usePty]);

  // XtermRenderer's own effect has resized the terminal by the time this runs
  // (child effects run before the parent's in the same commit), so the held
  // output now lands at the PTY's width.
  useEffect(() => {
    if (!ptySize || !heldRef.current) return;
    const held = heldRef.current;
    heldRef.current = null;
    if (held.length) xtermRef.current?.write(held.join(''));
  }, [ptySize]);

  // Stable identity: XtermRenderer is memo'd.
  const handleInput = useCallback((data: string) => sendInputRef.current?.(data), []);

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border flex-shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground font-mono truncate" data-tooltip={terminal.command}>
            {terminal.title || terminal.command.split('\n')[0]}
          </div>
          <div className="text-[11px] text-muted-foreground font-mono truncate" data-tooltip={terminal.cwd}>
            {subtitle}
          </div>
        </div>
        {ended ? (
          <span className="flex-shrink-0 text-xs text-muted-foreground">{t('runningTerminals.ended')}</span>
        ) : usePty ? (
          <span className="flex-shrink-0 text-[11px] text-foreground-subtle">{t('runningTerminals.typeHint')}</span>
        ) : null}
      </div>

      <div className="relative flex-1 min-h-0">
        {/* Bottom padding reserves a strip for the floating button, so the
            terminal's newest line — always its bottom one — sits just above the
            button instead of underneath it. */}
        <div className="h-full pt-2 pb-16">
          <XtermRenderer ref={xtermRef} output="" isRunning={false} directWrite
            fixedSize={usePty ? ptySize : undefined}
            onInput={usePty && !ended ? handleInput : undefined}
          />
        </div>

        {/* Same place and style as the session previews' "Open session". */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-4">
          <button
            onClick={onOpenTerminal}
            className="pointer-events-auto flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-brand text-white text-sm font-medium shadow-lv3 hover:bg-brand/90"
          >
            <span>{t('runningTerminals.openTerminal')}</span>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
