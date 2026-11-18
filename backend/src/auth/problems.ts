/**
 * Re-export shared problem helpers. User and device routes share one RFC 9457
 * shape (`code` + `retryable`); device-specific codes live in the same union.
 */
export {
  buildProblem,
  problemType,
  sendProblem,
  type ProblemBody,
  type ProblemCode,
  type SendProblemOptions,
} from "../http/problems.js";
