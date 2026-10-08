const { jsonResponse } = require('../http-helpers');
const { INSTRUCTION_MODES, hasExactKeys, validScopedIdentifier, validSessionId } = require('../request-validation');

function createInstructionsRoutes(ctx) {
  const {
    instructionModeAllowed, instructionScopeMatches, instructionService, instructionServiceResult,
    instructionTargetProjection, lateInstructionIds, linkInstructionLaunch, loadScopedInstruction,
    questionRegistrationLink, questionService, questionServiceReady, queueInstructionResponseLost,
    registrationSnapshotForInstructions, sendInstructionError, state,
  } = ctx;

  async function handleInstructionRequest({ request, response, requestUrl, info, body }) {
    const createPath = request.method === 'POST' && requestUrl.pathname === '/api/instructions/create';
    const actionPath = request.method === 'POST' && requestUrl.pathname.match(/^\/api\/instructions\/([^/]+)\/(send|cancel|alternative)$/);
    const latePath = request.method === 'POST' && requestUrl.pathname.match(/^\/api\/decisions\/([^/]+)\/late-instruction$/);
    if (!createPath && !actionPath && !latePath) return false;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }

    try {
      if (createPath) {
        const fields = ['session_id', 'execution_id', 'launch_ref', 'delivery_attempt_id',
          'logical_message_id', 'revision', 'text', 'mode', 'expected_turn_id'];
        if (!hasExactKeys(body, fields) || !validSessionId(body.session_id) ||
            !validScopedIdentifier(body.execution_id) || !validScopedIdentifier(body.launch_ref) ||
            !validScopedIdentifier(body.delivery_attempt_id) || !validScopedIdentifier(body.logical_message_id) ||
            !Number.isSafeInteger(body.revision) || body.revision < 0 ||
            typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text, 'utf8') > 64 * 1024 ||
            !INSTRUCTION_MODES.has(body.mode) ||
            (body.expected_turn_id !== null && !validScopedIdentifier(body.expected_turn_id))) {
          jsonResponse(response, 400, { error: 'instruction_invalid_request' });
          return true;
        }
        const snapshot = registrationSnapshotForInstructions();
        const link = snapshot ? linkInstructionLaunch(body.launch_ref, snapshot, true) : null;
        if (!link || link.launch.state !== 'bound' || !instructionScopeMatches(body, link)) {
          jsonResponse(response, 403, { error: 'instruction_scope_mismatch' });
          return true;
        }
        const target = instructionTargetProjection(body.launch_ref);
        if (!instructionModeAllowed(link.launch, target, body.mode, body.expected_turn_id)) {
          jsonResponse(response, 409, { error: target.reason || 'instruction_target_unverified' });
          return true;
        }
        const result = await instructionService.create({
          deliveryAttemptId: body.delivery_attempt_id,
          launchRef: body.launch_ref,
          logicalMessageId: body.logical_message_id,
          revision: body.revision,
          text: body.text,
          mode: body.mode,
          expectedTurnId: body.expected_turn_id,
        });
        const safe = instructionServiceResult(result);
        if (!safe) {
          jsonResponse(response, 503, { error: 'instruction_projection_unavailable' });
          return true;
        }
        jsonResponse(response, 200, safe);
        return true;
      }

      if (actionPath) {
        let deliveryAttemptId;
        try { deliveryAttemptId = decodeURIComponent(actionPath[1]); }
        catch { jsonResponse(response, 400, { error: 'instruction_invalid_request' }); return true; }
        if (!validScopedIdentifier(deliveryAttemptId) || !hasExactKeys(body,
          actionPath[2] === 'alternative'
            ? ['session_id', 'execution_id', 'new_delivery_attempt_id', 'logical_message_id', 'revision', 'text', 'mode', 'expected_turn_id']
            : ['session_id', 'execution_id']) ||
            !validSessionId(body.session_id) || !validScopedIdentifier(body.execution_id)) {
          jsonResponse(response, 400, { error: 'instruction_invalid_request' });
          return true;
        }
        const scoped = await loadScopedInstruction(deliveryAttemptId, body);
        if (scoped.missing) { jsonResponse(response, 404, { error: 'instruction_not_found' }); return true; }
        if (scoped.forbidden) { jsonResponse(response, 403, { error: 'instruction_scope_mismatch' }); return true; }
        if (actionPath[2] === 'send') {
          const { launch } = scoped.link;
          const target = instructionTargetProjection(launch.launchRef);
          const expectedTurnId = scoped.instruction.mode === 'steer' ? scoped.instruction.nativeTurnId : null;
          const allowNext = scoped.instruction.mode === 'next-user-input';
          if (launch.state !== 'bound' || scoped.link.execution.state !== 'active' ||
              !instructionModeAllowed(launch, target, scoped.instruction.mode, expectedTurnId, allowNext)) {
            jsonResponse(response, 409, { error: target.reason || 'instruction_target_unverified' });
            return true;
          }
          response.once('close', () => {
            if (!response.writableFinished) queueInstructionResponseLost(deliveryAttemptId);
          });
          const result = await instructionService.send(deliveryAttemptId);
          if (response.destroyed) return true;
          const safe = instructionServiceResult(result);
          if (!safe) {
            queueInstructionResponseLost(deliveryAttemptId);
            jsonResponse(response, 503, { error: 'instruction_projection_unavailable' });
            return true;
          }
          jsonResponse(response, 200, safe);
          return true;
        }
        if (actionPath[2] === 'cancel') {
          const result = await instructionService.cancel(deliveryAttemptId);
          const safe = instructionServiceResult(result);
          if (!safe) { jsonResponse(response, 503, { error: 'instruction_projection_unavailable' }); return true; }
          jsonResponse(response, 200, safe);
          return true;
        }
        if (!validScopedIdentifier(body.new_delivery_attempt_id) || !validScopedIdentifier(body.logical_message_id) ||
            !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.text !== 'string' ||
            !body.text.trim() || Buffer.byteLength(body.text, 'utf8') > 64 * 1024 ||
            !INSTRUCTION_MODES.has(body.mode) ||
            (body.expected_turn_id !== null && !validScopedIdentifier(body.expected_turn_id))) {
          jsonResponse(response, 400, { error: 'instruction_invalid_request' });
          return true;
        }
        const { launch, execution } = scoped.link;
        const target = instructionTargetProjection(launch.launchRef);
        if (launch.state !== 'bound' || execution.state !== 'active' ||
            !instructionModeAllowed(launch, target, body.mode, body.expected_turn_id, true)) {
          jsonResponse(response, 409, { error: target.reason || 'instruction_target_unverified' });
          return true;
        }
        const result = await instructionService.supersedeUnsent(deliveryAttemptId, {
          newDeliveryAttemptId: body.new_delivery_attempt_id,
          logicalMessageId: body.logical_message_id,
          revision: body.revision,
          text: body.text,
          mode: body.mode,
          expectedTurnId: body.expected_turn_id,
        });
        const safe = instructionServiceResult(result);
        if (!safe) { jsonResponse(response, 503, { error: 'instruction_projection_unavailable' }); return true; }
        jsonResponse(response, 200, safe);
        return true;
      }

      let internalQuestionId;
      try { internalQuestionId = decodeURIComponent(latePath[1]); }
      catch { jsonResponse(response, 400, { error: 'instruction_invalid_request' }); return true; }
      const lateFields = ['session_id', 'execution_id', 'index', 'digest', 'mode', 'expected_turn_id'];
      if (!hasExactKeys(body, lateFields) || !validSessionId(body.session_id) ||
          !validScopedIdentifier(body.execution_id) || !Number.isSafeInteger(body.index) || body.index < 0 ||
          typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.digest) ||
          !INSTRUCTION_MODES.has(body.mode) ||
          (body.expected_turn_id !== null && !validScopedIdentifier(body.expected_turn_id))) {
        jsonResponse(response, 400, { error: 'instruction_invalid_request' });
        return true;
      }
      if (!questionService || !questionServiceReady || typeof questionService.readLateAnswerDraft !== 'function') {
        jsonResponse(response, 503, { error: 'Late answer conversion is unavailable' });
        return true;
      }
      const questionSnapshot = await questionService.dashboardSnapshot();
      const question = questionSnapshot?.questions?.find((item) => item.internalQuestionId === internalQuestionId);
      const questionLink = question && questionRegistrationLink(question);
      if (!question || !questionLink || questionLink.sessionId !== body.session_id ||
          questionLink.execution.executionId !== body.execution_id ||
          !question.lateAnswerRefs?.some((ref) => ref.index === body.index && ref.digest === body.digest)) {
        jsonResponse(response, 404, { error: 'late_answer_not_found' });
        return true;
      }
      const launchSnapshot = registrationSnapshotForInstructions();
      const launchLink = launchSnapshot ? linkInstructionLaunch(question.launchRef, launchSnapshot, true) : null;
      if (!launchLink || launchLink.launch.state !== 'bound' || launchLink.execution.sessionId !== body.session_id ||
          launchLink.execution.executionId !== body.execution_id) {
        jsonResponse(response, 403, { error: 'instruction_scope_mismatch' });
        return true;
      }
      const target = instructionTargetProjection(question.launchRef);
      if (!instructionModeAllowed(launchLink.launch, target, body.mode, body.expected_turn_id)) {
        jsonResponse(response, 409, { error: target.reason || 'instruction_target_unverified' });
        return true;
      }
      const draft = await questionService.readLateAnswerDraft(internalQuestionId, body.index, body.digest);
      if (!draft || draft.launchRef !== question.launchRef || typeof draft.text !== 'string') {
        jsonResponse(response, 404, { error: 'late_answer_not_found' });
        return true;
      }
      const ids = lateInstructionIds(internalQuestionId, body.index, body.digest);
      const result = await instructionService.create({
        ...ids,
        launchRef: draft.launchRef,
        text: draft.text,
        mode: body.mode,
        expectedTurnId: body.expected_turn_id,
      });
      const safe = instructionServiceResult(result);
      if (!safe) { jsonResponse(response, 503, { error: 'instruction_projection_unavailable' }); return true; }
      jsonResponse(response, 200, safe);
      return true;
    } catch (error) {
      sendInstructionError(response, error);
      return true;
    }
  }

  return { handleInstructionRequest };
}

module.exports = { createInstructionsRoutes };
