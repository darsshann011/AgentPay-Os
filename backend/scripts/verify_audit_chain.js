#!/usr/bin/env node
/**
 * ============================================================================
 * AgentPay OS - Standalone Audit Log Cryptographic Hash Chain Verifier
 * ============================================================================
 * ZERO SERVER DEPENDENCY:
 * This script runs completely standalone using only Node's built-in modules
 * (crypto, fs, path). It independently reimplements the canonical JSON
 * serialization and SHA-256 hash chaining to provide zero-trust third-party
 * tamper verification of exported audit logs.
 *
 * Usage:
 *   node scripts/verify_audit_chain.js <path-to-audit-log-export.json>
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Independent canonical JSON stringifier (alphanumerically sorted keys)
 */
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return '{' + sortedKeys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/**
 * Independent SHA-256 hash calculator for audit log entry
 */
function calculateEntryHash(prevHash, entry) {
  const normalizedCreatedAt = entry.created_at
    ? (entry.created_at instanceof Date ? entry.created_at.toISOString() : new Date(entry.created_at).toISOString())
    : new Date().toISOString();
  const canonicalPayload = canonicalStringify({
    id: entry.id,
    transaction_id: entry.transaction_id || null,
    event_type: entry.event_type,
    detail: entry.detail || {},
    created_at: normalizedCreatedAt
  });
  return crypto
    .createHash('sha256')
    .update((prevHash || 'GENESIS') + canonicalPayload)
    .digest('hex');
}

function verifyAuditChainFile(filePath) {
  if (!filePath) {
    console.error('Error: Please provide a path to an exported JSON audit log file.');
    console.error('Usage: node scripts/verify_audit_chain.js <path-to-audit-log.json>');
    process.exit(2);
  }

  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: File not found: ${resolvedPath}`);
    process.exit(2);
  }

  let rawContent;
  try {
    rawContent = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    console.error(`Error reading file ${resolvedPath}:`, err.message);
    process.exit(2);
  }

  let entries;
  try {
    entries = JSON.parse(rawContent);
  } catch (err) {
    console.error('Error: Invalid JSON content in file:', err.message);
    process.exit(2);
  }

  if (!Array.isArray(entries)) {
    if (entries && Array.isArray(entries.logs)) {
      entries = entries.logs;
    } else {
      console.error('Error: JSON file must contain an array of audit log entries.');
      process.exit(2);
    }
  }

  if (entries.length === 0) {
    console.log('PASS: Audit log is empty (0 entries).');
    process.exit(0);
  }

  // If logs were exported newest-first, detect and sort chronologically (oldest-first)
  // Check if first entry has 'GENESIS' as prev_hash or if last entry has 'GENESIS'
  const isReverseOrder = entries[0]?.prev_hash !== 'GENESIS' && entries[entries.length - 1]?.prev_hash === 'GENESIS';
  const orderedEntries = isReverseOrder ? entries.slice().reverse() : entries;

  let expectedPrevHash = 'GENESIS';

  for (let i = 0; i < orderedEntries.length; i++) {
    const entry = orderedEntries[i];

    // 1. Verify prev_hash link
    if (entry.prev_hash !== expectedPrevHash) {
      console.log('FAIL');
      console.error(`Broken Link Detected at Entry Index ${i} (ID: ${entry.id}):`);
      console.error(`  - Reason: PREV_HASH_MISMATCH`);
      console.error(`  - Expected prev_hash: ${expectedPrevHash}`);
      console.error(`  - Found prev_hash:    ${entry.prev_hash}`);
      process.exit(1);
    }

    // 2. Recompute and verify entry_hash
    const expectedEntryHash = calculateEntryHash(expectedPrevHash, entry);
    if (entry.entry_hash !== expectedEntryHash) {
      console.log('FAIL');
      console.error(`Broken Link Detected at Entry Index ${i} (ID: ${entry.id}):`);
      console.error(`  - Reason: ENTRY_HASH_MISMATCH (Data tampering or signature corruption)`);
      console.error(`  - Event Type:         ${entry.event_type}`);
      console.error(`  - Created At:         ${entry.created_at}`);
      console.error(`  - Expected Hash:      ${expectedEntryHash}`);
      console.error(`  - Found Hash:         ${entry.entry_hash}`);
      process.exit(1);
    }

    expectedPrevHash = entry.entry_hash;
  }

  console.log(`PASS: All ${orderedEntries.length} audit log entries verified against tamper-evident cryptographic hash chain.`);
  process.exit(0);
}

if (require.main === module) {
  const targetFile = process.argv[2];
  verifyAuditChainFile(targetFile);
}

module.exports = {
  canonicalStringify,
  calculateEntryHash,
  verifyAuditChainFile
};
