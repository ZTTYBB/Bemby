import { Router } from "express";
import {
  deleteSecret,
  isValidSecretKey,
  listSecrets,
  setSecret,
  SECRET_KEY_PATTERN,
} from "../db/secrets";

// Names in, nothing out. There is no endpoint that reads a value back, masked or otherwise:
// a secret exists so the backend can use it where it is needed, and a panel that can display
// one is a panel that can leak one.

const router = Router();

router.get("/", (_req, res) => {
  res.json(listSecrets());
});

router.put("/:key", (req, res) => {
  const key = String(req.params.key ?? "");
  if (!isValidSecretKey(key)) {
    res.status(400).json({
      error: `Name must match ${SECRET_KEY_PATTERN.source} so it can be written as {name}`,
    });
    return;
  }
  const value = (req.body as { value?: unknown })?.value;
  if (typeof value !== "string" || !value) {
    res.status(400).json({ error: "A value is required" });
    return;
  }
  setSecret(key, value);
  res.json({ ok: true, key });
});

router.delete("/:key", (req, res) => {
  const removed = deleteSecret(String(req.params.key ?? ""));
  if (!removed) {
    res.status(404).json({ error: "No secret is stored under that name" });
    return;
  }
  res.json({ ok: true });
});

export default router;
