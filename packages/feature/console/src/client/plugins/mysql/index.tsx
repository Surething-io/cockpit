import { registerBubble, type BubbleComponentProps, type PluginItemBase } from '../../bubblePlugins';
import { MySQLBubble } from './MySQLBubble';

/** MySQL bubble data */
export interface MySQLPluginItem extends PluginItemBase {
  connectionString: string;
  displayName: string;
}

function MySQLAdapter({ item, selected, maximized, expandedHeight, bubbleContentHeight, timestamp, onSelect, onClose, onToggleMaximize, onTitleMouseDown }: BubbleComponentProps) {
  const data = item as MySQLPluginItem;
  return (
    <MySQLBubble
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
  type: 'mysql',
  idPrefix: 'mysql',

  match(input: string) {
    const t = input.trim().toLowerCase();
    return t.startsWith('mysql://');
  },

  parse(input: string) {
    const connStr = input.trim();
    let displayName = connStr;
    try {
      const u = new URL(connStr);
      const db = u.pathname.replace(/^\//, '') || 'mysql';
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
    const data = item as MySQLPluginItem;
    return { connectionString: data.connectionString, displayName: data.displayName };
  },

  Component: MySQLAdapter,

  async onClose(item) {
    try {
      await fetch('/api/mysql/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
    } catch { /* ignore */ }
  },
});
