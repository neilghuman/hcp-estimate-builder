// S3 spike 5: probe writable fields on the options[0] object specifically.
// Options have their own structure; test if note/description/summary/etc. are writable there.
const KEY = process.env.HCP_API_KEY;
const CUSTOMER = 'cus_21506500a3644ae4b706a6d76d7c0a47'; // Sarah Kelly (sandbox)

const OPTION_CANDIDATES = [
  'note', 'notes', 'description', 'summary', 'details', 'instructions',
  'internal_note', 'estimator_note', 'customer_note', 'title', 'name',
  'text', 'body', 'message', 'comment', 'memo', 'remarks', 'scope',
];

const body = {
  customer_id: CUSTOMER,
  options: [{
    name: 'SPIKE option field probe',
    line_items: [],
  }],
};

// Add candidates to the option object.
const opt = body.options[0];
for (const f of OPTION_CANDIDATES) {
  opt[f] = `=SENTINEL_${f}=`;
}

const res = await fetch('https://api.housecallpro.com/estimates', {
  method: 'POST',
  headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

if (!res.ok) {
  const text = await res.text();
  console.log('HTTP', res.status, '— request rejected');
  console.log(text.slice(0, 600));
  process.exit(1);
}

const est = JSON.parse(await res.text());
const returnedOpt = (est.options || [])[0] || {};

console.log(`estimate #${est.estimate_number}`);
console.log(`web: https://pro.housecallpro.com/app/estimates/${returnedOpt.id}`);
console.log();
console.log('OPTION-LEVEL FIELDS ACCEPTED & ECHOED BACK:');
const accepted = [];
for (const f of OPTION_CANDIDATES) {
  if (returnedOpt[f] !== undefined) {
    const val = typeof returnedOpt[f] === 'string' ? returnedOpt[f].slice(0, 60) : JSON.stringify(returnedOpt[f]).slice(0, 60);
    console.log(`  ${f.padEnd(20)} ${val}`);
    accepted.push(f);
  }
}

if (!accepted.length) {
  console.log('  (none)');
}

console.log();
console.log('ALL OPTION-LEVEL KEYS RETURNED BY HCP:');
console.log(' ', Object.keys(returnedOpt).sort().join(', '));
