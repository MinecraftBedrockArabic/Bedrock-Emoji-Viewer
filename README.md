# Bedrock Emoji Viewer

A VS Code extension that displays Minecraft Bedrock custom emoji glyphs inline in your editor.

## Features

- **Inline Emoji Display**: Automatically shows emoji images next to Unicode escape sequences
- **Hover Information**: Hover over `\uXXXX` to see glyph details and a larger preview
- **Auto-Detection**: Scans for `glyph_XX.png` files in your workspace
- **Real-time Updates**: Updates decorations as you type
- **Vanilla Emoji fallback**: Uses `glyph_E0.png` and `glyph_E1.png` if they are not used in the workspac

### File Structure

Place your Bedrock emoji glyph files in one of these locations:
- `./font/`
- `./<any-folder>/font/` (searches up to 3 levels deep)

### Glyph Files

Name your files as` glyph_XX.png` where XX is a hex value (00-FF)

Each glyph file should contain a 16x16 grid of emojis.

### In Your Code

Use **actual Unicode characters** (not escape sequences):
```javascript
const text = "Hello  World";  // Where  is the actual U+E000 character (0xE000)
```

The extension will **replace** the Unicode character with the emoji image from your glyph files.

## Unicode Emoji Insertion

The extension provides a command to quickly insert Bedrock emoji characters based on Unicode values or glyph pages.

### Insert by Unicode code point

After typing any of the following formats, press **`Ctrl + Shift + U`** to insert the corresponding emoji character:

```
0xXXXX
\uXXXX
U+XXXX
XXXX
```

Where `XXXX` is a hexadecimal Unicode value (for example `E000`).

---

### Insert from a glyph page (XX)

After typing one of the following formats, press **`Ctrl + Shift + U`** to open a glyph picker:

```
0xXX
\uXX
U+XX
XX
```

- `XX` is a hexadecimal glyph page (`00`–`FF`)
- Displays all emojis from the corresponding `glyph_XX.png`
- Select an emoji to insert it into the editor

### Settings

- **Hide Source Char:** Hide the original Unicode emoji character and only show the icon.
- **Ignore Transparent Glyphs:** Ignores glyphs that are completely transparent during loading.


---

### Notes

- Inserts the **actual Unicode character**, not an escape sequence
- Glyphs are resolved from workspace font files or the vanilla fallback
- Hex values are case-insensitive

## License

MIT