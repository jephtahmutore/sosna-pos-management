// printHtml — render a complete HTML document (the same string previously
// passed to window.open + document.write) and route to one of three paths:
//
//   1. Desktop / Electron — hidden iframe + iframe.contentWindow.print().
//      Native print dialog, no popup.
//   2. Mobile browser (Chrome on Android, Safari on iOS) — generate a PDF
//      via html2pdf and trigger the browser's download. User picks Open /
//      Share / Print from the download notification.
//   3. Capacitor APK — Android's WebView ignores <a download> clicks, so we
//      generate the PDF bytes, write them via @capacitor/filesystem to
//      Documents/, then open the OS share sheet via @capacitor/share. From
//      there the user can save, open in a viewer, or send to a printer.
//
// The Mobile Print Mode toggle in System Settings overrides path 2 with
// path 1's print-dialog behaviour for phones that prefer it.

import { isMobileApp } from './platform';

const PHONE_BREAKPOINT = 768;
export const MOBILE_PRINT_MODE_KEY = 'sosna.mobilePrintMode';

const isPhone = () =>
  typeof window !== 'undefined' && window.innerWidth <= PHONE_BREAKPOINT;

const readMobilePrintMode = () => {
  try {
    const v = window.localStorage.getItem(MOBILE_PRINT_MODE_KEY);
    return v === 'print' ? 'print' : 'pdf';
  } catch (_) {
    return 'pdf';
  }
};

// Pull a filename out of the receipt HTML's <title>, or default to "receipt".
const filenameFromHtml = (html) => {
  try {
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const raw = (m && m[1]) || 'receipt';
    return raw.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'receipt';
  } catch (_) {
    return 'receipt';
  }
};

// ── Shared helper: render the full HTML inside a hidden, off-screen iframe ──
// Returns the iframe + a cleanup function. The receipt's own <style> rules
// (`body { width: 80mm; … }`) apply correctly inside the iframe's document,
// which is what fixes the "blank PDF" bug from v1.4.89.
function renderInIframe(html) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:fixed;top:0;left:-10000px;width:80mm;height:auto;min-height:200mm;border:0;background:#fff;';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    try { iframe.remove(); } catch (_) {}
  };

  return { iframe, doc, cleanup };
}

// ── PDF generation (returns a Blob) ─────────────────────────────────────────
// Used by both the mobile-browser download path and the Capacitor share path.
async function buildPdfBlob(html) {
  // Lazy-import so desktop bundles never pay the ~600 KB library cost.
  const html2pdf = (await import('html2pdf.js')).default;

  const { iframe, doc, cleanup } = renderInIframe(html);

  // Let the iframe finish layout / image decoding before we snapshot it.
  await new Promise((r) => setTimeout(r, 250));

  // Measure the iframe body so the PDF page height matches the content
  // (otherwise an 80×297mm page wastes a lot of space for a 10-line receipt).
  const body = doc.body;
  // 80mm @ 96dpi ≈ 302px. Compute height from the rendered body, capped to
  // avoid pathological multi-page generation.
  const heightPx = Math.max(body.scrollHeight || 0, 200);
  // Convert px → mm (96 dpi → 1mm = 3.7795px) and clamp to PDF max ~ 5000mm.
  const heightMm = Math.min(Math.max(heightPx / 3.7795, 60), 5000);

  try {
    const pdf = await html2pdf()
      .set({
        margin: 0,
        filename: `${filenameFromHtml(html)}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: 2,
          backgroundColor: '#ffffff',
          // Critical: tell html2canvas to render the IFRAME's document, not
          // the parent page. Without this, computed styles fall back to the
          // parent's CSS and the body styles never apply.
          windowWidth: body.scrollWidth,
          windowHeight: body.scrollHeight,
        },
        jsPDF: { unit: 'mm', format: [80, heightMm], orientation: 'portrait' },
      })
      .from(body)
      .outputPdf('blob');
    return pdf;
  } finally {
    cleanup();
  }
}

// Public — true when the device is a phone AND the Mobile Print Mode
// setting is "PDF Download". UI surfaces (e.g. a "Download PDF" button
// in the Sales Report view modal) gate themselves on this.
export const shouldShowMobilePdfButton = () =>
  isPhone() && readMobilePrintMode() === 'pdf';

// True only when we can actually call Capacitor plugins from this JS context.
// isMobileApp() looks at user-agent — but the thin-shell APK redirects to the
// live tenant URL, where window.Capacitor is undefined and any plugin call
// throws "not implemented". So gate plugin paths on this stronger check.
const isCapacitorBridgeReachable = () =>
  typeof window !== 'undefined' &&
  typeof window.Capacitor !== 'undefined' &&
  typeof window.Capacitor.isPluginAvailable === 'function' &&
  window.Capacitor.isPluginAvailable('Filesystem') &&
  window.Capacitor.isPluginAvailable('Share');

// Public — always run the PDF path regardless of platform/setting. Used by
// the explicit "Download PDF" button. Tries Capacitor first when the bridge
// is reachable, otherwise falls back to the browser <a download> path so
// the user at least gets a downloadable file in mobile Chrome / Safari.
export async function downloadPdf(html) {
  try {
    if (isCapacitorBridgeReachable()) {
      await sharePdfFromApk(html);
    } else {
      await downloadPdfInBrowser(html);
    }
  } catch (err) {
    // If the Capacitor path errored (e.g. bridge was reported reachable but
    // the actual write/share failed), try the browser path as a last resort
    // before bubbling the error up.
    try {
      await downloadPdfInBrowser(html);
      return;
    } catch (_) {}
    alert(`PDF failed: ${err?.message || err}`);
    throw err;
  }
}

// ── Path 2: Mobile browser — download the PDF ────────────────────────────
async function downloadPdfInBrowser(html) {
  const blob = await buildPdfBlob(html);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameFromHtml(html)}.pdf`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { a.remove(); } catch (_) {}
    URL.revokeObjectURL(url);
  }, 1000);
}

// ── Path 3: Capacitor APK — save to filesystem + share ───────────────────
async function sharePdfFromApk(html) {
  const blob = await buildPdfBlob(html);
  // Read the blob as base64 for Filesystem.writeFile.
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const r = fr.result || '';
      const i = String(r).indexOf(',');
      resolve(i >= 0 ? String(r).slice(i + 1) : String(r));
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

  // Lazy-import Capacitor plugins so the browser bundle doesn't pull them.
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');

  const filename = `${filenameFromHtml(html)}.pdf`;
  const written = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  });

  try {
    await Share.share({
      title: filename,
      url: written.uri,
      dialogTitle: 'Share receipt',
    });
  } catch (_) {
    // User dismissed the share sheet — file is still saved at written.uri.
  }
}

// ── Path 1: Desktop / Electron — hidden iframe + print dialog ────────────
function printViaIframe(html) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    try { iframe.remove(); } catch (_) {}
  };

  iframe.onload = () => {
    try {
      const cw = iframe.contentWindow;
      cw.focus();
      if (cw && 'onafterprint' in cw) cw.onafterprint = cleanup;
      cw.print();
    } catch (_) {
      cleanup();
    }
    setTimeout(cleanup, 60_000);
  };

  if ('srcdoc' in iframe) {
    iframe.srcdoc = html;
  } else {
    iframe.onload = () => {
      try {
        const d = iframe.contentDocument || iframe.contentWindow.document;
        d.open(); d.write(html); d.close();
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (_) {}
      setTimeout(cleanup, 60_000);
    };
    iframe.src = 'about:blank';
  }
}

export default function printHtml(html) {
  if (typeof document === 'undefined') return;

  // Capacitor APK with reachable bridge — share via OS share sheet.
  // (The thin-shell APK loses the bridge on the redirected tenant URL,
  //  so we can only reach plugins from the bootstrap page itself.)
  if (isCapacitorBridgeReachable()) {
    sharePdfFromApk(html).catch(() => downloadPdfInBrowser(html).catch(() => {}));
    return;
  }

  if (isPhone() && readMobilePrintMode() === 'pdf') {
    downloadPdfInBrowser(html).catch(() => {});
    return;
  }

  printViaIframe(html);
}
