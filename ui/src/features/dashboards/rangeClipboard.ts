import { useI18n } from "../../i18n/i18n";
import { readClipboard, writeClipboard } from "../../lib/clipboard";
import { showErrorToast, showToast } from "../../lib/toasts";
import { rangeFromClipboard, rangeToClipboard, type TextRange } from "./timeRange";

/**
 * Copying and pasting a range, shared by the picker and the t c / t v shortcuts: a toast says
 * what happened, also where the browser offers no clipboard (plain HTTP).
 */
export function useRangeClipboard() {
  const { t } = useI18n();
  return {
    async copy(range: TextRange): Promise<void> {
      if (await writeClipboard(rangeToClipboard(range))) {
        showToast({ message: t("toolbar.time.copied") });
      } else {
        showErrorToast(t("toolbar.time.copyFailed"));
      }
    },
    /** The pasted range, or null after saying why there is none. */
    async paste(): Promise<TextRange | null> {
      const text = await readClipboard();
      if (text === null) {
        showErrorToast(t("toolbar.time.pasteFailed"));
        return null;
      }
      const range = rangeFromClipboard(text, Date.now());
      if (range === null) {
        showErrorToast(t("toolbar.time.pasteInvalid"));
      }
      return range;
    },
  };
}
