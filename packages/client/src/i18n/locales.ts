import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from "@lmcstools/core/settings";

export { DEFAULT_LOCALE, SUPPORTED_LOCALES };
export type { Locale };

export const LOCALE_META: Record<
  Locale,
  {
    readonly label: string;
    readonly nativeLabel: string;
    readonly dir: "ltr" | "rtl";
  }
> = {
  "en-US": { label: "English", nativeLabel: "English", dir: "ltr" },
  "pt-BR": {
    label: "Portuguese (Brazil)",
    nativeLabel: "Português (Brasil)",
    dir: "ltr",
  },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
