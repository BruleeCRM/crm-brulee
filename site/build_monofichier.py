"""Build version-monofichier.html: the whole site in a single HTML file.

Fonts, Three.js, the SVG loader and the glass shape are embedded as data, so the
file opens straight from disk. Python 3, no dependencies:

    python3 build_monofichier.py
"""
from __future__ import annotations
import base64
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent


def data_uri(path: pathlib.Path, mime: str) -> str:
    return f'data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode('ascii')


def build() -> pathlib.Path:
    html = (ROOT / 'index.html').read_text(encoding='utf-8')

    # 1. styles: fonts.css with embedded faces, then styles.css without its @import
    fonts_css = (ROOT / 'css/fonts.css').read_text(encoding='utf-8')
    fonts_css = re.sub(r'url\(\.\./assets/fonts/([^)]+)\)',
                       lambda m: 'url(' + data_uri(ROOT / 'assets/fonts' / m.group(1),
                                                    'font/woff2' if m.group(1).endswith('.woff2') else 'font/ttf') + ')',
                       fonts_css)
    styles_css = (ROOT / 'css/styles.css').read_text(encoding='utf-8')
    styles_css = re.sub(r'@import url\("\./fonts\.css[^"]*"\);\s*', '', styles_css)
    # the still flame of the version without 3D
    styles_css = re.sub(r'url\(\.\./assets/brand/([^)]+\.jpg)\)',
                        lambda m: 'url(' + data_uri(ROOT / 'assets/brand' / m.group(1), 'image/jpeg') + ')',
                        styles_css)
    html = re.sub(r'<link rel="stylesheet" href="\./css/styles\.css[^"]*">',
                  lambda m: '<style>\n' + fonts_css + '\n' + styles_css + '\n</style>', html)

    # 2. import map pointing at embedded modules (the loader still imports "three")
    imports = {
        'three': data_uri(ROOT / 'vendor/three.module.js', 'text/javascript'),
        'three/examples/jsm/loaders/SVGLoader.js': data_uri(ROOT / 'vendor/SVGLoader.js', 'text/javascript'),
    }
    html = re.sub(r'<script type="importmap">.*?</script>',
                  lambda m: '<script type="importmap">' + json.dumps({'imports': imports}) + '</script>',
                  html, flags=re.S)

    # 3. the module, with the shape(s) inlined instead of fetched
    app = (ROOT / 'js/app.js').read_text(encoding='utf-8')
    paths = re.search(r'shapes: \[([^\]]*)\]', app).group(1)
    shapes = [p.strip().strip("'\"") for p in paths.split(',') if p.strip()]
    sources = [(ROOT / p.lstrip('./')).read_text(encoding='utf-8').strip() for p in shapes]
    fetch_block = re.compile(r'const shapeSources = await Promise\.all\(.*?\}\)\);\n', re.S)
    if not fetch_block.search(app):
        raise SystemExit('shape loading block not found in js/app.js')
    literal = 'const shapeSources = ' + json.dumps(sources) + ';\n'
    app = fetch_block.sub(lambda m: literal, app)
    if '</script' in app:
        raise SystemExit('the module contains a closing script tag')
    html = re.sub(r'<script type="module" src="\./js/app\.js[^"]*"></script>',
                  lambda m: '<script type="module">\n' + app + '\n</script>', html)

    out = ROOT / 'version-monofichier.html'
    out.write_text(html, encoding='utf-8')
    return out


if __name__ == '__main__':
    path = build()
    print(f'{path.name}: {path.stat().st_size / 1e6:.2f} MB')
