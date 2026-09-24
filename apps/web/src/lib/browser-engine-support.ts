/**
 * Whether this browser can run the in-browser Office editor. The editor
 * frame isolates itself with Document-Isolation-Policy, which Chromium ships
 * from version 137 on desktop and 146 on Android. Other browsers are refused
 * rather than served by a server editor; the frame itself reports a Chromium
 * browser that still cannot isolate it.
 */
export const ENGINE_MINIMUM_CHROMIUM = { desktop: 137, mobile: 146 } as const;

export interface UserAgentData {
  brands?: Array<{ brand: string; version: string }>;
  mobile?: boolean;
}

export function browserEngineSupported(
  userAgentData: UserAgentData | undefined = (
    globalThis.navigator as { userAgentData?: UserAgentData } | undefined
  )?.userAgentData,
): boolean {
  const chromium = userAgentData?.brands?.find(
    ({ brand }) => brand === "Chromium",
  );
  const major = Number.parseInt(chromium?.version ?? "", 10);
  if (!Number.isInteger(major)) return false;
  return (
    major >=
    (userAgentData?.mobile
      ? ENGINE_MINIMUM_CHROMIUM.mobile
      : ENGINE_MINIMUM_CHROMIUM.desktop)
  );
}
