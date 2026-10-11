import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeError } from "@agentconnect/rag/parsers";

function run(
  command: string,
  args: string[],
  signal: AbortSignal,
  cwd: string,
) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        signal,
        cwd,
        timeout: 45000,
        maxBuffer: 16384,
        env: { ...process.env, OMP_THREAD_LIMIT: "1" },
      },
      (error) => {
        if (error)
          reject(
            new KnowledgeError(
              signal.aborted
                ? "INGESTION_CANCELLED"
                : (error as NodeJS.ErrnoException).code === "ENOENT"
                  ? "OCR_NOT_AVAILABLE"
                  : "OCR_FAILED",
            ),
          );
        else resolve();
      },
    );
  });
}

/** Local executables only; filenames/languages/commands are not supplied by document content. */
export async function ocrPdfPage(
  data: Uint8Array,
  page: number,
  signal: AbortSignal,
) {
  const dir = await mkdtemp(join(tmpdir(), "agentconnect-ocr-"));
  try {
    const pdf = join(dir, "source.pdf"),
      image = join(dir, "page"),
      text = join(dir, "recognized");
    await writeFile(pdf, data, { mode: 0o600 });
    await run(
      "pdftoppm",
      [
        "-f",
        String(page),
        "-l",
        String(page),
        "-singlefile",
        "-scale-to",
        "2400",
        "-png",
        pdf,
        image,
      ],
      signal,
      dir,
    );
    if ((await stat(image + ".png")).size > 20000000)
      throw new KnowledgeError("OCR_LIMIT");
    await run(
      "tesseract",
      [image + ".png", text, "-l", "eng", "--psm", "6"],
      signal,
      dir,
    );
    if ((await stat(text + ".txt")).size > 1000000)
      throw new KnowledgeError("OCR_LIMIT");
    return await readFile(text + ".txt", "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
