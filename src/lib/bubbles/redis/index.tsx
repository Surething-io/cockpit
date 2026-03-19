import { registerBubble, type BubbleComponentProps, type PluginItemBase } from '../../bubblePlugins';
import { RedisBubble } from './RedisBubble';

/** Redis 气泡数据 */
export interface RedisPluginItem extends PluginItemBase {
  connectionString: string;
  displayName: string;
}

function RedisAdapter({ item, selected, maximized, expandedHeight, bubbleContentHeight, timestamp, onSelect, onClose, onToggleMaximize, onTitleMouseDown }: BubbleComponentProps) {
  const data = item as RedisPluginItem;
  return (
    <RedisBubble
      id={data.id}
      connectionString={data.connectionString}
      displayName={data.displayName}
      selected={selected}
      maximized={maximized}
      expandedHeight={expandedHeight}
      bubbleContentHeight={bubbleContentHeight}
      timestamp={timestamp}
      onSelect={onSelect}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleMouseDown={onTitleMouseDown}
    />
  );
}

registerBubble({
  type: 'redis',
  idPrefix: 'redis',

  match(input: string) {
    const t = input.trim().toLowerCase();
    return t.startsWith('redis://') || t.startsWith('rediss://');
  },

  parse(input: string) {
    const connStr = input.trim();
    let displayName = connStr;
    try {
      const u = new URL(connStr);
      const db = u.pathname.replace(/^\//, '') || '0';
      displayName = `db${db}@${u.hostname}${u.port ? ':' + u.port : ':6379'}`;
    } catch { /* keep raw string */ }
    return { connectionString: connStr, displayName };
  },

  fromHistory(entry) {
    return {
      connectionString: entry.connectionString as string,
      displayName: (entry.displayName as string) || (entry.connectionString as string),
    };
  },

  toHistory(item) {
    const data = item as RedisPluginItem;
    return { connectionString: data.connectionString, displayName: data.displayName };
  },

  Component: RedisAdapter,

  async onClose(item) {
    try {
      await fetch('/api/redis/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
    } catch { /* ignore */ }
  },
});
