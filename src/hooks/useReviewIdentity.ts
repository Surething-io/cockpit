'use client';

import { useCallback, useState, useEffect } from 'react';
import { randomDisplayName } from '@/lib/review-utils';

const STORAGE_KEY = 'cockpit-review-identity';

interface ReviewIdentity {
  authorId: string;
  name: string;
}

function generateAuthorId(): string {
  // crypto.randomUUID() 只在安全上下文(HTTPS/localhost)可用，局域网 HTTP 访问时需要 fallback
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // fallback: 用 crypto.getRandomValues 手动拼 UUID v4
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function loadIdentity(): ReviewIdentity {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.authorId && parsed.name) {
        return parsed;
      }
    }
  } catch { /* ignore */ }

  const identity: ReviewIdentity = {
    authorId: generateAuthorId(),
    name: randomDisplayName(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

export function useReviewIdentity() {
  // 初始空值，避免 SSR/hydration 不匹配
  const [identity, setIdentity] = useState<ReviewIdentity>({ authorId: '', name: '' });

  // hydration 后从 localStorage 读取
  useEffect(() => {
    setIdentity(loadIdentity());
  }, []);

  const setName = useCallback((name: string) => {
    setIdentity(prev => {
      const updated = { ...prev, name };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const randomize = useCallback(() => {
    setName(randomDisplayName());
  }, [setName]);

  return { authorId: identity.authorId, name: identity.name, setName, randomize };
}
