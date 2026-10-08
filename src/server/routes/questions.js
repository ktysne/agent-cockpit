const { jsonResponse } = require('../http-helpers');
const { hasExactKeys, questionErrorStatus } = require('../request-validation');

function createQuestionsRoutes(ctx) {
  const {
    mutateCommonQuestion, questionService, queueQuestionResponseLost, resolveFreshWriterSessionId,
    state,
  } = ctx;

  async function handleQuestionRequest({ request, response, params, body }) {
    const operation = params[1];
    const expectedFields = operation === 'register'
      ? ['writer', 'questionId', 'questions', 'timeoutMinutes']
      : ['writer', 'questionId'];
    if (!hasExactKeys(body, expectedFields)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    let writerSessionId = null;
    try { writerSessionId = await resolveFreshWriterSessionId('pending', body); } catch {}
    if (!writerSessionId) {
      jsonResponse(response, 403, { error: 'Writer unavailable' });
      return;
    }
    try {
      if (operation === 'register') {
        const result = await questionService.register(body.writer, {
          questionId: body.questionId, questions: body.questions,
          timeoutMinutes: body.timeoutMinutes, category: 'ordinary',
        });
        jsonResponse(response, 200, result);
        return;
      }
      if (operation === 'status') {
        const result = await questionService.status(body.writer, body.questionId);
        jsonResponse(response, 200, result);
        return;
      }
      const registeredQuestion = await questionService.status(body.writer, body.questionId);
      if (!registeredQuestion) {
        if (operation === 'response-lost') {
          jsonResponse(response, 404, { error: 'Question not found' });
        } else {
          jsonResponse(response, 200, {
            status: { outcome: 'not_found', questionId: body.questionId, deliveryAttemptId: null, state: null },
            delivery: null,
          });
        }
        return;
      }
      if (operation === 'response-lost') {
        const result = await questionService.reportResponseLost(registeredQuestion.internalQuestionId);
        jsonResponse(response, 200, result);
        return;
      }
      let responseClosed = false;
      let responseLostQueued = false;
      let sinkResponded = false;
      const reportLost = () => {
        if (!sinkResponded || !responseClosed || responseLostQueued) return;
        responseLostQueued = true;
        queueQuestionResponseLost(registeredQuestion.internalQuestionId);
      };
      response.once('close', () => {
        if (!response.writableFinished) {
          responseClosed = true;
          reportLost();
        }
      });
      try {
        const result = await questionService.answerPoll(body.writer, body.questionId, (answers, metadata) => {
          if (sinkResponded || responseClosed || response.destroyed || response.writableEnded ||
              !metadata || !Array.isArray(answers)) throw new Error();
          sinkResponded = true;
          jsonResponse(response, 200, {
            status: { outcome: 'sent', questionId: metadata.questionId,
              deliveryAttemptId: metadata.deliveryAttemptId, state: 'sending' },
            delivery: {
              questionId: metadata.questionId,
              revision: metadata.revision,
              deliveryAttemptId: metadata.deliveryAttemptId,
              answers: structuredClone(answers),
            },
          });
        });
        if (!sinkResponded && !response.destroyed && !response.writableEnded) {
          jsonResponse(response, 200, { status: result, delivery: null });
        }
      } catch (error) {
        if (sinkResponded) {
          if (responseClosed || response.destroyed || !response.writableFinished) {
            responseClosed = true;
            reportLost();
          }
          return;
        }
        throw error;
      }
    } catch (error) {
      jsonResponse(response, questionErrorStatus(error), { error: 'Question request is unavailable' });
    }
    return;
  }

  async function handleQuestionMutation({ response, params, body }) {
    let internalQuestionId;
    try { internalQuestionId = decodeURIComponent(params[1]); }
    catch {
      jsonResponse(response, 400, { error: 'Invalid question id' });
      return;
    }
    if (!internalQuestionId.startsWith('cq-')) {
      jsonResponse(response, 404, { error: 'Question not found' });
      return;
    }
    await mutateCommonQuestion(response, internalQuestionId, body, params[2]);
    return;
  }

  return { handleQuestionRequest, handleQuestionMutation };
}

module.exports = { createQuestionsRoutes };
