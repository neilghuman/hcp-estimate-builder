// S4 integration test: verify /apply-estimate returns the estimate URL.
// Creates a full intake flow: customer → estimate → verify URL in response.

const API_BASE = 'http://scopefoundry.test/api/intake';
const WRITE_ENABLED = process.env.INTAKE_WRITE_ENABLED === 'true';

console.log(`S4 Integration Test: Estimate URL in Response\n`);
console.log(`INTAKE_WRITE_ENABLED=${WRITE_ENABLED}`);
console.log();

if (!WRITE_ENABLED) {
  console.log('⚠️  Test cannot run: INTAKE_WRITE_ENABLED is not true.');
  console.log('The /apply-estimate endpoint requires real writes.');
  console.log('');
  console.log('To enable:');
  console.log('  export INTAKE_WRITE_ENABLED=true');
  console.log('Then restart the dev container.');
  process.exit(1);
}

console.log('1. Create a new intake draft...');
const draftRes = await fetch(`${API_BASE}/drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
const draft = await draftRes.json();
console.log(`   ✓ Draft ${draft.public_id} created`);

const intakeId = draft.public_id;

// Populate all required fields for a complete flow
const intakePatch = {
  first_name: 'S4Test',
  last_name: 'IntegrationTest',
  phone: '2064581885',
  email: 'test@example.com',
  address_street: '123 Main St',
  address_city: 'Seattle',
  address_state: 'WA',
  address_zip: '98101',
  customer_tag: 'Tree',
  problem: 'Tree is leaning',
  timeframe: 'ASAP',
  getting_other_bids: 'No',
  final_estimate_response: 'Not Applicable',
  decision_factor: 'Safety',
  budget: '$1,000–2,500',
  pictures: 'No',
  callback_time: 'Anytime',
  additional_notes: 'Test intake for S4',
};

console.log('2. Populate intake fields...');
await fetch(`${API_BASE}/drafts/${intakeId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intakePatch) });
console.log('   ✓ Fields updated');

console.log('2b. Mark as new customer (decision required)...');
await fetch(`${API_BASE}/drafts/${intakeId}/new-customer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
console.log('   ✓ Marked as new customer');

console.log('3. Dry-run customer apply (no writes)...');
const custDryRes = await fetch(`${API_BASE}/drafts/${intakeId}/apply-customer?dryRun=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
const custDry = await custDryRes.json();
console.log(`   ✓ Plan: action=${custDry.plan?.action}, tag=${custDry.plan?.tag}`);

console.log('4. Apply customer (confirm write)...');
const custRes = await fetch(`${API_BASE}/drafts/${intakeId}/apply-customer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
const custRespBody = await custRes.json();
if (!custRespBody.ok) {
  console.error('   ✗ Customer apply failed:', custRespBody.error);
  process.exit(1);
}
console.log(`   ✓ Customer created: ${custRespBody.hcp_customer_id}`);

console.log('5. Dry-run estimate apply (preview plan)...');
const estDryRes = await fetch(`${API_BASE}/drafts/${intakeId}/apply-estimate?dryRun=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
const estDry = await estDryRes.json();
console.log(`   ✓ Plan: willCreateEstimate=${estDry.plan?.willCreateEstimate}`);
console.log(`   ✓ Note preview (first 80 chars): ${estDry.plan?.notePreview?.slice(0, 80)}`);

console.log('6. Apply estimate (confirm write)...');
const estRes = await fetch(`${API_BASE}/drafts/${intakeId}/apply-estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
const estRespBody = await estRes.json();
if (!estRespBody.ok) {
  console.error('   ✗ Estimate apply failed:', estRespBody.error);
  process.exit(1);
}
console.log(`   ✓ Estimate created: #${estRespBody.estimate_number}`);
console.log(`   ✓ Option ID: ${estRespBody.hcp_estimate_option_id}`);
console.log(`   Full response:`, JSON.stringify(estRespBody, null, 2));

// Verify the estimate URL is in the response
if (!estRespBody.estimate_url) {
  console.error('   ✗ estimate_url is missing from response!');
  process.exit(1);
}

console.log(`   ✓ Estimate URL: ${estRespBody.estimate_url}`);

console.log();
console.log('✓ S4 PASS: /apply-estimate returns estimate URL');
console.log();
console.log('NEXT STEP: Open estimate URL and verify:');
console.log(`  1. Link works: ${estRespBody.estimate_url}`);
console.log(`  2. Estimate #${estRespBody.estimate_number} loads`);
console.log(`  3. Summary Q&A appears in line items`);
