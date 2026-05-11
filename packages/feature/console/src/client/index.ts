// @cockpit/feature-console (client) — Console panel (terminal + bubble plugin host)

// Main console panel
export { ConsoleView } from './ConsoleView';

// Supporting UI components
export { CommandBubble, BUBBLE_CONTENT_HEIGHT } from './CommandBubble';
export { ConsoleInputBar } from './ConsoleInputBar';
export { ConsoleScrollButtons } from './ConsoleScrollButtons';
export { EnvManager } from './EnvManager';
export { QuickCommandsPopover } from './QuickCommandsPopover';
export { ShortIdBadge } from './ShortIdBadge';
export { XtermRenderer } from './XtermRenderer';
export { AliasManager } from './AliasManager';

// Hooks
export { useConsoleState, matchInput as matchConsoleInput, type ConsoleItem } from './useConsoleState';
export { useBrowserBridge } from './useBrowserBridge';
export { useCockpitBridge, getCockpitBridge } from './useCockpitBridge';

// Bubble plugin contract + registry
// Importing pluginRegistry registers all 6 built-in plugins as a side-effect.
export {
  matchInput,
  getPlugin,
  getAllPlugins,
  generatePluginItemId,
  type PluginItemBase,
  type BubbleComponentProps,
  type BubblePlugin,
} from './pluginRegistry';
export { registerBubble } from './bubblePlugins';

// Terminal client (browser-side WS wrapper)
export {
  executeCommand,
  interruptCommand,
  attachCommand,
  queryRunningCommands,
  sendStdin,
  resizePty,
  dispose as disposeTerminalWs,
} from './TerminalWsManager';
