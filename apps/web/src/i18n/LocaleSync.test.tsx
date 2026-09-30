import { act } from "react";
import { create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { changeLanguage, selectLocale } = vi.hoisted(() => ({
  changeLanguage: vi.fn().mockResolvedValue(undefined),
  selectLocale: { current: "pt-BR" as string },
}));

vi.mock("./index", () => ({ default: { changeLanguage } }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { locale: string }) => unknown) =>
    selector({ locale: selectLocale.current }),
}));

import { LocaleSync } from "./LocaleSync";

let renderer: ReturnType<typeof create> | undefined;
let documentElement: { lang: string; dir: string };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  changeLanguage.mockClear();
  documentElement = { lang: "", dir: "" };
  vi.stubGlobal("document", { documentElement });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function renderLocaleSync() {
  await act(() => {
    renderer = create(<LocaleSync />);
  });
}

describe("LocaleSync", () => {
  it("applies the persisted locale to i18next and the document element", async () => {
    selectLocale.current = "pt-BR";
    await renderLocaleSync();
    expect(changeLanguage).toHaveBeenCalledWith("pt-BR");
    expect(documentElement.lang).toBe("pt-BR");
    expect(documentElement.dir).toBe("ltr");
  });

  it("re-applies when the persisted locale changes", async () => {
    selectLocale.current = "en-US";
    await renderLocaleSync();
    expect(changeLanguage).toHaveBeenLastCalledWith("en-US");
    expect(documentElement.lang).toBe("en-US");

    await act(() => {
      selectLocale.current = "pt-BR";
      renderer?.update(<LocaleSync />);
    });
    expect(changeLanguage).toHaveBeenLastCalledWith("pt-BR");
    expect(documentElement.lang).toBe("pt-BR");
  });
});
