/**
 * ============================================================================
 * AgentPay OS - Clean Up Test Data Script
 * ============================================================================
 * Removes all temporary test agents and test rows created during test runs,
 * preserving only the official TravelBot demo agent.
 * ============================================================================
 */

require('dotenv').config();
const {
  supabase,
  isSupabaseConfigured,
  DEFAULT_TRAVELBOT_ID,
  deleteTestAgents,
  deleteTestAuditLogs,
  clearAuditLogTable,
  listAgents
} = require('../src/db/supabaseClient');

async function cleanupTestData() {
  console.log('========================================================');
  console.log('🧹 AgentPay OS - Cleaning Test Data from Supabase / Memory');
  console.log('========================================================');

  const deletedAgentCount = await deleteTestAgents();
  console.log(`✅ Cleanup completed. Removed ${deletedAgentCount} test agent(s).`);

  const deletedAuditCount = await deleteTestAuditLogs();
  console.log(`✅ Cleanup completed. Removed ${deletedAuditCount} test audit row(s).`);

  await clearAuditLogTable();
  console.log('✅ Audit ledger reset to clean GENESIS state.');

  const remainingAgents = await listAgents();
  console.log('\n📊 Remaining Agents in Database:');
  for (const agent of remainingAgents) {
    console.log(` - [${agent.id}] ${agent.name} | Budget: ₹${agent.budget_remaining} / ₹${agent.budget_total}`);
  }
  console.log('========================================================\n');
  return { deletedAgentCount, deletedAuditCount };
}

if (require.main === module) {
  cleanupTestData()
    .then(() => {
      setTimeout(() => process.exit(0), 100);
    })
    .catch((err) => {
      console.error('❌ Cleanup failed:', err);
      process.exit(1);
    });
}

module.exports = { cleanupTestData };
