const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

let glyphCache = new Map();
let decorationTypes = new Map();

// Check if a 16x16 glyph block is completely transparent
function isGlyphTransparent(pngData, row, col) {
    const startX = col * 16;
    const startY = row * 16;

    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
            const posX = startX + x;
            const posY = startY + y;

            // Calculate index in the buffer (RGBA = 4 bytes per pixel)
            const idx = (posY * pngData.width + posX) << 2;

            // Check Alpha channel (4th byte)
            const alpha = pngData.data[idx + 3];

            // If alpha > 0, the glyph is visible
            if (alpha > 0) {
                return false;
            }
        }
    }
    return true;
}

function activate(context) {
    console.log('Bedrock Emoji extension activated');

    // Load glyphs and apply decorations to the active editor
    loadGlyphs();

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) updateDecorations(editor);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) updateDecorations(editor);
        })
    );

    // React to configuration changes (for hideSourceChar and ignoreTransparentGlyphs)
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            const shouldReload = e.affectsConfiguration('bedrockEmoji.hideSourceChar') ||
                e.affectsConfiguration('bedrockEmoji.ignoreTransparentGlyphs');

            if (shouldReload) {
                decorationTypes.forEach(dec => dec.dispose());
                decorationTypes.clear();
                glyphCache.clear();

                loadGlyphs();
                const editor = vscode.window.activeTextEditor;
                if (editor) updateDecorations(editor);
            }
        })
    );

    // Hover to show glyph details
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(['*'], {
            provideHover(document, position) {
                // Check current position
                let char = document.getText(new vscode.Range(position, position.translate(0, 1)));
                let codePoint = char ? char.codePointAt(0) : null;
                let glyphInfo = codePoint ? getGlyphInfo(codePoint) : null;

                // If not found, check previous character (since icon renders after the char)
                if (!glyphInfo || !glyphInfo.imagePath) {
                    if (position.character > 0) {
                        const prevPos = position.translate(0, -1);
                        char = document.getText(new vscode.Range(prevPos, position));
                        codePoint = char ? char.codePointAt(0) : null;
                        glyphInfo = codePoint ? getGlyphInfo(codePoint) : null;
                    }
                }

                if (!glyphInfo || !glyphInfo.imagePath) return;

                const md = new vscode.MarkdownString();
                md.appendMarkdown('**Bedrock Emoji**\n\n');
                md.appendMarkdown(`Code: \`U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}\`\n\n`);
                md.appendMarkdown(`Glyph: \`glyph_${glyphInfo.glyphFile}.png\`\n\n`);
                md.appendMarkdown(`Position: Row ${glyphInfo.row}, Col ${glyphInfo.col}\n\n`);
                md.isTrusted = true;
                return new vscode.Hover(md);
            }
        })
    );

    // Command to reload glyphs
    context.subscriptions.push(
        vscode.commands.registerCommand('bedrockEmoji.reloadGlyphs', () => {
            decorationTypes.forEach(dec => dec.dispose());
            decorationTypes.clear();
            glyphCache.clear();

            loadGlyphs();
            const editor = vscode.window.activeTextEditor;
            if (editor) updateDecorations(editor);
            vscode.window.showInformationMessage(`Bedrock emoji glyphs reloaded! Found ${glyphCache.size} glyphs.`);
        })
    );

    // Open Emoji Picker for the typed Hex Byte
    context.subscriptions.push(
        vscode.commands.registerCommand('bedrockEmoji.convertToUnicode', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const document = editor.document;
            const cursorPos = editor.selection.active;
            const lineText = document.lineAt(cursorPos).text;
            const textUpToCursor = lineText.substring(0, cursorPos.character);

            // Match hex patterns: \uXX(XX), 0xXX(XX), U+XX(XX), or just XX(XX)
            const match = textUpToCursor.match(/(\\u|0x|[uU]\+)?([0-9a-fA-F]{2,4})$/);

            if (!match) {
                vscode.window.showWarningMessage('No valid hex value found before cursor.');
                return;
            }

            const prefix = match[1] || "";
            const hexValue = match[2].toUpperCase();

            // Check if this is a 4-digit codepoint (direct insert) or 2-digit glyph file (picker)
            if (hexValue.length === 4) {
                // Direct insert mode: E100 -> insert U+E100
                const codePoint = parseInt(hexValue, 16);
                const charString = String.fromCodePoint(codePoint);

                const rangeToReplace = new vscode.Range(
                    cursorPos.translate(0, -(prefix.length + hexValue.length)),
                    cursorPos
                );

                editor.edit(editBuilder => {
                    editBuilder.replace(rangeToReplace, charString);
                });
                return;
            }

            // Picker mode: E1 -> show picker for glyph_E1.png
            const hexByte = hexValue; // Already 2 digits
            const hexByteVal = parseInt(hexByte, 16);
            const glyphByte = hexByteVal; // For use in the picker loop below

            // Find the image file for this byte (glyph_E1.png)
            const imagePath = findGlyphFile(hexByte);

            if (!imagePath) {
                vscode.window.showWarningMessage(`Could not find glyph file: glyph_${hexByte}.png in workspace font folder.`);
                return;
            }

            // Read image and generate Base64
            let imageBase64;
            let pngData = null;

            try {
                const imageBuffer = fs.readFileSync(imagePath);
                imageBase64 = imageBuffer.toString('base64');

                // If setting is enabled, parse PNG to check transparency
                const config = vscode.workspace.getConfiguration('bedrockEmoji');
                if (config.get('ignoreTransparentGlyphs', true)) {
                    try {
                        pngData = PNG.sync.read(imageBuffer);
                    } catch (e) {
                        console.error('Failed to parse PNG for transparency check in picker', e);
                    }
                }

            } catch (e) {
                vscode.window.showErrorMessage(`Failed to read image file: ${imagePath}`);
                return;
            }

            // Generate QuickPick Items
            const items = [];

            for (let row = 0; row < 16; row++) {
                for (let col = 0; col < 16; col++) {
                    // If we have png data and the block is transparent, skip it
                    if (pngData && isGlyphTransparent(pngData, row, col)) {
                        continue;
                    }

                    const offset = row * 16 + col;
                    const unicode = (glyphByte * 256) + offset;
                    const charString = String.fromCodePoint(unicode);

                    // Create a cropped icon using SVG
                    const x = col * 16;
                    const y = row * 16;

                    const svgString = `
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                        <image href="data:image/png;base64,${imageBase64}" x="-${x}" y="-${y}" width="256" height="256" />
                    </svg>
                `;
                    const iconUri = vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svgString).toString('base64')}`);

                    items.push({
                        label: charString,
                        description: `U+${unicode.toString(16).toUpperCase().padStart(4, '0')} [${row}, ${col}]`,
                        iconPath: iconUri,
                        alwaysShow: true,
                        data: { unicode, prefixLength: prefix.length + hexValue.length }
                    });
                }
            }

            // Show QuickPick
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = items;
            quickPick.placeholder = `Select a glyph from glyph_${hexByte}.png`;
            quickPick.canSelectMany = false;
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;

            quickPick.show();

            // Handle Selection
            quickPick.onDidAccept(() => {
                const selected = quickPick.selectedItems[0];
                if (selected) {
                    const rangeToReplace = new vscode.Range(
                        cursorPos.translate(0, -selected.data.prefixLength),
                        cursorPos
                    );

                    editor.edit(editBuilder => {
                        editBuilder.replace(rangeToReplace, selected.label);
                    });
                }
                quickPick.hide();
            });

            quickPick.onDidHide(() => quickPick.dispose());
        })
    );

    if (vscode.window.activeTextEditor) updateDecorations(vscode.window.activeTextEditor);
}

// Helper to find the specific glyph file path
function findGlyphFile(hexByte) {
    // First check cache (if the glyphs were already loaded)
    // Any codepoint in this range works to get the path
    const sampleCodePoint = parseInt(hexByte, 16) * 256;
    for (let i = 0; i < 256; i++) {
        const info = glyphCache.get(sampleCodePoint + i);
        if (info) return info.imagePath;
    }

    // If not in cache (new file?), search disk
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return null;

    const rootPath = workspaceFolders[0].uri.fsPath;
    const targetFile = `glyph_${hexByte.toUpperCase()}.png`;

    // Search logic similar to loadGlyphs but targeted
    function searchDir(dir, depth) {
        if (depth > 3) return null;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'font') {
                        const fontDir = fullPath;
                        try {
                            const files = fs.readdirSync(fontDir);
                            const found = files.find(f => f.toLowerCase() === targetFile.toLowerCase());
                            if (found) return path.join(fontDir, found);
                        } catch (e) { }
                    } else {
                        const res = searchDir(fullPath, depth + 1);
                        if (res) return res;
                    }
                }
            }
        } catch (e) { }
        return null;
    }

    // Check root/font first
    const rootFont = path.join(rootPath, 'font');
    if (fs.existsSync(rootFont)) {
        try {
            const files = fs.readdirSync(rootFont);
            const found = files.find(f => f.toLowerCase() === targetFile.toLowerCase());
            if (found) return path.join(rootFont, found);
        } catch (e) { }
    }

    // Recursive search
    return searchDir(rootPath, 0);
}

function isHideSourceCharEnabled() {
    const config = vscode.workspace.getConfiguration('bedrockEmoji');
    return config.get('hideSourceChar', true);
}

// Search workspace for font folders and load glyph files
function loadGlyphs() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    const rootPath = workspaceFolders[0].uri.fsPath;

    const possiblePaths = [
        path.join(rootPath, 'font')
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) scanGlyphFiles(p);
    }

    searchForFontDirs(rootPath, 0, 3);

    // fallback to vanilla emoji if E0 or E1 missing
    const config = vscode.workspace.getConfiguration('bedrockEmoji');
    const ignoreTransparent = config.get('ignoreTransparentGlyphs', true);

    const extVanillaPath = path.join(__dirname, 'vanilla');
    ['E0', 'E1'].forEach(glyph => {
        const codeStart = parseInt(glyph, 16) * 256; // 0xE0*256 = 0xE000
        const filePath = path.join(extVanillaPath, `glyph_${glyph}.png`);

        if (!glyphCache.has(codeStart) && fs.existsSync(filePath)) {
            let pngData = null;
            if (ignoreTransparent) {
                try {
                    const buffer = fs.readFileSync(filePath);
                    pngData = PNG.sync.read(buffer);
                } catch (e) { }
            }

            for (let row = 0; row < 16; row++) {
                for (let col = 0; col < 16; col++) {
                    // Check transparency if enabled
                    if (pngData && isGlyphTransparent(pngData, row, col)) {
                        continue;
                    }

                    const unicode = codeStart + (row * 16 + col);
                    glyphCache.set(unicode, {
                        glyphFile: glyph,
                        row,
                        col,
                        imagePath: filePath
                    });
                }
            }
        }
    });
}


function searchForFontDirs(dir, currentDepth, maxDepth) {
    if (currentDepth >= maxDepth) return;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

            const fullPath = path.join(dir, entry.name);
            if (entry.name === 'font') {
                scanGlyphFiles(fullPath);
            } else {
                searchForFontDirs(fullPath, currentDepth + 1, maxDepth);
            }
        }
    } catch (e) { }
}

function scanGlyphFiles(fontPath) {
    const config = vscode.workspace.getConfiguration('bedrockEmoji');
    const ignoreTransparent = config.get('ignoreTransparentGlyphs', true);

    try {
        const files = fs.readdirSync(fontPath);
        for (const file of files) {
            const match = file.match(/glyph_([0-9A-Fa-f]{2})\.png$/i);
            if (!match) continue;

            const glyphByte = parseInt(match[1], 16);
            const fullPath = path.join(fontPath, file);

            let pngData = null;
            if (ignoreTransparent) {
                try {
                    const buffer = fs.readFileSync(fullPath);
                    pngData = PNG.sync.read(buffer);
                } catch (e) {
                    console.warn(`Could not parse PNG for transparency check: ${file}`);
                }
            }

            for (let row = 0; row < 16; row++) {
                for (let col = 0; col < 16; col++) {
                    // Check transparency if enabled
                    if (pngData && isGlyphTransparent(pngData, row, col)) {
                        continue;
                    }

                    const unicode = (glyphByte * 256) + (row * 16 + col);
                    glyphCache.set(unicode, {
                        glyphFile: match[1].toUpperCase(),
                        row,
                        col,
                        imagePath: fullPath
                    });
                }
            }
        }
    } catch (e) { }
}

function getGlyphInfo(codePoint) {
    return glyphCache.get(codePoint);
}

// Create or reuse a decoration type for a specific glyph cell
function getOrCreateDecorationType(glyphInfo) {
    const key = `${glyphInfo.glyphFile}_${glyphInfo.row}_${glyphInfo.col}_${isHideSourceCharEnabled()}`;
    if (decorationTypes.has(key)) return decorationTypes.get(key);

    const imageData = fs.readFileSync(glyphInfo.imagePath);
    const base64 = imageData.toString('base64');
    const dataUri = `data:image/png;base64,${base64}`;

    const xPercent = (glyphInfo.col * 100) / 15;
    const yPercent = (glyphInfo.row * 100) / 15;

    const hideChar = isHideSourceCharEnabled();

    const decorationType = vscode.window.createTextEditorDecorationType({
        // When hiding, pull the char and make it invisible
        ...(hideChar && {
            letterSpacing: "-1ch",
            opacity: "0",
        }),
        // When not hiding, keep the text normal
        ...(!hideChar && {
            letterSpacing: "0",
            opacity: "1",
        }),
        after: {
            contentText: " ",
            width: "16px",
            height: "16px",
            margin: "0",
            textDecoration: `
                display:inline-block;
                width:16px;
                height:16px;
                background-image:url('${dataUri}');
                background-size:1600% 1600%;
                background-position:${xPercent}% ${yPercent}%;
                background-repeat:no-repeat;
            `,
        },
    });

    decorationTypes.set(key, decorationType);
    return decorationType;
}

function updateDecorations(editor) {
    // clear previous ranges
    decorationTypes.forEach(decType => editor.setDecorations(decType, []));

    const text = editor.document.getText();
    const decorationMap = new Map();

    let i = 0;
    while (i < text.length) {
        const codePoint = text.codePointAt(i);
        const charLength = codePoint > 0xFFFF ? 2 : 1;
        const glyphInfo = getGlyphInfo(codePoint);

        if (glyphInfo && glyphInfo.imagePath) {
            const startPos = editor.document.positionAt(i);
            const endPos = editor.document.positionAt(i + charLength);
            const range = new vscode.Range(startPos, endPos);

            const decorationType = getOrCreateDecorationType(glyphInfo);
            if (!decorationMap.has(decorationType)) decorationMap.set(decorationType, []);
            decorationMap.get(decorationType).push({ range });
        }

        i += charLength;
    }

    decorationMap.forEach((ranges, decorationType) => {
        editor.setDecorations(decorationType, ranges);
    });
}

function deactivate() {
    decorationTypes.forEach(dec => dec.dispose());
    decorationTypes.clear();
}

module.exports = { activate, deactivate };