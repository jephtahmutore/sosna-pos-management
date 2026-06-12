const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// GET /api/main-categories — list all main categories for this tenant
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM main_categories WHERE deleted_at IS NULL AND tenant_id = ? ORDER BY name'
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/main-categories — create
router.post('/', auth, (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const info = db.prepare(
      "INSERT INTO main_categories (name, color, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,0,datetime('now'),datetime('now'))"
    ).run(name.trim(), color || '#6B7280', randomUUID(), tenantId, branchId, deviceId);
    const row = db.prepare('SELECT * FROM main_categories WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/main-categories/:id — edit
router.put('/:id', auth, (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const info = db.prepare(
      "UPDATE main_categories SET name=?, color=?, updated_at=datetime('now'), synced=0 WHERE id=? AND tenant_id=?"
    ).run(name.trim(), color || '#6B7280', req.params.id, req.user.tenantId);
    if (info.changes === 0) return res.status(404).json({ error: 'Main category not found' });
    const row = db.prepare('SELECT * FROM main_categories WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/main-categories/:id — blocked if any category still references it
router.delete('/:id', auth, (req, res) => {
  try {
    const mc = db.prepare('SELECT id, name FROM main_categories WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenantId);
    if (!mc) return res.status(404).json({ error: 'Main category not found' });

    const usingCats = db.prepare(
      "SELECT name FROM categories WHERE main_category_id = ? AND deleted_at IS NULL AND tenant_id = ? ORDER BY name LIMIT 10"
    ).all(req.params.id, req.user.tenantId);

    if (usingCats.length > 0) {
      const totalCount = db.prepare(
        "SELECT COUNT(*) AS c FROM categories WHERE main_category_id = ? AND deleted_at IS NULL AND tenant_id = ?"
      ).get(req.params.id, req.user.tenantId).c;
      const names = usingCats.map(c => c.name).join(', ');
      const more = totalCount > usingCats.length ? ` and ${totalCount - usingCats.length} more` : '';
      return res.status(400).json({
        error: `Cannot delete main category "${mc.name}" — it is used by ${totalCount} category/categories: ${names}${more}. Reassign or delete those categories first.`
      });
    }

    db.prepare(
      "UPDATE main_categories SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=? AND tenant_id=?"
    ).run(req.params.id, req.user.tenantId);
    res.json({ message: 'Main category deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
