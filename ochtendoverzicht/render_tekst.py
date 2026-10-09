#!/usr/bin/env python3
"""render_tekst.py — maakt het ochtendoverzicht als gewone tekst (geen HTML, geen weer).

    python3 render_tekst.py data.json   schrijft overzicht.txt en onderwerp.txt
"""

import json
import sys
from datetime import timedelta
from pathlib import Path

from render import deel_taken_in, dagen, iso, kort, lang

BREED = 44
LIJN = '─' * BREED


def kop(titel):
    return f'\n{titel.upper()}\n{LIJN}'


def taakregel(t, rechts=''):
    plek = ' · '.join(x for x in (t.get('project'), t.get('sectie')) if x)
    hoog = ' [HOOG]' if t.get('prioriteit') == 'p1' else ''
    regel = f'• {t["titel"]}{hoog}' + (f'  ({rechts})' if rechts else '')
    if plek:
        regel += f'\n    {plek}'
    if t.get('url'):
        regel += f'\n    {t["url"]}'
    return regel


def groep(naam, regels):
    return f'\n{naam} ({len(regels)})\n' + '\n'.join(regels) + '\n' if regels else ''


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
    if not per_dag:
        return kop('Agenda deze week' if week else 'Agenda vandaag') + \
            f'\n{"Geen afspraken deze week." if week else "Geen afspraken vandaag."}\n'
    uit = kop('Agenda deze week' if week else 'Agenda vandaag') + '\n'
    for d in sorted(per_dag):
        if week:
            uit += f'\n{lang(d).capitalize()}\n'
        for a in sorted(per_dag[d], key=lambda a: (not a.get('hele_dag'), a.get('start') or '')):
            tijd = 'hele dag' if a.get('hele_dag') else (a.get('start') or '') + (f'–{a["eind"]}' if a.get('eind') else '')
            extra = [x for x in (a.get('locatie'),
                                 'overlapt met een andere afspraak' if a.get('overlap') else '',
                                 'uit je mail, staat niet in je agenda' if a.get('bron') == 'mail' else '') if x]
            uit += f'{tijd:<12}{a["titel"]}' + (f'  [{"; ".join(extra)}]' if extra else '') + '\n'
    return uit


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

    t = f'Goedemorgen Kees, {lang(vandaag)}\n'
    if data.get('opening'):
        t += f'\n{data["opening"]}\n'

    t += agenda(data.get('agenda', []), vandaag, maandag)

    taken = (groep('Te laat', [taakregel(x, f'{dagen((vandaag - iso(x["due"])).days)} te laat') for x in g['te_laat']]) +
             groep('Vandaag', [taakregel(x) for x in g['vandaag']]) +
             groep('Komende zeven dagen', [taakregel(x, kort(iso(x['due']))) for x in g['week']]) +
             groep('Hoge prioriteit, geen datum', [taakregel(x) for x in g['hoog']]) +
             groep('Blijft liggen', [taakregel(x, f'{dagen(x["oud"])} oud') for x in g['liggen']]))
    t += kop('Taken') + '\n' + (taken or '\nGeen taken met een datum.\n') + \
        '\nTodoist: https://app.todoist.com/app/today\n'

    if data.get('uitgezocht'):
        t += kop('Uitgezocht') + '\n'
        for u in data['uitgezocht']:
            t += f'\n• {u["titel"]}\n    {u.get("antwoord", "")}\n    {u.get("url", "")}\n'

    def mailregel(m, wie):
        sinds = iso(m.get('sinds'))
        leeftijd = '' if not sinds else ('vandaag' if sinds == vandaag else dagen((vandaag - sinds).days))
        sub = ' · '.join(x for x in (m.get(wie), m.get('waarom')) if x)
        r = f'• {m.get("onderwerp") or "(geen onderwerp)"}' + (f'  ({leeftijd})' if leeftijd else '')
        if sub:
            r += f'\n    {sub}'
        if m.get('link'):
            r += f'\n    {m["link"]}'
        return r

    if antw or wacht or actie:
        t += kop('Mail') + '\n' + \
            groep('Actie nodig', [mailregel(m, 'van') for m in actie]) + \
            groep('Wacht op jouw antwoord', [mailregel(m, 'van') for m in antw]) + \
            groep('Jij wacht op antwoord', [mailregel(m, 'aan') for m in wacht])

    if vrijdag:
        af = [f'• {x["titel"]}' + (f'  ({kort(iso(x["op"]))})' if x.get('op') else '') for x in data.get('afgerond', [])]
        t += kop('Afgerond deze week') + '\n' + (groep('Gedaan', af) or '\nDeze week niets afgevinkt.\n')

    if data.get('storingen'):
        t += '\nLet op: ' + ' '.join(data['storingen']) + '\n'
    return onderwerp, t.rstrip() + '\n'


def main():
    bron = Path(sys.argv[1] if len(sys.argv) > 1 else 'data.json')
    onderwerp, tekst = bouw(json.loads(bron.read_text(encoding='utf-8')))
    (bron.parent / 'overzicht.txt').write_text(tekst, encoding='utf-8')
    (bron.parent / 'onderwerp.txt').write_text(onderwerp, encoding='utf-8')
    print(onderwerp)


if __name__ == '__main__':
    main()
