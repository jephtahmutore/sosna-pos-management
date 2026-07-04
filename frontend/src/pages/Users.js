import React, { useState, useEffect } from 'react';
import { getUsers, getUserStats, createUser, updateUser, deleteUser } from '../services/api';
import { FiPlus, FiSearch, FiEdit2, FiTrash2, FiUsers, FiUserCheck, FiUserX, FiShield, FiX, FiEye, FiEyeOff, FiUser, FiMail, FiPhone, FiLock } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { matchTokens } from '../utils/tokenSearch';

const ROLES = ['Administrator', 'Manager', 'Cashier', 'Staff'];
const roleColors = { Administrator: '#dc2626', Manager: '#2563eb', Cashier: '#16a34a', Staff: '#f59e0b' };
const avatarColors = ['#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#9333ea', '#0891b2', '#be185d'];

const ACTIONS = ['View', 'Add', 'Edit', 'Delete'];

const PAGE_GROUPS = [
  {
    group: 'Sales',
    pages: [
      { key: 'POS',          label: 'POS (Point of Sale)' },
      // Kassumbalesa 3-station workflow — separate roles per station.
      // Grant these to users you trust to take money + release goods.
      { key: 'Cashier',      label: 'Cashier station (3-station)' },
      { key: 'Dispatch',     label: 'Dispatch station (3-station)' },
      { key: 'SalesReport',  label: 'Sales Report' },
      { key: 'SalesInventory', label: 'Sales Inventory' },
      { key: 'CashReport',   label: 'Cash Report' },
      { key: 'SalesBinCard', label: 'Sales Bin Card' },
    ],
  },
  {
    group: 'Store',
    pages: [
      { key: 'Items',                label: 'Items / Products' },
      { key: 'Categories',           label: 'Categories' },
      { key: 'GRN',                  label: 'GRN (Goods Received)' },
      { key: 'SIV',                  label: 'SIV (Stock Issue Voucher)' },
      { key: 'SalesReturns',         label: 'Sales Returns' },
      { key: 'Production',           label: 'Production' },
      { key: 'StockAdjustment',      label: 'Stock Adjustments' },
      { key: 'StockReconciliation',  label: 'Stock Reconciliation' },
      { key: 'StockCount',           label: 'Stock Count' },
      { key: 'Inventory',            label: 'Inventory' },
      { key: 'BinCard',              label: 'Bin Card' },
      { key: 'ExpiryReport',         label: 'Expiry Report' },
    ],
  },
  {
    group: 'Accounting',
    pages: [
      { key: 'CashReceipt',        label: 'Cash Receipt (CR)' },
      { key: 'PaymentVoucher',     label: 'Payment Voucher (PV)' },
      { key: 'PvTypes',            label: 'PV Types' },
      { key: 'CashBook',           label: 'Cash Book' },
      { key: 'HQDeposits',         label: 'HQ Deposits' },
      { key: 'FxRates',            label: 'Currency Rates' },
      { key: 'AccountPayables',    label: 'Account Payables' },
      { key: 'AccountReceivables', label: 'Account Receivables' },
      { key: 'CapitalAccount',     label: 'Capital Account' },
      { key: 'DividendAccount',    label: 'Dividend Account' },
      { key: 'Shareholders',       label: 'Shareholders' },
      { key: 'LoanAccount',        label: 'Loan Account' },
      { key: 'ProfitReport',       label: 'Profit Report' },
    ],
  },
  {
    group: 'Contacts',
    pages: [
      { key: 'Suppliers', label: 'Suppliers' },
      { key: 'Customers', label: 'Customers' },
    ],
  },
];

// Expands old flat permissions (e.g. 'GRN', 'Accounting') to new 'Page:Action' format
const LEGACY_EXPAND = {
  POS:        ['POS'],
  Sales:      ['SalesReport', 'SalesInventory', 'CashReport', 'SalesBinCard'],
  Reports:    ['SalesReport', 'SalesInventory', 'CashReport', 'SalesBinCard'],
  Stock:      ['Items', 'Categories', 'StockAdjustment', 'StockReconciliation', 'StockCount', 'Inventory', 'BinCard', 'ExpiryReport'],
  GRN:        ['GRN', 'ExpiryReport'],
  SIV:        ['SIV', 'Production', 'SalesReturns'],
  Accounting: ['CashReceipt', 'PaymentVoucher', 'PvTypes', 'CashBook', 'HQDeposits', 'FxRates', 'AccountPayables', 'AccountReceivables', 'CapitalAccount', 'DividendAccount', 'Shareholders', 'LoanAccount', 'ProfitReport'],
  Suppliers:  ['Suppliers'],
  Customers:  ['Customers'],
};

const expandOldPerms = (perms) => {
  const result = new Set();
  for (const perm of perms) {
    if (perm.includes(':')) {
      result.add(perm);
    } else if (LEGACY_EXPAND[perm]) {
      LEGACY_EXPAND[perm].forEach(page =>
        ACTIONS.forEach(action => result.add(`${page}:${action}`))
      );
    }
  }
  return [...result];
};

const emptyForm = { firstName: '', lastName: '', email: '', password: '', phone: '', role: 'Cashier', status: 'Active' };
const getInitials = (first, last) => `${(first || '')[0] || ''}${(last || '')[0] || ''}`.toUpperCase() || '?';

const Users = () => {
  const [stats, setStats] = useState({ totalUsers: 0, active: 0, inactive: 0, administrators: 0 });
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('All');
  const [loading, setLoading] = useState(true);

  const [modal, setModal] = useState(null); // null | 'add' | 'edit' | 'delete'
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  // Permissions modal state
  const [permModal, setPermModal] = useState(false);

  useModalScrollLock(!!modal || permModal);
  const [permUser, setPermUser] = useState(null);
  const [accessLevel, setAccessLevel] = useState('Custom'); // 'All' | 'Custom'
  const [permList, setPermList] = useState([]);
  const [savingPerms, setSavingPerms] = useState(false);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchAll = async () => {
    try {
      const [statsRes, usersRes] = await Promise.all([getUserStats(), getUsers()]);
      if (statsRes.data) setStats(statsRes.data);
      if (usersRes.data) setUsers(usersRes.data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const openAdd = () => {
    setForm(emptyForm);
    setError('');
    setShowPassword(false);
    setModal('add');
  };

  const openEdit = (user) => {
    setSelected(user);
    setForm({
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      email: user.email || '',
      password: '',
      phone: user.phone || '',
      role: user.role || 'Cashier',
      status: user.status || 'Active',
    });
    setError('');
    setShowPassword(false);
    setModal('edit');
  };

  const openDelete = (user) => {
    setSelected(user);
    setPendingDelete({
      subject: `User: ${user.first_name} ${user.last_name}`,
      perform: async () => {
        try {
          await deleteUser(user.id);
          await fetchAll();
          showToast('User deleted.', 'error');
        } catch {
          showToast('Failed to delete user.', 'error');
        }
      },
    });
  };
  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const closeModal = () => { setModal(null); setSelected(null); setError(''); };

  const handleSave = async () => {
    if (!form.firstName.trim() || !form.lastName.trim() || !form.email.trim()) {
      setError('First name, last name, and email are required.');
      return;
    }
    if (modal === 'add' && !form.password.trim()) {
      setError('Password is required for new users.');
      return;
    }
    if (modal === 'edit') {
      if (!window.confirm('Are you sure you want to update this record?')) return;
    }
    setSaving(true);
    setError('');
    try {
      if (modal === 'add') {
        const defaultPerms = form.role === 'Administrator' ? ['All'] : [];
        await createUser({ ...form, permissions: defaultPerms });
        await fetchAll();
        closeModal();
        showToast('User created. Use the Permissions button to configure access.');
      } else {
        const payload = { ...form };
        if (!payload.password) delete payload.password;
        await updateUser(selected.id, payload);
        await fetchAll();
        closeModal();
        showToast('User updated successfully.');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save. Please try again.');
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteUser(selected.id);
      await fetchAll();
      closeModal();
      showToast('User deleted.', 'error');
    } catch {
      setError('Failed to delete user.');
    }
    setDeleting(false);
  };

  // ── Permissions modal ──────────────────────────────────────────
  const openPermModal = (u) => {
    setPermUser(u);
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    if (perms.includes('All') || perms.includes('Full Access')) {
      setAccessLevel('All');
      setPermList([]);
    } else {
      setAccessLevel('Custom');
      setPermList(expandOldPerms(perms));
    }
    setPermModal(true);
  };

  const togglePerm = (key) => {
    setPermList(prev =>
      prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]
    );
  };

  const togglePageAll = (pageKey) => {
    const allKeys = ACTIONS.map(a => `${pageKey}:${a}`);
    const allChecked = allKeys.every(k => permList.includes(k));
    if (allChecked) {
      setPermList(prev => prev.filter(p => !allKeys.includes(p)));
    } else {
      setPermList(prev => [...new Set([...prev, ...allKeys])]);
    }
  };

  const handleSavePerms = async () => {
    setSavingPerms(true);
    try {
      const permissions = accessLevel === 'All' ? ['All'] : permList;
      await updateUser(permUser.id, {
        firstName: permUser.first_name,
        lastName: permUser.last_name,
        email: permUser.email,
        phone: permUser.phone || '',
        role: permUser.role,
        status: permUser.status || 'Active',
        permissions,
      });
      await fetchAll();
      setPermModal(false);
      showToast('Permissions saved successfully.');
    } catch {
      showToast('Failed to save permissions.', 'error');
    }
    setSavingPerms(false);
  };
  // ──────────────────────────────────────────────────────────────

  const filtered = users.filter(u => {
    const matchSearch = matchTokens(search, u.first_name, u.last_name, u.email, u.phone, u.role);
    const matchRole = roleFilter === 'All' || u.role === roleFilter;
    return matchSearch && matchRole;
  });

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>User Management</h1>
          <p>Manage staff accounts and permissions</p>
        </div>
        <button className="btn btn-primary" onClick={openAdd} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiPlus /> Add User
        </button>
      </div>

      {/* Stats */}
      <div className="stat-cards" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="stat-card blue">
          <div className="stat-icon"><FiUsers /></div>
          <div><div className="stat-label">Total Users</div><div className="stat-value">{stats.totalUsers}</div></div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><FiUserCheck /></div>
          <div><div className="stat-label">Active</div><div className="stat-value">{stats.active}</div></div>
        </div>
        <div className="stat-card red">
          <div className="stat-icon"><FiUserX /></div>
          <div><div className="stat-label">Inactive</div><div className="stat-value">{stats.inactive}</div></div>
        </div>
        <div className="stat-card purple">
          <div className="stat-icon"><FiShield /></div>
          <div><div className="stat-label">Administrators</div><div className="stat-value">{stats.administrators}</div></div>
        </div>
      </div>

      {/* Filters */}
      <div className="filter-bar">
        <div className="search-input-container">
          <FiSearch style={{ color: '#9ca3af' }} />
          <input type="text" placeholder="Search by name or email..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} className="filter-dropdown">
          <option value="All">All Roles</option>
          {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>No users found.</td></tr>
            ) : filtered.map((user, idx) => (
              <tr key={user.id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="table-avatar" style={{ background: avatarColors[idx % avatarColors.length], flexShrink: 0 }}>
                      {getInitials(user.first_name, user.last_name)}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{user.first_name} {user.last_name}</div>
                      {user.phone && <div style={{ fontSize: 12, color: '#9ca3af' }}>{user.phone}</div>}
                    </div>
                  </div>
                </td>
                <td style={{ fontSize: 13, color: '#4b5563' }}>{user.email}</td>
                <td>
                  <span className="badge" style={{ background: `${roleColors[user.role] || '#6b7280'}18`, color: roleColors[user.role] || '#6b7280', fontWeight: 600 }}>
                    {user.role}
                  </span>
                </td>
                <td>
                  <span className={`badge ${user.status === 'Active' ? 'badge-success' : 'badge-danger'}`}>
                    {user.status || 'Active'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      onClick={() => openEdit(user)}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                    >
                      <FiEdit2 size={13} /> Edit
                    </button>
                    <button
                      onClick={() => openPermModal(user)}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                    >
                      <FiShield size={13} /> Permissions
                    </button>
                    <button
                      onClick={() => openDelete(user)}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#fff1f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                    >
                      <FiTrash2 size={13} /> Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add / Edit Modal */}
      {(modal === 'add' || modal === 'edit') && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #f1f5f9' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2563eb' }}>
                  <FiUser size={18} />
                </div>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{modal === 'add' ? 'Add New User' : 'Edit User'}</h3>
              </div>
              <button onClick={closeModal} style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#6b7280' }}>
                <FiX size={18} />
              </button>
            </div>

            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
              {error && (
                <div style={{ background: '#fff1f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', color: '#dc2626', fontSize: 13, marginBottom: 16 }}>
                  {error}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                <div>
                  <label style={labelStyle}>First Name *</label>
                  <div style={inputWrap}>
                    <FiUser size={14} style={iconStyle} />
                    <input style={inputStyle} placeholder="First name" value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Last Name *</label>
                  <div style={inputWrap}>
                    <FiUser size={14} style={iconStyle} />
                    <input style={inputStyle} placeholder="Last name" value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} />
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Username *</label>
                <div style={inputWrap}>
                  <FiMail size={14} style={iconStyle} />
                  <input style={inputStyle} placeholder="Username" autoComplete="off" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Phone</label>
                <div style={inputWrap}>
                  <FiPhone size={14} style={iconStyle} />
                  <input style={inputStyle} placeholder="Phone number" autoComplete="tel" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>{modal === 'add' ? 'Password *' : 'New Password (leave blank to keep current)'}</label>
                <div style={inputWrap}>
                  <FiLock size={14} style={iconStyle} />
                  <input style={{ ...inputStyle, paddingRight: 36 }} type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder={modal === 'add' ? 'Set password' : 'Leave blank to keep current'} value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
                  <button type="button" onClick={() => setShowPassword(s => !s)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0 }}>
                    {showPassword ? <FiEyeOff size={16} /> : <FiEye size={16} />}
                  </button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                <div>
                  <label style={labelStyle}>Role</label>
                  <select style={selectStyle} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Status</label>
                  <select style={selectStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </div>
              </div>

              {modal === 'add' && (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#16a34a' }}>
                  After creating the user, use the <strong>Permissions</strong> button to configure their page access.
                  {form.role === 'Administrator' && <span> Administrators get <strong>full access</strong> by default.</span>}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, padding: '16px 24px', borderTop: '1px solid #f1f5f9', justifyContent: 'flex-end' }}>
              <button onClick={closeModal} style={{ padding: '10px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14, color: '#374151', fontWeight: 500 }}>
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ padding: '10px 24px', background: saving ? '#93c5fd' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700 }}
              >
                {saving ? 'Saving...' : modal === 'add' ? 'Create User' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Permissions Modal */}
      {permModal && permUser && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #f1f5f9' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#16a34a' }}>
                  <FiShield size={18} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Permissions</h3>
                  <div style={{ fontSize: 13, color: '#6b7280' }}>{permUser.first_name} {permUser.last_name}</div>
                </div>
              </div>
              <button onClick={() => setPermModal(false)} style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#6b7280' }}>
                <FiX size={18} />
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
              {/* Access Level Radio */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>Access Level</div>
                <div style={{ display: 'flex', gap: 12 }}>
                  {['All', 'Custom'].map(level => (
                    <label key={level} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '10px 18px', borderRadius: 10, border: `2px solid ${accessLevel === level ? (level === 'All' ? '#16a34a' : '#2563eb') : '#e5e7eb'}`, background: accessLevel === level ? (level === 'All' ? '#f0fdf4' : '#eff6ff') : '#fafafa', fontWeight: accessLevel === level ? 700 : 400, fontSize: 14, color: accessLevel === level ? (level === 'All' ? '#16a34a' : '#2563eb') : '#6b7280' }}>
                      <input
                        type="radio"
                        name="accessLevel"
                        value={level}
                        checked={accessLevel === level}
                        onChange={() => setAccessLevel(level)}
                        style={{ accentColor: level === 'All' ? '#16a34a' : '#2563eb' }}
                      />
                      {level === 'All' ? 'All (Full Access)' : 'Custom'}
                    </label>
                  ))}
                </div>
              </div>

              {/* All Access Message */}
              {accessLevel === 'All' && (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '16px 20px', color: '#16a34a', fontSize: 14, fontWeight: 500 }}>
                  This user has <strong>full access</strong> to all pages and all actions. No restrictions applied.
                </div>
              )}

              {/* Custom Permissions */}
              {accessLevel === 'Custom' && (
                <div>
                  {/* Column headers */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px 60px 70px', gap: 4, padding: '0 8px 8px', borderBottom: '2px solid #f1f5f9', marginBottom: 4 }}>
                    <div style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Page</div>
                    {ACTIONS.map(a => (
                      <div key={a} style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'center' }}>{a}</div>
                    ))}
                  </div>

                  {PAGE_GROUPS.map(({ group, pages }) => (
                    <div key={group} style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 2, padding: '10px 8px 6px' }}>{group}</div>
                      {pages.map(({ key, label }) => {
                        const allChecked = ACTIONS.every(a => permList.includes(`${key}:${a}`));
                        const someChecked = ACTIONS.some(a => permList.includes(`${key}:${a}`));
                        return (
                          <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px 60px 70px', gap: 4, padding: '6px 8px', borderRadius: 8, background: someChecked ? '#f8faff' : 'transparent', marginBottom: 2 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <input
                                type="checkbox"
                                checked={allChecked}
                                ref={el => { if (el) el.indeterminate = someChecked && !allChecked; }}
                                onChange={() => togglePageAll(key)}
                                style={{ accentColor: '#2563eb', width: 15, height: 15, cursor: 'pointer' }}
                              />
                              <span style={{ fontSize: 13, color: '#374151', fontWeight: someChecked ? 600 : 400 }}>{label}</span>
                            </div>
                            {ACTIONS.map(action => (
                              <div key={action} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                <input
                                  type="checkbox"
                                  checked={permList.includes(`${key}:${action}`)}
                                  onChange={() => togglePerm(`${key}:${action}`)}
                                  style={{ accentColor: '#2563eb', width: 15, height: 15, cursor: 'pointer' }}
                                />
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', gap: 10, padding: '16px 24px', borderTop: '1px solid #f1f5f9', justifyContent: 'flex-end' }}>
              <button onClick={() => setPermModal(false)} style={{ padding: '10px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14, color: '#374151', fontWeight: 500 }}>
                Cancel
              </button>
              <button
                onClick={handleSavePerms}
                disabled={savingPerms}
                style={{ padding: '10px 24px', background: savingPerms ? '#86efac' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: savingPerms ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700 }}
              >
                {savingPerms ? 'Saving...' : 'Save Permissions'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      <Toast message={toast?.msg} type={toast?.type} onClose={() => setToast(null)} />

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

const labelStyle = { fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6, display: 'block' };
const inputWrap = { position: 'relative', display: 'flex', alignItems: 'center' };
const iconStyle = { position: 'absolute', left: 10, color: '#9ca3af', pointerEvents: 'none' };
const inputStyle = { width: '100%', padding: '9px 10px 9px 32px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box', background: '#fafafa' };
const selectStyle = { width: '100%', padding: '9px 10px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 14, outline: 'none', background: '#fafafa', cursor: 'pointer' };

export default Users;
