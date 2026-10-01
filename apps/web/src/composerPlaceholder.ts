import { translateDynamic } from "./i18n";

export function disconnectedComposerPlaceholder(): string {
  return translateDynamic(
    "chat.composer.placeholderDisconnected",
    "Ask for changes, send follow-ups, or attach images",
  );
}
