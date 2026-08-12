// S3 integration test: verify the summary is injected into an estimate as a line item.
// This uses a real HCP API call and Sarah Kelly's test customer.

import { getCustomer, createEmptyEstimate } from '../src/hcp.js';
import { buildEstimateSummary } from '../src/intake.js';

const KEY = process.env.HCP_API_KEY;
const CUSTOMER_ID = 'cus_21506500a3644ae4b706a6d76d7c0a47'; // Sarah Kelly (sandbox)

const testRow = {
  first_name: 'Test',
  last_name: 'S3Integration',
  phone: '2065551234',
  email: 'test@example.com',
  customer_tag: 'Tree',
  company: null,
  secondary_phone: null,
  address_street: '123 Main St',
  address_unit: null,
  address_city: 'Seattle',
  address_state: 'WA',
  address_zip: '98101',
  address_notes: null,
  problem: 'Tree is leaning over house',
  timeframe: 'ASAP',
  getting_other_bids: 'No',
  final_estimate_response: 'Not Applicable',
  decision_factor: 'Safety',
  budget: '$1,000–2,500',
  pictures: 'Yes',
  callback_time: 'Morning',
  callback_time_detail: null,
  additional_notes: 'Tree is dangerous',
  created_by: 'Test Script',
};

console.log('S3 Integration Test: Summary Injection into Estimate\n');

const summary = buildEstimateSummary(testRow);
console.log('Formatted Summary (first 300 chars):');
console.log(summary.slice(0, 300));
console.log('\n---\n');

// Fetch customer address
const customer = await getCustomer(CUSTOMER_ID);
const addressId = (customer.addresses && customer.addresses[0] && customer.addresses[0].id) || undefined;

console.log(`Customer: ${customer.name}`);
console.log(`Address ID: ${addressId || '(none)'}`);
console.log();

// Create estimate WITH summary
const est = await createEmptyEstimate({
  customerId: CUSTOMER_ID,
  addressId,
  optionName: testRow.customer_tag || 'Estimate',
  summary,
});

console.log(`✓ Estimate created: #${est.estimate_number} (option: ${est.option_id})`);
console.log(`  Deep-link: https://pro.housecallpro.com/app/estimates/${est.option_id}`);
console.log();
console.log('NEXT STEP: Open the estimate link above and verify:');
console.log('  1. Line items section shows "Customer Intake Summary" $0 item');
console.log('  2. Description contains the Question:/Answer: pairs');
console.log('  3. All customer/address/discovery info is present');
