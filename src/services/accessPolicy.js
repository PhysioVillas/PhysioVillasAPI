const ROLE_SCOPES = Object.freeze({
  operational: Object.freeze([
    'contacts:read',
    'conversations:read',
    'faq:read',
    'faq:write',
    'messages:read',
    'templates:read',
  ]),
  managerial: Object.freeze([
    'faq:read',
    'reporting:read',
    'templates:read',
  ]),
  executive: Object.freeze([
    'reporting:read',
  ]),
});

function getRoleScopes(role) {
  return ROLE_SCOPES[role] ?? [];
}

function hasRoleScope(role, scope) {
  return getRoleScopes(role).includes(scope);
}

export { ROLE_SCOPES, getRoleScopes, hasRoleScope };
