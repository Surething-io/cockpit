/**
 * 气泡插件统一入口
 *
 * 导入此文件即触发所有插件注册。
 * 新增插件只需在此处加一行 import。
 */

import './browser';
import './database';
import './redis';

export { matchInput, getPlugin, getAllPlugins, generatePluginItemId } from '../bubblePlugins';
export type { PluginItemBase, BubbleComponentProps, BubblePlugin } from '../bubblePlugins';
