const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let glyphCache = new Map();
let decorationTypes = new Map();

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

    // React to configuration changes (for hideSourceChar)
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('bedrockEmoji.hideSourceChar')) {
                decorationTypes.forEach(dec => dec.dispose());
                decorationTypes.clear();
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

    if (vscode.window.activeTextEditor) updateDecorations(vscode.window.activeTextEditor);
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
    const extVanillaPath = path.join(__dirname, 'vanilla');
    ['E0', 'E1'].forEach(glyph => {
        const codeStart = parseInt(glyph, 16) * 256; // 0xE0*256 = 0xE000
        const filePath = path.join(extVanillaPath, `glyph_${glyph}.png`);
        if (!glyphCache.has(codeStart) && fs.existsSync(filePath)) {
            for (let row = 0; row < 16; row++) {
                for (let col = 0; col < 16; col++) {
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
    } catch (e) {}
}

function scanGlyphFiles(fontPath) {
    try {
        const files = fs.readdirSync(fontPath);
        for (const file of files) {
            const match = file.match(/glyph_([0-9A-Fa-f]{2})\.png$/i);
            if (!match) continue;

            const glyphByte = parseInt(match[1], 16);
            const fullPath = path.join(fontPath, file);

            for (let row = 0; row < 16; row++) {
                for (let col = 0; col < 16; col++) {
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
    } catch (e) {}
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
