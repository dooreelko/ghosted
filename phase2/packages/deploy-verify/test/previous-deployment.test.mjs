import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPreviousTag } from '../src/previous-deployment.mjs';

const repo = '699571927575.dkr.ecr.us-east-1.amazonaws.com/ghost-phase2';

test('findPreviousTag returns the second-newest deployment\'s image tag', () => {
  const response = {
    deployments: [
      { version: 3, state: 'ACTIVE', containers: { ghost: { image: `${repo}:new-sha` } } },
      { version: 2, state: 'INACTIVE', containers: { ghost: { image: `${repo}:prev-sha` } } },
      { version: 1, state: 'INACTIVE', containers: { ghost: { image: `${repo}:oldest-sha` } } },
    ],
  };
  assert.equal(findPreviousTag(response), 'prev-sha');
});

test('findPreviousTag returns null when there is only one deployment', () => {
  const response = {
    deployments: [{ version: 1, state: 'ACTIVE', containers: { ghost: { image: `${repo}:only-sha` } } }],
  };
  assert.equal(findPreviousTag(response), null);
});

test('findPreviousTag returns null with no deployments at all', () => {
  assert.equal(findPreviousTag({ deployments: [] }), null);
});

test('findPreviousTag sorts by version regardless of input order', () => {
  const response = {
    deployments: [
      { version: 1, state: 'INACTIVE', containers: { ghost: { image: `${repo}:oldest-sha` } } },
      { version: 3, state: 'ACTIVE', containers: { ghost: { image: `${repo}:new-sha` } } },
      { version: 2, state: 'INACTIVE', containers: { ghost: { image: `${repo}:prev-sha` } } },
    ],
  };
  assert.equal(findPreviousTag(response), 'prev-sha');
});
