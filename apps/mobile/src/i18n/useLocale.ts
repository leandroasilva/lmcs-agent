import { DEFAULT_LOCALE, type Locale } from "@lmcstools/client/i18n";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { mobilePreferencesAtom } from "../state/preferences";
import i18n from "./index";

/**
 * Applies the device-persisted locale to i18next and returns it. Components
 * that render translated strings pair this with `useTranslation`, which
 * re-renders them on `languageChanged`.
 */
export function useLocale(): Locale {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const locale = preferences?.locale ?? DEFAULT_LOCALE;

  useEffect(() => {
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
  }, [locale]);

  return locale;
}
