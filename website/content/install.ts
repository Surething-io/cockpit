/**
 * Single source of truth for the install command.
 *
 * The hero renders it as the primary action and the PWA section repeats it in
 * step 1: that step used to read "Run the command above", which on a 390px
 * viewport pointed at something 1,143px off-screen. Repeating the string beats
 * asking the reader to hold it in working memory across a screen and a half —
 * but it has to be one string, not two literals that can drift apart.
 */
export const INSTALL_COMMAND = 'npm i -g @surething/cockpit && cockpit';
