import { useTranslation } from "react-i18next";

import { translateDynamic } from "~/i18n";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../../layout/WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const fallback = SETTINGS_BREADCRUMB_LABELS[normalizedPathname];
  return fallback
    ? translateDynamic(
        `settings.sections.${normalizedPathname.slice("/settings/".length)}`,
        fallback,
      )
    : null;
}

/**
 * `Settings / Section`. The scope a change applies to lives at the top of the
 * page content, see `SettingsScopeSentence`.
 */
export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const { t } = useTranslation();
  const sectionLabel = settingsBreadcrumbLabel(pathname);
  const rootLabel = t("settings.rootTitle");

  return (
    <WorkspaceBreadcrumb ariaLabel={t("settings.breadcrumbAria")}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{rootLabel}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? rootLabel}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
