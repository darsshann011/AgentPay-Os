/**
 * ============================================================================
 * AgentPay OS - Seed Demo Data Script (Step 10)
 * ============================================================================
 * Seeds or resets the "TravelBot Agent" in Supabase with baseline values:
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
  resetDatabaseState,
  getAgent,
  listAgents
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
        console.error('[Seed Error] Failed to seed Supabase:', error.message);
      } else {
        activeAgent = data;
        console.log('✅ TravelBot Agent successfully seeded/updated in Supabase:');
        console.log(JSON.stringify(data, null, 2));
      }
    } catch (err) {
      console.error('[Seed Exception]:', err.message);
    }
  } else {
    await resetDatabaseState();
    activeAgent = await getAgent(DEFAULT_TRAVELBOT_ID);
    console.log('✅ TravelBot Agent successfully initialized in local store:', activeAgent);
  }

  if (!activeAgent) {
    activeAgent = await getAgent(DEFAULT_TRAVELBOT_ID);
  }

  console.log('========================================================');
  console.log(`🎯 Active Agent ID: ${activeAgent?.id || DEFAULT_TRAVELBOT_ID}`);
  console.log(`🤖 Agent Name:      ${activeAgent?.name || 'TravelBot Agent'}`);
  console.log(`💰 Total Budget:    ₹${Number(activeAgent?.budget_total || 50000).toLocaleString('en-IN')}`);
  console.log(`💵 Remaining:       ₹${Number(activeAgent?.budget_remaining || 50000).toLocaleString('en-IN')}`);
  console.log(`🏢 Allowed Vendors: ${(activeAgent?.allowed_merchants || []).join(', ')}`);
  console.log(`⚡ Velocity Limit:  ${activeAgent?.velocity_limit || 5} tx/hr`);
  console.log('========================================================\n');
  return activeAgent;
}

if (require.main === module) {
  seedData().then(() => {
    // Graceful exit
    setTimeout(() => process.exit(0), 100);
  });
}

module.exports = { seedData };
