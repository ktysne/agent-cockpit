const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DecisionAnswerDelivery } = require('../src/server/decision-answers');

test('フックの入口は配信記録と世代の更新を共通受付へ渡す', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [path.join(root, 'server/routes/hooks.js'),
    ...fs.readdirSync(path.join(root, 'hooks'), { recursive: true })
      .filter((file) => file.endsWith('.js')).map((file) => path.join(root, 'hooks', file))];
  const directAccess = /\.(?:getHookDelivery|recordHookDelivery|acknowledgeHookDelivery|canReplayStopDelivery|cancelHookReminders|pendingHookDeliveries|stopGenerations|lastLifecycleAt|pendingHookReminders|hookDeliveryReminders|pendingSessionNotifications|pendingSessionNotificationOverflow|remindedReviewHeads|reviewPromptVersions|setDecisionLifecycle|deleteDecisionLifecycle)\b/;
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), directAccess, file);
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(DecisionAnswerDelivery.prototype))) {
    if (['constructor', 'intakeHookDelivery'].includes(name) || typeof descriptor.value !== 'function') continue;
    assert.doesNotMatch(descriptor.value.toString(), /this\.(?:stopGenerations|lastLifecycleAt|endedSessions)\.(?:set|add|delete|clear)\(/, name);
  }
});
