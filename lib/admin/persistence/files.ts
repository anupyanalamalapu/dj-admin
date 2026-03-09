import fs from "fs/promises";
import path from "path";
import { getContractsDir, getUploadsDir } from "./paths";
import { createId } from "../utils/id";

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function saveUploadedFile(args: {
  file: File;
  clientId: string;
}): Promise<{ filename: string; relativePath: string; absolutePath: string; sizeBytes: number; mimeType: string }> {
  const clientDir = path.join(getUploadsDir(), args.clientId);
  await fs.mkdir(clientDir, { recursive: true });

  const safeName = sanitizeFilename(args.file.name || "upload.bin");
  const finalName = `${createId("doc")}_${safeName}`;
  const absolutePath = path.join(clientDir, finalName);
  const relativePath = path.relative(process.cwd(), absolutePath);

  const data = Buffer.from(await args.file.arrayBuffer());
  await fs.writeFile(absolutePath, data);

  return {
    filename: finalName,
    relativePath,
    absolutePath,
    sizeBytes: data.byteLength,
    mimeType: args.file.type || "application/octet-stream",
  };
}

export async function saveGeneratedContract(args: {
  eventId: string;
  version: number;
  text: string;
}): Promise<string> {
  const dir = path.join(getContractsDir(), "generated", args.eventId);
  await fs.mkdir(dir, { recursive: true });
  const fileName = `contract_v${args.version}.txt`;
  const absolutePath = path.join(dir, fileName);
  await fs.writeFile(absolutePath, args.text, "utf8");
  return path.relative(process.cwd(), absolutePath);
}
