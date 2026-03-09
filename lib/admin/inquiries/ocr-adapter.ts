import { getAdminAiEnvConfig, validateRuntimeConfig } from "../config/runtime-config";

export interface OcrResult {
  extractedText: string;
  status: "not_needed" | "success" | "manual_required";
  reason?: string;
}

type OcrKind = "image" | "pdf";

function aiOcrEnabled(): boolean {
  const ai = getAdminAiEnvConfig();
  return ai.ocrEnabled && Boolean(ai.apiKey);
}

function ocrModel(): string {
  return getAdminAiEnvConfig().models.ocr || "gpt-4.1-mini";
}

function ocrModelCandidates(): string[] {
  const ai = getAdminAiEnvConfig();
  const preferred = ocrModel();
  const fallbacks = [
    ai.models.ocr,
    "gpt-4.1-mini",
    "gpt-4o-mini",
    ai.models.extract,
    ai.models.global,
  ];
  const candidates = [preferred, ...fallbacks].filter((value): value is string => Boolean(value));
  return Array.from(new Set(candidates));
}

function isImageFile(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  const name = file.name.toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".heif", ".tif", ".tiff"].some((ext) =>
    name.endsWith(ext)
  );
}

function isPdfFile(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  if (type === "application/pdf") return true;
  return file.name.toLowerCase().endsWith(".pdf");
}

function sniffBinaryKind(bytes: Buffer): OcrKind | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("utf8") === "%PDF-") {
    return "pdf";
  }

  if (bytes.length >= 8) {
    const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const isPng = pngSig.every((value, index) => bytes[index] === value);
    if (isPng) return "image";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image";
  }

  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return "image";
  }

  if (bytes.length >= 12) {
    const riff = bytes.subarray(0, 4).toString("ascii");
    const webp = bytes.subarray(8, 12).toString("ascii");
    if (riff === "RIFF" && webp === "WEBP") return "image";
  }

  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image";
  }

  if (
    (bytes.length >= 4 && bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return "image";
  }

  if (bytes.length >= 12) {
    const ftyp = bytes.subarray(4, 8).toString("ascii");
    const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
    if (ftyp === "ftyp" && ["heic", "heif", "heix", "hevc", "avif"].includes(brand)) {
      return "image";
    }
  }

  return null;
}

function detectOcrKind(file: File, bytes: Buffer): OcrKind | null {
  if (isPdfFile(file)) return "pdf";
  if (isImageFile(file)) return "image";
  return sniffBinaryKind(bytes);
}

function fileDataUri(file: File, bytes: Buffer): string {
  const fallbackMime = isPdfFile(file) ? "application/pdf" : "application/octet-stream";
  const mimeType = file.type || fallbackMime;
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function extractOutputText(response: any): string {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const fragments = (response?.output || [])
    .flatMap((outputItem: any) => outputItem?.content || [])
    .map((contentItem: any) => {
      if (typeof contentItem?.text === "string") return contentItem.text;
      if (typeof contentItem?.output_text === "string") return contentItem.output_text;
      return "";
    })
    .filter(Boolean);

  return fragments.join("\n");
}

async function loadOpenAiClient(): Promise<{ client: any | null; reason?: string }> {
  const apiKey = getAdminAiEnvConfig().apiKey;
  if (!apiKey) {
    return { client: null, reason: "OPENAI_API_KEY is missing." };
  }

  const reasons: string[] = [];

  try {
    const req = new Function("name", "return require(name);") as (name: string) => any;
    const openAiModule = req("openai");
    const OpenAI = openAiModule?.default || openAiModule?.OpenAI;
    if (OpenAI) {
      return { client: new OpenAI({ apiKey }) };
    }
    reasons.push("require('openai') did not expose OpenAI constructor");
  } catch (error) {
    reasons.push(`require('openai') failed: ${errorMessage(error)}`);
  }

  try {
    const dynamicImport = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<any>;
    const openAiModule = await dynamicImport("openai");
    const OpenAI = openAiModule.default || openAiModule.OpenAI;
    if (!OpenAI) {
      reasons.push("dynamic import('openai') did not expose OpenAI constructor");
      return { client: null, reason: reasons.join(" | ") };
    }
    return { client: new OpenAI({ apiKey }) };
  } catch (error) {
    reasons.push(`dynamic import('openai') failed: ${errorMessage(error)}`);
    return { client: null, reason: reasons.join(" | ") };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function buildOcrInputContent(args: {
  kind: OcrKind;
  dataUri: string;
  filename: string;
}): Array<Record<string, string>> {
  const extractionPrompt =
    args.kind === "image"
      ? "Extract all readable text from this screenshot or image. Return plain text only."
      : "Extract all readable text from this PDF or document upload. Return plain text only.";

  return args.kind === "image"
    ? [
        {
          type: "input_text",
          text: extractionPrompt,
        },
        {
          type: "input_image",
          image_url: args.dataUri,
        },
      ]
    : [
        {
          type: "input_text",
          text: extractionPrompt,
        },
        {
          type: "input_file",
          file_data: args.dataUri,
          filename: args.filename || "upload.pdf",
        },
      ];
}

async function runResponsesWithFetch(args: {
  model: string;
  content: Array<Record<string, string>>;
}): Promise<any> {
  const apiKey = getAdminAiEnvConfig().apiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing.");
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      input: [
        {
          role: "user",
          content: args.content,
        },
      ],
    }),
  });

  const raw = await response.text();
  if (!raw.trim()) {
    throw new Error(`Responses API returned empty body (${response.status}).`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Responses API returned non-JSON body (${response.status}).`);
  }
  if (!response.ok) {
    const errMsg = parsed?.error?.message || `HTTP ${response.status}`;
    throw new Error(errMsg);
  }
  return parsed;
}

async function runFileOcrWithAi(file: File): Promise<{ text: string | null; reason?: string }> {
  if (!aiOcrEnabled()) {
    const errors = validateRuntimeConfig().errors;
    return {
      text: null,
      reason:
        errors.length > 0
          ? errors.join(" | ")
          : "AI OCR is disabled. Set ADMIN_ENABLE_AI_OCR=true and configure OPENAI_API_KEY.",
    };
  }

  try {
    const clientLoad = await loadOpenAiClient();
    const client = clientLoad.client;

    const bytes = Buffer.from(await file.arrayBuffer());
    const kind = detectOcrKind(file, bytes);
    if (!kind) {
      return { text: null, reason: "Unsupported upload for AI OCR. Use image screenshots or PDFs." };
    }
    const dataUri = fileDataUri(file, bytes);
    const content = buildOcrInputContent({
      kind,
      dataUri,
      filename: file.name || "upload.pdf",
    });

    const attemptReasons: string[] = [];
    if (!client && clientLoad.reason) {
      attemptReasons.push(`SDK init failed: ${clientLoad.reason}`);
    }

    if (client) {
      for (const model of ocrModelCandidates()) {
        try {
          const response = await client.responses.create({
            model,
            input: [
              {
                role: "user",
                content,
              },
            ],
          });

          const text = extractOutputText(response).trim();
          if (text) {
            return { text };
          }
          attemptReasons.push(`SDK model ${model} returned no OCR text.`);
        } catch (error) {
          attemptReasons.push(`SDK model ${model} failed: ${errorMessage(error)}`);
        }
      }
    }

    for (const model of ocrModelCandidates()) {
      try {
        const response = await runResponsesWithFetch({ model, content });
        const text = extractOutputText(response).trim();
        if (text) {
          return { text };
        }
        attemptReasons.push(`Fetch model ${model} returned no OCR text.`);
      } catch (error) {
        attemptReasons.push(`Fetch model ${model} failed: ${errorMessage(error)}`);
      }
    }

    return {
      text: null,
      reason: attemptReasons.join(" | ") || "All OCR model attempts failed.",
    };
  } catch (error) {
    return { text: null, reason: errorMessage(error) };
  }
}

export async function runOcrAdapter(file: File | null): Promise<OcrResult> {
  if (!file) {
    return { extractedText: "", status: "not_needed" };
  }

  if (file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt")) {
    const text = await file.text();
    return { extractedText: text, status: "success" };
  }

  const aiFileOcr = await runFileOcrWithAi(file);
  if (aiFileOcr.text) {
    return { extractedText: aiFileOcr.text, status: "success" };
  }

  return {
    extractedText: "",
    status: "manual_required",
    reason:
      aiFileOcr.reason ||
      "AI OCR extraction is unavailable for this file type in the current environment. Upload a text file, image, or PDF, and ensure OPENAI_API_KEY is configured.",
  };
}
