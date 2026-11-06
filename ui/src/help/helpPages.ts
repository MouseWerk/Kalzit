/**
 * The guide pages shipped with the UI and readable before sign-in (src/help/HelpPage.tsx). Kept
 * apart from the page, so the help route can check a name without loading the guide texts.
 */
export const HELP_PAGES = ["getting-started", "installation"] as const;
export type HelpPageName = (typeof HELP_PAGES)[number];
