import type en from '../catalogs/en.json';

// Catalog keys are checked at compile time against the English catalog; scripts/checks/catalogs.sh
// keeps the Simplified Chinese one in step.
declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
  }
}
