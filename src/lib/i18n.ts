import { useSyncExternalStore } from 'react';

/**
 * Tiny UI-language store (English / Khmer) — same zero-dependency external
 * store pattern as useTheme. `t(key)` looks up a flat dictionary; unknown keys
 * fall back to the English string (or the key itself) so a missing translation
 * can never blank out the UI. Persisted to localStorage.
 *
 * Scope note: the shell (nav, top bar) and the OCR Image tab are fully
 * localized. Other tabs keep their English strings until keys are added here —
 * adding a key + `t()` call is all future coverage needs.
 */

export type Locale = 'en' | 'km';
const STORAGE_KEY = 'khmer-parser-locale';

const STRINGS: Record<string, { en: string; km: string }> = {
  // ── Shell / navigation ──────────────────────────────────────────────────
  'tab.document': { en: 'Parse Document', km: 'វិភាគឯកសារ' },
  'tab.document.hint': { en: 'Full document OCR & structure', km: 'OCR ឯកសារពេញ និងរចនាសម្ព័ន្ធ' },
  'tab.translated': { en: 'Parse + Translate', km: 'វិភាគ + បកប្រែ' },
  'tab.translated.hint': { en: 'Extract then translate', km: 'ស្រង់អត្ថបទ រួចបកប្រែ' },
  'tab.table': { en: 'Parse Table', km: 'វិភាគតារាង' },
  'tab.table.hint': { en: 'Tables to CSV / XLSX', km: 'តារាងទៅ CSV / XLSX' },
  'tab.ocr': { en: 'OCR Image', km: 'OCR រូបភាព' },
  'tab.ocr.hint': { en: 'One image → instant text', km: 'រូបភាពមួយ → អត្ថបទភ្លាមៗ' },
  'tab.compare': { en: 'Compare', km: 'ប្រៀបធៀប' },
  'tab.compare.hint': { en: 'A/B two backends', km: 'ប្រៀបធៀប backend ពីរ' },
  'tab.history': { en: 'History', km: 'ប្រវត្តិ' },
  'tab.history.hint': { en: 'Saved extractions', km: 'លទ្ធផលបានរក្សាទុក' },
  'short.document': { en: 'Parse', km: 'វិភាគ' },
  'short.translated': { en: 'Translate', km: 'បកប្រែ' },
  'short.table': { en: 'Table', km: 'តារាង' },
  'short.ocr': { en: 'OCR', km: 'OCR' },
  'short.compare': { en: 'Compare', km: 'ប្រៀប' },
  'short.history': { en: 'History', km: 'ប្រវត្តិ' },
  'short.settings': { en: 'Settings', km: 'កំណត់' },
  'brand.tagline': { en: 'Neural document engine', km: 'ម៉ាស៊ីនអានឯកសារ AI' },

  // ── OCR Image tab ───────────────────────────────────────────────────────
  'ocr.title': { en: 'Scan an image', km: 'ស្កេនរូបភាព' },
  'ocr.subtitle': { en: 'Drop one image — OCR starts instantly.', km: 'រូបភាពមួយសន្លឹក — OCR ដំណើរការភ្លាមៗ' },
  'ocr.drop.title': { en: 'Drop an image here', km: 'ទម្លាក់រូបភាពនៅទីនេះ' },
  'ocr.drop.hint': { en: 'tap to choose · paste anywhere', km: 'ចុចដើម្បីជ្រើសរើស · paste ក៏បាន' },
  'ocr.drop.accepted': { en: 'PNG · JPG · WEBP · BMP · TIFF', km: 'PNG · JPG · WEBP · BMP · TIFF' },
  'ocr.takePhoto': { en: 'Take photo', km: 'ថតរូប' },
  'ocr.preparing': { en: 'Preparing image…', km: 'កំពុងរៀបចំរូបភាព…' },
  'ocr.uploading': { en: 'Uploading…', km: 'កំពុងផ្ទុកឡើង…' },
  'ocr.running': { en: 'Reading text…', km: 'កំពុងអានអក្សរ…' },
  'ocr.done': { en: 'OCR complete', km: 'OCR បានបញ្ចប់' },
  'ocr.confidence': { en: 'Confidence', km: 'ភាពជឿជាក់' },
  'ocr.copy': { en: 'Copy text', km: 'ចម្លងអត្ថបទ' },
  'ocr.newImage': { en: 'New image', km: 'រូបភាពថ្មី' },
  'ocr.rerun': { en: 'Run again', km: 'ដំណើរការម្តងទៀត' },
  'ocr.crop': { en: 'Crop → re-run', km: 'កាត់ → ម្តងទៀត' },
  'crop.title': { en: 'Crop', km: 'កាត់រូប' },
  'crop.hint': { en: 'Drag to select the text area', km: 'អូសដើម្បីជ្រើសតំបន់អត្ថបទ' },
  'crop.apply': { en: 'OCR this area', km: 'OCR តំបន់នេះ' },
  'ocr.result': { en: 'Result', km: 'លទ្ធផល' },
  'ocr.text': { en: 'OCR Text', km: 'អត្ថបទ OCR' },
  'ocr.noImage': { en: 'No source image available.', km: 'គ្មានរូបភាពដើមទេ។' },
  'ocr.noText': { en: 'No text detected in this image.', km: 'រកមិនឃើញអត្ថបទក្នុងរូបភាពនេះទេ។' },
  'ocr.noText.hint': {
    en: 'Try "Crop → re-run" on the text area, or turn on high resolution in settings.',
    km: 'សាកល្បង «កាត់ → ម្តងទៀត» លើតំបន់អត្ថបទ ឬបើកគុណភាពខ្ពស់ក្នុងការកំណត់។',
  },
  'ocr.settings': { en: 'Advanced settings', km: 'ការកំណត់កម្រិតខ្ពស់' },
  'ocr.highRes': { en: 'High resolution', km: 'គុណភាពខ្ពស់' },
  'ocr.highRes.hint': { en: '300 DPI · catches small text', km: '300 DPI · ចាប់អក្សរតូច' },
  'ocr.ctc': { en: 'CTC decoder', km: 'ឌិកូដ CTC' },
  'ocr.ctc.hint': { en: 'Recommended for Khmer', km: 'ណែនាំសម្រាប់ភាសាខ្មែរ' },

  // ── Landing / guest gate ────────────────────────────────────────────────
  'landing.tagline': {
    en: 'Built by young Khmer to help with OCR and document extraction.',
    km: 'បង្កើតឡើងដោយកូនខ្មែរសម្រាប់ជួយក្នុង OCR និងការស្រង់ឯកសារ',
  },
  'landing.feature1': { en: 'Snap or upload an image — text appears instantly', km: 'ថត ឬផ្ទុករូបភាព — អត្ថបទចេញភ្លាមៗ' },
  'landing.feature2': { en: 'Parse full PDF documents & tables', km: 'វិភាគឯកសារ PDF និងតារាងពេញលេញ' },
  'landing.feature3': { en: 'Translate Khmer documents', km: 'បកប្រែឯកសារខ្មែរ' },
  'landing.guest': { en: 'Continue as guest', km: 'បន្តជាភ្ញៀវ' },
  'landing.or': { en: 'or', km: 'ឬ' },
  'landing.google': { en: 'Sign in with Google', km: 'ចូលតាម Google' },
  'landing.email': { en: 'Continue with email', km: 'បន្តតាមអ៊ីមែល' },
  'landing.create': { en: 'Create account', km: 'បង្កើតគណនី' },
  'landing.soon': { en: 'Coming soon', km: 'ឆាប់ៗនេះ' },
  'landing.soonToast': {
    en: "Accounts aren't ready yet — continue as guest for now.",
    km: 'គណនីមិនទាន់ដំណើរការទេ — សូមបន្តជាភ្ញៀវសិន',
  },

  // ── Settings ────────────────────────────────────────────────────────────
  'settings.title': { en: 'Settings', km: 'ការកំណត់' },
  'settings.language': { en: 'Language', km: 'ភាសា' },
  'settings.dark': { en: 'Dark mode', km: 'ផ្ទៃងងឹត' },
  'settings.dark.hint': { en: 'Neon night theme', km: 'រូបរាងពណ៌ងងឹត' },
  'settings.sound': { en: 'Sound effects', km: 'សំឡេង' },
  'settings.sound.hint': { en: 'Chime when OCR finishes', km: 'សំឡេងពេល OCR ចប់' },
  'settings.extraction': { en: 'Extraction', km: 'ការស្រង់អត្ថបទ' },
  'settings.account': { en: 'Account', km: 'គណនី' },
  'settings.guest': { en: 'Guest', km: 'ភ្ញៀវ' },
  'settings.backToWelcome': { en: 'Back to welcome page', km: 'ត្រឡប់ទៅទំព័រស្វាគមន៍' },
  'ocr.fullPage': { en: 'Full-page OCR fallback', km: 'OCR ទំព័រពេញបន្ថែម' },
  'ocr.fullPage.hint': { en: 'Catches margins & headers (slower)', km: 'ចាប់គែម និងក្បាលទំព័រ (យឺតជាង)' },

  // ── Common ──────────────────────────────────────────────────────────────
  'common.cancel': { en: 'Cancel', km: 'បោះបង់' },
  'common.close': { en: 'Close', km: 'បិទ' },
};

let currentLocale: Locale = readInitial();
const listeners = new Set<() => void>();

function readInitial(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'km') return saved;
  } catch {
    // localStorage blocked; default to English.
  }
  return 'en';
}

function applyLocale(locale: Locale) {
  currentLocale = locale;
  // Keep the document language honest for screen readers / font selection.
  if (typeof document !== 'undefined') document.documentElement.lang = locale === 'km' ? 'km' : 'en';
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore quota / disabled storage
  }
  listeners.forEach((l) => l());
}

// Apply on module load so the lang attribute is right from first paint.
if (typeof document !== 'undefined') applyLocale(currentLocale);

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): Locale {
  return currentLocale;
}

export function translate(locale: Locale, key: string): string {
  const entry = STRINGS[key];
  if (!entry) return key;
  return entry[locale] ?? entry.en;
}

export function useLocale(): {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
} {
  const locale = useSyncExternalStore(subscribe, getSnapshot, () => 'en' as Locale);
  return {
    locale,
    setLocale: applyLocale,
    t: (key) => translate(locale, key),
  };
}
