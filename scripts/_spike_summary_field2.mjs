// S3 spike 3 (throwaway): "Summary of work" is an estimate-level section in the HCP UI, separate
// from line items and private notes, and the API does not return it. Send every candidate field
// name in ONE create call, each with a distinguishable sentinel, so a single look at the UI shows
// which name HCP honours. A rejected call creates nothing, so this costs at most one record.
const KEY = process.env.HCP_API_KEY;
const CUSTOMER = 'cus_21506500a3644ae4b706a6d76d7c0a47'; // Sarah Kelly (sandbox)

const CANDIDATES = [
  'description',
  'summary',
  'summary_of_work',
  'work_description',
  'job_description',
  'note',
];

const body = {
  customer_id: CUSTOMER,
  options: [{ name: 'SPIKE summary-of-work probe', line_items: [] }],
};
for (const f of CANDIDATES) body[f] = `SENTINEL-${f}`;

const res = await fetch('https://api.housecallpro.com/estimates', {
  method: 'POST',
  headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log('HTTP', res.status);
if (!res.ok) { console.log(text.slice(0, 600)); process.exit(1); }

const est = JSON.parse(text);
const opt = (est.options || [])[0] || {};
console.log('estimate #    :', est.estimate_number);
console.log('web link      :', 'https://pro.housecallpro.com/app/estimates/' + opt.id);
console.log('echoed back   :');
for (const f of CANDIDATES) {
  console.log(`  ${f.padEnd(17)} ${est[f] === undefined ? '(not returned)' : JSON.stringify(est[f])}`);
}
