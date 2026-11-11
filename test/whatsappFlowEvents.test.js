import assert from 'node:assert/strict';
import test from 'node:test';
import { flowEventForMessage } from '../src/services/whatsappFlowEvents.js';

test('flow analytics emits a safe key only for a known interactive selection', () => {
  assert.deepEqual(flowEventForMessage({
    direction: 'in',
    messageType: 'interactive_list_reply',
    replyId: 'faq_horarios',
    createdAt: '2026-11-11T12:00:00Z',
  }), [
    {
      eventType: 'message_received',
      stepKey: null,
      source: 'patient',
      occurredAt: '2026-11-11T12:00:00Z',
    },
    {
      eventType: 'flow_option_selected',
      stepKey: 'faq_horarios',
      source: 'patient',
      occurredAt: '2026-11-11T12:00:00Z',
    },
  ]);
});

test('flow analytics ignores unknown IDs and unrelated messages', () => {
  assert.deepEqual(flowEventForMessage({
    direction: 'in',
    messageType: 'interactive_list_reply',
    replyId: 'person-name-or-arbitrary-value',
  }), [{ eventType: 'message_received', stepKey: null, source: 'patient', occurredAt: null }]);
  assert.deepEqual(flowEventForMessage({ direction: 'out', sentVia: 'api', messageType: 'text' }), []);
});

test('flow analytics identifies observed bot steps and Business App team replies', () => {
  assert.equal(flowEventForMessage({ direction: 'out', sentVia: 'api', messageType: 'faq_handoff' })[0].stepKey, 'faq_handoff');
  assert.deepEqual(flowEventForMessage({ direction: 'out', sentVia: 'business_app', messageType: 'text' }), [
    { eventType: 'team_message_sent', stepKey: null, source: 'team', occurredAt: null },
  ]);
});
