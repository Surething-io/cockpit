import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the subscription/socket boundary without a DOM renderer. React
// effects are mounted immediately and their real cleanup functions retained.
const effects = vi.hoisted(() => ({ cleanups: [] as (() => void)[] }));
vi.mock('react', () => ({
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (mount: () => (() => void) | undefined) => {
    const cleanup = mount();
    if (cleanup) effects.cleanups.push(cleanup);
  },
}));
import { useWebSocket } from './useWebSocket';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor() { Socket.instances.push(this); }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
}

afterEach(() => {
  for (const cleanup of effects.cleanups.splice(0).reverse()) cleanup();
  Socket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' } });
  vi.stubGlobal('WebSocket', Socket);
}

describe('WebSocket subscription readiness', () => {
  it('checks after the initial handshake, reuses an open socket and removes unmounted listeners', () => {
    setup();
    const first = vi.fn(), second = vi.fn(), onMessage = vi.fn();
    useWebSocket({ url: '/watch', onMessage, onOpen: first });
    const socket = Socket.instances[0];
    expect(first).not.toHaveBeenCalled();
    socket.open();
    expect(first).toHaveBeenCalledTimes(1);
    useWebSocket({ url: '/watch', onMessage, onOpen: second });
    expect(Socket.instances).toHaveLength(1);
    expect(second).toHaveBeenCalledTimes(1);
    socket.onmessage?.({ data: JSON.stringify({ type: 'graphProgress', data: { phase: 'done' } }) });
    expect(onMessage).toHaveBeenCalledTimes(2);
    effects.cleanups.pop()!();
    socket.open();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('checks again after reconnecting so a lost completion can be recovered', () => {
    setup();
    vi.useFakeTimers();
    const onOpen = vi.fn();
    useWebSocket({ url: '/watch', onMessage: vi.fn(), onOpen });
    Socket.instances[0].open();
    Socket.instances[0].close();
    vi.runOnlyPendingTimers();
    expect(Socket.instances).toHaveLength(2);
    expect(onOpen).toHaveBeenCalledTimes(1);
    Socket.instances[1].open();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
