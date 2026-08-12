// S3 spike 2 (throwaway): line_items are accepted by the create call even though no line-item
// subresource exists, so test whether a descriptive line item survives creation intact.
// Also re-tests message_from_pro to confirm the company template always wins.
const KEY = process.env.HCP_API_KEY;
const CUSTOMER = 'cus_21506500a3644ae4b706a6d76d7c0a47'; // Sarah Kelly (sandbox)

const SUMMARY = [
  'CUSTOMER INTAKE SUMMARY',
  '',
  'Question: What problem are you trying to solve?',
  'Answer: Lawn is overgrown and needs regular service',
  '',
  'Question: How soon are you hoping to have this done?',
  'Answer: This Week',
].join('\n');

const body = {
  customer_id: CUSTOMER,
  options: [{
    name: 'SPIKE line item probe',
    message_from_pro: 'SENTINEL_MESSAGE_FROM_PRO_v2',
    line_items: [{
      name: 'Customer Intake Summary',
      description: SUMMARY,
      unit_price: 0,
      quantity: 1,
      kind: 'labor',
      taxable: false,
    }],
  }],
};

const res = await fetch('https://api.housecallpro.com/estimates', {
  method: 'POST',
  headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log('HTTP', res.status);
if (!res.ok) { console.log(text); process.exit(1); }

const est = JSON.parse(text);
const opt = (est.options || [])[0] || {};
console.log('estimate_id     :', est.id);
console.log('estimate_number :', est.estimate_number);
console.log('option_id       :', opt.id);
console.log('message_from_pro overridden?', opt.message_from_pro !== 'SENTINEL_MESSAGE_FROM_PRO_v2');
console.log('option keys     :', Object.keys(opt).join(', '));
console.log('web link        : https://pro.housecallpro.com/app/estimates/' + opt.id);
