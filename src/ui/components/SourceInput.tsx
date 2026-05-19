import type { InputHTMLAttributes, RefObject } from "react";
import type { SourceInputKind } from "../../shared/types";
import { Tooltip } from "./Tooltip";

interface SourceInputProps {
  mode: SourceInputKind;
  repoUrl: string;
  htmlCode: string;
  cssCode: string;
  onModeChange: (mode: SourceInputKind) => void;
  onRepoUrlChange: (value: string) => void;
  onHtmlCodeChange: (value: string) => void;
  onCssCodeChange: (value: string) => void;
  onFilesChange: () => void;
  githubInputRef: RefObject<HTMLInputElement>;
  repoZipRef: RefObject<HTMLInputElement>;
  repoFolderRef: RefObject<HTMLInputElement>;
  productionFilesRef: RefObject<HTMLInputElement>;
}

export function SourceInput({
  mode,
  repoUrl,
  htmlCode,
  cssCode,
  onModeChange,
  onRepoUrlChange,
  onHtmlCodeChange,
  onCssCodeChange,
  onFilesChange,
  githubInputRef,
  repoZipRef,
  repoFolderRef,
  productionFilesRef
}: SourceInputProps) {
  return (
    <section className="panel source-panel">
      <div className="panel-title">
        <h2>Production Source</h2>
        <Tooltip label="Connect your repo to check against production tokens" />
      </div>

      <div className="segmented" role="tablist" aria-label="Production source type">
        <button className={mode === "html-css" ? "active" : ""} onClick={() => onModeChange("html-css")} type="button">
          HTML + CSS
        </button>
        <button className={mode === "production-file" ? "active" : ""} onClick={() => onModeChange("production-file")} type="button">
          Files
        </button>
        <button className={mode === "repo-upload" ? "active" : ""} onClick={() => onModeChange("repo-upload")} type="button">
          Repo
        </button>
        <button className={mode === "github" ? "active" : ""} onClick={() => onModeChange("github")} type="button">
          GitHub
        </button>
      </div>

      {mode === "html-css" && (
        <div className="split-code-grid">
          <label className="code-card">
            <span>HTML</span>
            <small>Paste the production component HTML here.</small>
            <textarea
              value={htmlCode}
              onChange={(event) => onHtmlCodeChange(event.target.value)}
              placeholder="<button class=&quot;primary-button&quot;>Save</button>"
              spellCheck={false}
            />
          </label>
          <label className="code-card">
            <span>CSS</span>
            <small>Paste the related production CSS here.</small>
            <textarea
              value={cssCode}
              onChange={(event) => onCssCodeChange(event.target.value)}
              placeholder=".primary-button { background: var(--color-primary); border-radius: 8px; }"
              spellCheck={false}
            />
          </label>
        </div>
      )}

      {mode === "github" && (
        <label>
          Repository URL
          <input
            ref={githubInputRef}
            value={repoUrl}
            onChange={(event) => onRepoUrlChange(event.target.value)}
            placeholder="https://github.com/org/repo"
            spellCheck={false}
          />
        </label>
      )}

      {mode === "repo-upload" && (
        <div className="file-grid">
          <label>
            Repository ZIP
            <input ref={repoZipRef} onChange={onFilesChange} type="file" accept=".zip" />
          </label>
          <label>
            Source folder
            <input
              ref={repoFolderRef}
              type="file"
              multiple
              onChange={onFilesChange}
              {...({ webkitdirectory: "" } as InputHTMLAttributes<HTMLInputElement>)}
            />
          </label>
        </div>
      )}

      {mode === "production-file" && (
        <div className="code-source">
          <label>
            HTML/CSS files
            <span className="helper-text">Upload the component HTML, CSS, or related source files.</span>
            <input
              ref={productionFilesRef}
              onChange={onFilesChange}
              type="file"
              multiple
              accept=".html,.htm,.css,.scss,.sass,.less,.js,.jsx,.ts,.tsx,.json,.vue,.svelte,.svg"
            />
          </label>
        </div>
      )}
    </section>
  );
}
