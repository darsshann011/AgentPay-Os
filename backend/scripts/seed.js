/**
 * ============================================================================
 * AgentPay OS - Seed Demo Data Script
 * ============================================================================
 * Seeds or resets the "TravelBot Agent" and Demo Catalog Items:
 * - TravelBot: ₹50,000 Budget, Allowed Vendors, Velocity Limit: 5
 * - Catalog: Hotel Vendor A Deluxe Suite (₹12,400), Cab SUV (₹2,500), Insurance (₹1,800)
 * ============================================================================
 */

const {
  supabase,
  isSupabaseConfigured,
  DEFAULT_TRAVELBOT_ID,
  DEFAULT_CATALOG_ITEMS,
  resetDatabaseState,
  getAgent,
  listCatalogItems
} = require('../src/db/supabaseClient');

async function seedData() {
  console.log('========================================================');
  console.log('🌱 Seeding AgentPay OS Database with Baseline Demo Data');
  console.log('========================================================');

  const travelBotData = {
    id: DEFAULT_TRAVELBOT_ID,
    name: 'TravelBot Agent',
    budget_total: 50000,
    budget_remaining: 50000,
    allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B', 'Insurance Vendor C'],
    velocity_limit: 5
  };

  let activeAgent = null;

  if (isSupabaseConfigured && supabase) {
    try {
      console.log('[Seed] Upserting TravelBot Agent in Supabase Postgres...');
      const { data, error } = await supabase
        .from('agents')
        .upsert(travelBotData, { onConflict: 'id' })
        .select()
        .single();

      if (error) {
        console.error('[Seed Error] Failed to seed agent in Supabase:', error.message);
      } else {
        activeAgent = data;
        console.log('✅ TravelBot Agent successfully seeded/updated in Supabase');
      }

      // Upsert catalog items in Supabase
      console.log('[Seed] Upserting Demo Catalog Items in Supabase Postgres...');
      const { error: catErr } = await supabase
        .from('catalog_items')
        .upsert(DEFAULT_CATALOG_ITEMS, { onConflict: 'sku' });

      if (catErr) {
        console.warn('[Seed Warning] catalog_items table not ready in Supabase schema cache (Fallback in-memory):', catErr.message);
      } else {
        console.log(`✅ Seeded ${DEFAULT_CATALOG_ITEMS.length} catalog items into Supabase.`);
      }
    } catch (err) {
      console.error('[Seed Exception]:', err.message);
    }
  } else {
    await resetDatabaseState();
    activeAgent = await getAgent(DEFAULT_TRAVELBOT_ID);
    console.log('✅ Demo state and catalog items initialized in local memory store.');
  }

  if (!activeAgent) {
    activeAgent = await getAgent(DEFAULT_TRAVELBOT_ID);
  }

  const catalog = await listCatalogItems();

  console.log('========================================================');
  console.log(`🎯 Active Agent ID: ${activeAgent?.id || DEFAULT_TRAVELBOT_ID}`);
  console.log(`🤖 Agent Name:      ${activeAgent?.name || 'TravelBot Agent'}`);
  console.log(`💰 Total Budget:    ₹${Number(activeAgent?.budget_total || 50000).toLocaleString('en-IN')}`);
  console.log(`💵 Remaining:       ₹${Number(activeAgent?.budget_remaining || 50000).toLocaleString('en-IN')}`);
  console.log(`🏢 Allowed Vendors: ${(activeAgent?.allowed_merchants || []).join(', ')}`);
  console.log(`⚡ Velocity Limit:  ${activeAgent?.velocity_limit || 5} tx/hr`);
  console.log(`📦 Catalog Items:   ${catalog.length} items available`);
  catalog.forEach(item => {
    console.log(`   - [${item.sku}] ${item.name} (${item.merchant}) — ₹${item.price} [Cat: ${item.category}, Stock: ${item.stock}]`);
  });
  console.log('========================================================\n');
  return { agent: activeAgent, catalog };
}

if (require.main === module) {
  seedData().then(() => {
    setTimeout(() => process.exit(0), 100);
  });
}

module.exports = { seedData };
