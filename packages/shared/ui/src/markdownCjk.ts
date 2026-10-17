import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import type { PluggableList } from 'unified';

/**
 * Remark plugin list that lets `**bold**`, `*em*` and `~~del~~` close next to
 * CJK punctuation. CommonMark's flanking rule rejects a closing delimiter that
 * follows punctuation and precedes a letter, so `**为什么：**同名` would render
 * its asterisks literally. Spread into a `remarkPlugins` array AFTER remarkGfm.
 */
export const remarkCjk: PluggableList = [remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough];
