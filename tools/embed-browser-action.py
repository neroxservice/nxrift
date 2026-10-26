# Erzeugt preload.js neu: bettet node_modules/electron-chrome-extensions/dist/cjs/browser-action.js ein
# (ein Sandbox-Preload darf keine lokalen Module laden). Nach Updates von electron-chrome-extensions ausführen.
import re
p = open('preload.js', encoding='utf8').read()
ba = open('node_modules/electron-chrome-extensions/dist/cjs/browser-action.js', encoding='utf8').read()
a = p.index('const __ba = (() => {')
b = p.index('return module.exports; })();')
head = p[:a] + "const __ba = (() => { const module = { exports: {} }; let exports = module.exports;\n"
open('preload.js', 'w', encoding='utf8').write(head + ba + "\n  " + p[b:])
