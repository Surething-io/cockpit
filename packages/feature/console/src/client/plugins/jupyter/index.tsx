import { registerBubble, type BubbleComponentProps, type PluginItemBase } from '../../bubblePlugins';
import { JupyterBubble } from './JupyterBubble';

/** Jupyter notebook bubble data */
export interface JupyterPluginItem extends PluginItemBase {
  filePath: string;
  displayName: string;
  cwd: string;
}

function JupyterAdapter({ item, selected, maximized, expandedHeight, bubbleContentHeight, timestamp, onSelect, onClose, onToggleMaximize, onTitleMouseDown }: BubbleComponentProps) {
  const data = item as JupyterPluginItem;
  return (
    <JupyterBubble
      id={data.id}
      filePath={data.filePath}
      displayName={data.displayName}
      cwd={data.cwd}
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
  type: 'jupyter',
  idPrefix: 'nb',

  match(input: string) {
    const t = input.trim();
    return t.endsWith('.ipynb');
  },

  parse(input: string) {
    const filePath = input.trim();
    const parts = filePath.split('/');
    const displayName = parts[parts.length - 1] || filePath;
    return { filePath, displayName, cwd: '' };
    // cwd is injected by useConsoleState.addPluginItem
  },

  fromHistory(entry) {
    return {
      filePath: entry.filePath as string,
      displayName: (entry.displayName as string) || '',
      cwd: (entry.cwd as string) || '',
    };
  },

  toHistory(item) {
    const data = item as JupyterPluginItem;
    return { filePath: data.filePath, displayName: data.displayName, cwd: data.cwd };
  },

  Component: JupyterAdapter,

  async onClose(item) {
    try {
      await fetch('/api/jupyter/shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bubbleId: item.id }),
      });
    } catch { /* ignore */ }
  },
});
