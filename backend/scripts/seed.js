/**
 * ============================================================================
 * AgentPay OS - Seed Demo Data Script (Step 10)
 * ============================================================================
 * Seeds the default "TravelBot Agent" with realistic operational parameters:
 * - Total Budget: ₹50,000
 * - Allowed Whitelisted Merchants: ["Hotel Vendor A", "Cab Vendor B", "Insurance Vendor C"]
 * - Hourly Velocity Limit: 5 transactions / hour
 * ============================================================================
 */

const {
  supabase,
  isSupabaseConfigured,
  createAgent,
  DEFAULT_TRAVELBOT_ID,
  resetMemoryStore,
  getAgent
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

  if (isSupabaseConfigured && supabase) {
    try {
      console.log('[Seed] Upserting TravelBot Agent in Supabase Postgres...');
      const { data, error } = await supabase
        .from('agents')
        .upsert(travelBotData)
        .select()
        .single();

      if (error) {
        console.error('[Seed Error] Failed to seed Supabase:', error.message);
      } else {
        console.log('✅ TravelBot Agent successfully seeded in Supabase:', data);
      }
    } catch (err) {
      console.error('[Seed Error]', err.message);
    }
  } else {
    resetMemoryStore();
    const seeded = await getAgent(DEFAULT_TRAVELBOT_ID);
    console.log('✅ TravelBot Agent successfully initialized in local store:', seeded);
  }

  console.log('========================================================');
  console.log('🎯 TravelBot ID:', DEFAULT_TRAVELBOT_ID);
  console.log('💰 Budget:      ₹50,000');
  console.log('🏢 Merchants:   Hotel Vendor A, Cab Vendor B, Insurance Vendor C');
  console.log('⚡ Velocity:    5 transactions / hour');
  console.log('========================================================');
}

if (require.main === module) {
  seedData().then(() => process.exit(0));
}

module.exports = { seedData };
