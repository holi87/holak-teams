// Argus error classes (RUNNER-CONTRACT.md SD-5). The outcome adapter classifies a failure
// by the error name, so every class sets `name` explicitly; the names the Java and Python
// templates also define are identical there. Messages must stay free of target data: name
// the resource kind or variable, never a body, token, or URL.

/** Created test data could not be removed: `automation fail cleanup-failed`. */
export class ArgusCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArgusCleanupError';
  }
}

/** A declared prerequisite (environment, account, service) is absent: `infrastructure fail prerequisite-missing`. */
export class ArgusPrerequisiteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArgusPrerequisiteError';
  }
}

/** An injected fault could not be restored or verified as restored: `infrastructure fail fault-restore-failed`. */
export class ArgusRestoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArgusRestoreError';
  }
}

/** A counterfactual stub received a request its fixture does not declare: `automation fail counterfactual-unmatched-request`. */
export class ArgusCounterfactualError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArgusCounterfactualError';
  }
}

/**
 * A counterfactual stub never served the fixture's subject exchange, so the regression
 * reached the API some other way: `automation fail counterfactual-subject-not-served`.
 */
export class ArgusCounterfactualSubjectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArgusCounterfactualSubjectError';
  }
}

/**
 * Read a required environment variable. An unset or empty value throws
 * ArgusPrerequisiteError, so the run reports a missing prerequisite instead of a skipped
 * or failing test. Tests never self-skip on prerequisites.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new ArgusPrerequisiteError(`required environment variable ${name} is not set`);
  }
  return value;
}
