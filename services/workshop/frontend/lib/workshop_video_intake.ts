/** Select the cloud intake before uploading any bytes or creating a draft. */
export async function submitWorkshopVideo(
  base: string, token: string, files: File[], title: string, concurrency: number,
  signal: AbortSignal, submitToBucket: () => Promise<Response>,
): Promise<Response> {
  const headers = { Authorization: `Bearer ${token}` };
  const options = await fetch(`${base}/v1/video/intake-options`, { headers, signal, cache: "no-store" });
  if (!options.ok) throw new Error(`无法读取反推配置（${options.status}）`);
  const { upload } = await options.json();
  if (upload === "tos") return submitToBucket();
  if (upload !== "server") throw new Error("工坊返回了未知的上传方式");
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  form.append("title", title);
  form.append("concurrency", String(concurrency));
  const result = await fetch(`${base}/v1/video/upload`, { method: "POST", headers, body: form, signal });
  if (result.status === 413) throw new Error("本次上传超过服务器限制，请分批上传或启用 TOS 大文件直传");
  return result;
}
