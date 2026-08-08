import { Router } from "express";
import {
  createFolder,
  createRecord,
  DEFAULT_EXPORT_FORMAT,
  deleteFolder,
  deleteRecord,
  exportData,
  exportFolderText,
  getExportFormat,
  findFolderByName,
  getRecord,
  getRecordById,
  dataStoreOffReason,
  isDataStoreEnabled,
  isValidDataName,
  listFolders,
  listRecords,
  parseDataValue,
  renameFolder,
  setExportFormat,
  updateRecord,
} from "../db/dataStore";

// Folders and records of the data store. Values do travel both ways here, unlike the secrets
// endpoints: the point of the store is that a person can read what a job saved, correct it and
// take a copy of it.

const router = Router();

/** Off means off everywhere, the panel included, whichever switch turned it off. */
router.use((_req, res, next) => {
  if (!isDataStoreEnabled()) {
    res.status(403).json({ error: dataStoreOffReason(), code: "DATA_DISABLED" });
    return;
  }
  next();
});

const nameError = (what: string) =>
  `${what} may not hold a brace or a bracket, or begin or end with a space, so it can be ` +
  `written as {data.folder.key} (or {data.folder[key]} where it holds a dot), and must be ` +
  `1-128 characters`;

function folderIdParam(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The folder's name, for the format kept under it. Null when there is no such folder. */
function folderNameOf(id: number): string | null {
  return listFolders().find((f) => f.id === id)?.name ?? null;
}

/** Reads the value out of a body: `valueText` is parsed, `value` is taken as the JSON it is. */
function bodyValue(body: { value?: unknown; valueText?: unknown }): unknown {
  if (typeof body?.valueText === "string") return parseDataValue(body.valueText);
  return body?.value;
}

router.get("/folders", (_req, res) => {
  res.json(listFolders());
});

router.post("/folders", (req, res) => {
  const name = String((req.body as { name?: unknown })?.name ?? "").trim();
  if (!isValidDataName(name)) {
    res.status(400).json({ error: nameError("A folder name") });
    return;
  }
  if (findFolderByName(name)) {
    res.status(409).json({ error: "A folder of that name already exists" });
    return;
  }
  res.json({ id: createFolder(name), name });
});

router.patch("/folders/:id", (req, res) => {
  const id = folderIdParam(req.params.id);
  const name = String((req.body as { name?: unknown })?.name ?? "").trim();
  if (!id) {
    res.status(400).json({ error: "Invalid folder id" });
    return;
  }
  if (!isValidDataName(name)) {
    res.status(400).json({ error: nameError("A folder name") });
    return;
  }
  const clash = findFolderByName(name);
  if (clash && clash.id !== id) {
    res.status(409).json({ error: "A folder of that name already exists" });
    return;
  }
  if (!renameFolder(id, name)) {
    res.status(404).json({ error: "No such folder" });
    return;
  }
  res.json({ ok: true, id, name });
});

router.delete("/folders/:id", (req, res) => {
  const id = folderIdParam(req.params.id);
  if (!id || !deleteFolder(id)) {
    res.status(404).json({ error: "No such folder" });
    return;
  }
  res.json({ ok: true });
});

router.get("/folders/:id/records", (req, res) => {
  const id = folderIdParam(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid folder id" });
    return;
  }
  res.json(listRecords(id));
});

router.post("/folders/:id/records", (req, res) => {
  const folderId = folderIdParam(req.params.id);
  const key = String((req.body as { key?: unknown })?.key ?? "").trim();
  if (!folderId) {
    res.status(400).json({ error: "Invalid folder id" });
    return;
  }
  if (!isValidDataName(key)) {
    res.status(400).json({ error: nameError("A record key") });
    return;
  }
  if (getRecord(folderId, key)) {
    res.status(409).json({ error: "That key is already in this folder" });
    return;
  }
  const id = createRecord(folderId, key, bodyValue(req.body ?? {}) ?? "");
  res.json({ id, key });
});

router.patch("/records/:id", (req, res) => {
  const id = folderIdParam(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid record id" });
    return;
  }
  const record = getRecordById(id);
  if (!record) {
    res.status(404).json({ error: "No such record" });
    return;
  }

  const body = (req.body ?? {}) as { key?: unknown; value?: unknown; valueText?: unknown };
  const changes: { key?: string; value?: unknown } = {};

  if (body.key !== undefined) {
    const key = String(body.key).trim();
    if (!isValidDataName(key)) {
      res.status(400).json({ error: nameError("A record key") });
      return;
    }
    const clash = getRecord(record.folderId, key);
    if (clash && clash.id !== id) {
      res.status(409).json({ error: "That key is already in this folder" });
      return;
    }
    changes.key = key;
  }

  if (body.value !== undefined || body.valueText !== undefined) {
    changes.value = bodyValue(body) ?? "";
  }

  if (!updateRecord(id, changes)) {
    res.status(400).json({ error: "Nothing to change" });
    return;
  }
  res.json({ ok: true });
});

router.delete("/records/:id", (req, res) => {
  const id = folderIdParam(req.params.id);
  if (!id || !deleteRecord(id)) {
    res.status(404).json({ error: "No such record" });
    return;
  }
  res.json({ ok: true });
});

/** The whole store, or one folder, as a plain JSON file the panel offers as a download. */
router.get("/export", (req, res) => {
  const folderId = req.query.folderId ? folderIdParam(req.query.folderId) : undefined;
  if (req.query.folderId && !folderId) {
    res.status(400).json({ error: "Invalid folder id" });
    return;
  }
  res.json(exportData(folderId ?? undefined));
});

/**
 * One folder as plain text, a line per record, to the format given. `save` keeps that format on
 * the folder for next time, and `limit` asks for the first lines only, which is what the panel
 * previews beside the field while it is being typed.
 */
router.post("/folders/:id/export-text", (req, res) => {
  const folderId = folderIdParam(req.params.id);
  if (!folderId) {
    res.status(400).json({ error: "Invalid folder id" });
    return;
  }
  const body = req.body as { format?: unknown; save?: unknown; limit?: unknown };
  const format =
    typeof body.format === "string" && body.format.trim()
      ? body.format
      : (getExportFormat(folderNameOf(folderId) ?? "") ?? DEFAULT_EXPORT_FORMAT);
  const limit = Number(body.limit);

  let result;
  try {
    result = exportFolderText(folderId, format, Number.isInteger(limit) ? limit : undefined);
  } catch (err) {
    // A path in the format that cannot be read apart, e.g. `{a[b}` -- the panel says so rather
    // than downloading a file of broken lines
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  if (!result) {
    res.status(404).json({ error: "Folder not found" });
    return;
  }
  if (body.save === true) setExportFormat(result.name, format);
  res.json(result);
});

export default router;
