import type { AuthContext } from "../modules/sessions/session.types";

declare global {
  namespace Express {
    interface Request {
      /** Set by loadSession when the request carries a valid, unexpired session. */
      auth?: AuthContext;
    }
  }
}

export {};
