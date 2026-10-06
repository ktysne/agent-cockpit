'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runProbe } = require('./existing-probe');

test('古いPR条件ではマージせず、fixtureの制約を記録する', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'poc164-existing-test-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));

  const { report, outputFile } = await runProbe({ outDir });
  const saved = JSON.parse(await fs.readFile(outputFile, 'utf8'));

  assert.deepEqual(saved, report);
  assert.equal(report.evidence, 'fixture-only');
  assert.equal(report.vendorAndGh.realGhInvoked, false);
  assert.equal(report.vendorAndGh.claudeCliInvoked, false);
  assert.equal(report.vendorAndGh.codexCliInvoked, false);

  assert.equal(report.cases.registration.distinctFixtureSessionCount, 3);
  assert.equal(report.cases.registration.oneRecordPerSameSessionAndPr, true);
  assert.equal(report.cases.registration.providerFieldPresent, false);
  assert.equal(report.cases.registration.runOrAttemptFieldPresent, false);
  assert.equal(report.cases.registration.nativeVendorIdPresent, false);

  for (const name of [
    'displayHeadMismatch',
    'baseMismatch',
    'nonBottomPr',
    'headChangedBeforeGh',
    'baseChangedAfterChildRetarget',
    'staleConvergence',
    'reservedHeadChanged',
    'reservationCancelled',
  ]) {
    assert.equal(report.cases[name].mergeCalls, 0, name + ' must not call fake gh merge');
  }
  assert.equal(report.cases.baseChangedAfterChildRetarget.childEditCalls, 1);
  assert.equal(report.cases.headChangedBeforeGh.fixtureInputUnchanged, true);
  assert.equal(report.cases.staleConvergence.reservationRetained, true);
  assert.equal(report.cases.reservedHeadChanged.reservationRetained, true);
  assert.equal(report.cases.reservationCancelled.cancelled, true);
  assert.equal(report.cases.reservationCancelled.noticeDelivered, true);

  assert.equal(report.cases.currentHeadConverged.mergeCalls, 1);
  assert.equal(report.cases.currentHeadConverged.matchHeadCommit, report.cases.currentHeadConverged.expectedHead);

  assert.equal(report.cases.squashMergeNotice.merged, true);
  assert.equal(report.cases.squashMergeNotice.parentNotified, true);
  assert.equal(report.cases.squashMergeNotice.childNotifiedWithRestack, true);
  assert.equal(report.cases.squashMergeNotice.endedSessionAlsoNotified, true);
  assert.equal(report.cases.squashMergeNotice.sameManagerDuplicateSuppressed, true);
  assert.equal(report.cases.rebaseMergeNotice.merged, true);
  assert.equal(report.cases.rebaseMergeNotice.methodArgument, true);
  assert.equal(report.cases.rebaseMergeNotice.childNotifiedWithRestack, true);
  assert.equal(report.cases.mergeCommitNotice.merged, true);
  assert.equal(report.cases.mergeCommitNotice.methodArgument, true);
  assert.equal(report.cases.mergeCommitNotice.childNotifiedWithRestack, false);

  assert.equal(report.cases.ghReportsOpen.queued, true);
  assert.equal(report.cases.ghReportsOpen.merged, false);
  assert.equal(report.cases.ghStateUnknown.status, 502);
  assert.equal(report.cases.ghStateUnknown.mergeIntentRetained, true);
  assert.equal(report.cases.conflictNotification.activeSessionNotified, true);
  assert.equal(report.cases.conflictNotification.endedSessionNotified, false);
  assert.equal(report.cases.conflictNotification.mergeCalls, 0);

  assert.equal(report.cases.deliveryDeduplication.repeatedCallsCollapsed, false);
  assert.equal(report.cases.deliveryDeduplication.repeatedCallsDelivered, 2);

  assert.equal(report.cases.httpBoundary.stateStatus, 200);
  assert.equal(report.cases.httpBoundary.snapshotIncludesFixture, true);
  assert.equal(report.cases.httpBoundary.unauthorizedStatus, 401);
  assert.equal(report.cases.httpBoundary.forbiddenOriginStatus, 403);
  assert.equal(report.cases.httpBoundary.missingOriginStatus, 403);
  assert.equal(report.cases.httpBoundary.badHostStatus, 400);
  assert.equal(report.cases.httpBoundary.crossSiteStatus, 403);
  assert.equal(report.cases.httpBoundary.validWriteStatus, 200);
  assert.equal(report.cases.httpBoundary.validWriteManagerCalls, 1);
  assert.equal(report.cases.httpBoundary.runtimeClosed, true);
  assert.equal(report.safety.fixtureRootCleaned, true);
});
