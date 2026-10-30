import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { Prisma } from "../db/prisma";
import { errorHandler } from "./errors";

function handle(err: unknown) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const req = { log: { error: vi.fn(), warn: vi.fn() } };
  errorHandler(err, req as unknown as Request, res as unknown as Response, vi.fn() as NextFunction);
  return { status: res.status.mock.calls[0]![0] as number, body: res.json.mock.calls[0]![0] };
}

describe("errorHandler", () => {
  it("answers a deadlock or serialization failure with 409 try again, not 500", () => {
    const deadlock = new Prisma.PrismaClientKnownRequestError(
      "Raw query failed. Code: `40P01`. Message: `deadlock detected`",
      { code: "P2010", clientVersion: "test" },
    );
    const conflict = new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict", {
      code: "P2034",
      clientVersion: "test",
    });

    for (const err of [deadlock, conflict]) {
      const { status, body } = handle(err);
      expect(status).toBe(409);
      expect(body.error).toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/same time/) });
    }
    expect(handle(new Error("boom")).status).toBe(500);
  });
});
