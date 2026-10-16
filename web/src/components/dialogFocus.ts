import { RefObject, useEffect } from "react";

export function useDialogFocus(
  ref: RefObject<HTMLElement>,
  onClose: () => void,
  enabled: boolean,
) {
  useEffect(() => {
    const current = ref.current;
    if (current === null) return undefined;
    const dialogElement: HTMLElement = current;

    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const focusables = getFocusable(dialogElement);
    (focusables[0] ?? dialogElement).focus();

    function onKeyDown(event: KeyboardEvent) {
      if (!enabled) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const currentFocusables = getFocusable(dialogElement);
      if (currentFocusables.length === 0) {
        event.preventDefault();
        dialogElement.focus();
        return;
      }

      const first = currentFocusables[0];
      const last = currentFocusables[currentFocusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    dialogElement.addEventListener("keydown", onKeyDown);
    return () => {
      dialogElement.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [enabled, onClose, ref]);
}

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      [
        "button:not([disabled])",
        "textarea:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "a[href]",
        "[tabindex]:not([tabindex='-1'])",
      ].join(","),
    ),
  ).filter((element) => !element.hasAttribute("aria-hidden"));
}
