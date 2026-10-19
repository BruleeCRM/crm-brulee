"""Fill the template with one business's content.

    python3 tools/build_site.py site.json [--out ../my-site]

Reads a JSON brief (see site.example.json), writes the finished site next to the
template or into --out, generates the glass shape if it names a library shape,
and rebuilds the single-file version. Run it again after editing site.json: it is
idempotent, so iterating on the copy is cheap.
"""
from __future__ import annotations
import datetime
import json
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
TEMPLATE = HERE.parent

# Line icons for the benefits. Simple strokes only: they sit at 16 px.
ICONS = {
    'spark': '<path d="M10 3 3 17h14L10 3z"/><path d="M4.5 12.5h11" opacity=".55"/>',
    'shield': '<path d="M10 3 4 5.5v5c0 3.4 2.4 5.7 6 6.5 3.6-.8 6-3.1 6-6.5v-5L10 3z"/>',
    'clock': '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l2.8 1.8"/>',
    'chart': '<path d="M3 16h14"/><path d="M6 16V9m4 7V5m4 11v-5"/>',
    'check': '<circle cx="10" cy="10" r="7"/><path d="m6.8 10.2 2.2 2.2 4.2-4.6"/>',
    'people': '<circle cx="8" cy="8" r="2.6"/><path d="M3.5 16c0-2.5 2-4.2 4.5-4.2s4.5 1.7 4.5 4.2"/><path d="M13.5 6.2a2.4 2.4 0 0 1 0 4.4M14.5 16c0-1.6-.5-2.9-1.4-3.7" opacity=".55"/>',
    'target': '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3.2"/>',
    'leaf': '<path d="M16 4c0 7-4 11-9 11H4c0-7 4-11 9-11h3z"/><path d="M4 16c3-4.5 6-6.8 9.5-8" opacity=".55"/>',
    'wrench': '<path d="M13.4 3.6a4 4 0 0 0-5 5L3.6 13.4a1.7 1.7 0 0 0 2.4 2.4l4.8-4.8a4 4 0 0 0 5-5l-2.3 2.3-2-.5-.5-2 2.4-2.2z"/>',
    'lock': '<rect x="4.5" y="8.5" width="11" height="8" rx="1.8"/><path d="M7.2 8.5V6.6a2.8 2.8 0 0 1 5.6 0v1.9"/>',
    'globe': '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c1.9 2 2.8 4.3 2.8 7S11.9 15 10 17c-1.9-2-2.8-4.3-2.8-7S8.1 5 10 3z" opacity=".7"/>',
    'code': '<path d="m7 6-4 4 4 4M13 6l4 4-4 4"/>',
    'phone': '<path d="M6.2 3.8 8 7l-1.6 1.6a9 9 0 0 0 5 5L13 12l3.2 1.8-.6 2.4c-.2.7-.9 1.1-1.6 1A13.6 13.6 0 0 1 3.8 6.2c-.1-.7.3-1.4 1-1.6l1.4-.8z"/>',
    'star': '<path d="m10 3 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4L5.5 17l.9-5L2.8 8.3l5-.7L10 3z"/>',
    'truck': '<path d="M2.5 6.5h8v8h-8z"/><path d="M10.5 9.5h3l2.5 2.5v2.5h-5.5z"/><circle cx="6" cy="15.5" r="1.4"/><circle cx="13" cy="15.5" r="1.4"/>',
    'euro': '<circle cx="10" cy="10" r="7"/><path d="M12.8 7.2a3.6 3.6 0 0 0-5 1.2c-.9 1.7-.3 3.8 1.4 4.7a3.6 3.6 0 0 0 3.6-.1M6.6 9.3h4.6M6.6 11h4"/>',
}

DEFAULTS = {
    'lang': 'fr', 'version': datetime.datetime.now().strftime('%Y%m%d%H%M%S'),   # busts browser caches on every build
    'year': str(datetime.date.today().year),
    'nav': ['Accueil', 'À propos', 'Services', 'Résultats', 'Contact'],
    'nav_label': 'Chapitres', 'loader_hint': 'Chargement',
    'form': {
        'title': 'Votre message', 'name': 'Votre nom', 'email': 'Votre e-mail',
        'company': 'Entreprise', 'project': 'Votre projet', 'optional': 'optionnel',
        'name_placeholder': 'Nom et prénom', 'email_placeholder': 'vous@entreprise.com',
        'company_placeholder': "Nom de l'entreprise",
        'project_placeholder': 'Ce que vous aimeriez faire…',
        'note': "Votre messagerie s'ouvrira<br>avec le message prêt à envoyer.",
        'button': 'Préparer mon e-mail',
    },
    'footer': {'spec': 'Three.js · WebGL 2 · 100 % temps réel', 'top': 'Haut de page'},
    'palette': ['#4d8cff', '#8f52f5', '#fa579e', '#ff9438', '#99123a'],
}


def deep_merge(base, extra):
    out = dict(base)
    for key, value in (extra or {}).items():
        out[key] = deep_merge(base[key], value) if isinstance(value, dict) and isinstance(base.get(key), dict) else value
    return out


def icon(name):
    body = ICONS.get(name)
    if body is None:
        raise SystemExit(f'unknown icon {name!r}. Available: {", ".join(sorted(ICONS))}')
    return ('<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" '
            f'stroke-linecap="round" stroke-linejoin="round">{body}</svg>')


LIBRARY = TEMPLATE / 'assets/library'


def resolve_shape(spec, out_dir, filename):
    """A shape is a library name, or the path of an SVG to bring in as it is."""
    target = out_dir / 'assets/shapes' / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    library_file = LIBRARY / f'{spec}.svg'
    if library_file.exists():
        shutil.copyfile(library_file, target)
        return f'library shape {spec}'
    candidate = pathlib.Path(spec).expanduser()
    if candidate.suffix.lower() == '.svg' and candidate.exists():
        result = subprocess.run([sys.executable, str(HERE / 'make_shape.py'), '--import',
                                 str(candidate), str(target)], capture_output=True, text=True)
        if result.returncode:
            raise SystemExit(f'shape {spec!r}: {result.stderr.strip()}')
        return f'imported {candidate.name}'
    result = subprocess.run([sys.executable, str(HERE / 'make_shape.py'), spec, str(target)],
                            capture_output=True, text=True)
    if result.returncode:
        names = ', '.join(sorted(f.stem for f in LIBRARY.glob('*.svg')))
        raise SystemExit(f'unknown shape {spec!r}. Library: {names}')
    return f'generated {spec}'


def main(argv):
    if not argv:
        raise SystemExit(__doc__)
    brief = deep_merge(DEFAULTS, json.loads(pathlib.Path(argv[0]).read_text(encoding='utf-8')))
    out = pathlib.Path(argv[argv.index('--out') + 1]).expanduser() if '--out' in argv else TEMPLATE.parent / 'site'
    out = out.resolve()
    if out == TEMPLATE:
        raise SystemExit('refusing to overwrite the template itself; pass --out')

    # 1. copy the engine, leaving generated content behind
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(TEMPLATE, out, ignore=shutil.ignore_patterns(
        '__pycache__', 'site.example.json', '*.pyc', 'out', 'site.json'))
    for stale in (out / 'assets/shapes').glob('*.svg'):
        stale.unlink()

    # 2. the glass shape. One silhouette is the rule: it breaks apart and recomposes
    # into itself. Two silhouettes keep the legacy morph from the first to the second.
    shapes = brief.get('shape') or brief.get('shapes')
    if not shapes:
        raise SystemExit('the brief needs "shape": a library name or the path of an SVG')
    if isinstance(shapes, str):
        shapes = [shapes]
    if len(shapes) == 1:
        notes = [resolve_shape(shapes[0], out, 'shape.svg')]
        shape_paths = ['./assets/shapes/shape.svg']
    elif len(shapes) == 2:
        notes = [resolve_shape(shapes[0], out, 'opening.svg'),
                 resolve_shape(shapes[1], out, 'final.svg')]
        shape_paths = ['./assets/shapes/opening.svg', './assets/shapes/final.svg']
    else:
        raise SystemExit('"shape" takes one silhouette ("shapes" takes two, for a morph)')

    # 3. brand mark: a custom SVG, or the default one already in the template
    mark_path = brief.get('mark')
    if mark_path:
        source = pathlib.Path(mark_path).expanduser()
        if not source.exists():
            raise SystemExit(f'brand mark not found: {source}')
        shutil.copyfile(source, out / 'assets/brand/mark.svg')
        notes.append(f'brand mark {source.name}')
    mark_svg = (out / 'assets/brand/mark.svg').read_text(encoding='utf-8').strip()
    mark_svg = re.sub(r'<title>.*?</title>', '', mark_svg, flags=re.S)
    mark_svg = re.sub(r'\s(width|height)="[^"]*"', '', mark_svg)
    mark_svg = re.sub(r'fill="(?!none)[^"]*"', 'fill="currentColor"', mark_svg)

    # 4. shape paths and palette into the engine
    app = (out / 'js/app.js').read_text(encoding='utf-8')
    app = re.sub(r"shapes: \[[^\]]*\]",
                 'shapes: [' + ', '.join(f"'{p}'" for p in shape_paths) + ']', app, count=1)
    app = re.sub(r"palette: \[[^\]]*\]",
                 'palette: [' + ', '.join(f"'{c}'" for c in brief['palette']) + ']', app, count=1)
    (out / 'js/app.js').write_text(app, encoding='utf-8')

    # 5. copy
    figures = brief['figures']
    tokens = {
        'LANG': brief['lang'], 'VERSION': brief['version'], 'YEAR': brief['year'],
        'TITLE': brief['title'], 'META_DESCRIPTION': brief['meta_description'],
        'BRAND': brief['brand'], 'BRAND_MARK': mark_svg, 'EMAIL': brief['email'],
        'LOADER_HINT': brief['loader_hint'], 'NAV_LABEL': brief['nav_label'],
        'NAV_1': brief['nav'][0], 'NAV_2': brief['nav'][1], 'NAV_3': brief['nav'][2],
        'NAV_4': brief['nav'][3], 'NAV_CONTACT': brief['nav'][4],
        'T1_A': brief['hero']['title'][0], 'T1_B': brief['hero']['title'][1],
        'LEAD_1': brief['hero']['lead'],
        'EYEBROW': brief['hero'].get('eyebrow', ''), 'CTA': brief['hero'].get('cta', brief['nav'][4]),
        'SCROLL_HINT': brief.get('scroll_hint', 'Faites défiler'),
        'TOOLS_LABEL': brief.get('tools_label', "Les outils qu'on branche"),
        'PORTRAIT_ALT': brief['about'].get('portrait_alt', 'Portrait'),
        # Social networks need an absolute address for the share image: set "site_url"
        # in the brief once the site has its domain.
        'OG_IMAGE': (brief.get('site_url', '').rstrip('/') + '/assets/brand/og.jpg') if brief.get('site_url') else './assets/brand/og.jpg',
        'ABOUT_NAME': brief['about'].get('name', ''), 'ABOUT_ROLE': brief['about'].get('role', ''),
        'CHEF_ALT': brief['contact'].get('chef_alt', ''),
        'T2_A': brief['about']['title'][0], 'T2_B': brief['about']['title'][1],
        'ABOUT': brief['about']['text'],
        'T3_A': brief['benefits']['title'][0], 'T3_B': brief['benefits']['title'][1],
        'T4_A': brief['results']['title'][0], 'T4_B': brief['results']['title'][1],
        'RESULTS_LEAD': brief['results']['lead'],
        'FIGURES_SOURCE': brief['results'].get('source', ''),
        'CT_A': brief['contact']['title'][0], 'CT_B': brief['contact']['title'][1],
        'CONTACT_LEAD': brief['contact']['lead'],
        'FORM_TITLE': brief['form']['title'], 'F_NAME': brief['form']['name'],
        'F_EMAIL': brief['form']['email'], 'F_COMPANY': brief['form']['company'],
        'F_PROJECT': brief['form']['project'], 'F_OPTIONAL': brief['form']['optional'],
        'F_NAME_PLACEHOLDER': brief['form']['name_placeholder'],
        'F_EMAIL_PLACEHOLDER': brief['form']['email_placeholder'],
        'F_COMPANY_PLACEHOLDER': brief['form']['company_placeholder'],
        'F_PROJECT_PLACEHOLDER': brief['form']['project_placeholder'],
        'FORM_NOTE': brief['form']['note'], 'FORM_BUTTON': brief['form']['button'],
        'FOOTER_SPEC': brief['footer']['spec'], 'FOOTER_TOP': brief['footer']['top'],
    }
    for i, item in enumerate(brief['benefits']['items'], start=1):
        tokens[f'ICON_{i}'] = icon(item['icon'])
        tokens[f'BENEFIT_{i}'] = item['text']
    for i, item in enumerate(figures, start=1):
        tokens[f'F{i}_VALUE'] = str(item['value'])
        tokens[f'F{i}_DECIMALS'] = str(item.get('decimals', 0))
        tokens[f'F{i}_SUFFIX'] = item.get('suffix', '')
        tokens[f'F{i}_LABEL'] = item['label']

    html = (out / 'index.html').read_text(encoding='utf-8')
    missing = sorted(set(re.findall(r'{{(\w+)}}', html)) - set(tokens))
    if missing:
        raise SystemExit('missing values for: ' + ', '.join(missing))
    for key, value in tokens.items():
        html = html.replace('{{%s}}' % key, str(value))
    (out / 'index.html').write_text(html, encoding='utf-8')
    css = (out / 'css/styles.css').read_text(encoding='utf-8').replace('{{VERSION}}', brief['version'])
    (out / 'css/styles.css').write_text(css, encoding='utf-8')

    # 6. single-file build
    subprocess.run([sys.executable, str(out / 'build_monofichier.py')], check=True, cwd=out)
    print('\n'.join(notes))
    print(f'site written to {out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
