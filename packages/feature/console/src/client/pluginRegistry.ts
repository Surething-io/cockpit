/**
 * Unified bubble plugin entry point.
 *
 * Importing this file triggers registration of all plugins.
 * To add a new plugin: implement BubblePlugin (see ./bubblePlugins),
 * call registerBubble() from an `index.tsx` in ./plugins/<name>/,
 * then add one import line here.
 */

import './plugins/browser';
import './plugins/database';
import './plugins/jupyter';
import './plugins/mysql';
import './plugins/redis';
import './plugins/neo4j';

export { matchInput, getPlugin, getAllPlugins, generatePluginItemId } from './bubblePlugins';
export type { PluginItemBase, BubbleComponentProps, BubblePlugin } from './bubblePlugins';
