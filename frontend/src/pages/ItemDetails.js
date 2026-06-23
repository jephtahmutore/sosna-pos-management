import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getProducts, createProduct, updateProduct, updateProductBarcode, deleteProduct, uploadProductImage, deleteProductImage, getSettings, getCategories, getMainCategories, getUnits, deleteAllProducts, importProducts, isHqHost } from '../services/api';
import CategoryFilter from '../components/CategoryFilter';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { FiSearch, FiPlus, FiEdit2, FiTrash2, FiCamera, FiX, FiZap, FiPrinter, FiUpload, FiDownload, FiAlertTriangle } from 'react-icons/fi';
import { FaBarcode } from 'react-icons/fa';
import { formatStock, formatStockForProduct } from '../utils/unitFormat';
import { unitsForProduct, pickDisplayUnit, displayInDefaultUnit, displayPriceInDefaultUnit } from '../utils/productUnits';
import { useCurrency } from '../context/CurrencyContext';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const API_BASE = process.env.REACT_APP_API_URL?.replace('/api', '') || 'http://localhost:5300';

const getCategoryClass = (cat) => {
  const map = { 'Beef': 'category-beef', 'Chicken': 'category-chicken', 'Pork': 'category-pork', 'Lamb': 'category-lamb', 'Processed': 'category-processed' };
  return map[cat] || 'badge-gray';
};

// Inline category badge style for the print document
const catBadgeStyle = (cat) => {
  const map = {
    'Beef':      { background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5' },
    'Chicken':   { background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a' },
    'Pork':      { background: '#ede9fe', color: '#5b21b6', border: '1px solid #c4b5fd' },
    'Lamb':      { background: '#dcfce7', color: '#166534', border: '1px solid #86efac' },
    'Processed': { background: '#e0f2fe', color: '#075985', border: '1px solid #7dd3fc' },
  };
  return {
    ...(map[cat] || { background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db' }),
    padding: '2px 8px', borderRadius: 12, fontSize: 10.5, fontWeight: 600, display: 'inline-block',
  };
};

const emptyBarcodeForm = { ub_number_start: 1, ub_number_length: 6, ub_quantity_start: 7, ub_quantity_length: 0, ub_decimal_start: 2 };

const BarcodePreview = ({ form }) => {
  const numStart  = parseInt(form.ub_number_start)  || 0;
  const numLen    = parseInt(form.ub_number_length)  || 0;
  const qStart    = parseInt(form.ub_quantity_start) || 0;
  const qLen      = parseInt(form.ub_quantity_length)|| 0;
  const decStart  = parseInt(form.ub_decimal_start)  || 0;
  const totalLen  = Math.max(numStart + numLen, qLen > 0 ? qStart + qLen : 0) + 1;
  const sample    = '2000006009982'.padEnd(totalLen, '?').slice(0, totalLen);
  return (
    <div style={{ marginTop: 16, padding: '12px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live Preview</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, fontFamily: 'monospace', fontSize: 15 }}>
        {sample.split('').map((char, i) => {
          const isCode   = i >= numStart && i < numStart + numLen;
          const isWeight = qLen > 0 && i >= qStart && i < qStart + qLen;
          return (
            <span key={i} style={{
              padding: '3px 5px', borderRadius: 4, fontWeight: 700,
              background: isCode ? '#dbeafe' : isWeight ? '#dcfce7' : '#f1f5f9',
              color:      isCode ? '#1d4ed8' : isWeight ? '#15803d' : '#94a3b8',
              border: `1px solid ${isCode ? '#93c5fd' : isWeight ? '#86efac' : '#e2e8f0'}`,
            }}>{char}</span>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12 }}>
        <span style={{ color: '#1d4ed8' }}>■ Product Code (pos {numStart}–{numStart + numLen - 1})</span>
        {qLen > 0 && <span style={{ color: '#15803d' }}>■ Weight (pos {qStart}–{qStart + qLen - 1})</span>}
      </div>
      {qLen > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#475569' }}>
          Weight digits: <strong>{sample.slice(qStart, qStart + qLen)}</strong> → insert decimal at {decStart} →{' '}
          <strong>{sample.slice(qStart, qStart + decStart)}.{sample.slice(qStart + decStart, qStart + qLen)}</strong> ={' '}
          <strong style={{ color: '#15803d' }}>{parseFloat(sample.slice(qStart, qStart + decStart) + '.' + sample.slice(qStart + decStart, qStart + qLen)).toFixed(3)} kg</strong>
        </div>
      )}
    </div>
  );
};

const ItemDetails = () => {
  const { t } = useLanguage();
  const { hasPermission, user: authUser } = useAuth();
  const { symbol: curSym } = useCurrency();
  // v1.6.1: HQ uses the same Item Details page that branches use. HQ
  // sees the New/Import/Sample buttons; branches don't (only HQ creates).
  // Inside the modal the form is split into two tabs — Item Details
  // (HQ-owned fields) and Pricing & Stock (branch-owned fields). HQ sees
  // only Tab 1; branches see both but Tab 1 is read-only for is_hq_owned=1
  // rows.
  const isBranch = !isHqHost();
  const isHq     = !isBranch;
  // Modal tab state — 'details' (Tab 1) or 'pricing' (Tab 2).
  const [activeTab, setActiveTab] = useState('details');
  const [items, setItems] = useState([]);
  const [dbCategories, setDbCategories] = useState([]);
  const [dbMainCategories, setDbMainCategories] = useState([]);
  const [dbUnits, setDbUnits] = useState([]);
  const [selMainIds, setSelMainIds] = useState(null);
  const [selCatIds, setSelCatIds] = useState(null);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState(null);
  // packagings: additional larger units (e.g. [{ name: 'Pack', conv: 6, price: 11 }, { name: 'Box', conv: 24, price: 40 }]).
  // The base unit (form.unit) is always the smallest packaging and lives in its own fields.
  // v1.7.2 — opening_base + per-packaging `opening` mirrors Grocery's pattern:
  // user enters how many of each unit they have ("46 Box + 10 Bottle"); save
  // collapses to a single base-unit total stored as current_stock in DB.
  const [form, setForm] = useState({ code: '', name: '', category_id: '', unit: 'pcs', cost_price: '', selling_price: '', current_stock: '', opening_base: '', min_stock: '', min_stock_unit: '', status: 'Active', packagings: [], container_product_sync_id: '', units_per_container: '', default_unit: '' });
  const [formError, setFormError] = useState('');
  const [importMsg, setImportMsg] = useState('');
  // Per-row breakdown of the last import — {imported_rows:[{row,code,name}],
  // skipped_rows:[{row,code,name,reason}]} — shown in a collapsible panel
  // below the status banner so the user can see exactly which CSV rows
  // landed and which got dropped (and why).
  const [importDetail, setImportDetail] = useState(null);
  const [importing, setImporting] = useState(false);
  const csvInputRef = React.useRef(null);
  // Admin-password gate: { kind: 'single' | 'all', item?: { id, name } }
  const [pendingDelete, setPendingDelete] = useState(null);
  // v1.6.7: same gate for unlocking a saved packaging row's conversion
  // factor. Holds the row index that the admin wants to unlock so the
  // password prompt knows which row to flip _locked=false on.
  const [pendingUnlockPack, setPendingUnlockPack] = useState(null);

  const handleDeleteAll = () => {
    setPendingDelete({ kind: 'all' });
  };

  const runDeleteAll = async () => {
    try {
      const res = await deleteAllProducts();
      await fetchItems();
      alert(res?.data?.message || 'Done.');
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete all products.');
    }
  };

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    setImporting(true);
    setImportMsg('');
    setImportDetail(null);
    try {
      const res = await importProducts(file);
      setImportMsg(res.data.message);
      setImportDetail({
        imported_rows: res.data.imported_rows || [],
        skipped_rows:  res.data.skipped_rows  || [],
      });
      await fetchItems();
    } catch (err) {
      setImportMsg(err.response?.data?.error || 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  const handleDownloadSample = () => {
    // v1.6.2 — HQ-only columns. Branch-owned (cost/selling/current_stock/
    // min_stock/alt_price) are intentionally absent: branches set those
    // on their own Item Details page. Backend ignores them on HQ import
    // even if present in the file.
    const csv =
      'code,name,category,main_category,unit,default_unit,alt_unit,conversion_factor,units_per_container\n' +
      'CL001,Castlite 330ml RB,Beer,Beverage,Bottle,Crate,Crate,24,24\n' +
      'EC001,Eagle Cassava 375ml RB,Beer,Beverage,Bottle,Crate,Crate,24,24\n' +
      'SV001,Savanna 330ml,Cider,Beverage,Bottle,Pack,Pack,12,12\n' +
      'HG001,Hunter Gold 750ml,Spirits,Beverage,Bottle,Box,Box,6,6\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'sosna_hq_items.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);

  const [showBarcodeModal, setShowBarcodeModal] = useState(false);
  const [barcodeItem, setBarcodeItem]  = useState(null);
  const [barcodeForm, setBarcodeForm]  = useState(emptyBarcodeForm);

  useModalScrollLock(showModal || showBarcodeModal);
  const [barcodeSaving, setBarcodeSaving] = useState(false);

  // Print preview
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  const [businessInfo, setBusinessInfo] = useState({});

  // Barcode scanner
  const scannerBuffer = useRef('');
  const scannerTimer = useRef(null);
  const itemsRef = useRef([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const handleScannerKey = useCallback((e) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'Enter') {
      const code = scannerBuffer.current.trim();
      scannerBuffer.current = '';
      clearTimeout(scannerTimer.current);
      if (!code) return;
      const found = itemsRef.current.find(p => p.code && p.code.toLowerCase() === code.toLowerCase());
      if (found) {
        setSearch(found.name);
      } else {
        // Open Add New with scanned code pre-filled
        setEditItem(null);
        setForm({ code, name: '', category_id: '', unit: 'pcs', cost_price: '', selling_price: '', current_stock: '', opening_base: '', min_stock: '', min_stock_unit: '', product_type: 'sellable', status: 'Active', packagings: [], container_product_sync_id: '', units_per_container: '', default_unit: '' });
        setImageFile(null); setImagePreview(null); setFormError('');
        setShowModal(true);
      }
    } else if (e.key.length === 1) {
      scannerBuffer.current += e.key;
      clearTimeout(scannerTimer.current);
      scannerTimer.current = setTimeout(() => { scannerBuffer.current = ''; }, 300);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleScannerKey);
    return () => window.removeEventListener('keydown', handleScannerKey);
  }, [handleScannerKey]);

  useEffect(() => {
    fetchItems();
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    getCategories().then(r => setDbCategories(r.data || [])).catch(() => {});
    getMainCategories().then(r => setDbMainCategories(r.data || [])).catch(() => {});
    getUnits().then(r => setDbUnits(r.data || [])).catch(() => {});
  }, []);

  const fetchItems = async () => {
    try {
      const res = await getProducts();
      setItems(res.data || []);
    } catch (err) { setItems([]); }
  };

  const activeCatIds = selCatIds === null ? null : new Set(selCatIds.map(String));
  const filtered = items.filter(i => {
    const matchSearch = !search || (i.name || '').toLowerCase().includes(search.toLowerCase()) || (i.code || '').toLowerCase().includes(search.toLowerCase());
    const matchCat = activeCatIds === null
      ? true
      : i.category_id ? activeCatIds.has(String(i.category_id)) : false;
    return matchSearch && matchCat;
  });

  const generateCode = () => {
    // Derive prefix from category name: first letter + up to 2 consonants
    const cat = dbCategories.find(c => String(c.id) === String(form.category_id));
    const prefix = (() => {
      if (!cat?.name) return 'IT';
      const vowels = new Set(['A','E','I','O','U']);
      const letters = cat.name.toUpperCase().replace(/[^A-Z]/g, '');
      const consonantsAfterFirst = letters.slice(1).split('').filter(c => !vowels.has(c));
      return (letters[0] + consonantsAfterFirst.join('')).substring(0, 3) || 'IT';
    })();
    let num = 1;
    let code;
    do {
      code = `${prefix}${String(num).padStart(3, '0')}`;
      num++;
    } while (items.some(i => i.code === code));
    setForm(prev => ({ ...prev, code }));
    setFormError('');
  };

  const handleSave = async () => {
    setFormError('');
    if (!form.code.trim()) {
      setFormError('Item code is required. Enter a code or click ⚡ to generate one.');
      return;
    }
    if (!form.name.trim()) {
      setFormError('Item name is required.');
      return;
    }
    const duplicate = items.find(i => i.code.trim().toLowerCase() === form.code.trim().toLowerCase() && (!editItem || i.id !== editItem.id));
    if (duplicate) {
      setFormError(`Code "${form.code}" is already used by "${duplicate.name}". Please choose a different code.`);
      return;
    }
    if (form.cost_price !== '' && parseFloat(form.cost_price) < 0) { setFormError('Cost Price cannot be negative.'); return; }
    if (form.selling_price !== '' && parseFloat(form.selling_price) < 0) { setFormError('Selling Price cannot be negative.'); return; }
    if (form.opening_base !== '' && parseFloat(form.opening_base) < 0) { setFormError('Opening Stock cannot be negative.'); return; }
    for (const p of (form.packagings || [])) {
      if (p.opening !== '' && p.opening != null && parseFloat(p.opening) < 0) { setFormError(`Opening for "${p.name}" cannot be negative.`); return; }
    }
    if (form.min_stock !== '' && parseFloat(form.min_stock) < 0) { setFormError('Min. Stock cannot be negative.'); return; }
    // Validate additional packagings: each must have a name + positive conversion factor.
    const seenNames = new Set([(form.unit || '').trim().toLowerCase()]);
    for (const p of (form.packagings || [])) {
      const name = (p.name || '').trim();
      if (!name) { setFormError('Packaging name cannot be empty.'); return; }
      if (seenNames.has(name.toLowerCase())) { setFormError(`Duplicate packaging name: ${name}.`); return; }
      seenNames.add(name.toLowerCase());
      if (!(parseFloat(p.conv) > 0)) { setFormError(`Conversion for "${name}" must be greater than 0.`); return; }
      if (p.price !== '' && parseFloat(p.price) < 0) { setFormError(`Price for "${name}" cannot be negative.`); return; }
    }
    try {
      // Build the units array — base first, then any larger packagings the user added.
      const units = [
        { name: (form.unit || 'pcs').trim() || 'pcs', conv: 1, price: parseFloat(form.selling_price || 0), is_base: true },
        ...(form.packagings || []).map(p => ({
          name: (p.name || '').trim(),
          conv: parseFloat(p.conv) || 0,
          price: parseFloat(p.price || 0),
          is_base: false,
        })),
      ];
      // Min Stock was entered in form.min_stock_unit (e.g. "Box"). Convert back
      // to base units before saving so the DB always holds it in the base unit.
      const minStockUnit = (form.min_stock_unit || '').trim();
      const minStockConv = minStockUnit
        ? (units.find(u => u.name === minStockUnit)?.conv || 1)
        : 1;
      const minStockEntered = form.min_stock === '' ? 10 : parseFloat(form.min_stock);
      // v1.7.2 (Grocery pattern): total opening stock = base qty + Σ(pack.qty × pack.conv).
      // The form lets the user type "46 Box + 10 Bottle"; we collapse it to a single
      // base-unit number (1114 Bottle) before saving. DB stores the total only.
      const openingBaseQty = parseFloat(form.opening_base) || 0;
      const openingPackQty = (form.packagings || []).reduce((sum, p) => {
        const q = parseFloat(p.opening) || 0;
        const c = parseFloat(p.conv) || 0;
        return sum + (q * c);
      }, 0);
      const totalOpening = openingBaseQty + openingPackQty;
      const data = {
        ...form,
        cost_price:    form.cost_price    === '' ? 0  : parseFloat(form.cost_price),
        selling_price: form.selling_price === '' ? 0  : parseFloat(form.selling_price),
        current_stock: totalOpening,
        min_stock:     minStockEntered * minStockConv,
        category_id:   form.category_id   === '' ? null : parseInt(form.category_id),
        units,
        container_product_sync_id: form.container_product_sync_id || null,
        units_per_container: form.units_per_container === '' ? null : parseFloat(form.units_per_container),
      };
      delete data.packagings;
      delete data.opening_base;
      delete data.min_stock_unit;
      let savedProduct;
      if (editItem) {
        const res = await updateProduct(editItem.id, data);
        savedProduct = res.data;
      } else {
        const res = await createProduct(data);
        savedProduct = res.data;
      }
      if (imageFile && savedProduct?.id) await uploadProductImage(savedProduct.id, imageFile);
      fetchItems();
      setShowModal(false);
      setEditItem(null);
      setImageFile(null);
      setImagePreview(null);
      setFormError('');
    } catch (err) {
      setFormError('Failed to save item: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleRemoveImage = async () => {
    if (editItem?.id && editItem.image_url) {
      try { await deleteProductImage(editItem.id); } catch (err) { /* ignore */ }
    }
    setImageFile(null);
    setImagePreview(null);
    if (editItem) setEditItem(prev => ({ ...prev, image_url: null }));
  };

  const handleDelete = (item) => {
    setPendingDelete({ kind: 'single', item: { id: item.id, name: item.name } });
  };

  const runDeleteSingle = async (id) => {
    try {
      await deleteProduct(id);
      fetchItems();
    } catch (err) {
      // Show the backend's blocking message (e.g. "used in 3 GRN line(s)…") instead of
      // silently removing the row from the UI.
      alert(err.response?.data?.error || err.message || 'Failed to delete item.');
    }
  };

  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (!job) return;
    if (job.kind === 'all') return runDeleteAll();
    if (job.kind === 'single') return runDeleteSingle(job.item.id);
  };

  const openNew = () => {
    setEditItem(null);
    // Pre-generate the code so the user can just type a name + save.
    // Mirrors generateCode() but inlined because that one reads
    // form.category_id from state (which we just cleared in this same
    // tick — it'd still see the previous form value due to React's
    // batched updates). 'IT' is the empty-category prefix.
    const taken = new Set(items.map(i => i.code));
    let n = 1, code;
    do { code = `IT${String(n).padStart(3, '0')}`; n++; } while (taken.has(code));
    setForm({ code, name: '', category_id: '', unit: 'pcs', cost_price: '', selling_price: '', current_stock: '', opening_base: '', min_stock: '', min_stock_unit: '', product_type: 'sellable', status: 'Active', packagings: [], container_product_sync_id: '', units_per_container: '', default_unit: '' });
    setImageFile(null); setImagePreview(null); setFormError('');
    setActiveTab('details');
    setShowModal(true);
  };

  // Parse units_json into the form's `packagings` array (skipping the base row, which lives in form.unit / form.selling_price).
  const buildPackagingsFromItem = (item) => {
    let arr = null;
    if (item.units_json) {
      try { arr = JSON.parse(item.units_json); } catch { arr = null; }
    }
    if (Array.isArray(arr) && arr.length) {
      // _locked: this row was loaded from the saved product, so its conversion factor is fixed
      // (historical stock movements rely on it). Price stays editable; users can add NEW packagings freely.
      return arr.filter(u => !u.is_base && (u.name || '').trim()).map(u => ({
        name: u.name, conv: String(u.conv ?? ''), price: String(u.price ?? ''), opening: '', _locked: true,
      }));
    }
    // Legacy fallback — single alt_unit row.
    if (item.alt_unit) {
      return [{ name: item.alt_unit, conv: String(item.conversion_factor ?? ''), price: String(item.alt_price ?? ''), opening: '', _locked: true }];
    }
    return [];
  };

  const openEdit = (item) => {
    setEditItem(item);
    // Min Stock is stored in base units. Display it in the product's default
    // unit (or base if none set) so the user reads/edits in the same unit
    // they see on Stock Card etc.
    const dispUnit = pickDisplayUnit(item);
    const minStockInDispUnit = parseFloat(item.min_stock || 0) / (dispUnit.conv || 1);
    setForm({
      code: item.code, name: item.name, category_id: item.category_id, unit: item.unit,
      cost_price: item.cost_price, selling_price: item.selling_price,
      current_stock: item.current_stock,
      // DB stores only the collapsed base-unit total. Seed opening_base with it
      // so re-saving is idempotent. Users who want "46 Box + 10 Bottle" form
      // can zero this and fill in the packaging rows.
      opening_base: item.current_stock != null ? String(item.current_stock) : '',
      min_stock: minStockInDispUnit ? String(minStockInDispUnit) : '',
      min_stock_unit: dispUnit.name || item.unit || '',
      product_type: item.product_type || 'finished',
      status: item.status || 'Active',
      packagings: buildPackagingsFromItem(item),
      container_product_sync_id: item.container_product_sync_id || '',
      units_per_container: item.units_per_container ?? '',
      default_unit: item.default_unit || '',
    });
    setImageFile(null);
    setImagePreview(item.image_url ? `${API_BASE}${item.image_url}` : null);
    setFormError('');
    // Branch editing an HQ-owned item → land on Pricing tab (since Details
    // is read-only there). HQ + non-HQ items → land on Details tab.
    setActiveTab(isBranch && item.is_hq_owned ? 'pricing' : 'details');
    setShowModal(true);
  };

  const closeModal = () => { setShowModal(false); setFormError(''); };

  const openBarcodeSettings = (item) => {
    setBarcodeItem(item);
    const defaultQtyLen = String(item.code || '').length === 6 ? 5 : 0;
    setBarcodeForm({
      ub_number_start:    item.ub_number_start   ?? 1,
      ub_number_length:   item.ub_number_length  ?? 6,
      ub_quantity_start:  item.ub_quantity_start  ?? 7,
      ub_quantity_length: item.ub_quantity_length ?? defaultQtyLen,
      ub_decimal_start:   item.ub_decimal_start   ?? 2,
    });
    setShowBarcodeModal(true);
  };

  const saveBarcodeSettings = async () => {
    setBarcodeSaving(true);
    try {
      const pInt = (val, def) => { const n = parseInt(val); return isNaN(n) ? def : n; };
      const newUB = {
        ub_number_start:    pInt(barcodeForm.ub_number_start,    1),
        ub_number_length:   pInt(barcodeForm.ub_number_length,   6),
        ub_quantity_start:  pInt(barcodeForm.ub_quantity_start,  7),
        ub_quantity_length: pInt(barcodeForm.ub_quantity_length, 0),
        ub_decimal_start:   pInt(barcodeForm.ub_decimal_start,   2),
      };
      const res = await updateProductBarcode(barcodeItem.id, newUB);
      const saved = res.data ? res.data : { ...barcodeItem, ...newUB };
      setItems(prev => prev.map(i => i.id === barcodeItem.id ? { ...i, ...saved } : i));
      setShowBarcodeModal(false);
      fetchItems();
    } catch (err) {
      alert('Failed to save barcode settings: ' + (err.response?.data?.error || err.message));
    } finally { setBarcodeSaving(false); }
  };

  const setBF = (field) => (e) => setBarcodeForm(prev => ({ ...prev, [field]: e.target.value }));
  const inputSt = { width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' };
  const labelSt = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };

  // ── Print preview stats — follow the filter ──
  const lowStockItems = filtered.filter(i => parseFloat(i.store_balance || 0) <= parseFloat(i.min_stock || 0));
  const categories    = [...new Set(filtered.map(i => i.category_name).filter(Boolean))];

  // Subtotals by main category (for display below the table)
  const subtotalsByMain = (() => {
    const map = new Map();
    for (const item of filtered) {
      const main = dbMainCategories.find(m => String(m.id) === String(item.main_category_id));
      const key = main ? main.id : '__unassigned__';
      const name = main ? main.name : 'Uncategorized';
      const color = main ? main.color : '#6b7280';
      if (!map.has(key)) map.set(key, { name, color, count: 0, totalSell: 0 });
      const entry = map.get(key);
      entry.count += 1;
      entry.totalSell += parseFloat(item.selling_price || 0);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  })();

  const handlePrint = () => {
    const bizName = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  |  ');
    const printedAt = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const avgSell = items.length > 0 ? (items.reduce((s, i) => s + parseFloat(i.selling_price || 0), 0) / items.length).toFixed(2) : '0.00';

    const rows = items.map((item, idx) => {
      const isLow = parseFloat(item.store_balance || 0) <= parseFloat(item.min_stock || 0);
      return `<tr style="border-bottom:1px solid #ddd;background:${isLow ? '#f5f5f5' : idx % 2 === 1 ? '#f9f9f9' : '#fff'}">
        <td style="padding:7px 10px;font-size:10.5px">${idx + 1}</td>
        <td style="padding:7px 10px;font-weight:700;font-family:monospace;font-size:11px">${item.code || '—'}</td>
        <td style="padding:7px 10px;font-weight:500">${item.name}</td>
        <td style="padding:7px 10px">${item.category_name || '—'}</td>
        <td style="padding:7px 10px">${item.unit || '—'}</td>
        <td style="padding:7px 10px;text-align:right;font-family:monospace">${(parseFloat(parseFloat(item.avg_cost_price || item.cost_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        <td style="padding:7px 10px;text-align:right;font-weight:600;font-family:monospace">${(parseFloat(parseFloat(item.selling_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        <td style="padding:7px 10px;text-align:right;font-family:monospace">${(parseFloat(parseFloat(item.min_stock || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        <td style="padding:7px 10px;text-align:right;font-weight:700;font-family:monospace">${isLow ? '⚠ ' : ''}${(parseFloat(parseFloat(item.store_balance || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} ${item.unit || ''}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:8px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10px;background:#f0f0f0;text-align:left}
      tfoot td{padding:9px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;margin-bottom:6px">Product Items List</div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${bizName}</div>
          <div style="font-size:10px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:14px;font-weight:700">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
          <div style="font-size:9px;margin-top:4px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:14px">
        ${[['Total Items', items.length], ['Categories', categories.length], ['Low Stock', lowStockItems.length], ['Avg. Sell Price', '$' + avgSell]].map(([lbl, val]) => `
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:16px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:16px">
        <div style="background:#000;padding:7px 12px">
          <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#fff">Product Inventory</span>
        </div>
        <table style="font-size:11px">
          <thead><tr>
            <th style="width:24px">#</th>
            <th>Code</th><th>Item Name</th><th>Category</th><th>Unit</th>
            <th style="text-align:right">Cost Price</th>
            <th style="text-align:right">Sell Price</th>
            <th style="text-align:right">Min. Stock</th>
            <th style="text-align:right">Store Balance</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <td colspan="5">Total — ${items.length} items</td>
            <td style="text-align:right">—</td>
            <td style="text-align:right">Avg $${avgSell}</td>
            <td colspan="2" style="text-align:right">${lowStockItems.length > 0 ? `⚠ ${lowStockItems.length} low on stock` : '✓ All OK'}</td>
          </tr></tfoot>
        </table>
      </div>
      ${lowStockItems.length > 0 ? `
        <div style="border:1.5px solid #000;padding:10px 14px;margin-bottom:16px">
          <div style="font-weight:700;font-size:11px;margin-bottom:4px">⚠ Low Stock Alert</div>
          <div style="font-size:11px">${lowStockItems.map(i => i.name).join(', ')} — at or below minimum threshold</div>
        </div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:24px;margin-bottom:14px">
        ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', printedBy]].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px">${bizName} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  return (
    <div className="page-content" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Sticky Top Section ──────────────────────────────────── */}
      <div style={{ flexShrink: 0, background: '#fff', zIndex: 10 }}>
      {/* ── Page Header ──────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1>{t('itemDetailsTitle')}</h1>
          <p>{t('itemsSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {!isBranch && (
            <button onClick={handleDownloadSample} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              <FiDownload size={14} /> {t('sampleCSV')}
            </button>
          )}
          {!isBranch && (
            <button onClick={() => csvInputRef.current?.click()} disabled={importing} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', background: importing ? '#d1fae5' : 'linear-gradient(135deg,#059669,#10b981)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, boxShadow: '0 3px 10px rgba(16,185,129,0.3)' }}>
              <FiUpload size={14} /> {importing ? t('importing') : t('importCSV')}
            </button>
          )}
          <input ref={csvInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleImport} />
          <button
            onClick={handlePrint}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500, color: '#374151', transition: 'all 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#6b7280'; e.currentTarget.style.background = '#f9fafb'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = '#fff'; }}
          >
            <FiPrinter size={16} /> {t('print')}
          </button>
          {!isBranch && hasPermission('Items:Add') && (
          <button className="btn btn-primary" onClick={openNew}>
            <FiPlus /> {t('newItem')}
          </button>
          )}
        </div>
      </div>

      {importMsg && (
        <div style={{ marginBottom: 16, padding: '10px 16px', background: importMsg.includes('failed') || importMsg.includes('error') ? '#fef2f2' : '#f0fdf4', color: importMsg.includes('failed') || importMsg.includes('error') ? '#dc2626' : '#16a34a', borderRadius: 8, fontSize: 13, fontWeight: 500, border: `1px solid ${importMsg.includes('failed') || importMsg.includes('error') ? '#fecaca' : '#bbf7d0'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{importMsg}</span>
          <button onClick={() => { setImportMsg(''); setImportDetail(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}><FiX size={14} /></button>
        </div>
      )}

      {importDetail && (importDetail.imported_rows.length > 0 || importDetail.skipped_rows.length > 0) && (
        <div style={{ marginBottom: 16, display: 'grid', gridTemplateColumns: importDetail.skipped_rows.length > 0 ? '1fr 1fr' : '1fr', gap: 12 }}>
          {importDetail.imported_rows.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #bbf7d0', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', background: '#f0fdf4', color: '#166534', fontSize: 12, fontWeight: 700, borderBottom: '1px solid #bbf7d0' }}>
                ✓ Imported ({importDetail.imported_rows.length})
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', color: '#64748b' }}>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600, width: 40 }}>#</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600, width: 80 }}>Code</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importDetail.imported_rows.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '6px 10px', color: '#94a3b8' }}>{r.row}</td>
                        <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.code}</td>
                        <td style={{ padding: '6px 10px' }}>{r.name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {importDetail.skipped_rows.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #fde68a', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', background: '#fffbeb', color: '#92400e', fontSize: 12, fontWeight: 700, borderBottom: '1px solid #fde68a' }}>
                ⚠ Skipped ({importDetail.skipped_rows.length})
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', color: '#64748b' }}>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600, width: 40 }}>#</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600, width: 80 }}>Code</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Name</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importDetail.skipped_rows.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '6px 10px', color: '#94a3b8' }}>{r.row}</td>
                        <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.code || '—'}</td>
                        <td style={{ padding: '6px 10px' }}>{r.name || '—'}</td>
                        <td style={{ padding: '6px 10px', color: '#92400e' }}>{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="search-input-container">
        <FiSearch style={{ color: '#9ca3af' }} />
        <input type="text" placeholder={t('searchByItemOrCode')} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <CategoryFilter
        categories={dbCategories}
        mainCategories={dbMainCategories}
        selectedMainIds={selMainIds}
        selectedCatIds={selCatIds}
        onChange={({ mainIds, catIds }) => { setSelMainIds(mainIds); setSelCatIds(catIds); }}
      />
      </div>{/* end sticky top */}

      {subtotalsByMain.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {subtotalsByMain.map(s => (
            <div key={s.name} style={{
              padding: '6px 12px', borderRadius: 8,
              background: (s.color || '#6b7280') + '15',
              border: `1px solid ${(s.color || '#6b7280')}40`,
              fontSize: 12,
            }}>
              <span style={{ color: s.color, fontWeight: 700 }}>{s.name}:</span>
              <span style={{ marginLeft: 6, color: '#374151', fontWeight: 600 }}>
                {s.count} item{s.count !== 1 ? 's' : ''} · avg ${s.count > 0 ? (s.totalSell / s.count).toFixed(2) : '0.00'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 52 }}>{t('photo')}</th>
              <th>{t('code')}</th>
              <th>{t('name')}</th>
              <th>{t('category')}</th>
              <th>{t('units')}</th>
              <th>{t('avgCostPrice')}</th>
              <th>{t('sellingPrice')}</th>
              <th>{t('marginPct')}</th>
              <th>{t('minStock')}</th>
              <th>{t('storeBalance')}</th>
              <th>{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(item => (
              <tr key={item.id}>
                <td>
                  {item.image_url ? (
                    <img src={`${API_BASE}${item.image_url}`} alt={item.name} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 8, border: '1px solid #e5e7eb' }} />
                  ) : (
                    <div style={{ width: 40, height: 40, borderRadius: 8, background: '#f3f4f6', border: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d1d5db' }}>
                      <FiCamera size={16} />
                    </div>
                  )}
                </td>
                <td style={{ fontWeight: 500, opacity: item.status === 'Inactive' ? 0.5 : 1 }}>{item.code}</td>
                <td style={{ fontWeight: 500, opacity: item.status === 'Inactive' ? 0.5 : 1 }}>
                  {item.name}
                  {item.status === 'Inactive' && (
                    <span style={{ marginLeft: 6, padding: '2px 8px', background: '#f3f4f6', color: '#6b7280', borderRadius: 10, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Inactive</span>
                  )}
                </td>
                <td><span className={`badge ${getCategoryClass(item.category_name)}`}>{item.category_name}</span></td>
                <td>
                  {(() => {
                    const disp = pickDisplayUnit(item);
                    const extras = unitsForProduct(item).filter(u => !u.is_base);
                    return (
                      <>
                        {disp.name}
                        {extras.length > 0 && (
                          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, lineHeight: 1.4 }}>
                            {extras.map(u => (
                              <div key={u.name}>1 {u.name} = {u.conv} {item.unit}</div>
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </td>
                <td>{curSym}{(parseFloat(displayPriceInDefaultUnit(item.avg_cost_price || item.cost_price || 0, item).price)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                <td>{curSym}{(parseFloat(displayPriceInDefaultUnit(item.selling_price, item).price)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                <td>
                  {(() => {
                    const cost = parseFloat(item.avg_cost_price || item.cost_price || 0);
                    const sell = parseFloat(item.selling_price || 0);
                    if (!(sell > 0)) return <span style={{ color: '#9ca3af' }}>—</span>;
                    const margin = ((sell - cost) / sell) * 100;
                    const color = margin >= 50 ? '#16a34a' : margin >= 25 ? '#b45309' : '#dc2626';
                    const bg    = margin >= 50 ? '#dcfce7' : margin >= 25 ? '#fef3c7' : '#fee2e2';
                    return (
                      <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700, background: bg, color }}>
                        {margin.toFixed(1)}%
                      </span>
                    );
                  })()}
                </td>
                <td>
                  {(() => {
                    const m = displayInDefaultUnit(item.min_stock || 0, item);
                    return `${m.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${m.unit}`;
                  })()}
                </td>
                <td style={{ color: parseFloat(item.store_balance || 0) <= parseFloat(item.min_stock || 0) ? '#dc2626' : '#16a34a', fontWeight: 500 }}>
                  {formatStockForProduct(item.store_balance || 0, item)}
                </td>
                <td>
                  <div className="action-btns">
                    {hasPermission('Items:Edit') && <button className="action-btn edit" onClick={() => openEdit(item)} title="Edit item"><FiEdit2 /></button>}
                    <button
                      onClick={() => openBarcodeSettings(item)}
                      title="Barcode scanner settings"
                      style={{
                        background: parseInt(item.ub_quantity_length) > 0 ? '#f0fdf4' : '#fffbeb',
                        border: `1px solid ${parseInt(item.ub_quantity_length) > 0 ? '#86efac' : '#fcd34d'}`,
                        color: parseInt(item.ub_quantity_length) > 0 ? '#15803d' : '#92400e',
                        borderRadius: 6, padding: '5px 7px', cursor: 'pointer', fontSize: 13, display: 'inline-flex', alignItems: 'center',
                      }}
                    >
                      <FaBarcode />
                    </button>
                    {hasPermission('Items:Delete') && !item.is_hq_owned && <button className="action-btn delete" onClick={() => handleDelete(item)} title="Delete item"><FiTrash2 /></button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>{/* end scrollable */}

      {/* ── Add / Edit Modal ──────────────────────────────────────── */}
      {showModal && (() => {
        // v1.6.1: HQ + branches share this same modal, split into two tabs:
        //   Tab 1 (details) — HQ-owned: code, name, category, unit,
        //     packagings, default unit, container, photo, UB barcode.
        //   Tab 2 (pricing) — Branch-owned: cost, selling, min stock,
        //     status, opening stock, notes.
        // HQ sees only Tab 1 (saves push to all branches).
        // Branches see both tabs but Tab 1 is read-only for is_hq_owned
        // items (Tab 2 is where the branch fills its own prices).
        const hqLocked = !!(editItem && editItem.is_hq_owned && isBranch);
        const showDetailsTab = true;            // both hosts can view it
        const showPricingTab = isBranch;        // HQ doesn't price; branch does
        // For new items on branch (shouldn't happen via UI, but if it does)
        // both tabs work normally without HQ lock.
        const tab = (!showPricingTab && activeTab === 'pricing') ? 'details'
                  : (showPricingTab && hqLocked && !editItem ? 'details' : activeTab);
        return (
        <Portal>
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 680 }}>
            {/* Sticky header — item name + breadcrumb (code · category · unit) */}
            <div className="modal-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <h3 style={{ margin: 0 }}>
                  {editItem
                    ? (form.name || editItem.name || 'Item')
                    : `${t('newEntry')} Item`}
                </h3>
                <button className="modal-close" onClick={closeModal}>×</button>
              </div>
              {editItem && (
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                  {(form.code || editItem.code) && <span style={{ fontFamily: 'monospace' }}>{form.code || editItem.code}</span>}
                  {editItem.category_name && <> · {editItem.category_name}</>}
                  {(form.unit || editItem.unit) && <> · {form.unit || editItem.unit}</>}
                  {editItem.is_hq_owned ? <span style={{ marginLeft: 8, background: '#fef3c7', color: '#92400e', padding: '1px 8px', borderRadius: 8, fontSize: 10, fontWeight: 700, letterSpacing: 0.3 }}>HQ</span> : null}
                </div>
              )}
              {/* Tabs — only when BOTH are visible (branch). HQ sees one
                  panel without tabs. */}
              {(showDetailsTab && showPricingTab) && (
                <div style={{ display: 'flex', gap: 0, marginTop: 12, borderBottom: '1px solid #e5e7eb' }}>
                  {[
                    { key: 'details', label: 'Item Details' },
                    { key: 'pricing', label: 'Pricing & Stock' },
                  ].map(({ key, label }) => (
                    <button key={key} type="button" onClick={() => setActiveTab(key)}
                      style={{
                        padding: '8px 16px', background: 'transparent', border: 'none', cursor: 'pointer',
                        fontSize: 13, fontWeight: tab === key ? 700 : 500,
                        color: tab === key ? '#0ea5e9' : '#64748b',
                        borderBottom: tab === key ? '2px solid #0ea5e9' : '2px solid transparent',
                        marginBottom: -1,
                      }}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-body">
              {formError && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', fontSize: 13 }}>
                  <span style={{ flexShrink: 0, fontSize: 15, marginTop: 1 }}>⚠</span>
                  <span>{formError}</span>
                </div>
              )}
              {hqLocked && tab === 'details' && (
                <div style={{ marginBottom: 14, padding: '8px 12px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12, color: '#92400e' }}>
                  <strong>HQ-owned item.</strong> These fields are managed centrally and can't be edited at the branch. Switch to <strong>Pricing &amp; Stock</strong> to set Cost / Selling / Min Stock / Status / Opening Stock.
                </div>
              )}
              {tab === 'details' && (<>
              <div className="form-row">
                <div className="form-group">
                  <label>
                    Code <span style={{ color: '#dc2626' }}>*</span>
                    {!editItem && <span style={{ fontSize: 10.5, fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>or click ⚡ to generate</span>}
                  </label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={form.code}
                      disabled={!!editItem || hqLocked}
                      onChange={e => { setForm({ ...form, code: e.target.value }); setFormError(''); }}
                      placeholder="e.g. BF001"
                      style={{ flex: 1, border: formError && !form.code.trim() ? '1.5px solid #dc2626' : undefined }}
                    />
                    {!editItem && (
                      <button
                        type="button" onClick={generateCode} title="Auto-generate a unique code based on category"
                        style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 8, border: '1.5px solid #d1d5db', background: '#fafafa', color: '#6b7280', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#fffbeb'; e.currentTarget.style.borderColor = '#f59e0b'; e.currentTarget.style.color = '#d97706'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = '#fafafa'; e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.color = '#6b7280'; }}
                      >
                        <FiZap size={15} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="form-group">
                  <label>Item Name <span style={{ color: '#dc2626' }}>*</span></label>
                  <input
                    value={form.name}
                    disabled={hqLocked}
                    onChange={e => { setForm({ ...form, name: e.target.value }); setFormError(''); }}
                    placeholder="Product name"
                    style={{ border: formError && !form.name.trim() ? '1.5px solid #dc2626' : undefined }}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Unit</label>
                  <select value={form.unit || ''} disabled={!!editItem || hqLocked} onChange={e => setForm({ ...form, unit: e.target.value })}>
                    {/* Always include the current value so editing existing products doesn't lose it */}
                    {form.unit && !dbUnits.some(u => u.name === form.unit) && (
                      <option value={form.unit}>{form.unit}</option>
                    )}
                    {dbUnits.length === 0 && !form.unit && <option value="">— No units configured —</option>}
                    {dbUnits.map(u => (
                      <option key={u.id} value={u.name}>{u.name}{u.abbreviation ? ` (${u.abbreviation})` : ''}</option>
                    ))}
                  </select>
                  {dbUnits.length === 0 && (
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                      Add units in <strong>Categories and Units → Units</strong> tab.
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label>Category</label>
                  <select value={form.category_id} disabled={hqLocked} onChange={e => setForm({ ...form, category_id: e.target.value })}>
                    <option value="">Select Category</option>
                    {dbCategories.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              </>)}{/* end tab===details block A — code/name/unit/category */}
              {tab === 'pricing' && (<>
              <div className="form-row">
                <div className="form-group">
                  <label>Opening Order Price ({curSym} / {form.unit || 'unit'})</label>
                  <input type="number" min="0" step="0.01" value={form.cost_price}
                    onChange={e => setForm({ ...form, cost_price: e.target.value })}
                    onBlur={e => { if (e.target.value !== '' && parseFloat(e.target.value) < 0) setForm(f => ({ ...f, cost_price: '0' })); }} />
                  {editItem && parseFloat(form.cost_price || 0) !== parseFloat(editItem.cost_price || 0) && (
                    <div style={{ marginTop: 6, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, fontSize: 11.5, color: '#92400e', lineHeight: 1.5 }}>
                      <strong>⚠ Changing cost price.</strong> Past sales keep their original COGS — historical Profit
                      Reports won't change. New sales (and any GRN-less products) will use the new cost going forward.
                      Was <strong>{curSym}{(parseFloat(parseFloat(editItem.cost_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong> →
                      Will be <strong>{curSym}{(parseFloat(parseFloat(form.cost_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>.
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label>Selling Price ({curSym} / {form.unit || 'unit'})</label>
                  <input type="number" min="0" step="0.01" value={form.selling_price}
                    onChange={e => {
                      const v = e.target.value;
                      // If the base unit IS the default unit (or no default set),
                      // a change here propagates: every packaging price becomes
                      // basePrice × conv. Otherwise just update the base price.
                      const baseName = (form.unit || 'pcs').trim();
                      const dflt = (form.default_unit || '').trim() || baseName;
                      if (dflt === baseName) {
                        const base = parseFloat(v) || 0;
                        setForm(f => ({
                          ...f,
                          selling_price: v,
                          packagings: f.packagings.map(p => ({
                            ...p,
                            price: (base * (parseFloat(p.conv) || 0)).toFixed(2),
                          })),
                        }));
                      } else {
                        setForm({ ...form, selling_price: v });
                      }
                    }}
                    onBlur={e => { if (e.target.value !== '' && parseFloat(e.target.value) < 0) setForm(f => ({ ...f, selling_price: '0' })); }} />
                </div>
              </div>
              </>)}{/* end tab===pricing block A — cost/selling */}
              {tab === 'details' && (<>

              {/* Multi-Unit (Packagings) Section — N alternative larger units per product. */}
              <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginTop: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Packaging (larger units)</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                      Base unit is <strong>{form.unit || 'pcs'}</strong>. Add packs/boxes that contain multiple {form.unit || 'pcs'} (e.g. 1 Box = 24 {form.unit || 'pcs'}).
                      &nbsp;Add new units on the <em>Categories and Units</em> page.
                    </div>
                  </div>
                  {!hqLocked && (
                    <button type="button"
                      onClick={() => setForm(f => ({ ...f, packagings: [...(f.packagings || []), { name: '', conv: '', price: '' }] }))}
                      style={{ padding: '6px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                      + Add Packaging
                    </button>
                  )}
                </div>

                {(form.packagings || []).length === 0 ? (
                  <div style={{ padding: '12px 14px', background: '#fff', border: '1px dashed #d1d5db', borderRadius: 8, fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
                    No extra packagings yet — this product is only sold in <strong>{form.unit || 'pcs'}</strong>.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {(form.packagings || []).map((p, idx) => {
                      // Only conversion is locked for rows loaded from the saved product; name + price stay editable,
                      // and any "+ Add Packaging" rows added during this session are fully editable.
                      const lockConv = !!p._locked || hqLocked;
                      return (
                        <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1.1fr 1.4fr auto', gap: 8, alignItems: 'end', background: '#fff', padding: 10, borderRadius: 8, border: '1px solid #e5e7eb' }}>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>Unit Name</label>
                            {(() => {
                              // Hide units already used as the base unit or by other packaging rows on this product,
                              // but keep this row's current value selectable so editing doesn't blank it.
                              const usedElsewhere = new Set(
                                (form.packagings || [])
                                  .map((q, i) => i === idx ? null : (q.name || '').trim())
                                  .filter(Boolean)
                              );
                              const baseName = (form.unit || '').trim();
                              const options = (dbUnits || []).filter(u =>
                                u.name === p.name || (u.name !== baseName && !usedElsewhere.has(u.name))
                              );
                              return (
                                <select value={p.name || ''}
                                  disabled={lockConv}
                                  onChange={e => setForm(f => ({ ...f, packagings: f.packagings.map((q, i) => i === idx ? { ...q, name: e.target.value } : q) }))}
                                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: lockConv ? '#f3f4f6' : '#fff' }}>
                                  <option value="">— Select a unit —</option>
                                  {options.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                                  {/* Preserve a custom name typed in older data so it doesn't silently blank out */}
                                  {p.name && !(dbUnits || []).some(u => u.name === p.name) && (
                                    <option value={p.name}>{p.name} (custom)</option>
                                  )}
                                </select>
                              );
                            })()}
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>1 {p.name || 'unit'} = how many {form.unit || 'pcs'}?</label>
                            <input type="number" min="0" step="0.01" value={p.conv}
                              disabled={lockConv}
                              onChange={e => setForm(f => ({ ...f, packagings: f.packagings.map((q, i) => i === idx ? { ...q, conv: e.target.value } : q) }))}
                              placeholder="e.g. 6" />
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>Order Price ({curSym} / {p.name || 'unit'}) — derived</label>
                            <div style={{ padding: '8px 10px', background: '#f3f4f6', borderRadius: 6, fontSize: 13, color: '#6b7280', minHeight: 18 }}>
                              {curSym}{(parseFloat(((parseFloat(form.cost_price) || 0) * (parseFloat(p.conv) || 0)))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                            </div>
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>Selling Price ({curSym} / {p.name || 'unit'})</label>
                            <input type="number" min="0" step="0.01" value={p.price}
                              onChange={e => {
                                const v = e.target.value;
                                // If this row IS the default unit, editing its
                                // price propagates: base = v / this.conv, other
                                // packagings = base × their conv. Otherwise just
                                // set this row's price (keeps unequal pricing possible).
                                const isDefault = (form.default_unit || '').trim() === (p.name || '').trim();
                                if (isDefault) {
                                  const conv = parseFloat(p.conv) || 1;
                                  const base = (parseFloat(v) || 0) / conv;
                                  setForm(f => ({
                                    ...f,
                                    selling_price: base ? base.toFixed(4) : '',
                                    packagings: f.packagings.map((q, i) => i === idx
                                      ? { ...q, price: v }
                                      : { ...q, price: (base * (parseFloat(q.conv) || 0)).toFixed(2) }),
                                  }));
                                } else {
                                  setForm(f => ({ ...f, packagings: f.packagings.map((q, i) => i === idx ? { ...q, price: v } : q) }));
                                }
                              }}
                              placeholder="0.00" />
                          </div>
                          {/* v1.6.7: when a saved packaging is locked,
                              admin can unlock the conversion via password
                              prompt. After unlock, name/conv/remove are
                              editable. hqLocked rows can't be unlocked
                              from a branch (HQ owns the structure). */}
                          {lockConv && !hqLocked && p._locked && (
                            <button type="button"
                              onClick={() => setPendingUnlockPack(idx)}
                              title="Unlock with admin password to edit conversion or remove"
                              style={{ height: 36, width: 36, background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}>
                              🔒
                            </button>
                          )}
                          <button type="button"
                            disabled={lockConv}
                            onClick={() => setForm(f => ({ ...f, packagings: f.packagings.filter((_, i) => i !== idx) }))}
                            title={lockConv ? 'Saved packagings cannot be removed (history depends on them) — click the 🔒 to unlock' : 'Remove this packaging'}
                            style={{ height: 36, width: 36, background: lockConv ? '#f3f4f6' : '#fee2e2', color: lockConv ? '#9ca3af' : '#dc2626', border: 'none', borderRadius: 6, cursor: lockConv ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700 }}>
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Default unit — auto-selected on GRN/SIV/POS lines (instead of always defaulting to base). */}
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: 14, marginTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1e40af', marginBottom: 6 }}>Default unit (auto-selected on GRN, SIV, POS)</div>
                <div style={{ fontSize: 11, color: '#1d4ed8', marginBottom: 10 }}>
                  Pick the unit you sell most often. New rows on GRN, SIV, and POS will start with this unit selected
                  instead of always defaulting to the base unit. Leave blank to use the base unit ({form.unit || 'pcs'}).
                </div>
                <select
                  value={form.default_unit || ''}
                  disabled={hqLocked}
                  onChange={e => setForm({ ...form, default_unit: e.target.value })}
                  style={{ width: '100%', maxWidth: 320, padding: '9px 10px', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 14, background: hqLocked ? '#f1f5f9' : '#fff' }}
                >
                  <option value="">— Use base unit ({form.unit || 'pcs'}) —</option>
                  <option value={form.unit || 'pcs'}>{form.unit || 'pcs'} (base)</option>
                  {(form.packagings || []).filter(p => (p.name || '').trim()).map((p, idx) => (
                    <option key={idx} value={p.name}>{p.name} (1 = {p.conv} {form.unit || 'pcs'})</option>
                  ))}
                </select>
              </div>

              {/* Returnable container link — used by GRN to record empties returned / new crates received. */}
              <div style={{ background: '#fefce8', border: '1px solid #fde68a', borderRadius: 10, padding: 14, marginTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#78350f', marginBottom: 6 }}>Returnable Container (Crate / Empties)</div>
                <div style={{ fontSize: 11, color: '#92400e', marginBottom: 10 }}>
                  If this product is sold in a deposit-bearing crate (you pay for empty crates from the supplier and get refunds when you return them), link it here.
                  The GRN form will show a container sub-row whenever you receive this product. Leave blank for items without crates.
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Container Product</label>
                    <select value={form.container_product_sync_id || ''}
                      disabled={hqLocked}
                      onChange={e => setForm({ ...form, container_product_sync_id: e.target.value })}>
                      <option value="">— No linked container —</option>
                      {items
                        .filter(p => !editItem || p.sync_id !== editItem.sync_id)
                        // Only items in the "Crates" category — keeps non-container
                        // products (beers, drinks, etc.) out of this list.
                        .filter(p => (p.category_name || '').toLowerCase() === 'crates')
                        .map(p => (
                          <option key={p.sync_id} value={p.sync_id}>{p.code ? `${p.code} · ` : ''}{p.name}</option>
                        ))}
                    </select>
                    <small style={{ color: '#92400e', fontSize: 11 }}>Pick the empty-crate product from the <strong>Crates</strong> category (create it as a normal item first, with a cost = deposit price).</small>
                  </div>
                  <div className="form-group">
                    <label>Units per Container</label>
                    <input type="number" min="0" step="1" value={form.units_per_container}
                      disabled={hqLocked}
                      onChange={e => setForm({ ...form, units_per_container: e.target.value })}
                      placeholder="e.g. 24" />
                    <small style={{ color: '#92400e', fontSize: 11 }}>How many bottles fit in one crate (used by GRN to suggest crate count).</small>
                  </div>
                </div>
              </div>
              </>)}{/* end tab===details block B — packagings/default/container */}
              {tab === 'pricing' && (<>
              {/* v1.7.2 (Grocery pattern): one Opening input per unit (base + each
                  packaging). User types "46 Box + 10 Bottle"; save collapses to
                  base total. Editing here replaces the prior opening movement. */}
              <div className="form-row">
                <div className="form-group">
                  <label>Opening Stock ({form.unit || 'unit'})</label>
                  <input type="number" min="0" step="0.01" value={form.opening_base}
                    onChange={e => setForm({ ...form, opening_base: e.target.value })}
                    onBlur={e => { if (e.target.value !== '' && parseFloat(e.target.value) < 0) setForm(f => ({ ...f, opening_base: '0' })); }}
                    placeholder={`how many loose ${form.unit || 'pcs'}`} />
                  {editItem && (
                    <div style={{ fontSize: 10, color: '#92400e', marginTop: 4 }}>
                      Saving voids the prior opening movement and writes a new one with the total below.
                    </div>
                  )}
                </div>
              </div>

              {/* Per-packaging opening + price (only when item has packagings). */}
              {(form.packagings || []).length > 0 && (
                <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginTop: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Packaging pricing &amp; opening</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {(form.packagings || []).map((p, idx) => (
                      <div key={idx} style={{ background: '#fff', padding: 10, borderRadius: 8, border: '1px solid #e5e7eb' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#111827', marginBottom: 8 }}>
                          {p.name || '(unnamed packaging)'}
                          <span style={{ marginLeft: 8, color: '#6b7280', fontWeight: 400, fontSize: 11 }}>
                            (1 {p.name || 'unit'} = {p.conv || '?'} {form.unit || 'pcs'})
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, alignItems: 'end' }}>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>Cost ({curSym} / {p.name || 'unit'})</label>
                            <input type="number" min="0" step="0.01"
                              value={(() => {
                                const conv = parseFloat(p.conv) || 0;
                                if (conv <= 0) return '';
                                const base = parseFloat(form.cost_price);
                                if (!base) return '';
                                return (base * conv).toFixed(2);
                              })()}
                              onChange={e => {
                                const conv = parseFloat(p.conv) || 0;
                                if (conv <= 0) return;
                                const entered = parseFloat(e.target.value);
                                const base = isNaN(entered) ? '' : (entered / conv);
                                setForm(f => ({ ...f, cost_price: base === '' ? '' : base.toFixed(4) }));
                              }}
                              placeholder="0.00" />
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>Selling ({curSym} / {p.name || 'unit'})</label>
                            <input type="number" min="0" step="0.01" value={p.price}
                              onChange={e => setForm(f => ({ ...f, packagings: f.packagings.map((q, i) => i === idx ? { ...q, price: e.target.value } : q) }))}
                              placeholder="0.00" />
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>Opening ({p.name || 'unit'})</label>
                            <input type="number" min="0" step="0.01" value={p.opening || ''}
                              onChange={e => setForm(f => ({ ...f, packagings: f.packagings.map((q, i) => i === idx ? { ...q, opening: e.target.value } : q) }))}
                              placeholder="0" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Total Opening Balance + Min Stock summary card. */}
              {(() => {
                const baseName = (form.unit || 'pcs').trim() || 'pcs';
                const openingBase = parseFloat(form.opening_base) || 0;
                const packs = (form.packagings || []).map(p => ({
                  name: (p.name || '').trim(),
                  conv: parseFloat(p.conv) || 0,
                  qty: parseFloat(p.opening) || 0,
                })).filter(p => p.qty > 0 && p.conv > 0);
                const totalBase = openingBase + packs.reduce((s, p) => s + p.qty * p.conv, 0);
                const dfltName = (form.default_unit || '').trim() || baseName;
                const dfltConv = dfltName === baseName ? 1 : ((form.packagings || []).find(p => (p.name || '').trim() === dfltName)?.conv || 1);
                const totalInDflt = dfltConv > 0 ? totalBase / dfltConv : totalBase;
                const breakdown = [
                  ...packs.map(p => `${p.qty} ${p.name}`),
                  openingBase > 0 ? `${openingBase} ${baseName}` : null,
                ].filter(Boolean).join(' + ');
                return (
                  <div style={{ background: 'linear-gradient(135deg, #1F213F 0%, #494D6F 100%)', borderRadius: 12, padding: 16, marginTop: 12, color: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 18 }}>📦</span>
                      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: '#F6C96B' }}>Total Opening Balance</div>
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1 }}>
                      {totalInDflt.toLocaleString(undefined, { maximumFractionDigits: 3 })} <span style={{ fontSize: 16, fontWeight: 600, opacity: 0.85 }}>{dfltName}</span>
                    </div>
                    {breakdown && (
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>
                        = {breakdown} = {totalBase.toLocaleString(undefined, { maximumFractionDigits: 3 })} {baseName}
                      </div>
                    )}
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.15)' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#F6C96B', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Minimum Stock</div>
                      <div style={{ display: 'flex', gap: 6, maxWidth: 280 }}>
                        <input type="number" min="0" step="0.01" value={form.min_stock}
                          onChange={e => setForm({ ...form, min_stock: e.target.value })}
                          onBlur={e => { if (e.target.value !== '' && parseFloat(e.target.value) < 0) setForm(f => ({ ...f, min_stock: '0' })); }}
                          style={{ flex: 2, minWidth: 0, width: '100%', padding: '7px 10px', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 13 }} />
                        {(() => {
                          const opts = [
                            { name: baseName, conv: 1 },
                            ...(form.packagings || [])
                              .filter(pp => (pp.name || '').trim() && parseFloat(pp.conv) > 0)
                              .map(pp => ({ name: pp.name.trim(), conv: parseFloat(pp.conv) })),
                          ];
                          const currentUnit = form.min_stock_unit || form.default_unit || baseName;
                          return (
                            <select
                              value={currentUnit}
                              onChange={e => setForm({ ...form, min_stock_unit: e.target.value })}
                              style={{ flex: 1, minWidth: 70, padding: '6px 8px', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 13 }}
                            >
                              {opts.map(o => (
                                <option key={o.name} value={o.name} style={{ color: '#1F213F' }}>{o.name}</option>
                              ))}
                            </select>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                );
              })()}
              </>)}{/* end tab===pricing block B — opening stock + packagings + total */}
              {tab === 'details' && (<>
              <div className="form-group" style={{ marginTop: 4 }}>
                <label>Product Photo</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6 }}>
                  {imagePreview ? (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <img src={imagePreview} alt="preview" style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 10, border: '2px solid #e5e7eb' }} />
                      <button type="button" onClick={handleRemoveImage} style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', background: '#dc2626', color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, padding: 0 }}>
                        <FiX size={11} />
                      </button>
                    </div>
                  ) : (
                    <div style={{ width: 80, height: 80, borderRadius: 10, border: '2px dashed #d1d5db', background: '#f9fafb', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', flexShrink: 0 }}>
                      <FiCamera size={22} />
                      <span style={{ fontSize: 10, marginTop: 4 }}>No photo</span>
                    </div>
                  )}
                  <div>
                    {hqLocked ? (
                      <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', padding: '6px 10px', borderRadius: 6 }}>Photo is managed by HQ.</div>
                    ) : (
                      <>
                        <label htmlFor="product-image-input" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, cursor: 'pointer', background: 'linear-gradient(135deg, #2563eb, #1d4ed8)', color: '#fff', fontSize: 13, fontWeight: 600, boxShadow: '0 2px 8px rgba(37,99,235,0.3)' }}>
                          <FiCamera size={14} /> {imagePreview ? 'Change Photo' : 'Upload Photo'}
                        </label>
                        <input id="product-image-input" type="file" accept="image/*" onChange={handleImageChange} style={{ display: 'none' }} />
                        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#9ca3af' }}>JPG, PNG, WEBP · Max 5MB</p>
                      </>
                    )}
                  </div>
                </div>
              </div>
              </>)}{/* end tab===details block C — photo */}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeModal}>{t('cancel')}</button>
              <button className="btn btn-primary" onClick={handleSave}>{t('save')} Item</button>
            </div>
          </div>
        </div>
        </Portal>
        );
      })()}

      {/* ── Barcode Settings Modal ────────────────────────────────── */}
      {showBarcodeModal && barcodeItem && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <FaBarcode style={{ color: '#2563eb', fontSize: 18 }} />
                  <h3 style={{ margin: 0, fontSize: 16 }}>Barcode Scanner Settings</h3>
                </div>
                <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>{barcodeItem.name} ({barcodeItem.code})</p>
              </div>
              <button onClick={() => setShowBarcodeModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280', padding: 0, lineHeight: 1 }}>×</button>
            </div>
            <div style={{ padding: '20px 24px' }}>
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#1e40af', marginBottom: 20 }}>
                Configure where in the barcode the <strong>product code</strong> and <strong>weight</strong> are located. Set <em>Quantity Length</em> to <strong>0</strong> for regular (non-weight) barcodes.
              </div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1d4ed8', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ background: '#dbeafe', color: '#1d4ed8', padding: '2px 8px', borderRadius: 4 }}>■</span> Product Code Position
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelSt}>Start Position (0-indexed)</label>
                    <input style={inputSt} type="number" min="0" value={barcodeForm.ub_number_start} onChange={setBF('ub_number_start')} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. 1 → skip first digit</div>
                  </div>
                  <div>
                    <label style={labelSt}>Code Length (digits)</label>
                    <input style={inputSt} type="number" min="1" value={barcodeForm.ub_number_length} onChange={setBF('ub_number_length')} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. 6 → read 6 digits</div>
                  </div>
                </div>
              </div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ background: '#dcfce7', color: '#15803d', padding: '2px 8px', borderRadius: 4 }}>■</span> Weight / Quantity Position
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelSt}>Start Position</label>
                    <input style={inputSt} type="number" min="0" value={barcodeForm.ub_quantity_start} onChange={setBF('ub_quantity_start')} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. 7</div>
                  </div>
                  <div>
                    <label style={labelSt}>Length (0 = none)</label>
                    <input style={inputSt} type="number" min="0" value={barcodeForm.ub_quantity_length} onChange={setBF('ub_quantity_length')} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. 5 digits</div>
                  </div>
                  <div>
                    <label style={labelSt}>Decimal At</label>
                    <input style={inputSt} type="number" min="0" value={barcodeForm.ub_decimal_start} onChange={setBF('ub_decimal_start')} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. 2 → XX.XXX</div>
                  </div>
                </div>
              </div>
              <BarcodePreview form={barcodeForm} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                <button onClick={() => setShowBarcodeModal(false)} style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
                <button onClick={saveBarcodeSettings} disabled={barcodeSaving} style={{ padding: '9px 24px', background: barcodeSaving ? '#9ca3af' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: barcodeSaving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
                  {barcodeSaving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Print Preview ─────────────────────────────────────────── */}
      {false && (
        <div
          className="print-preview-overlay"
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.85)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}
        >
          {/* Toolbar */}
          <div
            className="no-print"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 1001, borderBottom: '1px solid #1e293b' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={16} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>
                Print Preview — Items List ({items.length} items)
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => window.print()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                <FiPrinter size={14} /> Print
              </button>
              <button
                onClick={() => setShowPrintPreview(false)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}
              >
                <FiX size={14} /> Close
              </button>
            </div>
          </div>

          {/* A4 Document */}
          <div
            id="print-document"
            style={{ width: 794, background: '#ffffff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}
          >
            {/* Header Banner */}
            <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>
                  {businessInfo.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.7 }}>
                  {[businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  |  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>Product Items List</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                </div>
              </div>
            </div>

            {/* Accent bar */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #ef4444, #8b5cf6)' }} />

            {/* Body */}
            <div style={{ padding: '26px 44px 36px' }}>

              {/* Summary chips */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Total Items',   value: items.length,        bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
                  { label: 'Categories',    value: categories.length,   bg: '#f0fdf4', color: '#15803d', border: '#86efac' },
                  { label: 'Low Stock',     value: lowStockItems.length, bg: lowStockItems.length > 0 ? '#fef2f2' : '#f0fdf4', color: lowStockItems.length > 0 ? '#dc2626' : '#15803d', border: lowStockItems.length > 0 ? '#fca5a5' : '#86efac' },
                  { label: 'Avg. Sell Price', value: items.length > 0 ? '$' + (items.reduce((s, i) => s + parseFloat(i.selling_price || 0), 0) / items.length).toFixed(2) : '$0.00', bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
                ].map(chip => (
                  <div key={chip.label} style={{ padding: '12px 16px', borderRadius: 10, background: chip.bg, border: `1.5px solid ${chip.border}`, textAlign: 'center' }}>
                    <div style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 6 }}>{chip.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: chip.color }}>{chip.value}</div>
                  </div>
                ))}
              </div>

              {/* Items table */}
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                {/* Table header */}
                <div style={{ background: '#f8fafc', borderBottom: '1.5px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#2563eb', display: 'inline-block', flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#475569' }}>
                    Product Inventory
                  </span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['#', 'Code', 'Item Name', 'Category', 'Unit', 'Cost Price', 'Selling Price', 'Min. Stock', 'Store Balance'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: i >= 5 ? 'right' : 'left', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb', fontSize: 10.5, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => {
                      const isLow = parseFloat(item.store_balance || 0) <= parseFloat(item.min_stock || 0);
                      return (
                        <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9', background: isLow ? '#fff5f5' : idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                          <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                          <td style={{ padding: '8px 12px', fontWeight: 700, color: '#374151', fontFamily: 'monospace', fontSize: 11 }}>{item.code}</td>
                          <td style={{ padding: '8px 12px', fontWeight: 500, color: '#1e293b' }}>{item.name}</td>
                          <td style={{ padding: '8px 12px' }}>
                            <span style={catBadgeStyle(item.category_name)}>{item.category_name || '—'}</span>
                          </td>
                          <td style={{ padding: '8px 12px', color: '#374151' }}>{item.unit}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                            ${(parseFloat(parseFloat(item.avg_cost_price || item.cost_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, fontFamily: 'monospace', color: '#1d4ed8' }}>
                            ${(parseFloat(parseFloat(item.selling_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#6b7280' }}>
                            {(parseFloat(parseFloat(item.min_stock || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: isLow ? '#dc2626' : '#16a34a' }}>
                            {isLow ? '⚠ ' : ''}{(parseFloat(parseFloat(item.store_balance || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {item.unit}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f8fafc', borderTop: '2px solid #e2e8f0' }}>
                      <td colSpan={5} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11, color: '#374151' }}>
                        Total — {items.length} items
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', fontSize: 11 }}>
                        —
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#1d4ed8', fontSize: 11 }}>
                        Avg ${items.length > 0 ? (items.reduce((s, i) => s + parseFloat(i.selling_price || 0), 0) / items.length).toFixed(2) : '0.00'}
                      </td>
                      <td colSpan={2} style={{ padding: '10px 12px', textAlign: 'right', fontSize: 11, color: lowStockItems.length > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
                        {lowStockItems.length > 0 ? `⚠ ${lowStockItems.length} item${lowStockItems.length > 1 ? 's' : ''} low on stock` : '✓ All stock levels OK'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Low stock notice */}
              {lowStockItems.length > 0 && (
                <div style={{ border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 16px', background: '#fff5f5', marginBottom: 20, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ fontSize: 14, color: '#dc2626', flexShrink: 0 }}>⚠</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 11, color: '#dc2626', marginBottom: 3 }}>Low Stock Alert</div>
                    <div style={{ fontSize: 11, color: '#7f1d1d' }}>
                      {lowStockItems.map(i => i.name).join(', ')} — stock at or below minimum threshold
                    </div>
                  </div>
                </div>
              )}

              {/* Legend */}
              <div style={{ display: 'flex', gap: 20, marginBottom: 20, fontSize: 10.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 12, height: 12, background: '#fff5f5', border: '1px solid #fca5a5', borderRadius: 3, display: 'inline-block' }} />
                  <span style={{ color: '#6b7280' }}>Low / zero stock row</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: '#dc2626', fontWeight: 700 }}>⚠</span>
                  <span style={{ color: '#6b7280' }}>Balance at or below minimum</span>
                </div>
              </div>

              {/* Footer */}
              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>
                  {businessInfo.business_name || 'Business'} — Confidential
                </span>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>
                  Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Print styles ──────────────────────────────────────────── */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-preview-overlay {
            position: fixed !important;
            top: 0 !important; left: 0 !important;
            right: 0 !important; bottom: 0 !important;
            background: #fff !important;
            padding: 0 !important;
            overflow: visible !important;
            display: block !important;
          }
          #print-document {
            box-shadow: none !important;
            width: 100% !important;
            margin: 0 !important;
          }
        }
      `}</style>

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={
          pendingDelete?.kind === 'all'
            ? 'ALL products with no GRN/SIV/sales history'
            : pendingDelete?.kind === 'single'
              ? `Product: ${pendingDelete.item.name}`
              : ''
        }
        actionLabel={pendingDelete?.kind === 'all' ? 'Delete All' : 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {/* v1.6.7: unlock a saved packaging row's conversion / remove with
          admin password. Safer than dropping the lock entirely because
          historical movements may depend on the existing conversion. */}
      <AdminPasswordPrompt
        open={pendingUnlockPack !== null}
        subject={pendingUnlockPack !== null && form.packagings?.[pendingUnlockPack]
          ? `Edit packaging: ${form.packagings[pendingUnlockPack].name || 'unit'} (existing stock movements rely on the current conversion)`
          : 'Edit packaging'}
        actionLabel="Unlock"
        onConfirm={() => {
          if (pendingUnlockPack !== null) {
            const idx = pendingUnlockPack;
            setForm(f => ({
              ...f,
              packagings: f.packagings.map((q, i) => i === idx ? { ...q, _locked: false } : q),
            }));
          }
          setPendingUnlockPack(null);
        }}
        onCancel={() => setPendingUnlockPack(null)}
      />
    </div>
  );
};

export default ItemDetails;
