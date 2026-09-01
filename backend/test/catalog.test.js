const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const app = require('../src/server');
const { listCatalogItems } = require('../src/db/supabaseClient');

function getJson(serverUrl, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const req = http.request(
      url,
      {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('Catalog API - Step 7 Tests', async (t) => {
  let server;
  let serverUrl;

  t.before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('1. GET /api/catalog returns array of items with expected fields', async () => {
    const res = await getJson(serverUrl, '/api/catalog');

    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body), 'Catalog response must be an array');
    assert.ok(res.body.length >= 1, 'Catalog must contain items');

    for (const item of res.body) {
      assert.ok(typeof item.sku === 'string' && item.sku.length > 0, 'Item must have valid sku');
      assert.ok(typeof item.name === 'string' && item.name.length > 0, 'Item must have valid name');
      assert.ok(typeof item.merchant === 'string' && item.merchant.length > 0, 'Item must have valid merchant');
      assert.ok(typeof item.category === 'string' && item.category.length > 0, 'Item must have valid category');
      assert.ok(typeof item.price === 'number' && item.price > 0, 'Item price must be positive number');
      assert.ok(typeof item.currency === 'string', 'Item must have currency string');
      assert.ok(typeof item.stock === 'number', 'Item must have stock number');
    }
  });

  await t.test('2. Catalog includes the demo Hotel Vendor A room at ₹12,400', async () => {
    const res = await getJson(serverUrl, '/api/catalog');

    const hotelItem = res.body.find((i) => i.sku === 'HOTEL-DELUXE-2N' || i.merchant === 'Hotel Vendor A');
    assert.ok(hotelItem, 'Hotel Vendor A item must exist in catalog');
    assert.equal(hotelItem.merchant, 'Hotel Vendor A');
    assert.equal(hotelItem.price, 12400);
    assert.equal(hotelItem.currency, 'INR');
    assert.equal(hotelItem.category.toLowerCase(), 'hotel');
  });
});
