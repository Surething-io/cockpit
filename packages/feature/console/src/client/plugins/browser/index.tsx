import { registerBubble, type BubbleComponentProps, type PluginItemBase } from '../../bubblePlugins';
import { BrowserBubble } from './BrowserBubble';

/** Browser bubble data */
export interface BrowserPluginItem extends PluginItemBase {
  url: string;
}

function BrowserAdapter({ item, selected, maximized, expandedHeight, bubbleContentHeight, timestamp, onSelect, onClose, onToggleMaximize, onTitleMouseDown, extra }: BubbleComponentProps) {
  const data = item as BrowserPluginItem;
  return (
    <BrowserBubble
      id={data.id}
      url={data.url}
      selected={selected}
      maximized={maximized}
      expandedHeight={expandedHeight}
      bubbleContentHeight={bubbleContentHeight}
      timestamp={timestamp}
      onSelect={onSelect}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleMouseDown={onTitleMouseDown}
      onNewTab={extra?.addBrowserItem as ((url: string, afterId: string) => void) | undefined}
      initialSleeping={extra?.initialSleeping as boolean | undefined}
      onSleep={extra?.onSleep as ((id: string) => void) | undefined}
      onWake={extra?.onWake as ((id: string) => void) | undefined}
    />
  );
}

registerBubble({
  type: 'browser',
  idPrefix: 'browser',

  match(input: string) {
    const t = input.trim().toLowerCase();
    return t.startsWith('http://') || t.startsWith('https://');
  },

  parse(input: string) {
    return { url: input.trim() };
  },

  fromHistory(entry) {
    return { url: entry.url as string };
  },

  toHistory(item) {
    const data = item as BrowserPluginItem;
    return { url: data.url };
  },

  Component: BrowserAdapter,
});
