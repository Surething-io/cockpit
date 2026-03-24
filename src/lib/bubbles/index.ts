/**
 * Unified bubble plugin entry point
 *
 * Importing this file triggers registration of all plugins.
 * To add a new plugin, just add one import line here.
 */

import './browser';
import './database';
import './redis';

export { matchInput, getPlugin, getAllPlugins, generatePluginItemId } from '../bubblePlugins';
export type { PluginItemBase, BubbleComponentProps, BubblePlugin } from '../bubblePlugins';
