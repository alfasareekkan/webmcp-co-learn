/**
 * Guidance Session Manager — ESM, no external dependencies.
 * Manages active multi-step guidance sessions keyed by threadId.
 * All session state changes are logged with [SESSION] prefix.
 */

const sessions = new Map();

export const STATUS = {
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

export function createSession(threadId, question, fullPlan) {
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

export function getSession(threadId) {
  return sessions.get(threadId) || null;
}

export function getCurrentStep(threadId) {
  const session = sessions.get(threadId);
  if (!session || !session.steps.length) return null;
  const idx = session.currentStepIndex;
  if (idx < 0 || idx >= session.steps.length) return null;
  return session.steps[idx];
}

export function advanceStep(threadId) {
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

export function completeSession(threadId) {
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

export function abandonSession(threadId) {
  const session = sessions.get(threadId);
  if (!session) return;
  session.status = STATUS.ABANDONED;
  session.lastUpdatedAt = new Date().toISOString();
  log("abandonSession", "Session abandoned", {
    sessionId: session.sessionId,
    threadId,
  });
}

export function hasActiveSession(threadId) {
  const session = sessions.get(threadId);
  if (!session) return false;
  return (
    session.status === STATUS.ACTIVE || session.status === STATUS.WAITING_FOR_STEP
  );
}

export function getLastSuggestions(threadId) {
  const session = sessions.get(threadId);
  return session && Array.isArray(session.lastSuggestions)
    ? session.lastSuggestions
    : [];
}

export function clearSession(threadId) {
  if (sessions.has(threadId)) {
    const session = sessions.get(threadId);
    log("clearSession", "Cleared session", {
      sessionId: session.sessionId,
      threadId,
    });
    sessions.delete(threadId);
  }
}

export function setWaitingForStep(threadId) {
  const session = sessions.get(threadId);
  if (session) {
    session.status = STATUS.WAITING_FOR_STEP;
    session.lastUpdatedAt = new Date().toISOString();
  }
}

export function setActive(threadId) {
  const session = sessions.get(threadId);
  if (session) {
    session.status = STATUS.ACTIVE;
    session.lastUpdatedAt = new Date().toISOString();
  }
}

export function getAllActiveSessions() {
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
