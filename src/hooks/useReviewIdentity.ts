'use client';

import { useCallback, useState, useEffect } from 'react';
import { randomDisplayName } from '@/lib/review-utils';

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
    fetch('/api/review/identify')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
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
          const fallbackId = Math.random().toString(36).slice(2, 10);
          setAuthorId(fallbackId);
          setNameState(randomDisplayName());
          setNameConfirmed(false);
        }
      })
      .catch(() => {
        const fallbackId = Math.random().toString(36).slice(2, 10);
        setAuthorId(fallbackId);
        setNameState(randomDisplayName());
        setNameConfirmed(false);
      })
      .finally(() => setLoading(false));
  }, []);

  /** Confirm nickname (bind to MAC) */
  const confirmName = useCallback((newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setNameState(trimmed);
    setNameConfirmed(true);

    fetch('/api/review/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    }).catch(() => { /* Silently fail */ });
  }, []);

  /** Update nickname (rename for already-confirmed users) */
  const setName = useCallback((newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setNameState(trimmed);

    fetch('/api/review/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    }).catch(() => { /* Silently fail */ });
  }, []);

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
