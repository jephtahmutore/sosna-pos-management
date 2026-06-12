// Detects whether the web app is running inside the Sosna mobile APK
// (Capacitor webview).
//
// window.Capacitor only gets injected on local content. The APK loads the live
// tenant URL in the webview ("thin shell" pattern), so window.Capacitor is
// undefined on that origin. Instead we tag the webview's user-agent via
// capacitor.config.json (android.appendUserAgent = "SosnaMobileApp") and
// check for that token here.
export function isMobileApp() {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgent.includes('SosnaMobileApp');
}
