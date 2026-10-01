import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_LOCALE,
  LOCALE_META,
  SUPPORTED_LOCALES,
  type Locale,
} from "@lmcstools/client/i18n";
import { AsyncResult } from "effect/unstable/reactivity";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function SettingsLanguageRouteScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedLocale: Locale = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.locale ?? DEFAULT_LOCALE)
    : DEFAULT_LOCALE;

  return (
    <SettingsScreen title={t("settings.language.title")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title={t("settings.language.title")}>
          {SUPPORTED_LOCALES.map((locale, index) => (
            <Pressable
              key={locale}
              accessibilityRole="radio"
              accessibilityState={{
                checked: selectedLocale === locale,
                disabled: !preferencesReady,
              }}
              disabled={!preferencesReady}
              onPress={() => savePreferences({ locale })}
              className={
                index === 0
                  ? "flex-row items-center gap-4 p-4"
                  : "flex-row items-center gap-4 border-t border-border-subtle p-4"
              }
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-lg text-foreground">{LOCALE_META[locale].nativeLabel}</Text>
                <Text className="text-sm leading-normal text-foreground-muted">
                  {LOCALE_META[locale].label}
                </Text>
              </View>
              {selectedLocale === locale ? (
                <SymbolView
                  name="checkmark"
                  size={18}
                  tintColorClassName={"accent-icon"}
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
