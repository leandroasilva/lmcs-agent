import i18next from "i18next";
import type { ReactNode } from "react";

import enUS from "../i18n/locales/en-US.json";

// Hook-harness tests invoke components as plain functions, where React's
// context dispatcher is null and the real useTranslation crashes. This uses a
// dedicated i18next instance instead of src/i18n: src/i18n imports the mocked
// react-i18next, which would deadlock the pending mock factory. `t` is bound
// once so hook dependency lists stay stable across harness re-renders.
void i18next.init({
  resources: { "en-US": { translation: enUS } },
  lng: "en-US",
  fallbackLng: "en-US",
  returnEmptyString: false,
  interpolation: { escapeValue: false },
});

export function reactI18nextMock() {
  const t = i18next.t as unknown as (key: string, values?: Record<string, unknown>) => string;
  return {
    Trans: ({ children }: { children?: ReactNode }) => children ?? null,
    useTranslation: () => ({ t }),
  };
}
