import assert from 'node:assert/strict';
import test from 'node:test';
import { getRoleScopes, hasRoleScope } from '../src/services/accessPolicy.js';

test('access policy keeps direct patient-facing data with the operational role', () => {
  assert.equal(hasRoleScope('operational', 'messages:read'), true);
  assert.equal(hasRoleScope('operational', 'contacts:read'), true);
  assert.equal(hasRoleScope('managerial', 'messages:read'), false);
  assert.equal(hasRoleScope('executive', 'contacts:read'), false);
});

test('access policy grants aggregate reporting without raw conversation access', () => {
  assert.equal(hasRoleScope('managerial', 'reporting:read'), true);
  assert.equal(hasRoleScope('executive', 'reporting:read'), true);
  assert.equal(hasRoleScope('executive', 'conversations:read'), false);
});

test('access policy fails closed for unknown roles and scopes', () => {
  assert.deepEqual(getRoleScopes('unknown'), []);
  assert.equal(hasRoleScope('unknown', 'reporting:read'), false);
  assert.equal(hasRoleScope('operational', 'unknown:scope'), false);
});
