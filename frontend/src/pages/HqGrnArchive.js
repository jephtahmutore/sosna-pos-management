// HqGrnArchive — v1.9.14
// HQ-wide list of every CONFIRMED branch GRN, served from the
// master.db snapshot table. Full GRN doc (line items + credit notes)
// stays at the branch and is fetched on demand via "See Details".
//
// Filters: branch, supplier, from/to date. Roll-up footer shows item
// subtotal, CN total, and final payable across the filtered set so
// HQ can spot per-supplier or per-period AP movement at a glance.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiEye, FiInbox, FiX, FiPaperclip, FiUser, FiClock, FiFileText, FiSlash } from 'react-icons/fi';
import { getHqGrnArchive, getHqGrn, getHqGrnDetail, getHqBranches, getHqSuppliers, voidHqGrn } from '../services/api';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const fmtMoney = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayISO = () => new Date().toISOString().slice(0, 10);
const monthAgoISO = () => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
};

export default function HqGrnArchive() {
  const [rows, setRows]       = useState([]);
  const [totals, setTotals]   = useState({ count: 0, subtotal: 0, cn: 0, payable: 0 });
  const [branches, setBranches] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [branch, setBranch]   = useState('all');
  const [supplier, setSupplier] = useState('all');
  const [from, setFrom]       = useState(monthAgoISO());
  const [to, setTo]           = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [viewing, setViewing] = useState(null); // { grn, items, loading } | null

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await getHqGrnArchive({ branch, supplier, from, to });
      setRows(res.data?.grns || []);
      setTotals(res.data?.totals || { count: 0, subtotal: 0, cn: 0, payable: 0 });
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load.');
    }
    setLoading(false);
  };

  useEffect(() => {
    getHqBranches().then(r => setBranches(r.data?.branches || [])).catch(() => {});
    getHqSuppliers().then(r => setSuppliers(r.data?.suppliers || [])).catch(() => {});
  }, []);

  // Re-query whenever filters change.
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [branch, supplier, from, to]);

  const seeDetails = async (g) => {
    setViewing({ grn: g, items: [], cnRows: [], loading: true });
    try {
      // v1.10.3 — HQ-generated GRNs live at master.db → hq_grns. Legacy
      // ones live at the branch DB. Route to the correct detail endpoint.
      const r = g.source === 'hq'
        ? await getHqGrnDetail(g.grn_sync_id)
        : await getHqGrn(g.branch_slug, g.grn_sync_id);
      setViewing({
        grn:   r.data?.grn   || g,
        items: r.data?.items || [],
        cnRows: r.data?.credit_notes || [],
        damageByProduct: r.data?.damage_by_product || {},
        loading: false,
      });
    } catch (err) {
      setViewing({ grn: g, items: [], cnRows: [], loading: false, error: err?.response?.data?.error || 'Failed to load details.' });
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ GRN Archive</h1>
          <p>Every confirmed Goods Received Note across all branches</p>
        </div>
        <button onClick={load}
          style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, padding: 14, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 14 }}>
        <div>
          <label style={lbl}>Branch</label>
          <select value={branch} onChange={e => setBranch(e.target.value)} style={inp}>
            <option value="all">All branches</option>
            {branches.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Supplier</label>
          <select value={supplier} onChange={e => setSupplier(e.target.value)} style={inp}>
            <option value="all">All suppliers</option>
            {suppliers.map(s => <option key={s.id} value={s.sync_id || s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        </div>
        <div>
          <label style={lbl}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        </div>
      </div>

      {/* Roll-up cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
        <Card label="GRNs"          value={totals.count.toLocaleString()} color="#0ea5e9" />
        <Card label="Items Subtotal" value={fmtMoney(totals.subtotal)}     color="#0f172a" />
        <Card label="Credit Notes"   value={`−${fmtMoney(totals.cn)}`}     color="#dc2626" />
        <Card label="Final Payable"  value={fmtMoney(totals.payable)}      color="#16a34a" big />
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && rows.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiInbox /> No GRNs match those filters.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Date</th>
                  <th style={th}>GRN #</th>
                  <th style={th}>From PO</th>
                  <th style={th}>Branch</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Invoice #</th>
                  <th style={{ ...th, textAlign: 'right' }}>Items</th>
                  <th style={{ ...th, textAlign: 'right' }}>Subtotal</th>
                  <th style={{ ...th, textAlign: 'right' }}>CN</th>
                  <th style={{ ...th, textAlign: 'right' }}>Payable</th>
                  <th style={th}>Confirmed</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(g => (
                  <tr key={g.grn_sync_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>{g.date}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12, fontWeight: 700 }}>{g.grn_number}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12, color: '#64748b' }}>{g.po_number || '—'}</td>
                    <td style={td}>{g.branch_name || g.branch_slug}</td>
                    <td style={td}>{g.supplier_name || '—'}</td>
                    <td style={td}>{g.invoice_number || '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{g.items_count}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(g.items_subtotal)}</td>
                    <td style={{ ...td, textAlign: 'right', color: g.cn_total > 0 ? '#dc2626' : '#94a3b8' }}>{g.cn_total > 0 ? `−${fmtMoney(g.cn_total)}` : '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{fmtMoney(g.final_payable)}</td>
                    <td style={{ ...td, fontSize: 11, color: '#64748b' }}>
                      {g.confirmed_at ? new Date(g.confirmed_at).toLocaleString() : '—'}
                      {g.confirmed_by_name ? <div style={{ color: '#94a3b8' }}>{g.confirmed_by_name}</div> : null}
                    </td>
                    <td style={td}>
                      <button onClick={() => seeDetails(g)}
                        style={{ padding: '5px 12px', background: '#fff', color: '#0ea5e9', border: '1px solid #bae6fd', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <FiEye size={12} /> See Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewing && <DetailsModal
        state={viewing}
        onClose={() => setViewing(null)}
        onVoided={() => { setViewing(null); load(); }}
      />}
    </div>
  );
}

function Card({ label, value, color, big }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: big ? 24 : 20, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function ProvenanceField({ label, value, extra, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', fontFamily: mono ? 'monospace' : 'inherit' }}>{value}</div>
      {extra}
    </div>
  );
}

// v1.10.3 — cross-subdomain URL for branch-hosted invoice photos. The
// upload landed in TENANTS_DIR/<slug>/uploads/, so we point the browser at
// <slug>.<apex>/uploads/<path>.
function branchUploadUrl(branchSlug, path) {
  if (!path || !branchSlug) return null;
  const currentHost = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
  if (currentHost.startsWith(`${branchSlug}.`)) return `/uploads/${path}`;
  const parts = currentHost.split('.');
  const apex = parts.length > 2 ? parts.slice(1).join('.') : currentHost;
  const proto = (typeof window !== 'undefined' && window.location.protocol) || 'https:';
  return `${proto}//${branchSlug}.${apex}/uploads/${path}`;
}

// v1.10.4 — full provenance modal. Header shows GRN #; a Provenance card
// lays out PO, supplier, invoice # + attachment, branch confirmer,
// HQ generator, and timestamps. Line items + credit notes + totals follow.
function DetailsModal({ state, onClose, onVoided }) {
  const { grn, items, cnRows, damageByProduct = {}, loading, error } = state;
  const itemsSubtotal = items.reduce((s, i) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0), 0);
  const invoiceNumber = grn.invoice_number || grn.supplier_invoice_number;
  const invoiceUrl    = branchUploadUrl(grn.branch_slug, grn.invoice_attachment);
  const confirmedByBranch     = grn.confirmed_by_branch_name;
  const confirmedAtBranch     = grn.confirmed_at_branch;
  const generatedByHq         = grn.generated_by_hq_name || grn.confirmed_by_name;
  const generatedAt           = grn.generated_at        || grn.confirmed_at;
  // v1.10.115 — void flow. Two-step: user opens reason prompt → admin
  // password prompt. Only HQ-generated GRNs (source='hq' i.e. grn_sync_id
  // routes to /hq/hq/:syncId) can be voided from here; legacy branch GRNs
  // don't have a corresponding master.hq_grns row to soft-delete.
  const [voidStep, setVoidStep] = useState(null); // null | 'reason' | 'password'
  const [voidReason, setVoidReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState('');
  const canVoid = !!grn?.grn_sync_id;
  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 12, width: 'min(960px, 95vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>GRN {grn.grn_number || grn.grn_sync_id}</h3>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
              Branch: <strong>{grn.branch_name || grn.branch_slug}</strong>
              {grn.date && <> · {grn.date}</>}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <p style={{ color: '#64748b' }}>Loading…</p>
          ) : error ? (
            <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8 }}>
              {error}
              <div style={{ fontSize: 11, marginTop: 6, color: '#7f1d1d' }}>The branch may be offline. Snapshot totals are still visible on the list.</div>
            </div>
          ) : (
            <>
              {/* Provenance */}
              <div style={{ padding: 14, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <ProvenanceField label="From PO" value={grn.po_number || '—'} mono />
                <ProvenanceField label="Supplier" value={grn.supplier_name || '—'} />
                <ProvenanceField
                  label="Supplier Invoice #"
                  value={invoiceNumber || '—'}
                  extra={invoiceUrl && (
                    <a href={invoiceUrl} target="_blank" rel="noopener noreferrer"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4, color: '#1d4ed8', fontSize: 11, fontWeight: 600, textDecoration: 'none' }}>
                      <FiPaperclip size={11} /> View attachment
                    </a>
                  )}
                />
                <ProvenanceField
                  label={<><FiUser size={11} style={{ verticalAlign: 'middle' }}/> Confirmed at branch</>}
                  value={confirmedByBranch || '—'}
                  extra={confirmedAtBranch && (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      <FiClock size={10} style={{ verticalAlign: 'middle' }}/> {new Date(confirmedAtBranch).toLocaleString()}
                    </div>
                  )}
                />
                <ProvenanceField
                  label={<><FiFileText size={11} style={{ verticalAlign: 'middle' }}/> Generated at HQ</>}
                  value={generatedByHq || '—'}
                  extra={generatedAt && (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      <FiClock size={10} style={{ verticalAlign: 'middle' }}/> {new Date(generatedAt).toLocaleString()}
                    </div>
                  )}
                />
                <ProvenanceField label="Branch" value={grn.branch_name || grn.branch_slug} />
                {grn.notes && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <ProvenanceField label="Notes" value={grn.notes} />
                  </div>
                )}
              </div>

              <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#374151' }}>Line Items</h4>
              {items.length === 0 ? (
                <p style={{ color: '#9ca3af', fontStyle: 'italic' }}>No line items.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead style={{ background: '#f8fafc' }}>
                    <tr>
                      <th style={th}>Product</th>
                      <th style={th}>Unit</th>
                      <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                      {/* v1.10.114 — Damaged column. Shown in line units by
                          multiplying damaged_base × (line_qty / in_base). Cell
                          renders '—' when no damage recorded for this product. */}
                      <th style={{ ...th, textAlign: 'right', color: '#b91c1c' }}>Damaged</th>
                      <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                      <th style={{ ...th, textAlign: 'right' }}>Line $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(it => {
                      const dmg  = damageByProduct[it.product_sync_id];
                      const qtyLine = parseFloat(it.quantity || 0);
                      const damagedLine = (dmg && dmg.in_base > 0)
                        ? (parseFloat(dmg.damaged_base) * qtyLine) / parseFloat(dmg.in_base)
                        : (dmg ? parseFloat(dmg.damaged_base) : 0);
                      return (
                        <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={td}><strong>{it.product_name || `#${it.product_id}`}</strong>{it.product_code && <span style={{ color: '#94a3b8', fontSize: 11 }}> ({it.product_code})</span>}</td>
                          <td style={td}>{it.unit || it.product_base_unit}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{qtyLine.toLocaleString()}</td>
                          <td style={{ ...td, textAlign: 'right', color: damagedLine > 0 ? '#b91c1c' : '#94a3b8', fontWeight: damagedLine > 0 ? 700 : 400 }}>
                            {damagedLine > 0 ? damagedLine.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
                          </td>
                          <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>{fmtMoney(it.unit_price)}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtMoney(qtyLine * parseFloat(it.unit_price || 0))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid #e5e7eb', fontWeight: 700 }}>
                      <td colSpan={5} style={td}>Items subtotal</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(itemsSubtotal || grn.items_subtotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}

              {cnRows && cnRows.length > 0 && (
                <>
                  <h4 style={{ margin: '18px 0 8px', fontSize: 13, color: '#374151' }}>Credit Notes</h4>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead style={{ background: '#f8fafc' }}>
                      <tr>
                        <th style={th}>Type</th>
                        <th style={th}>Notes</th>
                        <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cnRows.map(c => (
                        <tr key={c.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={td}><strong>{c.reason}</strong></td>
                          <td style={{ ...td, color: '#64748b' }}>{c.notes || '—'}</td>
                          <td style={{ ...td, textAlign: 'right', color: '#dc2626', fontWeight: 700 }}>−{fmtMoney(c.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <div style={{ marginTop: 18, padding: 14, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span>Items subtotal</span><strong>{fmtMoney(grn.items_subtotal || itemsSubtotal)}</strong></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: grn.cn_total > 0 ? '#dc2626' : '#9ca3af' }}><span>Credit Notes</span><strong>{grn.cn_total > 0 ? '−' : ''}{fmtMoney(grn.cn_total)}</strong></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', marginTop: 6, borderTop: '2px solid #e5e7eb', fontWeight: 700, fontSize: 15 }}>
                  <span>Final Payable</span>
                  <span style={{ color: '#16a34a' }}>{fmtMoney(grn.final_payable || (itemsSubtotal - (grn.cn_total || 0)))}</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          {canVoid ? (
            <button onClick={() => { setVoidStep('reason'); setVoidError(''); }}
              disabled={loading || voidBusy}
              style={{ padding: '8px 18px', background: '#fff', color: '#b91c1c', border: '1px solid #fca5a5', borderRadius: 6, cursor: (loading || voidBusy) ? 'not-allowed' : 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <FiSlash size={14} /> Void GRN
            </button>
          ) : <div />}
          <button onClick={onClose}
            style={{ padding: '8px 22px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>Close</button>
        </div>
      </div>

      {/* Step 1 — reason prompt. Modal-in-modal on purpose so the user sees
          the GRN context behind it. Blocks the "void" action until reason
          is non-empty AND admin password is verified.
          v1.10.116 — stopPropagation on BOTH the overlay and the inner card,
          because this prompt renders INSIDE the parent DetailsModal's
          overlay div (which has onClick=onClose). Without stopPropagation,
          any click here — even typing in the textarea — bubbles up to the
          parent and closes the whole GRN modal. */}
      {voidStep === 'reason' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500 }}
             onClick={(e) => {
               e.stopPropagation();
               if (e.target === e.currentTarget && !voidBusy) setVoidStep(null);
             }}>
          <div onClick={e => e.stopPropagation()}
               style={{ background: '#fff', borderRadius: 12, padding: 22, width: 460, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#b91c1c' }}>Void GRN {grn.grn_number}</h3>
            <p style={{ fontSize: 13, color: '#4b5563', margin: '0 0 14px', lineHeight: 1.5 }}>
              This reverses branch stock, soft-deletes the GRN, and resets the linked PO line back to AWAITING_GRN.
              <strong style={{ color: '#b45309', display: 'block', marginTop: 6 }}>WAC is NOT recomputed — the affected products keep their current blended WAC until next receipt.</strong>
            </p>
            <label style={{ ...lbl, color: '#374151' }}>Reason for voiding *</label>
            <textarea rows={3} value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. wrong unit cost typed at PO create — regenerating with correct K value"
              style={{ ...inp, resize: 'vertical', minHeight: 60 }} />
            {voidError && <div style={{ marginTop: 10, color: '#b91c1c', fontSize: 12 }}>{voidError}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => { setVoidStep(null); setVoidReason(''); setVoidError(''); }}
                disabled={voidBusy}
                style={{ padding: '9px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, cursor: voidBusy ? 'not-allowed' : 'pointer' }}>
                Cancel
              </button>
              <button
                onClick={() => {
                  if (voidReason.trim().length < 3) { setVoidError('Reason must be at least 3 characters.'); return; }
                  setVoidError('');
                  setVoidStep('password');
                }}
                disabled={voidBusy || voidReason.trim().length < 3}
                style={{ padding: '9px 18px', background: voidBusy || voidReason.trim().length < 3 ? '#fca5a5' : '#dc2626', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: voidBusy || voidReason.trim().length < 3 ? 'not-allowed' : 'pointer' }}>
                Continue → Admin auth
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 2 — admin password. On confirm we have adminId/adminName from
          verifyAdmin; POST the void with reason + admin attestation. */}
      <AdminPasswordPrompt
        open={voidStep === 'password'}
        subject={`GRN ${grn.grn_number} — ${grn.branch_name || grn.branch_slug}`}
        actionLabel="Void GRN"
        onCancel={() => { if (!voidBusy) setVoidStep('reason'); }}
        onConfirm={async ({ adminId, adminName }) => {
          setVoidBusy(true); setVoidError('');
          try {
            await voidHqGrn(grn.grn_sync_id, { reason: voidReason.trim(), adminId, adminName });
            setVoidBusy(false);
            setVoidStep(null);
            setVoidReason('');
            onVoided && onVoided();
          } catch (err) {
            setVoidBusy(false);
            setVoidStep('reason');
            const msg = err.response?.data?.error || 'Failed to void GRN.';
            const vios = err.response?.data?.violations;
            setVoidError(
              vios && vios.length
                ? `${msg}\nProducts already consumed: ${vios.map(v => `${v.product_name} (short ${v.shortfall})`).join(', ')}`
                : msg
            );
          }
        }}
      />
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4 };
const td  = { padding: '8px 12px', color: '#0f172a' };
