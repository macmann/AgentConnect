import {
  maxAttachmentBytes,
  maxTotalAttachmentBytes,
  type ChatAttachment,
} from "@agentconnect/schemas/chat-attachments";
export async function readChatFiles(
  files: File[],
  existing: ChatAttachment[] = [],
): Promise<ChatAttachment[]> {
  if (
    files.some(
      (f) =>
        !/\.(png|jpe?g|webp|pdf|docx|pptx|xlsx|txt|md|csv|json)$/i.test(f.name),
    )
  )
    throw new Error("Choose a supported photo or document file.");
  if (files.length + existing.length > 6)
    throw new Error("Attach up to 6 files.");
  if (files.some((file) => file.size > maxAttachmentBytes))
    throw new Error("Each file must be 4 MB or smaller.");
  const total =
    files.reduce((n, f) => n + f.size, 0) +
    existing.reduce(
      (n, f) =>
        n +
        f.data.length * 0.75 -
        (f.data.endsWith("==") ? 2 : f.data.endsWith("=") ? 1 : 0),
      0,
    );
  if (total > maxTotalAttachmentBytes)
    throw new Error("Attachments must total 8 MB or less.");
  const uploads = await Promise.all(
    files.map(
      (file) =>
        new Promise<ChatAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              name: file.name,
              data: String(reader.result).split(",")[1]!,
            });
          reader.onerror = () =>
            reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        }),
    ),
  );
  return [...existing, ...uploads];
}
