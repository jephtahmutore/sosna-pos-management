import React, { createContext, useState, useContext, useEffect } from 'react';
import { login as loginAPI } from '../services/api';

const AuthContext = createContext(null);

// Maps new page keys → old flat permission keys (backward compat for existing users)
const LEGACY_MAP = {
  POS:              'POS',
  SalesReport:      'Sales',
  SalesInventory:   'Sales',
  CashReport:       'Sales',
  SalesBinCard:     'Sales',
  Sales:            'Sales',
  Reports:          'Reports',
  Items:            'Stock',
  GRN:              'GRN',
  SIV:              'SIV',
  Production:       'SIV',
  SalesReturns:     'SIV',
  Inventory:        'Stock',
  BinCard:          'Stock',
  StockAdjustment:  'Stock',
  Categories:       'Stock',
  ExpiryReport:     'GRN',
  StockCount:       'Stock',
  CashReceipt:         'Accounting',
  PaymentVoucher:      'Accounting',
  PvTypes:             'Accounting',
  CashBook:            'Accounting',
  AccountPayables:     'Accounting',
  AccountReceivables:  'Accounting',
  ProfitReport:        'Accounting',
  Suppliers:           'Suppliers',
  Customers:           'Customers',
  // v1.10.245 — HQ page keys share a single legacy umbrella 'HQ' so a user
  // with the flat 'HQ' perm passes any HqXxx:Action check. Grants admins a
  // one-line way to give an HQ manager full HQ access before the fine-
  // grained checkboxes get ticked.
  HqOverview:           'HQ',
  HqSalesReport:        'HQ',
  HqInventoryReport:    'HQ',
  HqCashPosition:       'HQ',
  HqConsolidatedProfit: 'HQ',
  HqAccountReceivables: 'HQ',
  HqProducts:           'HQ',
  HqPurchases:          'HQ',
  HqCostOfDelivery:     'HQ',
  HqConfirmGrn:         'HQ',
  HqGrnArchive:         'HQ',
  HqVariances:          'HQ',
  HqConfirmDamages:     'HQ',
  HqSuppliers:          'HQ',
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedUser = localStorage.getItem('user');
    if (savedUser && token) {
      setUser(JSON.parse(savedUser));
    }
    setLoading(false);
  }, [token]);

  const login = async (email, password, licenseKey) => {
    const response = await loginAPI({ email, password, ...(licenseKey ? { licenseKey } : {}) });
    const { token: newToken, user: userData } = response.data;
    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(userData));
    setToken(newToken);
    setUser(userData);
    return userData;
  };

  const loginWithToken = (token, userData) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(userData));
    setToken(token);
    setUser(userData);
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
  };

  // Returns true if user has full (unrestricted) access
  const isAllAccess = () => {
    if (!user) return false;
    if (user.role === 'Administrator') return true;
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    return perms.includes('All') || perms.includes('Full Access');
  };

  // Returns true if user has a specific permission key
  // Supports new format ('GRN:Delete') and old flat format ('GRN', 'Accounting')
  const hasPermission = (key) => {
    if (!user) return false;
    if (isAllAccess()) return true;
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    if (perms.includes(key)) return true;
    // Backward compat: old flat perm implies all actions for that page
    if (key.includes(':')) {
      const page = key.split(':')[0];
      const legacy = LEGACY_MAP[page];
      if (legacy && perms.includes(legacy)) return true;
    }
    return false;
  };

  // Returns true if user has ANY permission for any of the given page keys
  // Used for sidebar visibility — visible if user has at least one action on that page
  const hasPageAccess = (...pages) => {
    if (!user) return false;
    if (isAllAccess()) return true;
    return pages.some(page =>
      ['View', 'Add', 'Edit', 'Delete'].some(action => hasPermission(`${page}:${action}`))
    );
  };

  return (
    <AuthContext.Provider value={{
      user, token, login, loginWithToken, logout, loading,
      isAuthenticated: !!token,
      hasPermission, hasPageAccess, isAllAccess,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
export default AuthContext;
