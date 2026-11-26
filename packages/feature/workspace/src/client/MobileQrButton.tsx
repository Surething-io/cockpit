'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QrCode } from 'lucide-react';
import { Effect } from 'effect';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadMobileLinkToken, renderQrSvg } from './effect/workspaceClient';
import { buildMobileUrl, isLoopbackHostname } from './mobileLink';

interface MobileQrButtonProps {
  cwd?: string;
  sessionId?: string;
}

type QrState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string; hasToken: boolean }
  | { status: 'error' };

/**
 * Top-bar button that shows a QR code for the mobile route (/m), so a phone can
 * open the session being viewed. Hidden when the page was reached through a
 * loopback name: a phone cannot use that address. When token mode is on, the
 * code embeds the token so the phone signs in on the first scan.
 */
export function MobileQrButton({ cwd, sessionId }: MobileQrButtonProps) {
  const { t } = useTranslation();
  // Decided after mount: the hostname is not known while server rendering.
  const [remote, setRemote] = useState(false);
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<QrState>({ status: 'loading' });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRemote(!isLoopbackHostname(window.location.hostname));
  }, []);

  // Rebuild the code on every open so it follows the active session.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQr({ status: 'loading' });
    const program = Effect.gen(function* () {
      const token = yield* loadMobileLinkToken();
      const url = buildMobileUrl(window.location.origin, { cwd, sessionId, token });
      const svg = yield* renderQrSvg(url);
      return { svg, hasToken: token !== null };
    });
    BrowserRuntime.runPromiseExit(program).then((exit) => {
      if (cancelled) return;
      setQr(exit._tag === 'Success' ? { status: 'ready', ...exit.value } : { status: 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [open, cwd, sessionId]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  if (!remote) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={toggle}
        className="p-2 text-muted-foreground hover:text-foreground hover:bg-hover rounded-lg transition-colors"
        title={t('tabManagerTopBar.openOnPhone')}
      >
        <QrCode className="w-5 h-5" />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-60 p-3 bg-popover border border-border rounded-lg shadow-lv2 z-50">
          <div className="w-full aspect-square rounded-md bg-white p-2 flex items-center justify-center">
            {qr.status === 'ready' ? (
              <div
                className="w-full h-full [&>svg]:w-full [&>svg]:h-full"
                // Trusted markup: produced locally by the qrcode encoder.
                dangerouslySetInnerHTML={{ __html: qr.svg }}
              />
            ) : (
              <span className="text-xs text-neutral-500">
                {qr.status === 'error' ? t('tabManagerTopBar.phoneQrFailed') : t('common.loading')}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-foreground text-center">
            {cwd && sessionId ? t('tabManagerTopBar.phoneQrSessionHint') : t('tabManagerTopBar.phoneQrHint')}
          </p>
          {qr.status === 'ready' && qr.hasToken && (
            <p className="mt-1 text-xs text-muted-foreground text-center">
              {t('tabManagerTopBar.phoneQrTokenWarning')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
