'use client';

import { useCallback, useState, useEffect } from 'react';
import { randomDisplayName } from '@/lib/review-utils';

/**
 * 身份识别流程（纯 MAC 驱动）：
 *
 * 1. GET /api/review/identify → 服务端 ARP 查 MAC → 返回 { authorId, name }
 * 2. authorId 有值 + name 有值 → 已绑定，直接使用
 * 3. authorId 有值 + name 为 null → 未绑定，前端弹窗输入昵称
 * 4. authorId 为 null → 无法识别设备（跨子网等），fallback 随机 ID
 */

export function useReviewIdentity() {
  const [authorId, setAuthorId] = useState('');
  const [name, setNameState] = useState('');
  const [nameConfirmed, setNameConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);

  // 启动时从服务端获取身份
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
            // 有 authorId 但无昵称 → 生成随机昵称，等用户确认
            setNameState(randomDisplayName());
            setNameConfirmed(false);
          }
        } else {
          // 无法识别设备 → fallback 随机 ID + 随机昵称
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

  /** 确认昵称（绑定 MAC） */
  const confirmName = useCallback((newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setNameState(trimmed);
    setNameConfirmed(true);

    fetch('/api/review/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    }).catch(() => { /* 静默失败 */ });
  }, []);

  /** 修改昵称（已确认过的用户改名） */
  const setName = useCallback((newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setNameState(trimmed);

    fetch('/api/review/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    }).catch(() => { /* 静默失败 */ });
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
