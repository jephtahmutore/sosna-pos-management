// ─── Dual-unit stock display helper ──────────────────────────────────────────
// Stock is always stored in the BASE unit. This helper formats it for display
// taking the alt unit + conversion factor into account, when set.
//
// Examples (base = pcs, alt = box, conv = 6):
//   60 → "10 box (60 pcs)"
//   58 → "9 box + 4 pcs (58 pcs)"
//   3  → "3 pcs"
//   0  → "0 pcs"
//
// Negative stock (over-issued) → fall back to "X.XX base" only — no need to
// confuse the user with "-9 box -4 pcs" math.

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Format a base-unit quantity with optional alt-unit breakdown.
 *
 * @param {number|string} qty Raw base-unit quantity from DB
 * @param {string} baseUnit  Product's base unit, e.g. "pcs"
 * @param {string|null} altUnit Product's alt unit, e.g. "box" or null
 * @param {number|null} conversion 1 alt = N base (must be > 0)
 * @param {object} opts { showBaseInParens: bool (default true), decimals: int (default 2) }
 */
export function formatStock(qty, baseUnit, altUnit, conversion, opts = {}) {
  const { showBaseInParens = true, decimals = 2 } = opts;
  const q = Number(qty) || 0;
  const conv = Number(conversion) || 0;
  const base = baseUnit || '';
  const alt = (altUnit || '').trim();

  // No alt unit configured, or invalid conversion → plain display
  if (!alt || !(conv > 0)) {
    return `${round2(q).toFixed(decimals)} ${base}`.trim();
  }

  // Negative or zero stock → just show base unit (avoid weird "-9 box -4 pcs")
  if (q < conv) {
    return `${round2(q).toFixed(decimals)} ${base}`.trim();
  }

  const numAlt = Math.floor(q / conv);
  const remainder = round2(q - numAlt * conv);

  let core;
  if (remainder === 0) {
    core = `${numAlt} ${alt}`;
  } else {
    core = `${numAlt} ${alt} + ${remainder.toFixed(decimals)} ${base}`;
  }

  return showBaseInParens
    ? `${core} (${round2(q).toFixed(decimals)} ${base})`
    : core;
}

/**
 * Returns just the alt-unit count, or null if no breakdown applies.
 * Useful for compact UI where you want "10 box" alone.
 */
export function altUnitCount(qty, conversion) {
  const q = Number(qty) || 0;
  const conv = Number(conversion) || 0;
  if (!(conv > 0) || q < conv) return null;
  return Math.floor(q / conv);
}

// ─── Multi-unit display ─────────────────────────────────────────────────────
// Picks the BIGGEST packaging that fits, falling back to the base unit for the remainder.
// e.g. with PCS (base), 6-pack (6), Box (24):
//   4800 PCS → "200 Box (4800 PCS)"        — Box fits cleanly, biggest chosen
//   4805 PCS → "200 Box + 5 PCS (4805 PCS)" — biggest + base remainder
//     23 PCS → "23 PCS"                     — below smallest non-base, base only
//
// Pass the full product object — we read units_json (multi-unit) and fall back to alt_unit.
export function formatStockForProduct(qty, product, opts = {}) {
  const { showBaseInParens = true, decimals = 2 } = opts;
  const q = Number(qty) || 0;
  const base = product?.unit || '';

  // Parse units. We avoid importing productUnits.js to keep this file dependency-free.
  let units = null;
  if (product?.units_json) {
    try { units = JSON.parse(product.units_json); } catch { units = null; }
  }
  if (!Array.isArray(units) || units.length === 0) {
    return formatStock(q, base, product?.alt_unit, product?.conversion_factor, opts);
  }

  // Only the BIGGEST packaging + base unit are shown. Middle packagings (e.g. 6-pack)
  // are deliberately skipped so the display stays "1 big unit + remainder in smallest".
  const nonBase = units
    .filter(u => !u.is_base && parseFloat(u.conv) > 1)
    .map(u => ({ name: u.name, conv: parseFloat(u.conv) }))
    .sort((a, b) => b.conv - a.conv);

  const big = nonBase[0]; // largest only
  if (!big || q <= 0 || q < big.conv) {
    return `${round2(q).toFixed(decimals)} ${base}`.trim();
  }

  const numBig = Math.floor(q / big.conv);
  const remainder = round2(q - numBig * big.conv);

  const core = remainder === 0
    ? `${numBig} ${big.name}`
    : `${numBig} ${big.name} + ${remainder.toFixed(decimals)} ${base}`;

  return showBaseInParens
    ? `${core} (${round2(q).toFixed(decimals)} ${base})`
    : core;
}
