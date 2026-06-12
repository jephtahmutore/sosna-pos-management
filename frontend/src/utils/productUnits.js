// Frontend helper: parse a product's stored units configuration into a uniform array.
// Reads units_json first (the multi-unit shape), falls back to legacy alt_unit/conversion_factor/alt_price.
// Always returns at least one row: the base unit with conv=1.
export const unitsForProduct = (product) => {
  let arr = null;
  if (product?.units_json) {
    try { arr = JSON.parse(product.units_json); } catch { arr = null; }
  }
  if (Array.isArray(arr) && arr.length) {
    return arr.map(u => ({
      name: u.name,
      conv: parseFloat(u.conv) || 1,
      price: parseFloat(u.price) || 0,
      is_base: !!u.is_base,
    }));
  }
  const baseName = product?.unit || 'pcs';
  const out = [{ name: baseName, conv: 1, price: parseFloat(product?.selling_price) || 0, is_base: true }];
  if (product?.alt_unit && parseFloat(product.conversion_factor) > 0) {
    out.push({
      name: product.alt_unit,
      conv: parseFloat(product.conversion_factor),
      price: parseFloat(product.alt_price) || 0,
      is_base: false,
    });
  }
  return out;
};

// Pick the "display" unit for a product. Order of preference:
//   1. product.default_unit if it matches one of the configured units
//   2. otherwise the LARGEST non-base unit (biggest conv) — so a product with
//      Crate/Box/6Pack/pcs defaults to Crate instead of pcs
//   3. otherwise the base unit
// Returns the unit object: { name, conv, price, is_base }.
export const pickDisplayUnit = (product) => {
  const units = unitsForProduct(product);
  if (units.length === 0) return { name: product?.unit || 'pcs', conv: 1, price: 0, is_base: true };
  if (product?.default_unit) {
    const explicit = units.find(u => u.name === product.default_unit);
    if (explicit) return explicit;
  }
  const nonBase = units.filter(u => !u.is_base);
  if (nonBase.length > 0) {
    return nonBase.reduce((biggest, u) => (u.conv > biggest.conv ? u : biggest), nonBase[0]);
  }
  return units.find(u => u.is_base) || units[0];
};

// Convert a base-unit quantity into the product's display unit.
// Returns { qty, unit } so call sites can render `${qty} ${unit}`.
export const displayInDefaultUnit = (baseQty, product) => {
  const u = pickDisplayUnit(product);
  const conv = u.conv || 1;
  return { qty: parseFloat(baseQty || 0) / conv, unit: u.name };
};

// Convert a per-base-unit price into the per-display-unit price.
export const displayPriceInDefaultUnit = (basePrice, product) => {
  const u = pickDisplayUnit(product);
  const conv = u.conv || 1;
  return { price: parseFloat(basePrice || 0) * conv, unit: u.name };
};
