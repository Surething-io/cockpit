'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from '@cockpit/shared-ui';
import i18n from '@cockpit/shared-i18n';

// Convert a base64url VAPID key to the Uint8Array the Push API expects.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

const SW_URL = '/push-sw.js';

/**
 * Manages the browser's Web Push subscription for the mobile experience:
 * registers the push-only SW, requests permission, subscribes via VAPID, and
 * reports the subscription to the server. No-ops gracefully where unsupported
 * (e.g. iOS Safari before "Add to Home Screen").
 */
export function usePushSubscription() {
  // Starts false so the first client render matches the server (no capability
  // detection at SSR) — avoids a hydration mismatch. Flipped after mount.
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<PushPermission>('default');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ok =
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window;
    setSupported(ok);
    if (!ok) {
      setPermission('unsupported');
      return;
    }
    setPermission(Notification.permission as PushPermission);
    navigator.serviceWorker
      .getRegistration(SW_URL)
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setIsSubscribed(!!sub))
      .catch(() => {});
  }, []);

  const subscribe = useCallback(async () => {
    if (!supported || busy) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm as PushPermission);
      if (perm !== 'granted') return;

      const reg = await navigator.serviceWorker.register(SW_URL);
      await navigator.serviceWorker.ready;

      const res = await fetch('/api/push/public-key');
      if (!res.ok) throw new Error(`public-key HTTP ${res.status}`);
      const { publicKey } = (await res.json()) as { publicKey?: string };
      if (!publicKey) throw new Error('missing VAPID public key');

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      // Only mark subscribed once the server has actually stored it — otherwise
      // the UI would claim "on" while no subscription exists server-side.
      const saveRes = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub }),
      });
      if (!saveRes.ok) throw new Error(`subscribe HTTP ${saveRes.status}`);
      setIsSubscribed(true);
    } catch (e) {
      console.error('push subscribe failed', e);
      toast(i18n.t('mobile.notifyError', { defaultValue: 'Could not enable notifications' }), 'error');
    } finally {
      setBusy(false);
    }
  }, [supported, busy]);

  const unsubscribe = useCallback(async () => {
    if (!supported || busy) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_URL);
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setIsSubscribed(false);
    } catch (e) {
      console.error('push unsubscribe failed', e);
    } finally {
      setBusy(false);
    }
  }, [supported, busy]);

  return { supported, permission, isSubscribed, busy, subscribe, unsubscribe };
}
