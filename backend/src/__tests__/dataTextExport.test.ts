// A folder written out as a plain text file, a line per record, to a format the person gives --
// `{key}----{password}` for what a signup produced. The format is kept on the folder, since a
// folder exported once is exported the same way next time.

process.env.DATA_MANAGEMENT = "1";

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/database";
import {
  createFolder,
  createRecord,
  deleteFolder,
  DEFAULT_EXPORT_FORMAT,
  exportFolderText,
  formatRecordLine,
  getExportFormat,
  listFolders,
  renameFolder,
  setExportFormat,
} from "../db/dataStore";

beforeEach(() => {
  db.prepare("DELETE FROM data_records").run();
  db.prepare("DELETE FROM data_folders").run();
  db.prepare("DELETE FROM settings WHERE key = 'data_export_formats'").run();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('data_store_enabled','true')",
  ).run();
});

/** The shape a signup step leaves behind: the address as the key, the password inside. */
function seedOutlook(): number {
  const id = createFolder("outlook");
  createRecord(id, "Nina_Lewis_4781@outlook.com", { password: "cqlpxy_5665" });
  createRecord(id, "Ava_Hall_7592@outlook.com", { password: "xxxx", note: "backup" });
  return id;
}

describe("formatRecordLine", () => {
  const record = {
    key: "me@example.com",
    value: { password: "hunter2", login: { pin: "1234" } },
    updatedAt: "2026-08-08 21:48:41",
  };

  it("writes the format the user asked for", () => {
    expect(formatRecordLine("{key}----{password}", record)).toBe("me@example.com----hunter2");
  });

  it("takes {key}, {value} and {updatedAt} as the record's own", () => {
    expect(formatRecordLine("{key}", record)).toBe("me@example.com");
    expect(formatRecordLine("{value}", record)).toBe(JSON.stringify(record.value));
    expect(formatRecordLine("{updatedAt}", record)).toBe("2026-08-08 21:48:41");
  });

  it("reaches a field of a field", () => {
    expect(formatRecordLine("{login.pin}", record)).toBe("1234");
  });

  it("leaves a name with nothing behind it empty, not printed as it stands", () => {
    expect(formatRecordLine("{key}:{nope}", record)).toBe("me@example.com:");
  });

  it("reads \\t and \\n as the characters they name", () => {
    expect(formatRecordLine("{key}\\t{password}", record)).toBe("me@example.com\thunter2");
    expect(formatRecordLine("{key}\\n{password}", record)).toBe("me@example.com\nhunter2");
  });

  it("keeps the text around the placeholders, punctuation and all", () => {
    expect(formatRecordLine("user=({key}) pw=[{password}];", record)).toBe(
      "user=(me@example.com) pw=[hunter2];",
    );
  });

  it("writes a bare value as itself rather than as JSON", () => {
    expect(formatRecordLine("{key}={value}", { key: "a", value: "plain text" })).toBe(
      "a=plain text",
    );
  });
});

describe("exportFolderText", () => {
  it("writes a line per record in key order, ending in a newline", () => {
    const id = seedOutlook();
    const result = exportFolderText(id, "{key}----{password}")!;
    expect(result.name).toBe("outlook");
    expect(result.text).toBe(
      "Ava_Hall_7592@outlook.com----xxxx\nNina_Lewis_4781@outlook.com----cqlpxy_5665\n",
    );
    expect(result.lineCount).toBe(2);
  });

  it("cuts the lines short for a preview while still counting the folder", () => {
    const id = seedOutlook();
    const result = exportFolderText(id, "{key}", 1)!;
    expect(result.text.trim().split("\n")).toHaveLength(1);
    expect(result.lineCount).toBe(2);
  });

  it("writes nothing at all for a folder with no records", () => {
    const id = createFolder("empty");
    expect(exportFolderText(id, DEFAULT_EXPORT_FORMAT)!.text).toBe("");
  });

  it("has nothing to write for a folder that is not there", () => {
    expect(exportFolderText(9999, "{key}")).toBeNull();
  });

  it("refuses a format whose path cannot be read apart", () => {
    const id = seedOutlook();
    expect(() => exportFolderText(id, "{a[b}")).toThrow(/closing/);
  });
});

describe("the format kept on a folder", () => {
  it("is remembered, and comes back with the folder list", () => {
    const id = seedOutlook();
    expect(getExportFormat("outlook")).toBeUndefined();
    setExportFormat("outlook", "{key}----{password}");
    expect(getExportFormat("outlook")).toBe("{key}----{password}");
    expect(listFolders().find((f) => f.id === id)?.exportFormat).toBe("{key}----{password}");
  });

  it("is forgotten when set to nothing, back to the default", () => {
    setExportFormat("outlook", "{key}");
    setExportFormat("outlook", "  ");
    expect(getExportFormat("outlook")).toBeUndefined();
  });

  it("follows the folder through a rename", () => {
    const id = seedOutlook();
    setExportFormat("outlook", "{key}----{password}");
    renameFolder(id, "hotmail");
    expect(getExportFormat("hotmail")).toBe("{key}----{password}");
    expect(getExportFormat("outlook")).toBeUndefined();
  });

  it("goes when the folder does, rather than waiting for a folder of that name again", () => {
    const id = seedOutlook();
    setExportFormat("outlook", "{key}----{password}");
    deleteFolder(id);
    expect(getExportFormat("outlook")).toBeUndefined();
    expect(listFolders().find((f) => f.name === "outlook")?.exportFormat).toBeUndefined();
  });

  it("is one folder's own, not the store's", () => {
    seedOutlook();
    createFolder("sites");
    setExportFormat("outlook", "{key}----{password}");
    expect(getExportFormat("sites")).toBeUndefined();
  });
});
