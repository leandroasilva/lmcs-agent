import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE } from "@lmcstools/client/i18n";

import enUS from "./locales/en-US.json";
import ptBR from "./locales/pt-BR.json";

// Catalogs are bundled instead of fetched so remote and offline sessions
// never depend on reaching a static asset server.
void i18n.use(initReactI18next).init({
  resources: {
    "en-US": { translation: enUS },
    "pt-BR": { translation: ptBR },
  },
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
  missingKeyHandler: (_lngs, _ns, key) => {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] missing key: ${key}`);
    }
  },
});

/**
 * Lookup for keys built at runtime from registry ids (search items, keybinding
 * commands). The typed `t` only accepts literal catalog keys, so dynamic
 * registry lookups go through this single escape hatch with an explicit
 * English fallback.
 */
export function translateDynamic(
  key: string,
  fallback: string,
  values?: Record<string, unknown>,
): string {
  const lookup = i18n.t as unknown as (
    k: string,
    options: { defaultValue: string } & Record<string, unknown>,
  ) => string;
  return lookup(key, { defaultValue: fallback, ...values });
}

export default i18n;
