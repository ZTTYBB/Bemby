import type { RequestHandler } from "express";
import { isBulkAccountManagementEnabled } from "../jobs/bulkAdd";

// Reject bulk-management requests unless enabled via BULK_ACCOUNT_MANAGEMENT.
export const bulkMgmtGuard: RequestHandler = (_req, res, next) => {
  if (!isBulkAccountManagementEnabled()) {
    res.status(403).json({ error: "Bulk account management is not enabled" });
    return;
  }
  next();
};
