// S3 spike (throwaway): create ONE estimate on the approved sandbox customer (Sarah Kelly) with
// distinct sentinel text in each candidate field, so the HCP UI can tell us which one renders
// under the "Summary of Work" heading. Delete this file once the finding is recorded.
const KEY = process.env.HCP_API_KEY;
const CUSTOMER = 'cus_21506500a3644ae4b706a6d76d7c0a47'; // Sarah Kelly (sandbox)

const body = {
  customer_id: CUSTOMER,
  options: [{
    name: 'SPIKE field probe',
    message_from_pro: 'SENTINEL_MESSAGE_FROM_PRO',
    notes: 'SENTINEL_NOTES',
    line_items: [],
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
console.log('message_from_pro:', JSON.stringify(opt.message_from_pro));
console.log('notes           :', JSON.stringify(opt.notes));
console.log('web link        : https://pro.housecallpro.com/app/estimates/' + opt.id);
