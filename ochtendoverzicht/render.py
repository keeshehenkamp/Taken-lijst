#!/usr/bin/env python3
"""render.py — maakt het ochtendoverzicht in een vaste opmaak.

De routine verzamelt de gegevens (agenda, taken, mail) in data.json; dit script
deelt ze in en bouwt de HTML. Zo ziet het overzicht er elke dag hetzelfde uit,
ongeacht wat het taalmodel die ochtend doet.

    python3 render.py data.json      schrijft overzicht.html en onderwerp.txt
    python3 render.py voorbeeld.json  idem, met voorbeeldgegevens
"""

import html
import json
import re
import sys
import urllib.request
from datetime import date, timedelta
from pathlib import Path

DAGEN   = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag']
MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli',
           'augustus', 'september', 'oktober', 'november', 'december']

FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
K = dict(tekst='#1A1D21', zacht='#667085', lijn='#E4E7EC', vlak='#F2F4F7',
         rood='#D92D20', oranje='#DC6803', groen='#079455', blauw='#1570EF')

TODOIST_URL = 'https://app.todoist.com/app/today'
WEER_PLAATS = 'Amsterdam'

storingen = []


# ── Datum ───────────────────────────────────────────────────────

def lang(d):
    return f'{DAGEN[d.weekday()]} {d.day} {MAANDEN[d.month - 1]}'

def kort(d):
    return f'{DAGEN[d.weekday()][:2]} {d.day} {MAANDEN[d.month - 1][:3]}'

def iso(s):
    return date.fromisoformat(s[:10]) if s else None

def dagen(n):
    return f'{n} {"dag" if n == 1 else "dagen"}'

def esc(s):
    return html.escape(str(s or ''), quote=True)


# ── Indelen ─────────────────────────────────────────────────────

PRIO = {'p1': 0, 'p2': 1, 'p3': 2, 'p4': 3}

def deel_taken_in(taken, vandaag):
    """Verdeelt open taken over vaste groepen. Elke taak komt in één groep."""
    week_eind = vandaag + timedelta(days=7)
    op_prio   = lambda t: (PRIO.get(t.get('prioriteit'), 3), t['titel'].lower())

    te_laat, nu, week, hoog, liggen = [], [], [], [], []
    for t in taken:
        due = iso(t.get('due'))
        if due and due < vandaag:
            te_laat.append(t)
        elif due == vandaag:
            nu.append(t)
        elif due and due <= week_eind:
            week.append(t)
        elif not due and t.get('prioriteit') in ('p1', 'p2'):
            hoog.append(t)
        elif not due and t.get('aangemaakt'):
            oud = (vandaag - iso(t['aangemaakt'])).days
            if oud >= 14:
                liggen.append({**t, 'oud': oud})

    te_laat.sort(key=lambda t: (t['due'], *op_prio(t)))
    week.sort(key=lambda t: (t['due'], *op_prio(t)))
    liggen.sort(key=lambda t: -t['oud'])
    return dict(te_laat=te_laat, vandaag=sorted(nu, key=op_prio), week=week,
                hoog=sorted(hoog, key=op_prio), liggen=liggen[:4])


# ── Weer ────────────────────────────────────────────────────────

def weer_icoon(code):
    code = int(code)
    if code == 113: return '☀️'
    if code == 116: return '⛅'
    if code in (119, 122): return '☁️'
    if code in (143, 248, 260): return '🌫️'
    if code in (200, 386, 389, 392, 395): return '⛈️'
    if code in (179, 182, 185, 227, 230, 281, 284, 311, 314, 317, 320, 323, 326,
                329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377): return '🌨️'
    return '🌧️'

def haal_weer():
    try:
        url = f'https://wttr.in/{WEER_PLAATS}?format=j1&lang=nl'
        with urllib.request.urlopen(url, timeout=8) as r:
            data = json.load(r)
        nu, dag = data['current_condition'][0], data['weather'][0]
        uur = {int(h['time']): h for h in dag.get('hourly', [])}
        delen = [dict(naam=naam, icoon=weer_icoon(uur[t]['weatherCode']), temp=uur[t]['tempC'],
                      regen=int(uur[t]['chanceofrain']))
                 for naam, t in (('Ochtend', 900), ('Middag', 1500), ('Avond', 2100)) if t in uur]
        beschrijving = (nu.get('lang_nl') or nu['weatherDesc'])[0]['value']
        return dict(icoon=weer_icoon(nu['weatherCode']), beschrijving=beschrijving, temp=nu['temp_C'],
                    min=dag['mintempC'], max=dag['maxtempC'], wind=nu['windspeedKmph'], delen=delen)
    except Exception as e:
        storingen.append(f'Weer ophalen mislukt ({e.__class__.__name__}).')
        return None


# ── Bouwstenen ──────────────────────────────────────────────────

def kaart(inhoud):
    return f'''
  <tr><td style="padding:0 0 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#FFFFFF;border:1px solid {K['lijn']};border-radius:12px;">
      <tr><td style="padding:22px 24px;">{inhoud}</td></tr>
    </table>
  </td></tr>'''

def sectie_kop(titel, rechts=''):
    return f'''
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font:700 12px {FONT};letter-spacing:1.2px;text-transform:uppercase;color:{K['zacht']};">{titel}</td>
      <td align="right" style="font:400 12px {FONT};color:{K['zacht']};">{rechts}</td>
    </tr></table>'''

def groep(kop, kleur, rijen):
    """rijen: lijst van (titel_html, rechts_tekst, rechts_kleur)."""
    if not rijen:
        return ''
    regels = ''.join(f'''
      <tr>
        <td style="padding:9px 0;border-top:1px solid {K['lijn']};font:400 16px/1.4 {FONT};color:{K['tekst']};">{titel}</td>
        <td align="right" valign="top" style="padding:11px 0 9px 12px;border-top:1px solid {K['lijn']};
            font:400 13px {FONT};color:{rkleur or K['zacht']};white-space:nowrap;">{esc(rechts)}</td>
      </tr>''' for titel, rechts, rkleur in rijen)
    return f'''
    <p style="margin:18px 0 6px;font:700 15px {FONT};color:{K['tekst']};">
      <span style="color:{kleur};">●</span>&nbsp; {kop}
      <span style="font-weight:400;color:{K['zacht']};">&nbsp;{len(rijen)}</span>
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{regels}
    </table>'''

def taak_titel(t):
    plek = ' · '.join(x for x in (t.get('project'), t.get('sectie')) if x)
    prio = (f' <span style="font:700 11px {FONT};color:{K["rood"]};">&nbsp;HOOG</span>'
            if t.get('prioriteit') == 'p1' else '')
    titel = esc(t['titel'])
    if t.get('url'):
        titel = f'<a href="{esc(t["url"])}" style="color:{K["tekst"]};text-decoration:none;">{titel}</a>'
    sub = f'<div style="font:400 12px {FONT};color:{K["zacht"]};margin-top:2px;">{esc(plek)}</div>' if plek else ''
    return f'{titel}{prio}{sub}'


def afspraak_labels(a):
    regels = []
    if a.get('locatie'):
        regels.append(f'<span style="color:{K["zacht"]};">{esc(a["locatie"])}</span>')
    if a.get('overlap'):
        regels.append(f'<span style="color:{K["rood"]};font-weight:600;">Overlapt met een andere afspraak</span>')
    if a.get('bron') == 'mail':
        regels.append(f'<span style="color:{K["oranje"]};font-weight:600;">Uit je mail, staat niet in je agenda</span>')
    return ''.join(f'<div style="font:400 12px {FONT};margin-top:2px;">{r}</div>' for r in regels)


# ── Secties ─────────────────────────────────────────────────────

def agenda_sectie(items, vandaag, weekweergave):
    if weekweergave:
        eind = vandaag + timedelta(days=6)
        kop  = 'Deze week'
    else:
        eind = vandaag
        kop  = 'Agenda vandaag'
    # Dezelfde afspraak kan in twee agenda's staan; die tonen we één keer.
    per_dag, gezien = {}, set()
    for a in items:
        d = iso(a.get('dag'))
        sleutel = (a.get('dag'), a.get('start'), a.get('titel', '').strip().lower())
        if d and vandaag <= d <= eind and sleutel not in gezien:
            gezien.add(sleutel)
            per_dag.setdefault(d, []).append(dict(a))

    # Overlap binnen een dag markeren (alleen afspraken met een tijd).
    for rijen in per_dag.values():
        getimed = sorted((a for a in rijen if not a.get('hele_dag') and a.get('start')), key=lambda a: a['start'])
        for i, a in enumerate(getimed):
            for b in getimed[i + 1:]:
                if b['start'] < (a.get('eind') or a['start']):
                    a['overlap'] = b['overlap'] = True

    if not per_dag:
        leeg = 'Geen afspraken deze week.' if weekweergave else 'Geen afspraken vandaag.'
        return kaart(f'{sectie_kop(kop)}<p style="margin:14px 0 0;font:400 16px {FONT};color:{K["zacht"]};">{leeg}</p>')

    blokken = ''
    for d in sorted(per_dag):
        rijen = sorted(per_dag[d], key=lambda a: (not a.get('hele_dag'), a.get('start') or ''))
        regels = ''.join(f'''
        <tr>
          <td width="96" valign="top" style="padding:9px 0;border-top:1px solid {K['lijn']};
              font:600 14px {FONT};color:{K['blauw']};white-space:nowrap;">
            {'hele dag' if a.get('hele_dag') else esc(a.get('start')) + ('–' + esc(a.get('eind')) if a.get('eind') else '')}</td>
          <td style="padding:9px 0;border-top:1px solid {K['lijn']};font:400 16px/1.4 {FONT};color:{K['tekst']};">
            {esc(a['titel'])}{afspraak_labels(a)}
          </td>
        </tr>''' for a in rijen)
        dagkop = (f'<p style="margin:18px 0 6px;font:700 15px {FONT};color:{K["tekst"]};">'
                  f'{lang(d).capitalize()}</p>') if weekweergave else '<div style="height:12px;"></div>'
        blokken += f'{dagkop}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{regels}</table>'
    return kaart(sectie_kop(kop) + blokken)

def taken_sectie(g, vandaag):
    groepen = (
        groep('Te laat', K['rood'], [(taak_titel(t), f'{dagen((vandaag - iso(t["due"])).days)} te laat', K['rood'])
                                     for t in g['te_laat']]) +
        groep('Vandaag', K['blauw'], [(taak_titel(t), '', None) for t in g['vandaag']]) +
        groep('Komende zeven dagen', K['groen'], [(taak_titel(t), kort(iso(t['due'])), None) for t in g['week']]) +
        groep('Hoge prioriteit, geen datum', K['oranje'], [(taak_titel(t), '', None) for t in g['hoog']]) +
        groep('Blijft liggen', K['zacht'], [(taak_titel(t), f'{dagen(t["oud"])} oud', None) for t in g['liggen']])
    )
    if not groepen:
        groepen = f'<p style="margin:14px 0 0;font:400 16px {FONT};color:{K["zacht"]};">Geen taken met een datum.</p>'
    link = f'<a href="{TODOIST_URL}" style="color:{K["blauw"]};text-decoration:none;">Todoist openen</a>'
    return kaart(sectie_kop('Taken', link) + groepen)

def uitgezocht_sectie(items):
    if not items:
        return ''
    blokken = ''.join(f'''
    <div style="padding:12px 0;border-top:1px solid {K['lijn']};">
      <a href="{esc(u.get('url'))}" style="font:600 16px/1.4 {FONT};color:{K['tekst']};text-decoration:none;">{esc(u['titel'])}</a>
      <div style="margin-top:4px;font:400 15px/1.5 {FONT};color:#344054;">{esc(u.get('antwoord'))}</div>
    </div>''' for u in items)
    return kaart(sectie_kop('Uitgezocht', 'antwoord staat bij de taak') +
                 f'<div style="height:10px;"></div>{blokken}')

def mail_sectie(antwoord, wacht, actie, vandaag):
    if not antwoord and not wacht and not actie:
        return ''
    def rij(m, wie):
        titel = esc(m.get('onderwerp') or '(geen onderwerp)')
        if m.get('link'):
            titel = f'<a href="{esc(m["link"])}" style="color:{K["tekst"]};text-decoration:none;">{titel}</a>'
        sub = ' · '.join(x for x in (m.get(wie), m.get('waarom')) if x)
        sinds = iso(m.get('sinds'))
        rechts = '' if not sinds else ('vandaag' if sinds == vandaag else f'{dagen((vandaag - sinds).days)}')
        return (f'{titel}<div style="font:400 12px {FONT};color:{K["zacht"]};margin-top:2px;">{esc(sub)}</div>',
                rechts, None)
    inhoud = (groep('Actie nodig', K['rood'], [rij(m, 'van') for m in actie]) +
              groep('Wacht op jouw antwoord', K['oranje'], [rij(m, 'van') for m in antwoord]) +
              groep('Jij wacht op antwoord', K['zacht'], [rij(m, 'aan') for m in wacht]))
    return kaart(sectie_kop('Mail', 'Gmail') + inhoud)

def terugblik_sectie(afgerond):
    rijen = [(esc(t['titel']) + (f'<div style="font:400 12px {FONT};color:{K["zacht"]};margin-top:2px;">'
                                 f'{esc(t["project"])}</div>' if t.get('project') else ''),
              kort(iso(t['op'])) if t.get('op') else '', None) for t in afgerond]
    if not rijen:
        return kaart(sectie_kop('Afgerond deze week') +
                     f'<p style="margin:14px 0 0;font:400 16px {FONT};color:{K["zacht"]};">Deze week niets afgevinkt.</p>')
    return kaart(sectie_kop('Afgerond deze week') + groep('Gedaan', K['groen'], rijen))

def weer_sectie(w):
    if not w:
        return ''
    delen = ''.join(f'''
      <td align="center" width="{100 // len(w['delen'])}%"
          style="padding:12px 4px;background:{K['vlak']};border:3px solid #FFFFFF;border-radius:10px;">
        <div style="font:700 12px {FONT};color:{K['zacht']};text-transform:uppercase;letter-spacing:.8px;">{d['naam']}</div>
        <div style="font-size:28px;line-height:1.5;">{d['icoon']}</div>
        <div style="font:700 17px {FONT};color:{K['tekst']};">{d['temp']}°</div>
        <div style="font:400 12px {FONT};color:{K['blauw'] if d['regen'] >= 40 else K['zacht']};">💧 {d['regen']}%</div>
      </td>''' for d in w['delen'])
    return kaart(f'''
    {sectie_kop('Weer', WEER_PLAATS)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr>
      <td width="64" style="font-size:46px;line-height:1;">{w['icoon']}</td>
      <td>
        <div style="font:700 30px {FONT};color:{K['tekst']};">{w['temp']}°</div>
        <div style="font:400 14px {FONT};color:{K['zacht']};">{esc(w['beschrijving'])} · {w['min']}° tot {w['max']}° · wind {w['wind']} km/u</div>
      </td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr>{delen}</tr></table>''')


# ── Geheel ──────────────────────────────────────────────────────

def bouw(data):
    vandaag = iso(data['datum'])
    maandag = vandaag.weekday() == 0
    vrijdag = vandaag.weekday() == 4
    storingen.extend(data.get('storingen', []))

    g     = deel_taken_in(data.get('taken', []), vandaag)
    weer  = haal_weer() if not data.get('geen_weer') else None
    antw  = data.get('mail_antwoord', [])
    wacht = data.get('mail_wacht', [])
    actie = data.get('mail_actie', [])

    # Onderwerp en voorvertoning komen uit dezelfde telling, zodat ze altijd kloppen.
    afspraken_vandaag = [a for a in data.get('agenda', []) if iso(a.get('dag')) == vandaag]
    delen = []
    if afspraken_vandaag: delen.append(f'{len(afspraken_vandaag)} {"afspraak" if len(afspraken_vandaag) == 1 else "afspraken"}')
    if g['vandaag']:      delen.append(f'{len(g["vandaag"])} {"taak" if len(g["vandaag"]) == 1 else "taken"} vandaag')
    if g['te_laat']:      delen.append(f'{len(g["te_laat"])} te laat')
    if antw:              delen.append(f'{len(antw)} {"mail wacht" if len(antw) == 1 else "mails wachten"}')
    soort     = 'Week' if maandag else ('Terugblik' if vrijdag else 'Ochtend')
    onderwerp = f'{soort} · {kort(vandaag)} · {", ".join(delen) or "rustige dag"}'
    preheader = ' · '.join(t['titel'] for t in g['vandaag']) or data.get('opening', '')

    secties = (agenda_sectie(data.get('agenda', []), vandaag, weekweergave=maandag) +
               taken_sectie(g, vandaag) +
               uitgezocht_sectie(data.get('uitgezocht', [])) +
               mail_sectie(antw, wacht, actie, vandaag) +
               (terugblik_sectie(data.get('afgerond', [])) if vrijdag else '') +
               weer_sectie(weer))

    storing_html = (f'<tr><td style="padding:4px 8px;font:400 12px/1.5 {FONT};color:{K["oranje"]};">'
                    f'Let op: {esc(" ".join(storingen))}</td></tr>') if storingen else ''

    pagina = f'''<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:0;background:{K['vlak']};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">{esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{K['vlak']};">
  <tr><td align="center" style="padding:24px 12px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
      <tr><td style="padding:8px 8px 22px;">
        <div style="font:700 12px {FONT};letter-spacing:1.2px;text-transform:uppercase;color:{K['zacht']};">{lang(vandaag)}</div>
        <div style="margin-top:6px;font:800 28px/1.2 {FONT};color:{K['tekst']};">Goedemorgen Kees</div>
        {f'<p style="margin:10px 0 0;font:400 17px/1.55 {FONT};color:#344054;">{esc(data["opening"])}</p>' if data.get('opening') else ''}
      </td></tr>
      {secties}
      {storing_html}
    </table>
  </td></tr>
  </table>
</body>
</html>'''
    return onderwerp, pagina


def main():
    bron = Path(sys.argv[1] if len(sys.argv) > 1 else 'data.json')
    data = json.loads(bron.read_text(encoding='utf-8'))
    onderwerp, pagina = bouw(data)
    uit = bron.parent
    (uit / 'overzicht.html').write_text(pagina, encoding='utf-8')
    (uit / 'onderwerp.txt').write_text(onderwerp, encoding='utf-8')
    print(onderwerp)


if __name__ == '__main__':
    main()
