/**
 * Guidance Session Manager — pure JavaScript, no external dependencies.
 * Manages active multi-step guidance sessions keyed by threadId.
 * All session state changes are logged with [SESSION] prefix.
 */

const sessions = new Map(); // threadId -> session

const STATUS = {
  ACTIVE: "active",
  WAITING_FOR_STEP: "waiting_for_step",
  COMPLETE: "complete",
  ABANDONED: "abandoned",
};

function log(prefix, message, data) {
  const payload = data !== undefined ? ` ${JSON.stringify(data)}` : "";
  console.log(`[SESSION] ${prefix} ${message}${payload}`);
}

function generateSessionId() {
  return `gs_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Create a new guidance session.
 * @param {string} threadId - Unique thread/conversation id
 * @param {string} question - Original user question
 * @param {object} fullPlan - Plan from Gemini: { taskSummary, steps, suggestedFollowUps }
 * @returns {string} sessionId
 */
function createSession(threadId, question, fullPlan) {
  if (sessions.has(threadId)) {
    log("createSession", "Abandoning existing session for thread", { threadId });
    abandonSession(threadId);
  }

  const taskSummary = fullPlan.taskSummary || "Complete the task";
  const steps = Array.isArray(fullPlan.steps) ? fullPlan.steps : [];
  const suggestedFollowUps = Array.isArray(fullPlan.suggestedFollowUps)
    ? fullPlan.suggestedFollowUps
    : [];

  const sessionId = generateSessionId();
  const now = new Date().toISOString();

  const session = {
    sessionId,
    threadId,
    originalQuestion: question,
    taskSummary,
    steps,
    currentStepIndex: 0,
    completedSteps: [],
    status: steps.length > 0 ? STATUS.ACTIVE : STATUS.COMPLETE,
    lastSuggestions: suggestedFollowUps,
    createdAt: now,
    lastUpdatedAt: now,
  };

  sessions.set(threadId, session);
  log("createSession", "Created", {
    sessionId,
    threadId,
    stepCount: steps.length,
    taskSummary: taskSummary.slice(0, 50),
  });
  return sessionId;
}

/**
 * Get session for a thread.
 * @param {string} threadId
 * @returns {object|null} session or null
 */
function getSession(threadId) {
  return sessions.get(threadId) || null;
}

/**
 * Get the current step object for the thread (based on currentStepIndex).
 * @param {string} threadId
 * @returns {object|null} current step or null if none
 */
function getCurrentStep(threadId) {
  const session = sessions.get(threadId);
  if (!session || !session.steps.length) return null;
  const idx = session.currentStepIndex;
  if (idx < 0 || idx >= session.steps.length) return null;
  return session.steps[idx];
}

/**
 * Advance to the next step. Marks current step as completed.
 * @param {string} threadId
 * @returns {object|null} next step object, or null if all steps done
 */
function advanceStep(threadId) {
  const session = sessions.get(threadId);
  if (!session) {
    log("advanceStep", "No session for thread", { threadId });
    return null;
  }

  const currentStep = getCurrentStep(threadId);
  if (currentStep) {
    session.completedSteps.push(currentStep);
    log("advanceStep", "Step completed", {
      sessionId: session.sessionId,
      stepNumber: currentStep.stepNumber,
      threadId,
    });
  }

  session.currentStepIndex += 1;
  session.lastUpdatedAt = new Date().toISOString();

  if (session.currentStepIndex >= session.steps.length) {
    log("advanceStep", "All steps done for session", {
      sessionId: session.sessionId,
      threadId,
    });
    return null;
  }

  const nextStep = session.steps[session.currentStepIndex];
  log("advanceStep", "Advanced to next step", {
    sessionId: session.sessionId,
    stepNumber: nextStep.stepNumber,
    currentStepIndex: session.currentStepIndex,
    totalSteps: session.steps.length,
    threadId,
  });
  return nextStep;
}

/**
 * Mark session as complete and keep lastSuggestions for follow-ups.
 * @param {string} threadId
 */
function completeSession(threadId) {
  const session = sessions.get(threadId);
  if (!session) return;
  session.status = STATUS.COMPLETE;
  session.lastUpdatedAt = new Date().toISOString();
  log("completeSession", "Session completed", {
    sessionId: session.sessionId,
    threadId,
    completedSteps: session.completedSteps.length,
  });
}

/**
 * Mark session as abandoned.
 * @param {string} threadId
 */
function abandonSession(threadId) {
  const session = sessions.get(threadId);
  if (!session) return;
  session.status = STATUS.ABANDONED;
  session.lastUpdatedAt = new Date().toISOString();
  log("abandonSession", "Session abandoned", {
    sessionId: session.sessionId,
    threadId,
  });
}

/**
 * Check if thread has an active (or waiting) session that is not complete/abandoned.
 * @param {string} threadId
 * @returns {boolean}
 */
function hasActiveSession(threadId) {
  const session = sessions.get(threadId);
  if (!session) return false;
  return (
    session.status === STATUS.ACTIVE || session.status === STATUS.WAITING_FOR_STEP
  );
}

/**
 * Get last suggestion chips for the thread (for "yes" / follow-up resolution).
 * @param {string} threadId
 * @returns {string[]}
 */
function getLastSuggestions(threadId) {
  const session = sessions.get(threadId);
  return session && Array.isArray(session.lastSuggestions)
    ? session.lastSuggestions
    : [];
}

/**
 * Remove session from store entirely (e.g. when starting fresh).
 * @param {string} threadId
 */
function clearSession(threadId) {
  if (sessions.has(threadId)) {
    const session = sessions.get(threadId);
    log("clearSession", "Cleared session", {
      sessionId: session.sessionId,
      threadId,
    });
    sessions.delete(threadId);
  }
}

/**
 * Set status to waiting_for_step (watcher is active).
 * @param {string} threadId
 */
function setWaitingForStep(threadId) {
  const session = sessions.get(threadId);
  if (session) {
    session.status = STATUS.WAITING_FOR_STEP;
    session.lastUpdatedAt = new Date().toISOString();
  }
}

/**
 * Set status back to active (e.g. after showing next step).
 * @param {string} threadId
 */
function setActive(threadId) {
  const session = sessions.get(threadId);
  if (session) {
    session.status = STATUS.ACTIVE;
    session.lastUpdatedAt = new Date().toISOString();
  }
}

/**
 * For debugging: return all sessions that are still active or waiting.
 * @returns {object[]}
 */
function getAllActiveSessions() {
  const list = [];
  for (const [threadId, session] of sessions) {
    if (
      session.status === STATUS.ACTIVE ||
      session.status === STATUS.WAITING_FOR_STEP
    ) {
      list.push({
        threadId,
        sessionId: session.sessionId,
        currentStepIndex: session.currentStepIndex,
        totalSteps: session.steps.length,
        status: session.status,
      });
    }
  }
  return list;
}

module.exports = {
  createSession,
  getSession,
  getCurrentStep,
  advanceStep,
  completeSession,
  abandonSession,
  hasActiveSession,
  getLastSuggestions,
  clearSession,
  setWaitingForStep,
  setActive,
  getAllActiveSessions,
  STATUS,
};
