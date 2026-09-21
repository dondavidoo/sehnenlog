// Logik-Tests für Sehnenlog: node --test test/
// Jeder Block lädt das Modul frisch (eigener Speicher) und stellt die Uhr auf einen festen Tag.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './extract.mjs';

const T = '2026-09-21';                      // „heute“ in allen Tests
const clock = () => new Date(T + 'T10:00:00');

async function fresh(state) {
  const app = await loadApp();
  app._test.setNow(clock);
  app._test.setState(state || {});
  return app;
}
const day = (app, n) => app.addDays(T, n);   // n Tage relativ zu heute
const entry = (date, painDuring, extra) => ({ id: 'e' + date + (extra && extra.time || ''), date, time: '10:00', type: 'lauf', details: { min: '30' }, painDuring, ...extra });

describe('Datum', () => {
  test('addDays rechnet über Zeitumstellung und Jahreswechsel', async () => {
    const app = await fresh();
    assert.equal(app.addDays('2026-03-28', 1), '2026-03-29');
    assert.equal(app.addDays('2026-10-24', 1), '2026-10-25');
    assert.equal(app.addDays('2025-12-31', 1), '2026-01-01');
    assert.equal(app.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(app.daysBetween('2026-03-28', '2026-03-30'), 2);
  });
  test('isIsoDate verlangt Muster und Kalender', async () => {
    const app = await fresh();
    assert.equal(app.isIsoDate('2026-09-21'), true);
    assert.equal(app.isIsoDate('2026-13-01'), false);
    assert.equal(app.isIsoDate('2026-02-30'), false);
    assert.equal(app.isIsoDate(''), false);
    assert.equal(app.isIsoDate(20260921), false);
  });
  test('relDay und dayLabel', async () => {
    const app = await fresh();
    assert.equal(app.relDay(T), 'heute');
    assert.equal(app.relDay(day(app, -1)), 'gestern');
    assert.equal(app.dayLabel(T), 'Heute · Mo, 21.9.');
    assert.equal(app.dayLabel(day(app, -1)), 'Gestern · So, 20.9.');
    assert.equal(app.dayLabel(day(app, -2)), 'Sa, 19.9.');
  });
});

describe('Umzug alter Daten und Import-Prüfung', () => {
  test('v3: Morgenwert am Training vom Vortag wird zum Morgen des Folgetags', async () => {
    const app = await fresh();
    const n = app.normalize({ entries: [
      { id: 'a', date: '2026-09-10', time: '18:00', type: 'lauf', painDuring: 1, painMorning: 2, stiffness: '15bis30' },
      { id: 'b', date: '2026-09-12', time: '18:00', type: 'lauf', painDuring: 1, skipped: true },
      { id: 'kaputt', time: '18:00' }
    ], rest: [{ id: 'r1', date: '2026-09-14', pain: 1, stiff: 'unter15' }, { id: 'r2', date: '2026-09-11', pain: 5, stiff: 'ueber45' }, { id: 'r3', date: '2026-09-15' }] });
    assert.equal(n.legacy, true);
    assert.equal(n.entries.length, 2);
    assert.equal(n.dropped, 2);   // Einheit ohne Datum, Morgen ohne Wert
    const m = Object.fromEntries(n.mornings.map(x => [x.date, x]));
    assert.equal(m['2026-09-11'].pain, 2);                    // der Morgen-Check gewinnt
    assert.match(m['2026-09-11'].note, /zweiter Eintrag: Schmerz 5, Sehne steif über 45 Min\./);
    assert.equal(n.doppelt, 1);
    assert.equal(m['2026-09-13'].skipped, true);
    assert.equal(m['2026-09-14'].pain, 1);
    assert.deepEqual(n.tests, []);
  });
  test('v4 mit Monatstests: ungültige Zeilen werden gezählt, nicht übernommen', async () => {
    const app = await fresh();
    const n = app.normalize({ v: 4, entries: [], mornings: [{ date: '2026-09-20', pain: 1, stiff: 'unter15' }],
      tests: [{ date: '2026-09-01', right: 18, left: 24 }, { date: '2026-13-01', right: 1, left: 1 }, { date: '2026-09-02', right: 'x', left: 2 }] });
    assert.equal(n.tests.length, 1);
    assert.equal(n.dropped, 2);
    assert.equal(n.tests[0].id, 't2026-09-01');
  });
  test('cleanEntry bringt Fremddaten auf die erwarteten Typen', async () => {
    const app = await fresh();
    const c = app.cleanEntry({ id: 42, date: '2026-09-20', time: '18:00" autofocus onfocus="x', type: 'kraft', painDuring: 11, effort: '7',
      details: { ex: { a1: { sets: 3, reps: '12', weight: null }, a2: null }, min: 5 } });
    assert.equal(c.id, '42');
    assert.equal(c.time, '');
    assert.equal(c.painDuring, null);
    assert.equal(c.effort, null);
    assert.deepEqual(c.details.ex.a1, { sets: '3', reps: '12', weight: '' });
    assert.equal('a2' in c.details.ex, false);
    assert.equal(c.details.min, '5');
  });
  test('normalize lehnt Unbrauchbares ab', async () => {
    const app = await fresh();
    assert.equal(app.normalize(null), null);
    assert.equal(app.normalize({ foo: 1 }), null);
    assert.equal(app.normalize('text'), null);
  });
});

describe('Urteil (assess)', () => {
  // Drei ruhige Trainingstage mit Morgen danach, jeweils zwei Tage Abstand
  function calmDays(app, opts = {}) {
    const entries = [], mornings = [];
    [-6, -4, -2].forEach((n, i) => {
      entries.push(entry(day(app, n), opts.pain ?? 1, { type: 'kraft', effort: opts.effort ?? 8, progressed: opts.progressedAt === i }));
      mornings.push(app.makeMorning(day(app, n + 1), opts.morning ? opts.morning[i] : 1, opts.stiff ? opts.stiff[i] : 'unter15', ''));
    });
    return { entries, mornings };
  }
  test('1 – ohne Daten: zu wenig Daten', async () => {
    const app = await fresh();
    assert.equal(app.assess().word, 'Noch zu wenig Daten');
  });
  test('2 – ein bewerteter Tag: zu wenig Daten', async () => {
    const app = await fresh();
    app._test.setState({ entries: [entry(day(app, -2), 1)], mornings: [app.makeMorning(day(app, -1), 1, 'unter15', '')] });
    assert.equal(app.assess().word, 'Noch zu wenig Daten');
    assert.equal(app.assess().kicker, '1 von 2 bewerteten Trainingstagen');
  });
  test('3 – Training gestern ohne Morgen heute: Morgen-Check offen', async () => {
    const app = await fresh();
    app._test.setState({ entries: [entry(day(app, -3), 1), entry(day(app, -1), 1)], mornings: [app.makeMorning(day(app, -2), 1, 'unter15', '')] });
    assert.equal(app.assess().word, 'Morgen-Check offen');
    assert.equal(app.pending().length, 1);
  });
  test('4 – ein offener Morgen älter als drei Tage blockiert nicht mehr', async () => {
    const app = await fresh();
    const s = calmDays(app);
    s.entries.push(entry(day(app, -10), 1));   // Morgen vom Tag -9 fehlt
    app._test.setState(s);
    assert.equal(app.pending().length, 1);
    assert.notEqual(app.assess().word, 'Morgen-Check offen');
  });
  test('5 – übersprungener Morgen zählt nicht als offen', async () => {
    const app = await fresh();
    app._test.setState({ entries: [entry(day(app, -1), 1)], mornings: [app.skippedMorning(T)] });
    assert.equal(app.pending().length, 0);
    assert.equal(app.assess().word, 'Noch zu wenig Daten');
  });
  test('6 – Schmerz während über 3: Zurücknehmen', async () => {
    const app = await fresh();
    const s = calmDays(app); s.entries[2].painDuring = 4;
    app._test.setState(s);
    const a = app.assess();
    assert.equal(a.word, 'Zurücknehmen');
    assert.match(a.reasons[0], /4\/10 – über der 3\/10-Grenze/);
  });
  test('7 – Morgenschmerz +2: Zurücknehmen, +1: Level halten', async () => {
    const app = await fresh();
    app._test.setState(calmDays(app, { morning: [1, 1, 3] }));
    assert.equal(app.assess().word, 'Zurücknehmen');
    app._test.setState(calmDays(app, { morning: [1, 1, 2] }));
    const a = app.assess();
    assert.equal(a.word, 'Level halten');
    assert.match(a.reasons[0], /um einen Punkt gestiegen \(1 → 2\)/);
  });
  test('8 – Steifigkeit über 45 Min.: Zurücknehmen, 30–45: Level halten', async () => {
    const app = await fresh();
    app._test.setState(calmDays(app, { stiff: ['unter15', 'unter15', 'ueber45'] }));
    assert.equal(app.assess().word, 'Zurücknehmen');
    app._test.setState(calmDays(app, { stiff: ['unter15', 'unter15', '30bis45'] }));
    assert.equal(app.assess().word, 'Level halten');
  });
  test('9 – drei ruhige Tage, Steigerung vor 4 Tagen: Level halten bis die Woche um ist', async () => {
    const app = await fresh();
    app._test.setState(calmDays(app, { progressedAt: 1 }));   // Tag -4
    const a = app.assess();
    assert.equal(a.word, 'Level halten');
    assert.match(a.kicker, /Woche ist noch nicht um/);
    assert.match(a.todo, /Noch 3 Tage/);
  });
  test('10 – drei ruhige Tage ohne Steigerung: Steigern', async () => {
    const app = await fresh();
    app._test.setState(calmDays(app));
    const a = app.assess();
    assert.equal(a.word, 'Steigern');
    assert.equal(a.reasons.length, 1);   // Anstrengung 8 ist kein Grund
  });
  test('11 – ruhig und letzter Satz höchstens 6: Steigern mit Hinweis „zu leicht“', async () => {
    const app = await fresh();
    app._test.setState(calmDays(app, { effort: 5 }));
    const a = app.assess();
    assert.equal(a.word, 'Steigern');
    assert.match(a.reasons[1], /höchstens 5\/10 an – das ist zu leicht/);
  });
  test('12 – nur zwei ruhige Tage: Level halten (Standard)', async () => {
    const app = await fresh();
    const s = calmDays(app); s.entries.shift(); s.mornings.shift();
    app._test.setState(s);
    const a = app.assess();
    assert.equal(a.word, 'Level halten');
    assert.match(a.reasons[0], /noch keine drei durchgehend ruhigen/);
  });
  test('13 – Steigerung mit Zukunftsdatum ergibt keine negativen Tage', async () => {
    const app = await fresh();
    const s = calmDays(app); s.entries.push(entry(day(app, 3), 1, { progressed: true })); s.mornings.push(app.makeMorning(day(app, 4), 1, 'unter15', ''));
    app._test.setState(s);
    assert.doesNotMatch(app.assess().todo + app.assess().reasons.join(' '), /vor -\d/);
  });
  test('Schmerz während ohne Wert zählt nicht als ruhig', async () => {
    const app = await fresh();
    const s = calmDays(app); s.entries[1].painDuring = null;
    app._test.setState(s);
    assert.equal(app.assess().word, 'Level halten');
  });
});

describe('Warnzeichen', () => {
  test('drei Morgen ab 6/10 in drei Wochen', async () => {
    const app = await fresh();
    app._test.setState({ mornings: [-20, -10, -1].map(n => app.makeMorning(day(app, n), 6, 'unter15', '')) });
    assert.equal(app.redFlags().length, 1);
    app._test.setState({ mornings: [-25, -10, -1].map(n => app.makeMorning(day(app, n), 6, 'unter15', '')) });
    assert.equal(app.redFlags().length, 0);   // einer liegt außerhalb des Fensters
  });
  test('Monatstest: rechts null Wiederholungen oder deutlicher Einbruch', async () => {
    const app = await fresh();
    app._test.setState({ tests: [app.makeTest(day(app, -40), 20, 25, ''), app.makeTest(day(app, -5), 13, 25, '')] });
    assert.match(app.testFlags()[0], /von 20 auf 13 gefallen/);
    app._test.setState({ tests: [app.makeTest(day(app, -5), 0, 25, '')] });
    assert.match(app.testFlags()[0], /kein einbeiniges Wadenheben/);
    app._test.setState({ tests: [app.makeTest(day(app, -40), 20, 25, ''), app.makeTest(day(app, -5), 15, 25, '')] });
    assert.deepEqual(app.testFlags(), []);   // 25 % weniger ist noch kein Warnzeichen
    app._test.setState({ tests: [app.makeTest(day(app, -60), 0, 25, '')] });
    assert.deepEqual(app.testFlags(), []);   // zu alt
  });
  test('Monatstest fällig: nach 30 Tagen, der erste nach zwei Wochen Daten', async () => {
    const app = await fresh();
    assert.equal(app.testDue(), false);
    app._test.setState({ mornings: [app.makeMorning(day(app, -13), 1, 'unter15', '')] });
    assert.equal(app.testDue(), false);
    app._test.setState({ mornings: [app.makeMorning(day(app, -14), 1, 'unter15', '')] });
    assert.equal(app.testDue(), true);
    app._test.setState({ tests: [app.makeTest(day(app, -29), 18, 24, '')] });
    assert.equal(app.testDue(), false);
    app._test.setState({ tests: [app.makeTest(day(app, -30), 18, 24, '')] });
    assert.equal(app.testDue(), true);
  });
});

describe('Speichern, Sicherung, Import', () => {
  test('save legt den Vorgängerstand ab; Import ergänzt und ersetzt, „übersprungen“ überschreibt keinen Wert', async () => {
    const app = await fresh();
    app._test.setState({ entries: [entry(day(app, -2), 1)], mornings: [app.makeMorning(day(app, -1), 2, 'unter15', '')] });
    await app.save();
    assert.ok(app.__dom.store.get('sehnenlog.local:' + app.KEY));
    const prev = await app.readSnapshot(app.KEY_PREV);
    assert.equal(prev, null);   // vor dem ersten Speichern gab es nichts
    await app.applyBackup(JSON.stringify({ v: 4,
      entries: [entry(day(app, -2), 3), entry(day(app, -4), 1)],
      mornings: [app.skippedMorning(day(app, -1)), app.makeMorning(day(app, -3), 1, 'unter15', '')],
      tests: [{ date: day(app, -10), right: 18, left: 24 }] }));
    assert.equal(app.state.entries.length, 2);
    assert.equal(app.state.entries.find(e => e.date === day(app, -2)).painDuring, 3);
    assert.equal(app.morningOf(day(app, -1)).pain, 2);       // nicht durch „übersprungen“ ersetzt
    assert.equal(app.state.mornings.length, 2);
    assert.equal(app.state.tests.length, 1);
    const prev2 = await app.readSnapshot(app.KEY_PREV);
    assert.equal(prev2.entries.length, 1);                     // Stand vor dem Import
    const payload = JSON.parse(app.backupPayload());
    assert.equal(payload.tests.length, 1);
    assert.equal(payload.v, 4);
  });
  test('load übernimmt einen v3-Stand und lässt den alten Schlüssel liegen', async () => {
    const app = await fresh();
    app.__dom.store.set('sehnenlog.local:sehnenlog:v3', JSON.stringify({ entries: [{ id: 'a', date: '2026-09-10', time: '18:00', type: 'lauf', painDuring: 1, painMorning: 2, stiffness: 'unter15' }], rest: [] }));
    await app.load();
    assert.equal(app.state.entries.length, 1);
    assert.equal(app.morningOf('2026-09-11').pain, 2);
    assert.ok(app.state.migrationNote);
    assert.ok(app.__dom.store.get('sehnenlog.local:sehnenlog:v3'));
    assert.ok(app.__dom.store.get('sehnenlog.local:' + app.KEY));
  });
  test('ein unlesbarer Import verändert nichts', async () => {
    const app = await fresh();
    app._test.setState({ entries: [entry(day(app, -2), 1)] });
    await app.applyBackup('{"entries": [ kaputt');
    assert.equal(app.state.entries.length, 1);
    await app.applyBackup('');
    assert.equal(app.state.entries.length, 1);
  });
  test('Sicherung wird nach einer Woche Daten fällig', async () => {
    const app = await fresh();
    app._test.setState({ mornings: [app.makeMorning(day(app, -3), 1, 'unter15', '')] });
    assert.equal(app.backupFaellig(), false);
    app._test.setState({ mornings: [app.makeMorning(day(app, -7), 1, 'unter15', '')] });
    assert.equal(app.backupFaellig(), true);
  });
});

describe('Texte und Formular', () => {
  test('summary und Zuletzt je Übung', async () => {
    const app = await fresh();
    const e = { id: 'k1', date: day(app, -3), time: '10:00', type: 'kraft', painDuring: 1, details: { ex: { a1: { sets: '3', reps: '12', weight: '15' }, iso1: { sets: '5', reps: '45', weight: '' } } } };
    app._test.setState({ entries: [e] });
    assert.equal(app.summary(e), 'Wadenheben, gestrecktes Knie 3× 12 Wdh. 15 kg · Wadenheben halten 5× 45 Sek.');
    assert.deepEqual(app.lastExUse('a1'), { date: day(app, -3), sets: '3', reps: '12', weight: '15' });
    assert.equal(app.lastExUse('b1'), null);
    app._test.setDraft(app.draftFromEntry(e), 'k1');
    assert.equal(app.lastExUse('a1'), null);   // die bearbeitete Einheit zählt nicht als „zuletzt“
    assert.deepEqual(app.doseParts('4 × 10 · Tempo 3/3'), { sets: '4', reps: '10' });
    assert.deepEqual(app.doseParts('3 × 10–15 · je 5 Sek. halten'), { sets: '3', reps: '10–15' });
  });
  test('draftIsEmpty erkennt angefangene Entwürfe', async () => {
    const app = await fresh();
    const d = app.newDraft();
    assert.equal(app.draftIsEmpty(d), true);
    d.run.min = '30';
    assert.equal(app.draftIsEmpty(d), false);
  });
  test('collagenGap warnt nicht vor der eigenen Dosis', async () => {
    const app = await fresh();
    const e = { id: 'k', date: T, time: '10:00', type: 'kraft', painDuring: 1, collagen: true, details: {} };
    app._test.setState({ entries: [e] });
    const d = app.draftFromEntry(e); d.time = '11:30';
    app._test.setDraft(d, 'k');
    assert.equal(app.collagenGap(), null);
    app._test.setDraft(d, null);
    assert.ok(app.collagenGap() < 6);
  });
  test('Export kürzt auf 30 Tage und sagt es', async () => {
    const app = await fresh();
    app._test.setState({ mornings: Array.from({ length: 40 }, (_, i) => app.makeMorning(day(app, -i), 1, 'unter15', '')) });
    const x = app.buildExport();
    assert.match(x, /Gekürzt auf die letzten 30 Tage mit Einträgen \(von 40\)/);
    assert.equal(x.split('\n').filter(l => /^[A-Za-z]{2}, \d+\.\d+\./.test(l)).length, 30);
  });
  test('Logbuch baut sich ohne Fehler auf – mit Monatstest im Verlauf und in der Übersicht', async () => {
    const app = await fresh();
    app._test.setState({ entries: [entry(day(app, -2), 1)], mornings: [app.makeMorning(day(app, -1), 1, 'unter15', '')], tests: [app.makeTest(day(app, -2), 18, 24, 'Rucksack')] });
    app.render();
    const html = app.__dom.root.innerHTML;
    assert.doesNotMatch(html, /konnte nicht aufgebaut/);
    assert.match(html, /rechts 18 · links 24 · rechts 6 weniger \(75 % von links\)/);
    assert.match(html, /zuletzt 19\.9\.: rechts 18, links 24/);
    assert.match(html, /data-act="openTest"/);
    assert.doesNotMatch(html, /class="del"/);   // kein Lösch-× in den Zeilen
    for (const t of ['plan', 'ex', 'supp', 'scale', 'data']) { app._test.setTab(t); app.render(); assert.doesNotMatch(app.__dom.root.innerHTML, /konnte nicht aufgebaut/, t); }
  });
});
