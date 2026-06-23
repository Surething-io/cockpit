/**
 * Web Push core (server-only).
 *
 * Standard W3C Push + VAPID — no Google/Firebase registration, no API keys.
 * We self-generate a VAPID keypair (stored in settings.json), the browser
 * hands us a push endpoint per subscription, and web-push signs the request
 * with our private key. Outbound HTTPS to the browser's push service (FCM /
 * Mozilla autopush / Apple) is all that's required.
 */
import webpush from 'web-push';
import {
  SETTINGS_FILE,
  PUSH_SUBSCRIPTIONS_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from '@cockpit/shared-utils';

export interface PushVapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

interface Settings {
  push?: PushVapid;
  [k: string]: unknown;
}

interface SubStore {
  subscriptions: webpush.PushSubscription[];
}

export interface PushPayload {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

// Cache the configured keypair so web-push.setVapidDetails runs once per process.
let configured: PushVapid | null = null;

/**
 * Get the VAPID keypair, generating + persisting it on first use. Merges into
 * settings.json without clobbering other sections.
 */
export async function getVapid(): Promise<PushVapid> {
  if (configured) return configured;
  const vapid = await withFileLock(SETTINGS_FILE, async () => {
    const settings = await readJsonFile<Settings>(SETTINGS_FILE, {});
    if (settings.push?.publicKey && settings.push?.privateKey) {
      return {
        publicKey: settings.push.publicKey,
        privateKey: settings.push.privateKey,
        subject: settings.push.subject || 'mailto:cockpit@localhost',
      };
    }
    const keys = webpush.generateVAPIDKeys();
    const push: PushVapid = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:cockpit@localhost',
    };
    await writeJsonFile(SETTINGS_FILE, { ...settings, push });
    return push;
  });
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  configured = vapid;
  return vapid;
}

export async function getPublicKey(): Promise<string> {
  return (await getVapid()).publicKey;
}

export async function addSubscription(sub: webpush.PushSubscription): Promise<void> {
  await withFileLock(PUSH_SUBSCRIPTIONS_FILE, async () => {
    const store = await readJsonFile<SubStore>(PUSH_SUBSCRIPTIONS_FILE, { subscriptions: [] });
    if (!store.subscriptions.some((s) => s.endpoint === sub.endpoint)) {
      store.subscriptions.push(sub);
      await writeJsonFile(PUSH_SUBSCRIPTIONS_FILE, store);
    }
  });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await withFileLock(PUSH_SUBSCRIPTIONS_FILE, async () => {
    const store = await readJsonFile<SubStore>(PUSH_SUBSCRIPTIONS_FILE, { subscriptions: [] });
    const next = store.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (next.length !== store.subscriptions.length) {
      await writeJsonFile(PUSH_SUBSCRIPTIONS_FILE, { subscriptions: next });
    }
  });
}

/**
 * Send a notification to every stored subscription. Subscriptions the push
 * service reports as gone (404/410) are pruned. Fire-and-forget friendly:
 * never throws — returns counts.
 */
export async function sendPushNotification(
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  try {
    await getVapid();
  } catch {
    return { sent: 0, pruned: 0 };
  }
  const store = await readJsonFile<SubStore>(PUSH_SUBSCRIPTIONS_FILE, { subscriptions: [] });
  if (store.subscriptions.length === 0) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  const dead: string[] = [];
  let sent = 0;

  await Promise.all(
    store.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) dead.push(sub.endpoint);
      }
    }),
  );

  if (dead.length) {
    await withFileLock(PUSH_SUBSCRIPTIONS_FILE, async () => {
      const cur = await readJsonFile<SubStore>(PUSH_SUBSCRIPTIONS_FILE, { subscriptions: [] });
      await writeJsonFile(PUSH_SUBSCRIPTIONS_FILE, {
        subscriptions: cur.subscriptions.filter((s) => !dead.includes(s.endpoint)),
      });
    });
  }

  return { sent, pruned: dead.length };
}
