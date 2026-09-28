import { useEffect } from "react";

import { LOCALE_META } from "@lmcstools/client/i18n";

import { useClientSettings } from "~/hooks/useSettings";

import i18n from "./index";

/** Applies the persisted locale to i18next and to the document element. */
export function LocaleSync() {
  const locale = useClientSettings((settings) => settings.locale);

  useEffect(() => {
    void i18n.changeLanguage(locale);
    document.documentElement.lang = locale;
    document.documentElement.dir = LOCALE_META[locale].dir;
  }, [locale]);

  return null;
}
