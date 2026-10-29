import { z } from "zod";

// ponytail: one factory, one timezone; make it a setting if a second site opens elsewhere.
const FACTORY_TIME_ZONE = "Asia/Kathmandu";

/** Today's date (YYYY-MM-DD) at the factory, whatever timezone the server runs in. */
export function factoryToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FACTORY_TIME_ZONE }).format(now);
}

/** A business date (purchase, cutting, issue, receipt): any valid day up to the factory's today. */
export const businessDate = z.iso
  .date("Enter a valid date.")
  .refine((value) => value <= factoryToday(), "Date cannot be in the future.");
