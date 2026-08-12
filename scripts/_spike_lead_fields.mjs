// S3 spike 7: probe HCP leads API — what fields are writable for storing the summary?
const KEY = process.env.HCP_API_KEY;
const CUSTOMER = 'cus_21506500a3644ae4b706a6d76d7c0a47'; // Sarah Kelly (sandbox)

// Test 1: Create a lead with note/description/summary fields (same candidates as estimates)
const CANDIDATES = [
  'note', 'notes', 'description', 'summary', 'details', 'instructions',
  'internal_note', 'message', 'body', 'text', 'scope', 'requirements',
];

const leadBody = {
  customer_id: CUSTOMER,
  status: 'received',
  title: 'SPIKE lead field probe',
};

// Add candidates
for (const f of CANDIDATES) {
  leadBody[f] = `=SENTINEL_${f}=`;
}

console.log('Creating lead with candidate fields...\n');

const res = await fetch('https://api.housecallpro.com/leads', {
  method: 'POST',
  headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(leadBody),
});

if (!res.ok) {
  const text = await res.text();
  console.log('HTTP', res.status, '— request rejected');
  console.log(text.slice(0, 600));
  process.exit(1);
}

const lead = JSON.parse(await res.text());

console.log(`lead #${lead.id}`);
console.log(`web: https://pro.housecallpro.com/app/leads/${lead.id}`);
console.log();
console.log('ACCEPTED & ECHOED BACK:');
const accepted = [];
for (const f of CANDIDATES) {
  if (lead[f] !== undefined) {
    const val = typeof lead[f] === 'string' ? lead[f].slice(0, 60) : JSON.stringify(lead[f]).slice(0, 60);
    console.log(`  ${f.padEnd(20)} ${val}`);
    accepted.push(f);
  }
}

if (!accepted.length) {
  console.log('  (none)');
}

console.log();
console.log('ALL LEAD-LEVEL KEYS RETURNED BY HCP:');
console.log(' ', Object.keys(lead).sort().join(', '));
