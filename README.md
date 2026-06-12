# Sosna — Management System

Bespoke Point of Sale + accounting system for Sosna. Single-tenant
deployment at `sosnazm.com` covering three branches:

- Branch 1 + Branch 2 — ledger in K (Kwacha)
- Branch 3 — ledger in USD, payments in USD or FRA, change in USD or FRA
- HQ (Accounting Head) — consolidated books in K

Forked from the Liquor multi-tenant codebase on 2026-06-13; major schema
work in progress to support the per-branch dual-currency requirements.

Built with React, Electron, Node.js/Express, and SQLite (better-sqlite3).

## Features

- **Dashboard** – Real-time sales metrics, revenue charts, top products, low stock alerts
- **POS** – Product grid with category filters, cart with quantity controls, checkout
- **Item Details** – Full product catalog management (CRUD)
- **GRN (Goods Received Notes)** – Track incoming stock from suppliers
- **SIV (Store Issue Vouchers)** – Track outgoing stock issuances
- **Inventory** – Live stock status with low-stock indicators
- **Cash Receipts / Payment Vouchers / Cash Book** – Full cash flow tracking
- **Account Payables / AP Payments** – Supplier invoice tracking and payment status
- **Sales Returns / Stock Adjustments** – Returns and reconciliation
- **Suppliers / Customers** – Contact and account management
- **User Management** – Role-based access with action-level permissions
- **Single-tenant** – One SQLite DB; web access via `sosnazm.com` (no subdomains). Three branches differentiated by `branch_id`.
- **Cross-Device Sync** – Desktop Electron app syncs to VPS every 30s via UUID sync IDs

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, React Router v6, Recharts, react-icons |
| Desktop | Electron |
| Backend | Node.js, Express 4 |
| Database | SQLite (better-sqlite3) |
| Auth | JWT + bcrypt |

## Prerequisites

- **Node.js** v18+ and npm

## Setup

### 1. Install

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2. Configure Environment

Edit `backend/.env`:

```env
PORT=5300
TENANT_PORT=5300
JWT_SECRET=your_jwt_secret
TENANTS_DIR=../tenants
```

### 3. Run

```bash
# From root: start backend + frontend
npm run dev

# Desktop (Electron)
npm run desktop
```

### 4. Default Login

- **Email:** admin@sosna.com
- **Password:** admin123

## Architecture

- `backend/server.js` – Electron / desktop server (port 5300)
- `backend/server-tenant.js` – Web multi-tenant server (port 5300), reads `X-Tenant` header set by nginx
- `tenants/<slug>.db` – Per-tenant SQLite DB
- VPS deploy: PM2 process name `sosna`, served at `*.sosnazm.com`

## License

Private – All rights reserved.
