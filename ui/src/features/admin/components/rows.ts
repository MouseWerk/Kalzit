import { type FocusEvent, type KeyboardEvent, useState } from "react";

const FIELD = /^(INPUT|SELECT|TEXTAREA)$/;

/**
 * Arrow-key navigation for a list of rows (roving tab index): one row is in the tab order, Up and
 * Down move between rows, Home and End jump. The controls inside a row stay reachable with Tab;
 * keys typed into a field are left to the field.
 */
export function useRowKeys(count: number) {
  const [active, setActive] = useState(0);
  const current = Math.max(0, Math.min(active, count - 1));

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const target = event.target as HTMLElement;
    if (FIELD.test(target.tagName)) {
      return;
    }
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-row]"));
    const row = target.closest<HTMLElement>("[data-row]");
    const index = row === null ? -1 : rows.indexOf(row);
    let next: HTMLElement | undefined;
    if (event.key === "Home") {
      next = rows[0];
    } else if (event.key === "End") {
      next = rows.at(-1);
    } else if (event.key === "ArrowDown") {
      next = rows[Math.min(index + 1, rows.length - 1)];
    } else {
      next = rows[Math.max(index - 1, 0)];
    }
    if (next !== undefined) {
      event.preventDefault();
      next.focus();
    }
  }

  return {
    listProps: { onKeyDown },
    rowProps: (index: number) => ({
      "data-row": "",
      tabIndex: index === current ? 0 : -1,
      onFocus: (event: FocusEvent<HTMLElement>) => {
        if (event.target === event.currentTarget) {
          setActive(index);
        }
      },
    }),
  };
}
