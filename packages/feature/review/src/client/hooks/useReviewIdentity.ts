'use client';

import { useCallback, useState, useEffect } from 'react';
import { randomDisplayName } from '../../server/lib/reviewUtils';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { AppError } from '@cockpit/effect-core';

/**
 * Identity resolution flow (MAC-driven):
 *
 * 1. GET /api/review/identify → server ARP lookup for MAC → returns { authorId, name }
 * 2. authorId present + name present → already bound, use directly
 * 3. authorId present + name null → not bound, show nickname input dialog
 * 4. authorId null → device unidentifiable (cross-subnet etc.), fallback to random ID
 */

export function useReviewIdentity() {
  const [authorId, setAuthorId] = useState('');
  const [name, setNameState] = useState('');
  const [nameConfirmed, setNameConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);

  // Fetch identity from server on mount
  useEffect(() => {
    const identifyEff = Effect.tryPromise({
      try: async () => {
        const res = await fetch('/api/review/identify');
        return res.ok ? ((await res.json()) as { authorId?: string; name?: string } | null) : null;
      },
      catch: (cause) => new AppError({ message: 'review identify failed', cause }),
    });
    const applyFallback = () => {
      const fallbackId = Math.random().toString(36).slice(2, 10);
      setAuthorId(fallbackId);
      setNameState(randomDisplayName());
      setNameConfirmed(false);
    };
    BrowserRuntime.runPromise(
      identifyEff.pipe(
        Effect.match({
          onSuccess: (data) => {
            if (data?.authorId) {
              setAuthorId(data.authorId);
              if (data.name) {
                setNameState(data.name);
                setNameConfirmed(true);
              } else {
                // Has authorId but no nickname → generate random nickname, wait for user confirmation
                setNameState(randomDisplayName());
                setNameConfirmed(false);
              }
            } else {
              // Device unidentifiable → fallback to random ID + random nickname
              applyFallback();
            }
          },
          onFailure: applyFallback,
        })
      )
    ).finally(() => setLoading(false));
  }, []);

  // Shared: POST /api/review/identify { name } — fire-and-forget
  const postIdentify = useCallback((trimmed: string) => {
    const eff = Effect.tryPromise({
      try: async () => {
        await fetch('/api/review/identify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
      },
      catch: (cause) => new AppError({ message: 'review identify POST failed', cause }),
    });
    BrowserRuntime.runFork(eff.pipe(Effect.orElse(() => Effect.void)));
  }, []);

  /** Confirm nickname (bind to MAC) */
  const confirmName = useCallback((newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setNameState(trimmed);
    setNameConfirmed(true);
    postIdentify(trimmed);
  }, [postIdentify]);

  /** Update nickname (rename for already-confirmed users) */
  const setName = useCallback((newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setNameState(trimmed);
    postIdentify(trimmed);
  }, [postIdentify]);

  const randomize = useCallback(() => {
    setNameState(randomDisplayName());
  }, []);

  return {
    authorId,
    name,
    nameConfirmed,
    loading,
    setName,
    confirmName,
    randomize,
  };
}
