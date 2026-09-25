import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const read = name => JSON.parse(fs.readFileSync(new URL(`../n8n/interview-sms/${name}.workflow.json`, import.meta.url)));
const workflow = read('send-via-chatwoot');
const nodes = new Map(workflow.nodes.map(node => [node.name, node]));

// Execute the exported routing code and branches with mocked Chatwoot HTTP responses.
// This test never opens a network connection or sends a message.
function route(input, scenario = {}) {
  const outputs = {};
  const calls = [];
  const $ = name => ({ first: () => ({ json: outputs[name] }) });
  const expression = (text, data) => new Function('$json', '$', `return (${text.slice(3, -2).trim()})`)(data, $);
  let name = 'Interview SMS Input';
  let data = input;
  let steps = 0;
  while (name) {
    assert(++steps < 45, 'Unexpected graph cycle');
    const node = nodes.get(name);
    assert(node, `Unknown node: ${name}`);
    let branch = 0;
    if (node.type.endsWith('.code')) {
      data = new Function('$json', '$', node.parameters.jsCode)(data, $).json;
    } else if (node.type.endsWith('.if')) {
      branch = expression(node.parameters.conditions.conditions[0].leftValue, data) ? 0 : 1;
    } else if (node.type.endsWith('.httpRequest')) {
      const raw = node.parameters.jsonBody;
      const body = raw ? JSON.parse(raw.startsWith('={{') ? expression(raw, data) : raw) : null;
      calls.push({ name, body });
      switch (name) {
        case 'CW Find Contact':
          data = { payload: scenario.newContact ? [] : [{ id: 42, contact_inboxes: scenario.unlinked ? [] : [{ source_id: 'source17', inbox: { id: 17 } }] }] };
          break;
        case 'CW Link Inbox': data = { source_id: 'source17' }; break;
        case 'CW Create Contact':
          data = { payload: { contact: { id: 42, contact_inboxes: [{ source_id: 'source17', inbox: { id: 17 } }] } } };
          break;
        case 'CW List Conversations':
          data = { payload: scenario.noConversation ? [] : [
            { id: 99, inbox_id: 9, status: 'open' },
            { id: 81, inbox_id: 17, status: 'open' },
            { id: 82, inbox_id: 17, status: scenario.resolved ? 'resolved' : 'open' },
          ] };
          break;
        case 'CW Reopen Conversation': assert.deepEqual(body, { status: 'open' }); data = { success: true }; break;
        case 'CW Create Conversation':
          assert.equal(body.inbox_id, 17);
          assert.equal(body.source_id, 'source17');
          data = { id: 83 };
          break;
        case 'CW Get Conversation Labels': data = { payload: scenario.labels || [] }; break;
        case 'CW Add Interview Label':
          assert.deepEqual(body.labels, [...new Set([...(scenario.labels || []), 'interview'])]);
          data = { payload: body.labels };
          break;
        case 'CW Post Interview Message':
          assert.equal(body.message_type, 'outgoing');
          assert.equal(body.private, false);
          assert.equal(body.content, input.message);
          assert(calls.some(call => call.name === 'CW Add Interview Label'));
          assert(node.parameters.url.includes("$('Conversation Ready').first().json.conv_id"));
          data = { id: 900, message_type: 1, private: false, sender: { type: 'user' } };
          break;
        default: throw new Error(`Unexpected HTTP node: ${name}`);
      }
    }
    outputs[name] = data;
    const edges = workflow.connections[name]?.main?.[branch] || [];
    assert(edges.length <= 1);
    name = edges[0]?.node;
  }
  assert.equal(calls.filter(call => call.name === 'CW Post Interview Message').length, 1);
  assert.equal(data.status, 'submitted_to_chatwoot');
  assert.equal(data.Id, input.Id ?? null);
  return { data, calls };
}

const input = { phone: '202-555-0123', message: 'Offline interview fixture', Id: 70 };

test('reuses the newest conversation in inbox 17 and its contact link', () => {
  const result = route(input);
  assert.equal(result.data.phone, '+12025550123');
  assert.equal(result.data.conversation_id, 82);
  assert(!result.calls.some(call => ['CW Link Inbox', 'CW Create Contact', 'CW Create Conversation', 'CW Reopen Conversation'].includes(call.name)));
});

test('reopens an existing resolved conversation', () => {
  assert(route(input, { resolved: true }).calls.some(call => call.name === 'CW Reopen Conversation'));
});

test('links an existing contact and creates a conversation when needed', () => {
  const result = route(input, { unlinked: true, noConversation: true });
  assert(result.calls.some(call => call.name === 'CW Link Inbox'));
  assert.equal(result.data.conversation_id, 83);
});

test('creates a new contact and conversation when neither exists', () => {
  assert(route(input, { newContact: true, noConversation: true }).calls.some(call => call.name === 'CW Create Contact'));
});

test('preserves other labels and adds interview only once', () => {
  route(input, { labels: ['existing-category'] });
  route(input, { labels: ['existing-category', 'interview'] });
});

test('rejects invalid phone numbers and empty messages', () => {
  assert.throws(() => route({ phone: 'invalid', message: 'Fixture' }), /valid phone/);
  assert.throws(() => route({ phone: '+12025550123', message: '' }), /content is empty/);
});

test('keeps queue IDs isolated and distinguishes submission from delivery', () => {
  for (const id of [101, 102]) {
    const { data } = route({ ...input, Id: id });
    assert.equal(data.Id, id);
    assert.equal(data.chatwoot_message_id, 900);
    assert.equal(data.data.status, 'submitted_to_chatwoot');
  }
});

test('both parent workflows route through the shared sender without direct Telnyx sends', () => {
  for (const name of ['fluentcrm-interview-notification', 'interview-sms-queue-drainer']) {
    const parent = read(name);
    assert(!parent.nodes.some(node => node.parameters.url === 'https://api.telnyx.com/v2/messages'));
    const sender = parent.nodes.find(node => node.name === 'Send via Chatwoot');
    assert.equal(sender.parameters.workflowId.value, workflow.id);
    assert.equal(sender.parameters.mode, 'each');
    assert.equal(sender.parameters.options.waitForSubWorkflow, true);
  }
});

test('approved SMS template contains the booking link and email mention', () => {
  const parent = read('fluentcrm-interview-notification');
  const field = parent.nodes.find(node => node.name === 'Edit Fields').parameters.assignments.assignments.find(field => field.name === 'message');
  const message = new Function('$json', `return (${field.value.slice(3, -2)})`)({ body: { first_name: 'Test', custom_field: { position_applied_for: 'example' } } });
  assert(message.startsWith('Hi Test, thank you for applying for the example position'));
  assert(message.includes('https://www.unitedservicesnorthwest.com/schedule-your-phone-interview/'));
  assert(message.includes('We’ve also sent this link to your email.'));
});
