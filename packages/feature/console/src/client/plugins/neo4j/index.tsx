import { registerBubble, type BubbleComponentProps, type PluginItemBase } from '../../bubblePlugins';
import { Neo4jBubble } from './Neo4jBubble';

export interface Neo4jPluginItem extends PluginItemBase {
  connectionString: string;
  displayName: string;
}

function Neo4jAdapter({ item, selected, maximized, expandedHeight, bubbleContentHeight, timestamp, onSelect, onClose, onToggleMaximize, onTitleMouseDown }: BubbleComponentProps) {
  const data = item as Neo4jPluginItem;
  return (
    <Neo4jBubble
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
  type: 'neo4j',
  idPrefix: 'neo4j',

  match(input: string) {
    const t = input.trim().toLowerCase();
    return t.startsWith('neo4j://') || t.startsWith('neo4j+s://') || t.startsWith('bolt://') || t.startsWith('bolt+s://');
  },

  parse(input: string) {
    const connStr = input.trim();
    let displayName = connStr;
    try {
      const u = new URL(connStr);
      displayName = `${u.hostname}${u.port ? ':' + u.port : ':7687'}`;
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
    const data = item as Neo4jPluginItem;
    return { connectionString: data.connectionString, displayName: data.displayName };
  },

  Component: Neo4jAdapter,

  async onClose(item) {
    try {
      await fetch('/api/neo4j/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
    } catch { /* ignore */ }
  },
});
