# Maple Mono CN

Cockpit bundles Maple Mono CN Regular v7.9, matching the original file
preview font. CJK glyphs occupy two Latin cells; box-drawing characters and
diagram symbols such as arrows occupy one. The complete character set is
retained; only the container format changes.

- Project: https://github.com/subframe7536/maple-font
- Source: https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMono-CN-unhinted.zip
- Archive SHA-256: `d41cb72721e99cfe4fbd1a7b0f182a013457de46aa612018f924dd024699d3b9`
- TTF SHA-256: `0fcc5139bfd5ab14ff989bb7dfd5236d0cafc10e60b9828569e6883613ab4085`
- License: SIL Open Font License 1.1, reproduced in `LICENSE.txt`.

To reproduce the WOFF2 file, extract `MapleMono-CN-Regular.ttf` from the
archive and run with FontTools 4.62.1 and Brotli installed:

```python
from fontTools.ttLib import TTFont

font = TTFont("MapleMono-CN-Regular.ttf")
font.flavor = "woff2"
font.save("MapleMono-CN-Regular.woff2")
```

`public/html-lib/mono-font.css` owns the font face and shared family stack.
Keep this font and its license in the npm package's `public` directory.
