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
  app._test.setProgrammStart('2026-09-01');   // die Testdaten liegen im September
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
    app._test.setState({ entries: [entry(day(app, -2), 1, { type: 'kraft', painAfter: 2, spots: ['knoechel'] })], mornings: [app.makeMorning(day(app, -1), 1, 'unter15', '')] });
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
    app._test.setProgrammStart('2026-10-07');
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
  test('Austrittstest ist erst „bereit“, wenn alle Kriterien der Phase stehen', async () => {
    const app = await fresh();
    assert.equal(app.testDue(), false);
    app._test.setState({ mornings: [app.makeMorning(day(app, -14), 1, 'unter15', '')] });
    assert.equal(app.testDue(), false);
    assert.match(app.exitTestStatus().text, /von 6 Kriterien erfüllt/);
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
    assert.equal(payload.v, 5);
    assert.equal(payload.ladders.a1.step, -1);
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
    app._test.setTab('log'); app.render();
    const html = app.__dom.root.innerHTML;
    assert.doesNotMatch(html, /konnte nicht aufgebaut/);
    assert.match(html, /rechts 18 · links 24 · rechts 6 weniger \(75 % von links\)/);
    assert.match(html, /zuletzt 19\.9\.: rechts 18, links 24/);
    assert.match(html, /data-act="openTest"/);
    assert.doesNotMatch(html, /class="del"/);   // kein Lösch-× in den Zeilen
    for (const t of ['heute', 'fort', 'plan', 'ex', 'supp', 'scale', 'data']) { app._test.setTab(t); app.render(); assert.doesNotMatch(app.__dom.root.innerHTML, /konnte nicht aufgebaut/, t); }
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
    app._test.setTab('log'); app.render();
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
    app._test.setDraft(d, 'alt'); app._test.openForm(true); app._test.setTab('log'); app.render();
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

describe('Paket 6: Leitern, Vorschlag, Lauf-Leiter, Phasen, Austrittstest', () => {
  const P = '2026-10-07';
  const kraft = (date, ex, extra) => ({ id: 'k' + date, date, time: '18:00', type: 'kraft', details: { ex }, painDuring: 1, painAfter: 1, spots: ['knoechel'], ...extra });
  const morn = (app, date, pain) => app.makeMorning(date, pain ?? 1, 'unter15', '');
  async function prog(now) {
    const app = await loadApp();
    app._test.setNow(() => new Date(now + 'T10:00:00'));
    app._test.setProgrammStart(P);
    return app;
  }
  test('Start: Vorschlag ist Einheit 1; erste Einheit startet beide Leitern', async () => {
    const app = await prog('2026-10-08');
    app._test.setState({});
    const p = app.proposal();
    assert.equal(p.item.kind, 'start');
    assert.match(p.item.text, /Wadenheben gestreckt 1 × 12/);
    assert.deepEqual(Object.keys(app.exFromLadders()).sort(), ['a1', 'a3', 'bal', 'dehn']);
    assert.equal(app.exFromLadders().a1.v, 'beidbeinig');
    assert.equal(app.exFromLadders().a3.band, 0);
    // ohne Varianten-Angabe rückt nichts vor
    const e0 = kraft('2026-10-08', { a1: { sets: '1', reps: '12', weight: '' }, a3: { sets: '1', reps: '15', weight: '' } });
    app._test.setState({ entries: [e0] });
    assert.equal(app.applyLadderAdvance(e0), null);
    const e = kraft('2026-10-08', { a1: { sets: '1', reps: '12', weight: '', v: 'beidbeinig' }, a3: { sets: '1', reps: '15', weight: '', band: 0 } });
    app._test.setState({ entries: [e] });
    assert.deepEqual(app.applyLadderAdvance(e), ['Wadenheben gestreckt', 'Band-Adduktion']);
    assert.equal(app.ladderStatus('a1').step, 0);
    assert.equal(app.ladderStatus('a2').step, -1);
  });
  test('Nach drei grünen Einheiten: genau ein Vorschlag, zuerst die neue Übung', async () => {
    const app = await prog('2026-10-16');
    const ex = { a1: { sets: '1', reps: '12', weight: '', v: 'beidbeinig' }, a3: { sets: '1', reps: '15', weight: '', band: 0 } };
    const entries = ['2026-10-08', '2026-10-10', '2026-10-13'].map(d => kraft(d, ex));
    const mornings = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-13', '2026-10-14'].map(d => morn(app, d));
    const ladders = { a1: { step: 0, since: '2026-10-08' }, a3: { step: 0, since: '2026-10-08' } };
    app._test.setState({ entries, mornings, ladders });
    assert.equal(app.ladderStatus('a1').counter, 3);
    const p = app.proposal();
    assert.equal(p.streak, 3);
    assert.equal(p.item.kind, 'neu');
    assert.equal(p.item.key, 'a2');
    // ein Gelb dazwischen setzt den Zähler zurück
    const m2 = mornings.map(m => m.date === '2026-10-11' ? morn(app, m.date, 2) : m);
    app._test.setState({ entries, mornings: m2, ladders });
    assert.equal(app.proposal().item, null);
    assert.equal(app.proposal().streak, 1);
  });
  test('Alle Übungen drin: Sätze vor Stufe, Ball und Doming nur ohne Innenfuß-Schmerz', async () => {
    const app = await prog('2026-11-10');
    const ex = { a1: { sets: '2', reps: '12', weight: '', v: 'beidbeinig' }, a3: { sets: '3', reps: '15', weight: '', band: 0 }, a2: { sets: '1', reps: '12', weight: '', v: 'beidbeinig' }, b4: { sets: '1', reps: '12', weight: '', loop: 1 } };
    const entries = ['2026-11-02', '2026-11-04', '2026-11-07'].map(d => kraft(d, ex));
    const mornings = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-07', '2026-11-08'].map(d => morn(app, d));
    const ladders = { a1: { step: 1, since: '2026-11-01' }, a3: { step: 2, since: '2026-11-01' }, a2: { step: 0, since: '2026-11-01' }, hip: { step: 0, since: '2026-11-01' } };
    app._test.setState({ entries, mornings, ladders });
    let p = app.proposal();
    assert.equal(p.item.kind, 'neu'); assert.equal(p.item.key, 'a6');   // Ball + Doming sind dran
    // Innenfuß vor drei Tagen: Ball/Doming warten, stattdessen Sätze bei der ersten Übung mit vollem Zähler
    const entries2 = entries.map(e => e.date === '2026-11-07' ? { ...e, spots: ['innenfuss'] } : e);
    app._test.setState({ entries: entries2, mornings, ladders });
    p = app.proposal();
    assert.equal(app.gateOk('a6'), false);
    assert.match(p.gated, /Innenfuß/);
    assert.equal(p.item.kind, 'sätze');
    assert.equal(p.item.key, 'a1');
    assert.match(p.item.text, /3 × 12 · beidbeinig \(war 2 × 12/);
  });
  test('Entlastungswoche blockiert Steigerungen', async () => {
    const app = await prog('2026-10-29');   // Woche 3 ab 7.10. = vierte Woche
    app._test.setState({ ladders: { a1: { step: 0, since: P }, a3: { step: 0, since: P } } });
    assert.equal(app.isDeloadWeek(), true);
    assert.match(app.proposal().blocked, /Entlastungswoche/);
  });
  test('Lauf-Leiter: Einstieg nach 7 ruhigen Morgen, +10 % nach zwei grünen Läufen', async () => {
    const app = await prog('2026-10-20');
    const mornings = []; for (let i = 0; i <= 13; i++) mornings.push(morn(app, app.addDays('2026-10-20', -i)));
    app._test.setState({ mornings });
    let r = app.runStatus();
    assert.equal(r.step, -1); assert.equal(r.gate, true); assert.equal(r.next, 0);
    const run = (date, min) => ({ id: 'r' + date, date, time: '08:00', type: 'lauf', details: { min: String(min), pace: '6:10' }, painDuring: 1, painAfter: 1, spots: ['knoechel'] });
    app._test.setState({ mornings, entries: [run('2026-10-12', 30), run('2026-10-15', 30)], run: { step: 1, since: '2026-10-12' } });
    r = app.runStatus();
    assert.equal(r.counter, 2);
    assert.equal(r.next, 2);
    assert.equal(r.nextText, '33 Min. locker am Stück');
    const e = run('2026-10-20', 33);
    app._test.setState({ mornings, entries: [run('2026-10-12', 30), run('2026-10-15', 30), e], run: { step: 1, since: '2026-10-12' } });
    assert.equal(app.applyRunAdvance(e), '33 Min. locker am Stück');
    assert.equal(app.runStatus().step, 2);
  });
  test('Phase 1: Kriterien, Austrittstest mit 24-Stunden-Regel, Wiederholung nach 14 Tagen und 4 Einheiten', async () => {
    const app = await prog('2026-12-10');
    const ex = { a1: { sets: '3', reps: '12', weight: '', v: 'beidbeinig' }, a2: { sets: '3', reps: '12', weight: '', v: 'beidbeinig' }, a3: { sets: '3', reps: '15', weight: '', band: 0 }, b4: { sets: '2', reps: '12', weight: '', loop: 1 } };
    const run = (date, min) => ({ id: 'r' + date, date, time: '08:00', type: 'lauf', details: { min: String(min), pace: '6:10' }, painDuring: 1, painAfter: 1, spots: ['knoechel'] });
    const entries = ['2026-12-01', '2026-12-03', '2026-12-06'].map(d => kraft(d, ex)).concat([run('2026-11-28', 30), run('2026-12-05', 30)]);
    const mornings = []; for (let i = 0; i <= 20; i++) mornings.push(morn(app, app.addDays('2026-12-10', -i)));
    const ladders = { a1: { step: 2, since: '2026-11-20' }, a2: { step: 2, since: '2026-11-20' }, a3: { step: 2, since: '2026-11-20' }, hip: { step: 1, since: '2026-11-25' } };
    const base = { entries, mornings, ladders, run: { step: 1, since: '2026-11-20' } };
    app._test.setState(base);
    const crit = app.phaseCriteria(1);
    assert.equal(crit.filter(c => !c.ok).length, 0, JSON.stringify(crit.filter(c => !c.ok)));
    assert.equal(app.exitTestStatus().ready, true);
    // Test am 8.12.: Zahlen reichen, aber der Morgen danach fehlt → offen
    const t1 = app.makeTest('2026-12-08', 15, 20, '', { after: 2 });
    const m2 = mornings.filter(m => m.date !== '2026-12-09');
    app._test.setState({ ...base, mornings: m2, tests: [t1] });
    assert.equal(app.testOutcome(t1, app.PHASEN[0]).status, 'offen');
    assert.equal(app.phaseState().nr, 1);
    assert.match(app.exitTestStatus().text, /Ergebnis offen/);
    // Morgen danach höher als am Testtag → nicht bestanden; Wiederholung ab 22.12.
    const m3 = mornings.map(m => m.date === '2026-12-09' ? morn(app, m.date, 2) : m);
    app._test.setState({ ...base, mornings: m3, tests: [t1] });
    assert.equal(app.testOutcome(t1, app.PHASEN[0]).status, 'nicht');
    const rt = app.retestStatus();
    assert.equal(rt.from, '2026-12-22'); assert.equal(rt.ok, false); assert.equal(rt.sessions, 0);
    assert.match(app.exitTestStatus().text, /frühestens ab 22\.12\./);
    // Morgen danach gleich → bestanden, Phase 2 seit 9.12.
    app._test.setState({ ...base, tests: [t1] });
    assert.equal(app.testOutcome(t1, app.PHASEN[0]).status, 'bestanden');
    assert.equal(app.phaseState().nr, 2);
    assert.equal(app.phaseState().since, '2026-12-09');
    // Zu wenig Wiederholungen → nicht bestanden trotz ruhigem Morgen
    const t2 = app.makeTest('2026-12-08', 8, 20, '', {});
    assert.match(app.testOutcome(t2, app.PHASEN[0]).reasons[0], /rechts 8 Wdh\. – Ziel 10/);
  });
  test('Phase 3 verlangt Hop-Test und Hops; packState trägt Leitern, Lauf und Ausrüstung', async () => {
    const app = await prog('2027-03-10');
    const t = app.makeTest('2027-03-09', 26, 28, '', { jumpR: '110', jumpL: '130', hops: 10, after: 1 });
    app._test.setState({ tests: [t], mornings: [morn(app, '2027-03-09'), morn(app, '2027-03-10')] });
    const o = app.testOutcome(t, app.PHASEN[2]);
    assert.equal(o.status, 'nicht');
    assert.match(o.reasons[0], /Hop-Test rechts 85 % von links – Ziel 90 %/);
    const ps = app.packState();
    assert.equal(ps.v, 5);
    assert.equal(ps.settings.thera[0].name, 'gelb');
    assert.equal(ps.ladders.a1.step, -1);
    assert.equal(ps.run.step, -1);
    const n = app.normalize({ v: 5, entries: [], mornings: [], tests: [], settings: { thera: [{ name: 'orange', kg: '3 kg' }] }, ladders: { a1: { step: 99, since: 'x' }, kaputt: 1 }, run: { step: 2, since: '2027-01-01' } });
    assert.equal(n.settings.thera[0].name, 'orange');
    assert.equal(n.settings.loop.length, 5);
    assert.equal(n.ladders.a1.step, app.LADDERS.a1.steps.length - 1);
    assert.equal(n.ladders.a1.since, null);
    assert.equal(n.run.step, 2);
  });
  test('Tab „Heute“ und „Fortschritt“ bauen sich auf und zeigen Vorschlag, Chips und Phasenleiste', async () => {
    const app = await prog('2026-10-16');
    const ex = { a1: { sets: '1', reps: '12', weight: '', v: 'beidbeinig' }, a3: { sets: '1', reps: '15', weight: '', band: 0 } };
    const entries = ['2026-10-08', '2026-10-10', '2026-10-13'].map(d => kraft(d, ex));
    const mornings = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-13', '2026-10-14'].map(d => morn(app, d));
    app._test.setState({ entries, mornings, ladders: { a1: { step: 0, since: '2026-10-08' }, a3: { step: 0, since: '2026-10-08' } } });
    const h = app.tabToday();
    assert.match(h, /Sehnenkraft fällig/);
    assert.match(h, /Wadenheben gebeugt<\/button> 1 × 12[\s\S]*⬆ heute steigern/);
    assert.match(h, /Theraband gelb \(4,5 kg\)/);
    assert.match(h, /class="swatch" style="background:#E3B93C"/);
    assert.match(h, /data-act="openFromToday" data-type="kraft"/);
    const f = app.tabProgress();
    assert.match(f, /class="phase cur"/);
    assert.match(f, /von 6 Kriterien erfüllt/);
    assert.match(f, /data-acc="equip"/); assert.match(f, /Theraband gelb → rot → grün → blau/);
    assert.match(f, /data-act="ladderUp" data-key="a1"/);
  });
});

describe('Paket 6b: Review-Korrekturen', () => {
  const P = '2026-10-07';
  const kraft = (date, ex, extra) => ({ id: 'k' + date, date, time: '18:00', type: 'kraft', details: { ex }, painDuring: 1, painAfter: 1, spots: ['knoechel'], ...extra });
  const morn = (app, date, pain) => app.makeMorning(date, pain ?? 1, 'unter15', '');
  async function prog(now) { const app = await loadApp(); app._test.setNow(() => new Date(now + 'T10:00:00')); app._test.setProgrammStart(P); return app; }
  test('Stufenwechsel verlangt die neue Variante bzw. das neue Band – alte Dosis rückt nicht vor', async () => {
    const app = await prog('2026-11-10');
    const ex = { a1: { sets: '3', reps: '12', weight: '', v: 'beidbeinig' }, a3: { sets: '3', reps: '15', weight: '', band: 0 }, a2: { sets: '3', reps: '12', weight: '', v: 'beidbeinig' }, b4: { sets: '3', reps: '15', weight: '', loop: 1 }, a6: { sets: '3', reps: '12', weight: '', v: 'beidbeinig, mittlere Höhe' }, a5: { sets: '3', reps: '5', weight: '', v: 'sitzend, je 5 Sek.' } };
    const entries = ['2026-11-02', '2026-11-04', '2026-11-07'].map(d => kraft(d, ex));
    const mornings = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-07', '2026-11-08'].map(d => morn(app, d));
    const ladders = { a1: { step: 2, since: '2026-11-01' }, a3: { step: 2, since: '2026-11-01' }, a2: { step: 2, since: '2026-11-01' }, hip: { step: 2, since: '2026-11-01' }, a6: { step: 3, since: '2026-11-01' }, a5: { step: 2, since: '2026-11-01' } };
    app._test.setState({ entries, mornings, ladders });
    const p = app.proposal();
    assert.equal(p.item.kind, 'stufe'); assert.equal(p.item.key, 'a1');
    assert.match(p.item.text, /3 × 12 · beidbeinig auf der Stufe \(war 3 × 12 · beidbeinig\)/);
    const same = kraft('2026-11-10', ex);
    app._test.setState({ entries: entries.concat([same]), mornings, ladders });
    assert.equal(app.applyLadderAdvance(same), null);   // gleiche Dosis wie bisher: kein Vorrücken
    assert.equal(app.ladderStatus('a1').step, 2);
    const neu = kraft('2026-11-10', { ...ex, a1: { sets: '3', reps: '12', weight: '', v: 'beidbeinig auf der Stufe' } });
    app._test.setState({ entries: entries.concat([neu]), mornings, ladders });
    assert.deepEqual(app.applyLadderAdvance(neu), ['Wadenheben gestreckt']);
    assert.equal(app.ladderStatus('a1').step, 3);
  });
  test('Vorrücken nur bei sauberer Einheit; Hantelschritt aus den Einstellungen', async () => {
    const app = await prog('2026-10-08');
    const bad = kraft('2026-10-08', { a1: { sets: '1', reps: '12', weight: '', v: 'beidbeinig' }, a3: { sets: '1', reps: '15', weight: '', band: 0 } }, { painDuring: 5 });
    app._test.setState({ entries: [bad] });
    assert.equal(app.applyLadderAdvance(bad), null);
    const bad2 = { ...bad, painDuring: 1, allDay: true };
    assert.equal(app.applyLadderAdvance(bad2), null);
    app._test.setState({ settings: { hantelSchritt: 2.5 }, ladders: { a1: { step: 5, since: P }, a3: { step: 0, since: P } } });
    assert.match(app.stepText(app.LADDERS.a1.steps[6], 'wdh'), /\+2\.5 kg Kurzhantel/);
  });
  test('Zweite Startübung wird ohne Zähler nachgeholt; Löschen der auslösenden Einheit nimmt den Schritt zurück', async () => {
    const app = await prog('2026-10-10');
    app._test.setState({ ladders: { a1: { step: 0, since: '2026-10-08' } } });
    const p = app.proposal();
    assert.equal(p.item.kind, 'neu'); assert.equal(p.item.key, 'a3');
    assert.match(p.item.text, /Noch nicht gestartet/);
    app._test.setState({ ladders: { a1: { step: 1, since: '2026-10-10', prev: { step: 0, since: '2026-10-08' } } } });
    app.revertLadderAdvance({ type: 'kraft', date: '2026-10-10' });
    assert.equal(app.ladderStatus('a1').step, 0);
    assert.equal(app.ladderStatus('a1').since, '2026-10-08');
  });
  test('Offener Test verfällt nach vier Tagen ohne Morgenwert; Basis fällt auf den letzten Morgen davor zurück', async () => {
    const app = await prog('2026-12-20');
    const t = app.makeTest('2026-12-10', 15, 20, '', { after: 1 });
    app._test.setState({ tests: [t], mornings: [morn(app, '2026-12-05', 1)] });
    const o = app.testOutcome(t, app.PHASEN[0]);
    assert.equal(o.status, 'nicht'); assert.match(o.reasons[0], /nicht wertbar/);
    app._test.setState({ tests: [t], mornings: [morn(app, '2026-12-05', 1), morn(app, '2026-12-11', 2)] });
    assert.equal(app.testOutcome(t, app.PHASEN[0]).status, 'nicht');   // 2 > 1 (letzter Morgen davor)
    app._test.setState({ tests: [t], mornings: [morn(app, '2026-12-05', 2), morn(app, '2026-12-11', 2)] });
    assert.equal(app.testOutcome(t, app.PHASEN[0]).status, 'bestanden');
  });
});

describe('Paket 7: Kleinkram und Sprung zur Übung', () => {
  test('„Heute“ verlinkt jede Übung; Vorschlag rechnet mit dem Eintragsdatum', async () => {
    const app = await loadApp();
    app._test.setNow(() => new Date('2026-10-16T10:00:00'));
    app._test.setProgrammStart('2026-10-07');
    app._test.setState({ ladders: { a1: { step: 0, since: '2026-10-08' }, a3: { step: 0, since: '2026-10-08' } } });
    const h = app.tabToday();
    assert.match(h, /data-act="gotoEx" data-ex="a1"/);
    assert.match(h, /data-act="gotoEx" data-ex="bal"/);
    assert.match(h, /data-act="gotoEx" data-ex="dehn"/);
    assert.equal(app.proposal('2026-10-29').blocked && /Entlastungswoche/.test(app.proposal('2026-10-29').blocked), true);
    assert.equal(app.proposal('2026-10-16').blocked, null);
  });
});

describe('Paket 8: Vier Tabs, Sicherung mit Programmstand', () => {
  test('Nachschlage-Seiten laufen unter „Mehr“, Sicherung trägt Leitern und Import übernimmt sie', async () => {
    const app = await fresh();
    app._test.setTab('plan'); app.render();
    const html = app.__dom.root.innerHTML;
    assert.match(html, /id="tab-mehr" aria-controls="panel" data-tab="mehr" aria-selected="true"/);
    assert.match(html, /class="morebar"/);
    app._test.setTab('mehr'); app.render();
    assert.match(app.__dom.root.innerHTML, /class="more-row" data-tab="data"/);
    app._test.setState({ ladders: { a1: { step: 3, since: '2026-09-10' } }, run: { step: 2, since: '2026-09-12' } });
    const dump = JSON.parse(app.backupPayload());
    assert.equal(dump.ladders.a1.step, 3);
    assert.equal(dump.run.step, 2);
    const other = await fresh();
    await other.applyBackup(JSON.stringify(dump));
    assert.equal(other.ladderStatus('a1').step, 3);
    assert.equal(other.runStatus().step, 2);
    const third = await fresh();
    third._test.setState({ ladders: { a1: { step: 1, since: '2026-09-10' } } });
    await third.applyBackup(JSON.stringify({ v: 4, entries: [], mornings: [], tests: [] }));   // alte Sicherung ohne Programmstand
    assert.equal(third.ladderStatus('a1').step, 1);
  });
});

describe('Paket 9: Plyometrie-Leiter ab Phase 3', () => {
  test('inaktiv vor Phase 3; Einstieg, Zähler, nächste Stufe nach 14 Tagen und 4 grünen Einheiten', async () => {
    const app = await loadApp();
    app._test.setNow(() => new Date('2027-03-28T10:00:00'));   // Woche 24 – keine Entlastungswoche
    app._test.setProgrammStart('2026-10-07');
    const morn = (d, p) => app.makeMorning(d, p ?? 1, 'unter15', '');
    // zwei bestandene Tests → Phase 3 seit 2027-03-02
    const t1 = app.makeTest('2026-12-10', 15, 20, '', { after: 1 }), t2 = app.makeTest('2027-03-01', 26, 28, '', { after: 1, balance: true });
    const mornings = ['2026-12-10', '2026-12-11', '2027-03-01', '2027-03-02'].map(d => morn(d));
    app._test.setState({ tests: [t2], mornings });
    assert.equal(app.phaseState().nr, 2);   // der eine Test besteht Phase 1, mehr nicht
    assert.equal(app.plyoStatus().active, false);
    app._test.setState({ tests: [t1, t2], mornings });
    assert.equal(app.phaseState().nr, 3);
    let s = app.plyoStatus();
    assert.equal(s.active, true); assert.equal(s.step, -1); assert.equal(s.ready, true);
    const plyo = (date, ex, sets, reps) => ({ id: 'p' + date, date, time: '18:00', type: 'plyo', details: { ex: { [ex]: { sets: String(sets), reps: String(reps), weight: '' } } }, painDuring: 1, painAfter: 1, spots: ['knoechel'] });
    const e1 = plyo('2027-03-28', 'p1', 3, 20);
    app._test.setState({ tests: [t1, t2], mornings, entries: [e1] });
    assert.equal(app.applyPlyoAdvance(e1), 'Pogo Hops 3 × 20');
    assert.equal(app.plyoStatus().step, 0);
    // vier grüne Pogo-Einheiten, aber erst 10 Tage: noch nicht bereit
    app._test.setNow(() => new Date('2027-03-30T10:00:00'));
    const dates = ['2027-03-20', '2027-03-23', '2027-03-26', '2027-03-29'];
    const entries = dates.map(d => plyo(d, 'p1', 3, 20));
    const m2 = mornings.concat(dates.flatMap(d => [morn(d), morn(app.addDays(d, 1))]));
    app._test.setState({ tests: [t1, t2], mornings: m2, entries, plyo: { step: 0, since: '2027-03-20' } });
    s = app.plyoStatus();
    assert.equal(s.counter, 4); assert.equal(s.ready, false);
    app._test.setNow(() => new Date('2027-04-04T10:00:00'));
    app._test.setState({ tests: [t1, t2], mornings: m2, entries, plyo: { step: 0, since: '2027-03-20' } });
    s = app.plyoStatus();
    assert.equal(s.ready, true); assert.equal(s.next.ex, 'p2');
    assert.match(app.tabToday(), /Plyometrie[\s\S]*Seilspringen/);
    assert.equal(app.packState().plyo.step, 0);
  });
});

describe('Paket 10: Stufenpläne für alle Übungen', () => {
  test('Einbeinstand und Dehnung laufen ab Start; Seitstütz und Dorsalextension starten mit dem ersten Eintrag', async () => {
    const app = await loadApp();
    app._test.setNow(() => new Date('2026-10-16T10:00:00'));
    app._test.setProgrammStart('2026-10-07');
    app._test.setState({ ladders: { a1: { step: 0, since: '2026-10-08' }, a3: { step: 0, since: '2026-10-08' } } });
    assert.equal(app.ladderStatus('bal').step, 0);
    assert.equal(app.ladderStatus('dehn').step, 0);
    assert.equal(app.ladderStatus('b3').step, -1);
    assert.equal(app.ladderStatus('b1').step, -1);
    const h = app.tabToday();
    assert.match(h, /Einbeinstand<\/button> 2 × 30 Sek\. · je Seite, Augen offen/);
    assert.match(h, /Wadendehnung<\/button> 2 × 30 Sek\./);
    assert.match(h, /data-type="crossfit"/);
    const e = { id: 'k1', date: '2026-10-16', time: '18:00', type: 'kraft', painDuring: 1, painAfter: 1, spots: ['knoechel'],
      details: { ex: { a1: { sets: '1', reps: '12', weight: '', v: 'beidbeinig' }, b3: { sets: '1', reps: '12', weight: '', v: 'je Seite' }, b1: { sets: '1', reps: '15', weight: '', band: 0 } } } };
    app._test.setState({ entries: [e], ladders: { a1: { step: 0, since: '2026-10-08' }, a3: { step: 0, since: '2026-10-08' } } });
    const adv = app.applyLadderAdvance(e);
    assert.ok(adv.includes('Seitstütz mit Beinheben (Hüfte, Alternative)'));
    assert.ok(adv.includes('Band-Dorsalextension (nur auf Hinweis)'));
    assert.equal(app.ladderStatus('b3').step, 0);
    assert.equal(app.ladderStatus('a1').step, 0);   // Kernübung ohne Vorschlag rückt nicht vor
    const f = app.tabProgress();
    assert.match(f, /In jeder Einheit/); assert.match(f, /Geparkt/);
    assert.match(f, /data-act="ladderUp" data-key="bal"/);
    assert.equal(app.exDefaults('b3').v, 'je Seite');
  });
});
