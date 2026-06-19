import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import {
  getSettings, updateBusiness,
  getDrawerPort, updateDrawerPort,
  getLanConfig, updateLanConfig, getLanStatus,
} from '../services/api';
import {
  FiSave, FiPrinter, FiMonitor, FiCloud, FiServer, FiDollarSign,
  FiWifi, FiWifiOff, FiAlertTriangle, FiTrash2, FiPlus,
} from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { MOBILE_PRINT_MODE_KEY } from '../utils/printHtml';

// SystemSettings — POS/device-level configuration extracted from the old Profile page.
// Holds everything that is NOT identity/contact info: currencies, default deposit,
// single-location mode, receipt printer, drawer port, cloud sync, LAN sync, factory reset.
const SystemSettings = () => {
  const { logout } = useAuth();
  const { refresh: refreshCurrency } = useCurrency();

  const [businessName, setBusinessName] = useState('');
  const [form, setForm] = useState({
    singleLocationMode: false,
    currencies: [{ code: 'USD', symbol: '$', is_primary: true }],
    receiptPrinterType: 'usb',
    receiptPrinterName: '',
    receiptPrinterIp:   '',
    receiptPrinterPort: 9100,
    defaultCrateDeposit: 57,
    // Currency mode controls the dual-currency UI gate. 'K' hides the FX
    // rate / dual-currency payment / USD+FRA receipt features (default for
    // lusaka1, mansa1). 'USD+FRA' unlocks them (kassumbalesa1).
    currencyMode: 'K',
    // Workflow mode swaps the single-screen POS for the 3-station flow
    // (Sales → Cashier → Dispatch). 'single_pos' is the default for lusaka1,
    // mansa1. 'three_station' is used for kassumbalesa1.
    workflowMode: 'single_pos',
  });
  const [saving, setSaving] = useState(false);

  const [drawerPort, setDrawerPort] = useState('POS-80');
  const [savingPort, setSavingPort] = useState(false);

  // Mobile-only print behaviour. Per-device (localStorage) — see printHtml.js.
  const [mobilePrintMode, setMobilePrintMode] = useState(() => {
    try {
      return localStorage.getItem(MOBILE_PRINT_MODE_KEY) === 'print' ? 'print' : 'pdf';
    } catch (_) { return 'pdf'; }
  });
  const updateMobilePrintMode = (mode) => {
    setMobilePrintMode(mode);
    try { localStorage.setItem(MOBILE_PRINT_MODE_KEY, mode); } catch (_) {}
  };

  // Cloud sync status
  const [syncInfo, setSyncInfo] = useState(null);
  const [resetting, setResetting] = useState(false);

  // LAN sync (mother/child)
  const [lanConfig, setLanConfig] = useState({ role: 'child', motherIp: '', lanSyncKey: '', localIp: '' });
  const [lanChildren, setLanChildren] = useState([]);
  const [savingLan, setSavingLan] = useState(false);
  const [lanMessage, setLanMessage] = useState('');

  // Factory reset modal
  const [resetStep, setResetStep] = useState(0);

  useModalScrollLock(resetStep > 0);
  const [factoryResetting, setFactoryResetting] = useState(false);

  useEffect(() => {
    fetch('/api/sync/status').then(r => r.json()).then(setSyncInfo).catch(() => {});
    getDrawerPort().then(res => setDrawerPort(res.data?.port || 'POS-80')).catch(() => {});
    getLanConfig().then(r => setLanConfig(prev => ({ ...prev, ...r.data }))).catch(() => {});
    getSettings().then(res => {
      const b = res.data?.business || {};
      setBusinessName(b.business_name || '');
      setForm({
        singleLocationMode: !!b.single_location_mode,
        blockOversell: !!b.block_oversell,
        currencies: (() => {
          try {
            const parsed = b.currencies_json ? JSON.parse(b.currencies_json) : null;
            if (Array.isArray(parsed) && parsed.length) return parsed;
          } catch { /* fall through */ }
          return [{ code: 'USD', symbol: '$', is_primary: true }];
        })(),
        receiptPrinterType: (b.receipt_printer_type || 'usb').toLowerCase(),
        receiptPrinterName: b.receipt_printer_name || '',
        receiptPrinterIp:   b.receipt_printer_ip   || '',
        receiptPrinterPort: parseInt(b.receipt_printer_port) || 9100,
        defaultCrateDeposit: parseFloat(b.default_crate_deposit) || 57,
        currencyMode: (String(b.currency_mode || 'K').toUpperCase() === 'USD+FRA') ? 'USD+FRA' : 'K',
        workflowMode: (String(b.workflow_mode || 'single_pos').toLowerCase() === 'three_station') ? 'three_station' : 'single_pos',
      });
    }).catch(() => {});
  }, []);

  // Poll LAN children list every 5s while role=mother
  useEffect(() => {
    if (lanConfig.role !== 'mother') { setLanChildren([]); return; }
    const tick = () => getLanStatus().then(r => setLanChildren(r.data?.children || [])).catch(() => {});
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [lanConfig.role]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await updateBusiness({
        single_location_mode: form.singleLocationMode ? 1 : 0,
        block_oversell: form.blockOversell ? 1 : 0,
        currencies: form.currencies,
        receipt_printer_type: form.receiptPrinterType,
        receipt_printer_name: form.receiptPrinterName,
        receipt_printer_ip:   form.receiptPrinterIp,
        receipt_printer_port: form.receiptPrinterPort,
        default_crate_deposit: form.defaultCrateDeposit,
        currency_mode: form.currencyMode,
        workflow_mode: form.workflowMode,
      });
      refreshCurrency();
      alert('System settings saved.');
    } catch {
      alert('Failed to save. Please try again.');
    }
    setSaving(false);
  };

  const handleSaveDrawerPort = async () => {
    setSavingPort(true);
    try {
      await updateDrawerPort(drawerPort);
      alert('Drawer port saved.');
    } catch { alert('Failed to save drawer port.'); }
    setSavingPort(false);
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleConnectToCloud = () => {
    setPendingDelete({
      subject: 'Disconnect sync settings — Cloud Setup screen will reload',
      actionLabel: 'Reset Sync',
      perform: async () => {
        setResetting(true);
        try {
          await fetch('/api/sync/reset', { method: 'POST' });
          window.location.reload();
        } catch {
          alert('Failed to reset sync config. Make sure the backend is running.');
          setResetting(false);
        }
      },
    });
  };

  const handleSaveLan = async () => {
    setSavingLan(true); setLanMessage('');
    try {
      const res = await updateLanConfig({
        role: lanConfig.role,
        motherIp: lanConfig.motherIp.trim(),
        lanSyncKey: lanConfig.lanSyncKey.trim(),
      });
      setLanConfig({ ...lanConfig, ...res.data });
      setLanMessage('LAN sync settings saved. New target will apply on next sync cycle.');
    } catch (err) {
      setLanMessage(err.response?.data?.error || 'Failed to save LAN settings.');
    } finally { setSavingLan(false); }
  };

  const doFactoryReset = async (includeSettings) => {
    setFactoryResetting(true);
    try {
      await fetch('/api/sync/factory-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeSettings }),
      });
      logout();
    } catch {
      alert('Factory reset failed. Please try again.');
      setFactoryResetting(false);
      setResetStep(0);
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>System Settings</h1>
          <p>POS hardware, currencies, sync and device-level configuration</p>
        </div>
      </div>

      <div className="profile-form-card">
        <form onSubmit={handleSave}>

          {/* ── Currency Mode (per-branch dual-currency gate) ───────────── */}
          {/* Drives whether the FX rate inputs, dual-currency payment modal, */}
          {/* and USD+FRA receipt lines appear in this tenant's UI. K-only    */}
          {/* branches (lusaka1, mansa1) keep the current Kwacha flow. The    */}
          {/* dual-currency branch (kassumbalesa1) flips to 'USD+FRA' so the  */}
          {/* extra UI surfaces. Stored on business_settings.currency_mode.   */}
          <div className="form-section">
            <h3 className="form-section-title"><FiDollarSign /> Currency Mode</h3>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
              Controls dual-currency features for this branch. Most branches keep <strong>Kwacha only</strong>.
              Switch to <strong>USD + FRA</strong> only on the branch that accepts foreign currency at the till.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { val: 'K',       label: 'Kwacha only',       sub: 'Single-currency POS (default)' },
                { val: 'USD+FRA', label: 'USD + FRA (dual)',  sub: 'Unlocks FX rates, dual-currency payment, USD+FRA receipt' },
              ].map(opt => (
                <label key={opt.val}
                       style={{ flex: '1 1 240px', display: 'flex', alignItems: 'flex-start', gap: 10,
                                padding: '12px 14px',
                                border: `1.5px solid ${form.currencyMode === opt.val ? '#2563eb' : '#e5e7eb'}`,
                                borderRadius: 10,
                                background: form.currencyMode === opt.val ? '#eff6ff' : '#fff',
                                cursor: 'pointer' }}>
                  <input type="radio" name="currency-mode" value={opt.val}
                         checked={form.currencyMode === opt.val}
                         onChange={() => setForm(f => ({ ...f, currencyMode: opt.val }))}
                         style={{ marginTop: 3 }} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{opt.sub}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* ── Workflow Mode (per-branch POS shape) ─────────────────────── */}
          {/* Drives whether this branch uses the single-screen POS (one      */}
          {/* cashier creates + pays in one step) or the 3-station flow       */}
          {/* (Sales → Cashier → Dispatch). Default 'single_pos' keeps        */}
          {/* lusaka1, mansa1 on the current behaviour; kassumbalesa1 flips    */}
          {/* to 'three_station'. Stored on business_settings.workflow_mode.   */}
          <div className="form-section">
            <h3 className="form-section-title"><FiDollarSign /> Workflow Mode</h3>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
              Controls the POS shape for this branch. Most branches use the <strong>single-screen POS</strong>.
              Switch to <strong>3-station</strong> only on branches where Sales, Cashier, and Dispatch are separate roles.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { val: 'single_pos',    label: 'Single-screen POS',  sub: 'One cashier does everything (default)' },
                { val: 'three_station', label: '3-station workflow', sub: 'Sales → Cashier → Dispatch with order hand-off' },
              ].map(opt => (
                <label key={opt.val}
                       style={{ flex: '1 1 240px', display: 'flex', alignItems: 'flex-start', gap: 10,
                                padding: '12px 14px',
                                border: `1.5px solid ${form.workflowMode === opt.val ? '#2563eb' : '#e5e7eb'}`,
                                borderRadius: 10,
                                background: form.workflowMode === opt.val ? '#eff6ff' : '#fff',
                                cursor: 'pointer' }}>
                  <input type="radio" name="workflow-mode" value={opt.val}
                         checked={form.workflowMode === opt.val}
                         onChange={() => setForm(f => ({ ...f, workflowMode: opt.val }))}
                         style={{ marginTop: 3 }} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{opt.sub}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* ── Currencies ──────────────────────────────────────────────── */}
          <div className="form-section">
            <h3 className="form-section-title"><FiDollarSign /> Currencies</h3>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
              Configure the currencies you trade in. The <strong>Primary</strong> currency's symbol appears in all price displays.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button type="button"
                onClick={() => setForm(f => ({ ...f, currencies: [...(f.currencies || []), { code: '', symbol: '', is_primary: false }] }))}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                <FiPlus size={12} /> Add Currency
              </button>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {(form.currencies || []).map((c, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr auto auto', gap: 8, alignItems: 'center', background: '#fff', padding: 10, borderRadius: 6, border: '1px solid #e5e7eb' }}>
                  <div>
                    <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>Code</label>
                    <input type="text" value={c.code} placeholder="e.g. USD, ZMW, EUR"
                      onChange={e => setForm(f => ({ ...f, currencies: f.currencies.map((q, i) => i === idx ? { ...q, code: e.target.value.toUpperCase() } : q) }))}
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 5, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>Symbol</label>
                    <input type="text" value={c.symbol} placeholder="$ / K / €"
                      onChange={e => setForm(f => ({ ...f, currencies: f.currencies.map((q, i) => i === idx ? { ...q, symbol: e.target.value } : q) }))}
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 5, fontSize: 13, fontWeight: 700, textAlign: 'center', boxSizing: 'border-box' }} />
                  </div>
                  <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: c.is_primary ? '#16a34a' : '#6b7280', cursor: 'pointer' }}>
                    <span>Primary</span>
                    <input type="radio" checked={!!c.is_primary} name="primaryCurrency"
                      onChange={() => setForm(f => ({ ...f, currencies: f.currencies.map((q, i) => ({ ...q, is_primary: i === idx })) }))} />
                  </label>
                  <button type="button"
                    disabled={(form.currencies || []).length <= 1}
                    onClick={() => setForm(f => {
                      const remaining = f.currencies.filter((_, i) => i !== idx);
                      if (!remaining.some(c => c.is_primary) && remaining.length) remaining[0].is_primary = true;
                      return { ...f, currencies: remaining };
                    })}
                    title={(form.currencies || []).length <= 1 ? 'At least one currency required' : 'Remove'}
                    style={{ width: 32, height: 32, background: (form.currencies || []).length <= 1 ? '#f3f4f6' : '#fee2e2', color: (form.currencies || []).length <= 1 ? '#9ca3af' : '#dc2626', border: 'none', borderRadius: 5, cursor: (form.currencies || []).length <= 1 ? 'not-allowed' : 'pointer' }}>
                    <FiTrash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* ── Single-location mode ────────────────────────────────────── */}
          <div className="form-section" style={{ marginTop: 24 }}>
            <h3 className="form-section-title">Single-location mode</h3>
            <div style={{ padding: '12px 14px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox"
                  checked={!!form.singleLocationMode}
                  onChange={e => setForm({ ...form, singleLocationMode: e.target.checked })}
                  style={{ marginTop: 3 }} />
                <span>
                  <span style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Auto-SIV after each GRN</span>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3, lineHeight: 1.5 }}>
                    Every GRN automatically issues to the sales counter — no manual SIV needed.
                    Useful for shops where the store and sales counter are the same room.
                  </div>
                </span>
              </label>
            </div>
          </div>

          {/* ── Stock guard at POS ─────────────────────────────────────── */}
          <div className="form-section" style={{ marginTop: 24 }}>
            <h3 className="form-section-title">Stock guard at POS</h3>
            <div style={{ padding: '12px 14px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox"
                  checked={!!form.blockOversell}
                  onChange={e => setForm({ ...form, blockOversell: e.target.checked })}
                  style={{ marginTop: 3 }} />
                <span>
                  <span style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Block selling beyond available stock</span>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3, lineHeight: 1.5 }}>
                    When ON: product cards with 0 stock can't be tapped, and the cart qty edit caps at what's
                    available. When OFF (default): cashiers can sell beyond stock — the existing behaviour.
                  </div>
                </span>
              </label>
            </div>
          </div>

          {/* ── Default crate / empty-bottle deposit ────────────────────── */}
          <div className="form-section" style={{ marginTop: 24 }}>
            <h3 className="form-section-title">Default crate / empty-bottle deposit</h3>
            <div style={{ padding: '12px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220, fontSize: 12, color: '#78350f', lineHeight: 1.5 }}>
                Pre-fills the deposit value on each GRN line that has a linked container.
                You can still override per line. Set the linked empty product on each item under <em>Item Details → Returnable Container</em>.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#92400e' }}>{form.currencies?.find(c => c.is_primary)?.symbol || ''}</span>
                <input type="number" step="0.01" min="0"
                  value={form.defaultCrateDeposit ?? ''}
                  onChange={e => setForm({ ...form, defaultCrateDeposit: e.target.value === '' ? '' : parseFloat(e.target.value) })}
                  placeholder="57"
                  style={{ width: 110, padding: '8px 10px', border: '1px solid #fcd34d', borderRadius: 6, fontSize: 14, fontWeight: 600, textAlign: 'right' }} />
              </div>
            </div>
          </div>

          {/* ── Receipt Printer ─────────────────────────────────────────── */}
          <div className="form-section" style={{ marginTop: 24 }}>
            <h3 className="form-section-title"><FiPrinter /> Receipt Printer</h3>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
              Choose how the receipt printer is connected. <strong>USB / Shared</strong> uses the Windows printer queue name
              (Devices and Printers, e.g. POS-80). <strong>Network (LAN)</strong> sends raw ESC/POS bytes to the printer's IP
              on its TCP port (default 9100).
            </p>
            <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
              {[
                { val: 'usb', label: 'USB / Shared',  sub: 'Windows printer queue' },
                { val: 'lan', label: 'Network (LAN)', sub: 'Direct IP — port 9100' },
              ].map(opt => (
                <label key={opt.val}
                  style={{
                    flex: 1, padding: '12px 14px', borderRadius: 8, cursor: 'pointer',
                    border: `2px solid ${form.receiptPrinterType === opt.val ? '#2563eb' : '#e5e7eb'}`,
                    background: form.receiptPrinterType === opt.val ? '#eff6ff' : '#fff',
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                  <input type="radio" name="printerType"
                    checked={form.receiptPrinterType === opt.val}
                    onChange={() => setForm({ ...form, receiptPrinterType: opt.val })}
                    style={{ accentColor: '#2563eb' }} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: form.receiptPrinterType === opt.val ? '#1d4ed8' : '#374151' }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{opt.sub}</div>
                  </div>
                </label>
              ))}
            </div>
            {form.receiptPrinterType === 'usb' ? (
              <div className="form-group" style={{ marginBottom: 0, maxWidth: 360 }}>
                <label>Windows Printer Name</label>
                <input type="text"
                  value={form.receiptPrinterName}
                  onChange={e => setForm({ ...form, receiptPrinterName: e.target.value })}
                  placeholder="e.g. POS-80" />
                <small style={{ color: '#6b7280', fontSize: 11 }}>
                  Find this in Windows → Devices and Printers (right-click the printer → Printer properties → Sharing tab).
                </small>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, maxWidth: 520 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Printer IP Address</label>
                  <input type="text" value={form.receiptPrinterIp}
                    onChange={e => setForm({ ...form, receiptPrinterIp: e.target.value })}
                    placeholder="e.g. 192.168.1.50" />
                  <small style={{ color: '#6b7280', fontSize: 11 }}>The LAN IP shown on the printer's self-test page.</small>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>TCP Port</label>
                  <input type="number" min="1" max="65535" value={form.receiptPrinterPort}
                    onChange={e => setForm({ ...form, receiptPrinterPort: parseInt(e.target.value) || 9100 })}
                    placeholder="9100" />
                </div>
              </div>
            )}

            <details style={{ marginTop: 16 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: '#6b7280' }}>Legacy drawer port (advanced)</summary>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: 12 }}>Drawer Port</label>
                  <input type="text" value={drawerPort}
                    onChange={e => setDrawerPort(e.target.value)}
                    placeholder="e.g. POS-80" style={{ width: 160 }} />
                </div>
                <button type="button" onClick={handleSaveDrawerPort} disabled={savingPort} className="btn btn-secondary" style={{ marginBottom: 0 }}>
                  <FiSave /> {savingPort ? 'Saving...' : 'Save'}
                </button>
                <small style={{ color: '#9ca3af', fontSize: 11, flexBasis: '100%' }}>
                  Used by the standalone Open Drawer fallback when no printer is configured above.
                </small>
              </div>
            </details>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <FiSave /> {saving ? 'Saving...' : 'Save System Settings'}
            </button>
          </div>
        </form>

        {/* ── Customer Display ──────────────────────────────────────────── */}
        <div className="form-section" style={{ marginTop: 24 }}>
          <h3 className="form-section-title"><FiMonitor /> Customer Display</h3>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
            Preview how the customer-facing screen looks on the second monitor.
          </p>
          <button type="button"
            onClick={() => window.open(`/customer-display?bizName=${encodeURIComponent(businessName || '')}`, '_blank', 'width=1024,height=768')}
            className="btn btn-secondary">
            <FiMonitor /> Preview Customer Display
          </button>
        </div>

        {/* ── Mobile Print Mode ────────────────────────────────────────── */}
        <div className="form-section" style={{ marginTop: 24 }}>
          <h3 className="form-section-title"><FiPrinter /> Mobile Print Mode</h3>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
            How receipts and reports print when this device is a phone (screen ≤ 768 px).
            Desktop is always uses the print dialog.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 12px', border: `1.5px solid ${mobilePrintMode === 'print' ? '#2563eb' : '#e5e7eb'}`, borderRadius: 10, cursor: 'pointer', background: mobilePrintMode === 'print' ? '#eff6ff' : '#fff' }}>
              <input
                type="radio"
                name="mobile-print-mode"
                value="print"
                checked={mobilePrintMode === 'print'}
                onChange={() => updateMobilePrintMode('print')}
                style={{ marginTop: 4 }}
              />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>Print Dialog</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  Opens the browser's print dialog. The user picks "Save as PDF" or a connected printer.
                </div>
              </div>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 12px', border: `1.5px solid ${mobilePrintMode === 'pdf' ? '#2563eb' : '#e5e7eb'}`, borderRadius: 10, cursor: 'pointer', background: mobilePrintMode === 'pdf' ? '#eff6ff' : '#fff' }}>
              <input
                type="radio"
                name="mobile-print-mode"
                value="pdf"
                checked={mobilePrintMode === 'pdf'}
                onChange={() => updateMobilePrintMode('pdf')}
                style={{ marginTop: 4 }}
              />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>PDF Download <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700, marginLeft: 6 }}>RECOMMENDED</span></div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  Generates a PDF and downloads it. Always works — no dialog needed.
                </div>
              </div>
            </label>
          </div>
          <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 10 }}>
            Saved per-device — set this on each phone independently.
          </p>
        </div>

        {/* ── Cloud Sync ────────────────────────────────────────────────── */}
        <div className="form-section" style={{ marginTop: 24 }}>
          <h3 className="form-section-title"><FiCloud /> Cloud Sync</h3>
          {syncInfo ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              {syncInfo.tenantId === 'local-only' || !syncInfo.isConfigured ? (
                <>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280' }}>
                    <FiWifiOff size={16} /> Offline Only — not connected to cloud
                  </span>
                  <button className="btn btn-primary" onClick={handleConnectToCloud} disabled={resetting} style={{ marginLeft: 'auto' }}>
                    <FiWifi /> {resetting ? 'Resetting...' : 'Connect to Cloud'}
                  </button>
                </>
              ) : (
                <>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#16a34a' }}>
                    <FiWifi size={16} /> Connected to Cloud
                  </span>
                  <span style={{ color: '#6b7280', fontSize: 13 }}>
                    {syncInfo.vpsUrl && <><strong style={{ color: '#111827' }}>{syncInfo.vpsUrl.replace('https://','').split('.')[0]}</strong>.sidanitsolutions.com &nbsp;|&nbsp;</>}
                    Tenant: <strong>{syncInfo.tenantId?.substring(0, 8)}…</strong> &nbsp;|&nbsp;
                    Branch: <strong>{syncInfo.branchId?.substring(0, 8)}…</strong>
                  </span>
                  <button className="btn btn-secondary" onClick={handleConnectToCloud} disabled={resetting} style={{ marginLeft: 'auto' }}>
                    <FiWifiOff /> {resetting ? 'Resetting...' : 'Change / Disconnect'}
                  </button>
                </>
              )}
            </div>
          ) : (
            <span style={{ color: '#9ca3af', fontSize: 13 }}>Loading sync status…</span>
          )}
        </div>

        {/* ── LAN Sync (Mother / Child) ────────────────────────────────── */}
        <div className="form-section" style={{ marginTop: 24 }}>
          <h3 className="form-section-title"><FiServer /> LAN Sync (Mother / Child)</h3>
          <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 14, marginTop: -4 }}>
            On a multi-PC setup, designate one PC as the Mother. Other PCs (children) sync to the Mother instead of directly to the cloud.
            Leave unchecked + Mother IP empty to keep the existing direct-to-cloud sync.
          </p>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={lanConfig.role === 'mother'}
              onChange={e => setLanConfig({ ...lanConfig, role: e.target.checked ? 'mother' : 'child' })}
              style={{ width: 16, height: 16, cursor: 'pointer' }} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>This PC is the Mother</span>
          </label>

          {lanConfig.role === 'mother' ? (
            <>
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: '#15803d', fontWeight: 600, marginBottom: 4 }}>This PC's LAN IP (give to child PCs):</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#14532d', fontFamily: 'monospace' }}>{lanConfig.localIp || '—'}</div>
                {lanConfig.allLocalIps && lanConfig.allLocalIps.length > 1 && (
                  <div style={{ fontSize: 11, color: '#374151', marginTop: 8, padding: '6px 8px', background: '#fff', border: '1px dashed #bbf7d0', borderRadius: 6 }}>
                    <strong style={{ color: '#15803d' }}>Other detected addresses</strong> (use one of these on children if the one above doesn't work):
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontFamily: 'monospace', fontSize: 11 }}>
                      {lanConfig.allLocalIps.map((entry, i) => <li key={i}>{entry}</li>)}
                    </ul>
                  </div>
                )}
                <div style={{ fontSize: 11, color: '#15803d', marginTop: 6 }}>Make sure this PC has a <strong>static IP</strong> on your router so children don't lose connection.</div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: '#374151', fontWeight: 600, marginBottom: 6 }}>
                  Children connected: <span style={{ color: lanChildren.length > 0 ? '#16a34a' : '#9ca3af' }}>{lanChildren.length}</span>
                  <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 8, fontWeight: 400 }}>(active in last 5 min)</span>
                </div>
                {lanChildren.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>No children syncing yet. Configure other PCs with this Mother's IP and the same sync key.</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: '#6b7280', textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5 }}>
                        <th style={{ textAlign: 'left',  padding: '4px 8px', fontWeight: 600 }}>Device</th>
                        <th style={{ textAlign: 'left',  padding: '4px 8px', fontWeight: 600 }}>IP</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 600 }}>Last sync</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lanChildren.map(c => (
                        <tr key={c.deviceId} style={{ borderTop: '1px solid #e5e7eb' }}>
                          <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#374151' }}>{c.deviceShort}</td>
                          <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#6b7280' }}>{c.ip}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: c.secondsAgo < 10 ? '#16a34a' : '#6b7280' }}>{c.secondsAgo}s ago</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>Mother PC's IP Address</label>
              <input type="text" value={lanConfig.motherIp}
                onChange={e => setLanConfig({ ...lanConfig, motherIp: e.target.value })}
                placeholder="e.g. 192.168.1.10  (leave empty to use cloud direct)"
                style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }} />
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>LAN Sync Key (shared secret across all PCs in this branch)</label>
            <input type="text" value={lanConfig.lanSyncKey}
              onChange={e => setLanConfig({ ...lanConfig, lanSyncKey: e.target.value })}
              placeholder="e.g. wisekings-aroma-2026"
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={handleSaveLan} disabled={savingLan} className="btn btn-primary">
              <FiSave /> {savingLan ? 'Saving…' : 'Save LAN Settings'}
            </button>
            {lanMessage && (
              <span style={{ fontSize: 13, color: lanMessage.includes('Failed') ? '#dc2626' : '#16a34a' }}>{lanMessage}</span>
            )}
          </div>
        </div>

        {/* ── Factory Reset (Danger Zone) ──────────────────────────────── */}
        <div className="form-section" style={{ marginTop: 24, borderTop: '2px solid #fee2e2', paddingTop: 20 }}>
          <h3 className="form-section-title" style={{ color: '#dc2626' }}><FiAlertTriangle /> Danger Zone</h3>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
            Factory reset wipes all local data — products, orders, GRN, SIV, customers, suppliers, and disconnects from cloud. This cannot be undone.
          </p>
          <button type="button" onClick={() => setResetStep(1)}
            style={{ padding: '9px 20px', background: '#fff', border: '2px solid #dc2626', borderRadius: 8, color: '#dc2626', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
            <FiAlertTriangle style={{ marginRight: 6 }} /> Factory Reset
          </button>
        </div>
      </div>

      {/* ── Confirm reset modals ────────────────────────────────────────── */}
      {resetStep === 1 && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '36px 40px', maxWidth: 400, width: '90%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#fee2e2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <FiAlertTriangle size={28} color="#dc2626" />
            </div>
            <h3 style={{ margin: '0 0 8px', fontSize: 20 }}>Factory Reset?</h3>
            <p style={{ color: '#6b7280', fontSize: 14, margin: '0 0 24px' }}>
              This will permanently delete <strong>all data</strong> on this device — orders, products, GRN, SIV, customers, suppliers — and disconnect from cloud. This <strong>cannot be undone</strong>.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => setResetStep(0)} style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
              <button onClick={() => setResetStep(2)} style={{ padding: '10px 24px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>Yes, Continue</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {resetStep === 2 && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '36px 40px', maxWidth: 400, width: '90%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 18 }}>Delete Company Settings?</h3>
            <p style={{ color: '#6b7280', fontSize: 14, margin: '0 0 24px' }}>
              Do you also want to delete the company name, phone number, and email?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => doFactoryReset(true)}  disabled={factoryResetting} style={{ padding: '12px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
                {factoryResetting ? 'Resetting...' : 'Yes — Delete Everything'}
              </button>
              <button onClick={() => doFactoryReset(false)} disabled={factoryResetting} style={{ padding: '12px', background: '#f97316', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
                {factoryResetting ? 'Resetting...' : 'No — Keep Company Settings'}
              </button>
              <button onClick={() => setResetStep(0)} disabled={factoryResetting} style={{ padding: '10px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={pendingDelete?.subject || ''}
        actionLabel={pendingDelete?.actionLabel || 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

export default SystemSettings;
