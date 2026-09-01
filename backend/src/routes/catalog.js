const express = require('express');
const router = express.Router();
const { listCatalogItems } = require('../db/supabaseClient');

/**
 * GET /api/catalog
 * Lightweight, unauthenticated read-only endpoint returning all catalog items.
 * Returns: Array of { sku, name, merchant, category, price, currency, stock }
 */
router.get('/', async (req, res) => {
  try {
    const items = await listCatalogItems();
    return res.status(200).json(items);
  } catch (err) {
    console.error('[Catalog API Error]', err);
    return res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

module.exports = router;
