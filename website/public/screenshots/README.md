# Screenshots

Drop final panel screenshots here as PNG files. The `PanelSection` component
in `components/sections/PanelSection.tsx` will display them automatically;
until they exist, a styled placeholder card shows the panel name.

Expected files (4:3 aspect ratio, ~1600×1200 ideal):

- `agent.png` — Agent panel (chat interface)
- `explorer.png` — Explorer panel (file browser + editor)
- `console.png` — Console panel (terminal + bubbles)

No build step required — placing the file is enough; Next.js static export
picks them up at build time and the `<img>` `onError` fallback hides itself
if the file is missing.
