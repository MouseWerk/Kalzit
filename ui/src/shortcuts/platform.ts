/**
 * Whether the browser runs on a Mac (or an iPhone or iPad with a keyboard): the platform's
 * command key is then Cmd, and keys are drawn as the system draws them (⌃ ⌥ ⇧ ⌘). Read from
 * `navigator.userAgentData` where the browser has it, from `navigator.platform` otherwise.
 */
export function isMac(): boolean {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform =
    typeof data?.platform === "string" && data.platform !== "" ? data.platform : navigator.platform;
  return /mac|iphone|ipad/i.test(platform);
}
