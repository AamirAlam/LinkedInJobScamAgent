import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  prepareAssessmentAuthorisation,
  applyAssessmentAuthorisation,
} from '../assessment-authorisation.ts';

function source(outcome = 'no_harmful_behaviour_found') {
  return JSON.stringify({
    purpose: 'automated_execution_path_audit',
    inspection: {
      check: 'repository_inspection',
      artifact: 'https://github.com/example/assessment',
      outcome,
      finding: 'Synthetic source assessment.',
      scope: {
        inspection_boundary: 'repository_controlled_code',
        requested_action: 'npm run dev',
        artifact_revision: 'a'.repeat(40),
        inspected_files: ['package.json'],
        findings:
          outcome === 'harmful_behaviour_found'
            ? [
                {
                  file: 'package.json',
                  start_line: 1,
                  end_line: 1,
                  behaviour: 'Inert synthetic harmful finding.',
                  harmful: true,
                },
              ]
            : [],
        gaps: outcome === 'unresolved' ? ['Uninspected execution path.'] : [],
      },
    },
  });
}
function completed(raw = source()) {
  return {
    ...prepareAssessmentAuthorisation(raw, 'fixture.json'),
    status: 'completed_verification',
    outcome: 'verified',
    verification: {
      reviewer: 'Synthetic reviewer',
      reviewed_at: '2020-01-01T00:00:00Z',
      organisation: 'Example fixture company',
      requester: 'Fixture requester',
      independent_channel: 'independent_company_contact',
      evidence_reference: 'fixture-contact-record',
      evidence_summary:
        'Synthetic independent confirmation of identity, authority and exact assessment.',
      identity_confirmed: true,
      authority_confirmed: true,
      action_confirmed: true,
    },
  };
}

test('preparation records no claimed verification and pending input cannot affect policy', () => {
  const raw = source();
  const record = prepareAssessmentAuthorisation(raw, 'fixture.json');
  assert.equal(record.status, 'pending_verification');
  assert.equal(record.outcome, 'unresolved');
  assert.equal(record.verification.reviewer, '');
  assert.equal(record.verification.authority_confirmed, false);
  assert.throws(() => applyAssessmentAuthorisation(JSON.stringify(record), raw, 'fixture.json'));
});

test('completed authorisation enables precautions only after clean inspection; unresolved and harmful inspection retain their actions', () => {
  for (const [outcome, expected] of [
    ['no_harmful_behaviour_found', 'SAFE'],
    ['unresolved', 'HOLD'],
    ['harmful_behaviour_found', 'FLAG'],
  ]) {
    const raw = source(outcome);
    const result = applyAssessmentAuthorisation(
      JSON.stringify(completed(raw)),
      raw,
      'fixture.json',
    );
    assert.equal(result.recommendation.action, expected);
    assert.equal(result.assessment.inspection, outcome);
    assert.equal(result.inspection.scope?.artifact_revision, 'a'.repeat(40));
    assert.equal(result.belief_update, 'not_applied_no_authorisation_likelihoods_configured');
    if (expected === 'SAFE') {
      assert.ok('precautions' in result.recommendation);
    }
  }
});

test('unresolved authorisation remains HOLD even with a clean source assessment', () => {
  const raw = source();
  const record = completed(raw);
  const unresolved = {
    ...record,
    outcome: 'unresolved',
    verification: { ...record.verification, authority_confirmed: false },
  };
  const result = applyAssessmentAuthorisation(JSON.stringify(unresolved), raw, 'fixture.json');
  assert.equal(result.recommendation.action, 'HOLD');
  assert.match(result.recommendation.reason, /authorisation remains unresolved/);
});

test('verified records reject missing confirmations, evidence and invalid verification times', () => {
  const raw = source();
  const record = completed(raw);
  const invalidVerifications = [
    ...['identity_confirmed', 'authority_confirmed', 'action_confirmed'].map((field) => ({
      ...record.verification,
      [field]: false,
    })),
    { ...record.verification, evidence_reference: '' },
    { ...record.verification, evidence_summary: ' ' },
    { ...record.verification, reviewer: '' },
    { ...record.verification, independent_channel: 'requester_linkedin_profile' },
    { ...record.verification, reviewed_at: '9999-01-01T00:00:00Z' },
  ];
  for (const verification of invalidVerifications) {
    assert.throws(() =>
      applyAssessmentAuthorisation(
        JSON.stringify({ ...record, verification }),
        raw,
        'fixture.json',
      ),
    );
  }
});

test('authorisation rejects tampered source hash and changed artifact, revision, action or boundary', () => {
  const raw = source();
  const record = completed(raw);
  assert.throws(() =>
    applyAssessmentAuthorisation(
      JSON.stringify({ ...record, source_report_sha256: '0'.repeat(64) }),
      raw,
      'fixture.json',
    ),
  );
  for (const field of ['artifact', 'revision', 'requested_action', 'inspection_boundary']) {
    assert.throws(() =>
      applyAssessmentAuthorisation(
        JSON.stringify({ ...record, binding: { ...record.binding, [field]: 'changed' } }),
        raw,
        'fixture.json',
      ),
    );
  }
  assert.throws(() =>
    applyAssessmentAuthorisation(JSON.stringify(record), source('unresolved'), 'fixture.json'),
  );
});

test('unavailable revisions, legacy scope and noncanonical artifacts cannot prepare authorisation', () => {
  const original = JSON.parse(source());
  for (const revision of ['unresolved', 'main', 'a'.repeat(41)]) {
    assert.throws(() =>
      prepareAssessmentAuthorisation(
        JSON.stringify({
          ...original,
          inspection: {
            ...original.inspection,
            scope: { ...original.inspection.scope, artifact_revision: revision },
          },
        }),
        'fixture.json',
      ),
    );
  }
  assert.throws(() =>
    prepareAssessmentAuthorisation(
      JSON.stringify({
        ...original,
        inspection: {
          ...original.inspection,
          artifact: 'https://github.com/example/assessment/',
        },
      }),
      'fixture.json',
    ),
  );
});
