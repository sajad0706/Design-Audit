import { strFromU8, unzipSync } from "fflate";
import type { ProductionReference, SourceInputKind, SourceTextFile } from "../shared/types";
import { isSourceFile, parseProductionSource } from "./sourceParser";

const MAX_FILE_SIZE = 2_000_000;
const MAX_FILES = 700;

// Downloads a public GitHub repository archive and turns source files into production tokens.
export async function readGithubRepository(repoUrl: string): Promise<ProductionReference> {
  const repo = parseGithubUrl(repoUrl);
  if (!repo) throw new Error("Enter a GitHub repository URL.");

  const metaResponse = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`);
  if (!metaResponse.ok) throw new Error("Could not read this GitHub repository.");
  const meta = (await metaResponse.json()) as { default_branch?: string; full_name?: string };
  const branch = repo.branch || meta.default_branch || "main";
  const branchPath = branch.split("/").map(encodeURIComponent).join("/");
  const archiveUrl = `https://codeload.github.com/${repo.owner}/${repo.name}/zip/refs/heads/${branchPath}`;

  const archiveResponse = await fetch(archiveUrl);
  if (!archiveResponse.ok) throw new Error("Could not download the repository archive.");

  const files = readZipSourceFiles(await archiveResponse.arrayBuffer());
  if (!files.length) throw new Error("No readable source files were found in that repository.");
  return parseProductionSource(files, "github", `${meta.full_name || `${repo.owner}/${repo.name}`}@${branch}`);
}

// Reads either a repository ZIP or an extracted folder upload.
export async function readRepositoryUpload(zipFile: File | null, looseFiles: FileList | null): Promise<ProductionReference> {
  if (zipFile) {
    const files = readZipSourceFiles(await zipFile.arrayBuffer());
    if (!files.length) throw new Error("No readable source files were found in that ZIP.");
    return parseProductionSource(files, "repo-upload", zipFile.name);
  }

  const files = await readLooseSourceFiles(Array.from(looseFiles || []));
  if (!files.length) throw new Error("Choose a repository ZIP or source folder.");
  return parseProductionSource(files, "repo-upload", `${files.length} uploaded files`);
}

// Reads one or more production files and optional pasted HTML/CSS snippets.
export async function readProductionFiles(
  fileList: FileList | null,
  pastedHtml = "",
  pastedCss = "",
  inputKind: SourceInputKind = "production-file"
): Promise<ProductionReference> {
  const files = await readLooseSourceFiles(Array.from(fileList || []));
  const pastedFiles = readPastedProductionCode(pastedHtml, pastedCss);
  const allFiles = files.concat(pastedFiles);

  if (!allFiles.length) throw new Error("Choose production files or paste HTML/CSS code.");
  return parseProductionSource(allFiles, inputKind, productionFileLabel(files, pastedFiles));
}

function parseGithubUrl(input: string): { owner: string; name: string; branch?: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/github\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const branchIndex = parts.indexOf("tree");
  return {
    owner: parts[0],
    name: parts[1].replace(/\.git$/i, ""),
    branch: branchIndex >= 0 ? parts.slice(branchIndex + 1).join("/") : undefined
  };
}

function readZipSourceFiles(buffer: ArrayBuffer): SourceTextFile[] {
  const unzipped = unzipSync(new Uint8Array(buffer));
  const files: SourceTextFile[] = [];

  for (const [name, bytes] of Object.entries(unzipped)) {
    if (files.length >= MAX_FILES) break;
    if (!isSourceFile(name) || bytes.byteLength > MAX_FILE_SIZE) continue;
    files.push({ name, size: bytes.byteLength, text: strFromU8(bytes) });
  }

  return files;
}

async function readLooseSourceFiles(files: File[]): Promise<SourceTextFile[]> {
  const accepted: SourceTextFile[] = [];
  for (const file of files.slice(0, MAX_FILES)) {
    const name = file.webkitRelativePath || file.name;
    if (!isSourceFile(name) || file.size > MAX_FILE_SIZE) continue;
    accepted.push({ name, size: file.size, text: await file.text() });
  }
  return accepted;
}

function readPastedProductionCode(htmlCode: string, cssCode: string): SourceTextFile[] {
  const files: SourceTextFile[] = [];
  const html = htmlCode.trim();
  const css = cssCode.trim();

  if (html.length > MAX_FILE_SIZE || css.length > MAX_FILE_SIZE) throw new Error("Pasted HTML/CSS code is too large.");
  if (html) files.push({ name: "pasted-component.html", size: html.length, text: html });
  if (css) files.push({ name: "pasted-component.css", size: css.length, text: css });

  return files;
}

function productionFileLabel(files: SourceTextFile[], pastedFiles: SourceTextFile[]): string {
  const pastedNames = new Set(pastedFiles.map((file) => file.name));
  const hasHtml = pastedNames.has("pasted-component.html");
  const hasCss = pastedNames.has("pasted-component.css");
  if (!files.length && hasHtml && hasCss) return "Pasted HTML + CSS";
  if (!files.length && hasHtml) return "Pasted HTML";
  if (!files.length && hasCss) return "Pasted CSS";
  if (files.length === 1 && !pastedFiles.length) return files[0].name;
  if (pastedFiles.length) return `${files.length} production files + pasted input`;
  return `${files.length} production files`;
}
