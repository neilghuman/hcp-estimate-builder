// S3 spike 6: test option.notes array structure — what does HCP accept?
// Try strings, objects, different structures to figure out the format.
const KEY = process.env.HCP_API_KEY;
const CUSTOMER = 'cus_21506500a3644ae4b706a6d76d7c0a47'; // Sarah Kelly (sandbox)

const tests = [
  {
    label: 'notes as array of strings',
    body: {
      customer_id: CUSTOMER,
      options: [{
        name: 'Test: notes as strings',
        line_items: [],
        notes: ['First note', 'Second note', 'Third note'],
      }],
    },
  },
  {
    label: 'notes as array of objects with text property',
    body: {
      customer_id: CUSTOMER,
      options: [{
        name: 'Test: notes as objects',
        line_items: [],
        notes: [
          { text: 'Customer Intake Summary', content: 'Line 1\nLine 2' },
        ],
      }],
    },
  },
  {
    label: 'notes as a single string (will auto-array)',
    body: {
      customer_id: CUSTOMER,
      options: [{
        name: 'Test: notes as single string',
        line_items: [],
        notes: 'This is the summary text',
      }],
    },
  },
];

for (const test of tests) {
  console.log(`\n=== ${test.label} ===`);
  
  const res = await fetch('https://api.housecallpro.com/estimates', {
    method: 'POST',
    headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(test.body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.log('HTTP', res.status, '— REJECTED');
    console.log(text.slice(0, 300));
    continue;
  }

  const est = JSON.parse(await res.text());
  const opt = (est.options || [])[0] || {};

  console.log(`estimate #${est.estimate_number}`);
  console.log(`option notes field returned as: ${JSON.stringify(opt.notes)}`);
  console.log(`web: https://pro.housecallpro.com/app/estimates/${opt.id}`);
}

console.log('\n(Each test estimate is live in HCP — check the web URLs above to see what format persisted)');
