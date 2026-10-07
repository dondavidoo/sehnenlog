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

describe('Ampel (assess)', () => {
  // Drei grüne Trainingstage mit Morgen danach, jeweils zwei Tage Abstand; Morgen am Trainingstag selbst = Ausgangsniveau 1
  function calmDays(app, opts = {}) {
    const entries = [], mornings = [];
    [-6, -4, -2].forEach((n, i) => {
      entries.push(entry(day(app, n), opts.pain ?? 1, { type: 'kraft', time: '18:00', effort: opts.effort ?? 8, painAfter: opts.after ? opts.after[i] : 1, allDay: !!(opts.allDay && opts.allDay[i]), spots: ['knoechel'] }));
      mornings.push(app.makeMorning(day(app, n), 1, 'unter15', ''));
      mornings.push(app.makeMorning(day(app, n + 1), opts.morning ? opts.morning[i] : 1, opts.stiff ? opts.stiff[i] : 'unter15', ''));
    });
    return { entries, mornings };
  }
  test('1 – ohne Daten: noch keine Bewertung', async () => {
    const app = await fresh();
    assert.equal(app.assess().word, 'Noch keine Bewertung');
  });
  test('2 – ein bewerteter grüner Tag: Grün, 1 von 3', async () => {
    const app = await fresh();
    app._test.setState({ entries: [entry(day(app, -2), 1, { painAfter: 2, spots: ['knoechel'] })], mornings: [app.makeMorning(day(app, -1), 1, 'unter15', '')] });
    const a = app.assess();
    assert.equal(a.word, 'Grün');
    assert.equal(a.kicker, '1 von 3 für die nächste Steigerung');
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
    assert.equal(app.assess().word, 'Noch keine Bewertung');
  });
  test('6 – Schmerz während über 3: Rot, Stufe wiederholen', async () => {
    const app = await fresh();
    const s = calmDays(app); s.entries[2].painDuring = 4;
    app._test.setState(s);
    const a = app.assess();
    assert.equal(a.word, 'Rot – Stufe wiederholen');
    assert.match(a.reasons[0], /4\/10 – über der 3\/10-Grenze/);
  });
  test('7 – zweites Rot in sieben Tagen: eine Stufe runter', async () => {
    const app = await fresh();
    const s = calmDays(app); s.entries[1].painDuring = 5; s.entries[2].painDuring = 4;
    app._test.setState(s);
    assert.equal(app.assess().word, 'Rot – eine Stufe runter');
  });
  test('8 – Schmerz danach: 4–5 Gelb, über 5 Rot, leer kein Verstoß', async () => {
    const app = await fresh();
    app._test.setState(calmDays(app, { after: [1, 1, 4] }));
    let a = app.assess();
    assert.equal(a.word, 'Gelb – Stufe halten');
    assert.match(a.reasons[0], /danach lag bei 4\/10/);
    app._test.setState(calmDays(app, { after: [1, 1, 6] }));
    assert.equal(app.assess().word, 'Rot – Stufe wiederholen');
    app._test.setState(calmDays(app, { after: [1, 1, null] }));
    a = app.assess();
    assert.equal(a.word, 'Grün – Steigerung frei');
    assert.match(a.reasons[1], /nicht eingetragen/);
  });
  test('9 – ganztägig spürbar: Gelb', async () => {
    const app = await fresh();
    app._test.setState(calmDays(app, { allDay: [false, false, true] }));
    const a = app.assess();
    assert.equal(a.word, 'Gelb – Stufe halten');
    assert.match(a.reasons[0], /Rest des Tages/);
  });
  test('10 – Morgen +1 gegenüber dem Morgen des Trainingstags: Gelb; ab 4: Rot', async () => {
    const app = await fresh();
    app._test.setState(calmDays(app, { morning: [1, 1, 2] }));
    let a = app.assess();
    assert.equal(a.word, 'Gelb – Stufe halten');
    assert.match(a.reasons[0], /von 1 auf 2 gestiegen/);
    app._test.setState(calmDays(app, { morning: [1, 1, 3] }));
    assert.equal(app.assess().word, 'Gelb – Stufe halten');   // +2 ist kein Rot mehr
    app._test.setState(calmDays(app, { morning: [1, 1, 4] }));
    assert.equal(app.assess().word, 'Rot – Stufe wiederholen');
  });
  test('11 – nach 48 Stunden nicht zurück: Rot', async () => {
    const app = await fresh();
    const s = calmDays(app, { morning: [1, 1, 2] });
    s.mornings.push(app.makeMorning(T, 2, 'unter15', ''));   // zwei Tage nach dem letzten Training immer noch 2
    app._test.setState(s);
    const a = app.assess();
    assert.equal(a.word, 'Rot – Stufe wiederholen');
    assert.match(a.reasons[0], /48 Stunden/);
  });
  test('12 – Steifigkeit: ab 15 Min. Gelb, über 45 Rot', async () => {
    const app = await fresh();
    app._test.setState(calmDays(app, { stiff: ['unter15', 'unter15', 'ueber45'] }));
    assert.equal(app.assess().word, 'Rot – Stufe wiederholen');
    app._test.setState(calmDays(app, { stiff: ['unter15', 'unter15', '15bis30'] }));
    assert.equal(app.assess().word, 'Gelb – Stufe halten');
  });
  test('13 – drei grüne in Folge: Steigerung frei; Gelb davor setzt den Zähler zurück', async () => {
    const app = await fresh();
    app._test.setState(calmDays(app));
    const a = app.assess();
    assert.equal(a.word, 'Grün – Steigerung frei');
    assert.match(a.todo, /Genau eine Sache/);
    app._test.setState(calmDays(app, { after: [1, 4, 1] }));
    const b = app.assess();
    assert.equal(b.word, 'Grün');
    assert.equal(b.kicker, '1 von 3 für die nächste Steigerung');
  });
  test('14 – weniger als 48 Stunden zwischen zwei Kraft-Einheiten: Gelb', async () => {
    const app = await fresh();
    const s = calmDays(app);
    s.entries.push(entry(day(app, -3), 1, { type: 'kraft', time: '18:00', painAfter: 1, spots: ['knoechel'] }));   // Tag -3, dann Tag -2: 24 h
    s.mornings.push(app.makeMorning(day(app, -3), 1, 'unter15', ''));
    app._test.setState(s);
    const a = app.assess();
    assert.equal(a.word, 'Gelb – Stufe halten');
    assert.match(a.reasons[0], /24 Stunden seit der letzten Sehnenkraft/);
  });
  test('15 – kein Ruhetag in sieben Tagen: Gelb', async () => {
    const app = await fresh();
    const entries = [], mornings = [];
    for (let n = -6; n <= 0; n++) { entries.push(entry(day(app, n), 1, { type: 'volleyball', painAfter: 1, spots: ['knoechel'] })); mornings.push(app.makeMorning(day(app, n), 1, 'unter15', '')); }
    app._test.setState({ entries, mornings });
    const a = app.assess();
    assert.equal(a.word, 'Gelb – Stufe halten');
    assert.match(a.reasons.join(' '), /keinen Ruhetag/);
  });
  test('Schmerz während ohne Wert bleibt grün (kein Verstoß), aber nicht als Argument', async () => {
    const app = await fresh();
    const s = calmDays(app); s.entries[1].painDuring = null;
    app._test.setState(s);
    assert.equal(app.assess().word, 'Grün – Steigerung frei');
  });
});

describe('Laufregeln', () => {
  const run = (date, min, pace, cadence, extra) => ({ id: 'r' + date, date, time: '08:00', type: 'lauf', details: { min: String(min), pace, cadence: cadence ? String(cadence) : '' }, painDuring: 1, ...extra });
  test('längster Lauf der letzten 30 Tage + 10 %', async () => {
    const app = await fresh();
    app._test.setState({ entries: [run('2026-08-01', 60, '5:49'), run('2026-09-10', 30, '6:10', 170)] });
    const c = app.runCheck({ date: T, min: '34', pace: '6:10' });
    assert.equal(c.longest, 30);   // der 60er ist älter als 30 Tage
    assert.equal(c.limit, 33);
    assert.equal(c.tooLong, true);
    assert.match(c.warn[0], /über 33 Min/);
    assert.equal(app.runCheck({ date: T, min: '33' }).tooLong, false);
  });
  test('Referenzpace aus den ersten drei Läufen ab Programmstart, Warnung ab 5 % schneller, Kadenzziel +5 %', async () => {
    const app = await fresh();
    app._test.setNow(() => new Date('2026-10-30T10:00:00'));
    app._test.setState({ entries: [run('2026-09-01', 60, '5:00', 160), run('2026-10-08', 30, '6:00', 170), run('2026-10-12', 30, '6:10', 170), run('2026-10-16', 30, '6:20', 170)] });
    const c = app.runCheck({ date: '2026-10-30', min: '30', pace: '5:40', cadence: '172' });
    assert.equal(Math.round(c.ref.pace), 370);   // Schnitt aus 6:00, 6:10, 6:20 – der alte 5:00er zählt nicht
    assert.equal(c.tooFast, true);
    assert.equal(c.cadTarget, 179);
    assert.equal(app.runCheck({ date: '2026-10-30', min: '30', pace: '5:55' }).tooFast, false);
    const d = app.runCheck({ date: '2026-10-30', min: '30' }, 'r2026-10-16');   // der dritte Lauf wird gerade bearbeitet: nur zwei Referenzläufe
    assert.equal(d.ref.pace, null);
    assert.equal(d.ref.paceN, 2);
  });
  test('zu langer Lauf macht den Trainingstag Gelb', async () => {
    const app = await fresh();
    app._test.setState({ entries: [run(day(app, -10), 30, '6:10'), run(day(app, -2), 40, '6:10', null, { painAfter: 1, spots: ['knoechel'] })],
      mornings: [app.makeMorning(day(app, -2), 1, 'unter15', ''), app.makeMorning(day(app, -1), 1, 'unter15', '')] });
    const a = app.assess();
    assert.equal(a.word, 'Gelb – Stufe halten');
    assert.match(a.reasons[0], /40 Min\. liegt über 33 Min/);
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

describe('Paket 4: Kadenz, Steigerung, Rettungskopie, Speicher-Zusage, Safari', () => {
  test('cleanEntry und summary kennen Kadenz und „gesteigert: was“', async () => {
    const app = await fresh();
    const c = app.cleanEntry({ id: 'r1', date: T, type: 'lauf', painDuring: 1, progressed: true, progressedWhat: 'Tempo', details: { min: '30', cadence: 172, pace: '5:40' } });
    assert.equal(c.progressedWhat, 'Tempo');
    assert.equal(c.details.cadence, '172');
    assert.equal(app.summary(c), '30 Min. · 5:40 · 172 Schritte/Min.');
    const d = app.draftFromEntry(c);
    assert.equal(d.run.cadence, '172');
    assert.equal(d.progressedWhat, 'Tempo');
    assert.equal(app.draftIsEmpty(d), false);
    const leer = app.newDraft(); leer.progressedWhat = 'x';
    assert.equal(app.draftIsEmpty(leer), false);
  });
  test('Verlauf zeigt Kollagen und die Art der Steigerung; Export auch', async () => {
    const app = await fresh();
    app._test.setState({ entries: [entry(day(app, -1), 1, { collagen: true, progressed: true, progressedWhat: 'Gewicht 15 → 17,5 kg' })] });
    app.render();
    const html = app.__dom.root.innerHTML;
    assert.match(html, /gesteigert: Gewicht 15 → 17,5 kg/);
    assert.match(html, /· Kollagen</);
    assert.match(app.buildExport(), /Steigerung: Gewicht 15 → 17,5 kg/);
  });
  test('unlesbarer Stand wird als Rohtext gerettet und überlebt das nächste Speichern', async () => {
    const app = await fresh();
    app.__dom.store.set('sehnenlog.local:' + app.KEY, '{"entries": [ kaputt');
    await app.load();
    assert.match(app.state.dataNote, /Rohtext/);
    assert.equal(app.state.rescue.raw, '{"entries": [ kaputt');
    app.state.entries.push(entry(day(app, -1), 1));
    await app.save();
    const r = await app.readRescue();
    assert.equal(r.raw, '{"entries": [ kaputt');
    assert.ok(JSON.parse(app.__dom.store.get('sehnenlog.local:' + app.KEY)).entries.length === 1);
    app._test.setTab('data'); app.render();
    assert.match(app.__dom.root.innerHTML, /Unlesbarer Stand – Rohtext/);
  });
  test('dauerhafter Speicher wird nur einmal von selbst angefragt', async () => {
    const app = await fresh();
    let calls = 0;
    globalThis.navigator.storage = { persisted: async () => false, persist: async () => { calls++; return false; } };
    await app.load(); await new Promise(r => setTimeout(r, 20));
    assert.equal(calls, 1);
    assert.equal(app.state.meta.persistAsked, true);
    assert.match(app.__dom.store.get('sehnenlog.local:sehnenlog:meta'), /"persistAsked":true/);
    await app.load(); await new Promise(r => setTimeout(r, 20));
    assert.equal(calls, 1);                       // beim zweiten Start kein Dialog mehr
    await app.checkPersistence(true);
    assert.equal(calls, 2);                       // „Erneut anfragen“ fragt
    delete globalThis.navigator.storage;
  });
  test('Safari-Erkennung: nur Safari im Browser-Modus', async () => {
    const app = await fresh();
    const nav = globalThis.navigator;
    nav.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    assert.equal(app.safariBrowserModus(), true);
    nav.standalone = true;
    assert.equal(app.safariBrowserModus(), false);
    nav.standalone = false;
    nav.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0 Mobile/15E148 Safari/604.1';
    assert.equal(app.safariBrowserModus(), false);
    nav.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
    assert.equal(app.safariBrowserModus(), false);
  });
  test('Formular baut sich mit Hinweis-Containern auf; Alteintrag verliert „detail“ nur beim Speichern', async () => {
    const app = await fresh();
    const alt = { id: 'alt', date: day(app, -2), time: '10:00', type: 'lauf', painDuring: 1, detail: 'alter Freitext', details: {} };
    app._test.setState({ entries: [alt] });
    assert.equal(app.summary(alt), 'alter Freitext');
    const d = app.draftFromEntry(alt);
    assert.match(d.note, /Alteintrag: alter Freitext/);
    app._test.setDraft(d, 'alt'); app._test.openForm(true); app.render();
    const html = app.__dom.root.innerHTML;
    for (const id of ['when-note', 'collagen-note', 'progressed-what', 'save-entry', 'entry-hint']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(html, /id="progressed-what" hidden/);
  });
});

describe('Paket 5: Schmerz danach, Schmerzort, Distanz, Speicherformat v5', () => {
  test('cleanEntry und makeMorning kennen die neuen Felder; Unbekanntes fällt raus', async () => {
    const app = await fresh();
    const c = app.cleanEntry({ id: 1, date: '2026-10-07', type: 'lauf', painDuring: 1, painAfter: 11, allDay: 'ja', spots: ['knoechel', 'mond', 'knoechel'], details: { min: 30, km: 5.2 } });
    assert.equal(c.painAfter, null);
    assert.equal(c.allDay, true);
    assert.deepEqual(c.spots, ['knoechel']);
    assert.equal(c.details.km, '5.2');
    const m = app.makeMorning('2026-10-07', 2, 'unter15', 'x', ['spann', 'nix']);
    assert.deepEqual(m.spots, ['spann']);
    assert.deepEqual(app.skippedMorning('2026-10-08').spots, []);
  });
  test('packState schreibt v5; ein v4-Stand wird übernommen und ohne neue Felder bewertet', async () => {
    const app = await fresh();
    assert.equal(app.packState().v, 5);
    assert.equal(app.KEY, 'sehnenlog:v5');
    assert.equal(app.KEYS_ALT[0], 'sehnenlog:v4');
    const n = app.normalize({ v: 4, entries: [{ id: 'a', date: day(app, -2), type: 'kraft', painDuring: 1 }], mornings: [{ date: day(app, -1), pain: 1, stiff: 'unter15' }], tests: [] });
    assert.equal(n.legacy, false);
    assert.equal(n.from, 4);
    assert.equal(n.entries[0].painAfter, null);
    assert.deepEqual(n.entries[0].spots, []);
    app._test.setState(n);
    assert.equal(app.assess().word, 'Grün');
  });
  test('summary und Export zeigen Distanz, danach, ganztägig und Ort', async () => {
    const app = await fresh();
    const e = { id: 'x', date: day(app, -1), time: '08:00', type: 'lauf', details: { min: '30', km: '5,2', pace: '6:10' }, painDuring: 1, painAfter: 2, allDay: true, spots: ['innenfuss', 'spann'] };
    assert.equal(app.summary(e), '30 Min. · 5,2 km · 6:10');
    app._test.setState({ entries: [e], mornings: [app.makeMorning(T, 1, 'unter15', '', ['knoechel'])] });
    const x = app.buildExport();
    assert.match(x, /danach 2\/10 \(ganztägig spürbar\)/);
    assert.match(x, /Ort: Innenfuß \/ Kahnbein, Spann/);
    assert.match(x, /Morgen: Schmerz 1\/10, Sehne steif unter 15 Min\., Ort: hinter dem Knöchel/);
  });
  test('Formular: Schmerzort ist Pflicht, sobald ein Wert über 0 liegt; Verlauf bietet „danach eintragen“ an', async () => {
    const app = await fresh();
    const e = { id: 'x', date: day(app, -1), time: '08:00', type: 'kraft', details: { ex: {} }, painDuring: 1, painAfter: null, allDay: false, spots: ['knoechel'] };
    app._test.setState({ entries: [e], mornings: [app.makeMorning(T, 1, 'unter15', '', ['knoechel'])] });
    const d = app.newDraft(); d.painDuring = 2; d.spots = [];
    app._test.setDraft(d); app._test.openForm(true);
    let html = app.tabLog();
    assert.match(html, /Der Schmerzort fehlt noch/);
    assert.match(html, /id="save-entry" data-act="saveEntry" disabled/);
    d.spots = ['knoechel'];
    html = app.tabLog();
    assert.doesNotMatch(html, /Der Schmerzort fehlt noch/);
    assert.match(html, /data-chips="spots" data-val="knoechel" aria-pressed="true"/);
    assert.match(html, /data-act="editAfter" data-id="x"/);
    app._test.setAfterEdit({ id: 'x', pain: 2, allDay: false, spots: ['knoechel'] });
    html = app.tabLog();
    assert.match(html, /data-scale="aPain" data-val="2" aria-pressed="true"/);
    assert.match(html, /data-act="saveAfter" data-id="x" >/);
  });
  test('Lauf-Formular zeigt Distanz und die Laufhinweise', async () => {
    const app = await fresh();
    const d = app.newDraft(); d.type = 'lauf'; d.painDuring = 0;
    app._test.setDraft(d); app._test.openForm(true);
    const html = app.tabLog();
    assert.match(html, /data-path="run.km"/);
    assert.match(html, /id="run-note"/);
    assert.match(html, /Noch kein Lauf in den letzten 30 Tagen/);
  });
});
