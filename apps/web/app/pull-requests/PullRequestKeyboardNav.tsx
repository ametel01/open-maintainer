"use client";

import { useEffect } from "react";

export function PullRequestKeyboardNav() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (event.key === "/") {
        const search = document.querySelector<HTMLElement>("[data-pr-search]");
        if (search) {
          event.preventDefault();
          search.focus();
        }
        return;
      }
      if (event.key !== "j" && event.key !== "k") {
        return;
      }
      const items = [
        ...document.querySelectorAll<HTMLElement>("[data-pr-nav-item]"),
      ];
      if (items.length === 0) {
        return;
      }
      event.preventDefault();
      const active = document.activeElement;
      const currentIndex = items.findIndex((item) => item === active);
      const fallbackIndex = event.key === "j" ? -1 : 0;
      const nextIndex =
        event.key === "j"
          ? Math.min(items.length - 1, (currentIndex ?? fallbackIndex) + 1)
          : Math.max(0, (currentIndex < 0 ? items.length : currentIndex) - 1);
      items[nextIndex]?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return null;
}
