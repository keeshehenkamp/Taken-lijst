#!/usr/bin/env python3
"""render_tekst.py — maakt het ochtendoverzicht in een eenvoudige, compacte opmaak.

Kopjes, lijstjes en klikbare titels; geen zichtbare links, geen weer, geen zware
opmaak. Klein genoeg om elke ochtend goedkoop mee te sturen.

    python3 render_tekst.py data.json
        schrijft overzicht.html (voor htmlBody), overzicht.txt (voor body) en onderwerp.txt
"""

import html
import json
import sys
from datetime import timedelta
from pathlib import Path

from render import deel_taken_in, dagen, iso, kort, lang

GRIJS = 'color:#777'


def e(s):
    return html.escape(str(s or ''))


def link(titel, url):
    return f'<a href="{e(url)}">{e(titel)}</a>' if url else e(titel)


def grijs(s):
    return f' <span style="{GRIJS}">· {e(s)}</span>' if s else ''


def lijst(naam, items):
    """items: lijst van (html, tekst). Leeg = niets tonen."""
    if not items:
        return '', ''
    h = f'<p><b>{e(naam)}</b></p><ul>' + ''.join(f'<li>{x}</li>' for x, _ in items) + '</ul>'
    t = f'{naam}\n' + ''.join(f'- {y}\n' for _, y in items) + '\n'
    return h, t


def agenda(items, vandaag, week):
    eind = vandaag + timedelta(days=6 if week else 0)
    per_dag, gezien = {}, set()
    for a in items:
        d = iso(a.get('dag'))
        sleutel = (a.get('dag'), a.get('start'), a.get('titel', '').strip().lower())
        if d and vandaag <= d <= eind and sleutel not in gezien:
            gezien.add(sleutel)
            per_dag.setdefault(d, []).append(dict(a))
    for rijen in per_dag.values():
        timed = sorted((a for a in rijen if not a.get('hele_dag') and a.get('start')), key=lambda a: a['start'])
        for i, a in enumerate(timed):
            for b in timed[i + 1:]:
                if b['start'] < (a.get('eind') or a['start']):
                    a['overlap'] = b['overlap'] = True

    kop = 'Deze week' if week else 'Agenda'
    if not per_dag:
        leeg = 'Geen afspraken deze week.' if week else 'Geen afspraken vandaag.'
        return f'<h3>{kop}</h3><p>{leeg}</p>', f'{kop.upper()}\n{leeg}\n\n'

    h, t = f'<h3>{kop}</h3>', f'{kop.upper()}\n'
    for d in sorted(per_dag):
        items = []
        for a in sorted(per_dag[d], key=lambda a: (not a.get('hele_dag'), a.get('start') or '')):
            tijd = 'hele dag' if a.get('hele_dag') else (a.get('start') or '') + (f'–{a["eind"]}' if a.get('eind') else '')
            extra = ', '.join(x for x in (a.get('locatie'),
                                         'overlapt!' if a.get('overlap') else '',
                                         'alleen in je mail' if a.get('bron') == 'mail' else '') if x)
            items.append((f'<b>{e(tijd)}</b> {e(a["titel"])}{grijs(extra)}',
                          f'{tijd} {a["titel"]}' + (f' ({extra})' if extra else '')))
        dh, dt = lijst(lang(d).capitalize() if week else '', items)
        if not week:
            dh = dh.replace('<p><b></b></p>', '')
            dt = dt.lstrip('\n')
        h, t = h + dh, t + dt
    return h, t


def bouw(data):
    vandaag = iso(data['datum'])
    maandag, vrijdag = vandaag.weekday() == 0, vandaag.weekday() == 4
    g = deel_taken_in(data.get('taken', []), vandaag)
    antw, wacht, actie = (data.get(k, []) for k in ('mail_antwoord', 'mail_wacht', 'mail_actie'))

    afspraken = [a for a in data.get('agenda', []) if iso(a.get('dag')) == vandaag]
    delen = []
    if afspraken:    delen.append(f'{len(afspraken)} {"afspraak" if len(afspraken) == 1 else "afspraken"}')
    if g['vandaag']: delen.append(f'{len(g["vandaag"])} {"taak" if len(g["vandaag"]) == 1 else "taken"} vandaag')
    if g['te_laat']: delen.append(f'{len(g["te_laat"])} te laat')
    if antw:         delen.append(f'{len(antw)} {"mail wacht" if len(antw) == 1 else "mails wachten"}')
    soort = 'Week' if maandag else ('Terugblik' if vrijdag else 'Ochtend')
    onderwerp = f'{soort} · {kort(vandaag)} · {", ".join(delen) or "rustige dag"}'

    h = f'<p>Goedemorgen Kees, {e(lang(vandaag))}.</p>'
    t = f'Goedemorgen Kees, {lang(vandaag)}.\n\n'
    if data.get('opening'):
        h += f'<p>{e(data["opening"])}</p>'
        t += f'{data["opening"]}\n\n'

    ah, at = agenda(data.get('agenda', []), vandaag, maandag)
    h, t = h + ah, t + at

    def taak(x, rechts=''):
        return (link(x['titel'], x.get('url')) + (f' — {e(rechts)}' if rechts else ''),
                x['titel'] + (f' ({rechts})' if rechts else ''))

    blokken = [lijst('Te laat', [taak(x, f'{dagen((vandaag - iso(x["due"])).days)} te laat') for x in g['te_laat']]),
               lijst('Vandaag', [taak(x) for x in g['vandaag']]),
               lijst('Komende dagen', [taak(x, kort(iso(x['due']))) for x in g['week']]),
               lijst('Belangrijk, zonder datum', [taak(x) for x in g['hoog']]),
               lijst('Blijft liggen', [taak(x, f'{dagen(x["oud"])} oud') for x in g['liggen']])]
    h += '<h3>Taken</h3>' + (''.join(b[0] for b in blokken) or '<p>Geen taken met een datum.</p>')
    t += 'TAKEN\n' + (''.join(b[1] for b in blokken) or 'Geen taken met een datum.\n\n')

    if data.get('uitgezocht'):
        uh, ut = lijst('', [(link(u['titel'], u.get('url')) + f'<br>{e(u.get("antwoord"))}',
                             f'{u["titel"]}: {u.get("antwoord", "")}') for u in data['uitgezocht']])
        h += '<h3>Uitgezocht</h3>' + uh.replace('<p><b></b></p>', '')
        t += 'UITGEZOCHT\n' + ut.lstrip('\n')

    def mail(m, wie):
        sinds = iso(m.get('sinds'))
        leeftijd = '' if not sinds else ('vandaag' if sinds == vandaag else dagen((vandaag - sinds).days))
        sub = ', '.join(x for x in (m.get(wie), m.get('waarom'), leeftijd) if x)
        return (link(m.get('onderwerp') or '(geen onderwerp)', m.get('link')) + grijs(sub),
                (m.get('onderwerp') or '(geen onderwerp)') + (f' ({sub})' if sub else ''))

    if antw or wacht or actie:
        blokken = [lijst('Actie nodig', [mail(m, 'van') for m in actie]),
                   lijst('Wacht op jouw antwoord', [mail(m, 'van') for m in antw]),
                   lijst('Jij wacht op antwoord', [mail(m, 'aan') for m in wacht])]
        h += '<h3>Mail</h3>' + ''.join(b[0] for b in blokken)
        t += 'MAIL\n' + ''.join(b[1] for b in blokken)

    if vrijdag:
        af = [(e(x['titel']) + grijs(kort(iso(x['op'])) if x.get('op') else ''), x['titel'])
              for x in data.get('afgerond', [])]
        fh, ft = lijst('Afgevinkt', af)
        h += '<h3>Deze week</h3>' + (fh or '<p>Deze week niets afgevinkt.</p>')
        t += 'DEZE WEEK\n' + (ft or 'Deze week niets afgevinkt.\n\n')

    if data.get('storingen'):
        h += f'<p style="{GRIJS}">Let op: {e(" ".join(data["storingen"]))}</p>'
        t += 'Let op: ' + ' '.join(data['storingen']) + '\n'

    h = f'<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;max-width:600px">{h}</div>'
    return onderwerp, h, t.rstrip() + '\n'


def main():
    bron = Path(sys.argv[1] if len(sys.argv) > 1 else 'data.json')
    onderwerp, h, t = bouw(json.loads(bron.read_text(encoding='utf-8')))
    (bron.parent / 'overzicht.html').write_text(h, encoding='utf-8')
    (bron.parent / 'overzicht.txt').write_text(t, encoding='utf-8')
    (bron.parent / 'onderwerp.txt').write_text(onderwerp, encoding='utf-8')
    print(onderwerp)


if __name__ == '__main__':
    main()
