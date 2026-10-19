/**
 * Wraps an async Express route handler so a thrown/rejected error is passed
 * to next(err) instead of crashing the whole process. Express 4 does not
 * catch async errors on its own — without this, any bug in a route handler
 * (a typo'd variable, an unexpected null, etc.) takes down every in-flight
 * request on the server, not just the one that errored.
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
