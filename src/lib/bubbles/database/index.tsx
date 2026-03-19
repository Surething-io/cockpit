import { registerBubble, type BubbleComponentProps, type PluginItemBase } from '../../bubblePlugins';
import { DatabaseBubble } from './DatabaseBubble';

/** Database 气泡数据 */
export interface DatabasePluginItem extends PluginItemBase {
  connectionString: string;
  displayName: string;
}

function DatabaseAdapter({ item, selected, maximized, expandedHeight, bubbleContentHeight, timestamp, onSelect, onClose, onToggleMaximize, onTitleMouseDown }: BubbleComponentProps) {
  const data = item as DatabasePluginItem;
  return (
    <DatabaseBubble
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
  type: 'database',
  idPrefix: 'db',

  match(input: string) {
    const t = input.trim().toLowerCase();
    return t.startsWith('postgresql://') || t.startsWith('postgres://');
  },

  parse(input: string) {
    const connStr = input.trim();
    let displayName = connStr;
    try {
      const u = new URL(connStr);
      const db = u.pathname.replace(/^\//, '') || 'postgres';
      displayName = `${db}@${u.hostname}${u.port ? ':' + u.port : ''}`;
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
    const data = item as DatabasePluginItem;
    return { connectionString: data.connectionString, displayName: data.displayName };
  },

  Component: DatabaseAdapter,

  async onClose(item) {
    try {
      await fetch('/api/db/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
    } catch { /* ignore */ }
  },
});
