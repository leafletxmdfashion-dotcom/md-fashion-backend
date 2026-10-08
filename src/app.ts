import { randomUUID } from "node:crypto";

import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";

import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./lib/errors";
import { logger } from "./lib/logger";
import { createRateLimiters } from "./lib/rate-limit";
import { CSRF_HEADER } from "./modules/auth/csrf";
import { apiRouter } from "./routes/index";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// A factory so each test suite gets fresh in-memory rate-limit state.
export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", env.trustProxy);

  // JSON-only API: nothing here should ever be rendered or framed by a browser.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );

  app.use(
    cors({
      origin: env.clientOrigin,
      credentials: true,
      allowedHeaders: ["Content-Type", CSRF_HEADER, "X-Request-Id"],
      exposedHeaders: [CSRF_HEADER, "X-Request-Id"],
    }),
  );

  // Auth responses carry secrets (CSRF tokens); skipping compression there avoids BREACH-style leaks.
  app.use(compression({ filter: (req, res) => !req.url.startsWith("/api/v1/auth") && compression.filter(req, res) }));

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/health" },
      // Bodies are never logged; query strings are dropped as well.
      serializers: {
        req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split("?")[0],
          remoteAddress: req.remoteAddress,
        }),
      },
    }),
  );

  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.status(200).json({ success: true, data: { status: "ok" } });
  });

  app.use("/api/v1", apiRouter(createRateLimiters()));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
