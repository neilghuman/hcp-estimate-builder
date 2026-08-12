// S3 spike 4 (throwaway): brute-force probe for ANY writable estimate-level fields.
// Send 30+ candidate names; anything HCP accepts and echoes back is a candidate for the summary.
const KEY = process.env.HCP_API_KEY;
const CUSTOMER = 'cus_21506500a3644ae4b706a6d76d7c0a47'; // Sarah Kelly (sandbox)

const CANDIDATES = [
  // Semantic "summary of work" variants
  'summary_of_work', 'work_summary', 'summary', 'description', 'job_description',
  'work_description', 'scope', 'scope_of_work', 'project_scope', 'proposal',
  // "Notes" variants
  'note', 'notes', 'estimate_note', 'estimate_notes', 'work_note', 'work_notes',
  'internal_notes', 'instructions', 'instructions_for_estimator', 'estimator_notes',
  // Text blocks
  'details', 'body', 'text', 'content', 'estimate_text', 'estimate_description',
  'custom_note', 'custom_notes', 'title', 'name', 'subject',
  // Less obvious
  'message', 'message_for_customer', 'customer_message', 'estimate_message',
  'requirements', 'terms', 'estimate_terms', 'header', 'footer', 'preamble',
];

const body = {
  customer_id: CUSTOMER,
  options: [{ name: 'SPIKE exhaustive field probe', line_items: [] }],
};

// Add all candidates with distinct sentinels.
for (const f of CANDIDATES) {
  body[f] = `=SENTINEL_${f}=`;
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
const opt = (est.options || [])[0] || {};

console.log(`estimate #${est.estimate_number}`);
console.log(`web: https://pro.housecallpro.com/app/estimates/${opt.id}`);
console.log();
console.log('ACCEPTED & ECHOED BACK:');
const accepted = [];
for (const f of CANDIDATES) {
  if (est[f] !== undefined) {
    const val = typeof est[f] === 'string' ? est[f].slice(0, 60) : JSON.stringify(est[f]).slice(0, 60);
    console.log(`  ${f.padEnd(25)} ${val}`);
    accepted.push(f);
  }
}

if (!accepted.length) {
  console.log('  (none)');
}

console.log();
console.log('ESTIMATE-LEVEL KEYS RETURNED BY HCP:');
console.log(' ', Object.keys(est).sort().join(', '));
