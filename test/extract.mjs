// Schneidet den App-Code aus index.html und lädt ihn in Node – ohne Browser.
// Die Logik (Urteil, Umzug alter Daten, Import, Warnzeichen) läuft nachweislich ohne DOM;
// was das Modul vom Browser braucht, bekommt es hier als schlanke Attrappe.
//
//   const app = await loadApp();            // frisches Modul mit leerem Speicher
//   app._test.setNow(() => new Date('2026-09-21T10:00:00'));
//   app._test.setState({ entries, mornings, tests });
//   app.assess().word
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const INDEX = path.join(here, '..', 'index.html');

export const EXPORTS = [
  'state', '_test', 'today', 'addDays', 'daysBetween', 'isIsoDate', 'relDay', 'dayLabel', 'fmt', 'fmtY',
  'normalize', 'fromLegacy', 'cleanEntry', 'validEntry', 'validMorning', 'validTest', 'makeMorning', 'skippedMorning', 'makeTest',
  'sorted', 'entriesOf', 'hasTraining', 'morningOf', 'testOf', 'dayList', 'days', 'pending', 'assess', 'redFlags', 'testFlags', 'testDue',
  'summary', 'collagenGap', 'buildExport', 'backupPayload', 'backupFaellig', 'packState',
  'lastExUse', 'doseParts', 'draftIsEmpty', 'newDraft', 'draftFromEntry',
  'save', 'load', 'applyBackup', 'readSnapshot', 'readRescue', 'checkPersistence', 'safariBrowserModus', 'render', 'tabLog', 'tabData', 'tabPlan', 'tabEx', 'tabSupp', 'tabScales',
  'KEY', 'KEY_PREV', 'KEY_TRASH', 'KEYS_ALT', 'SCHMERZ_MAX', 'EXPORT_TAGE', 'TEST_INTERVALL_TAGE'
];

// Attrappen für alles, was der Code vom Browser anfasst. Der Speicher ist eine Map je Modul.
const STUBS = `
const __store = new Map();
const __root = { innerHTML: '', clientWidth: 390, contains() { return false; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: {
  getItem: k => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => { __store.set(k, String(v)); },
  removeItem: k => { __store.delete(k); },
  clear: () => __store.clear(),
  get length() { return __store.size; },
  key: i => [...__store.keys()][i] ?? null
} });
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {} });
globalThis.window = globalThis;
globalThis.location = { protocol: 'file:' };
globalThis.CSS = { escape: s => String(s) };
globalThis.confirm = () => true;
globalThis.addEventListener = () => {};
globalThis.document = {
  addEventListener() {},
  getElementById(id) { return id === 'root' ? __root : null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return { style: {}, setAttribute() {}, append() {}, remove() {}, click() {} }; },
  body: { appendChild() {} },
  activeElement: null
};
export const __dom = { root: __root, store: __store };
`;

export function extract(indexPath = INDEX) {
  const html = readFileSync(indexPath, 'utf8');
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('Modul-Skript nicht gefunden in ' + indexPath);
  let src = m[1];
  if (!src.includes('\nload();\n')) throw new Error('Autostart load() nicht gefunden');
  src = src.replace('\nload();\n', '\n');   // der Test entscheidet selbst, wann geladen wird
  return STUBS + src + `\nexport { ${EXPORTS.join(', ')} };\n`;
}

let n = 0;
export async function loadApp(indexPath = INDEX) {
  const dir = path.join(here, '.build');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `app-${process.pid}-${++n}.mjs`);
  writeFileSync(file, extract(indexPath));
  return import(pathToFileURL(file).href);
}
