"use client";

import {
  type RepositoryIgnoreRule,
  type RepositoryUploadFile,
  buildRepositoryIgnoreRules,
  isRepositoryPathIgnored,
  repositoryIgnoreFileNames,
  repositoryUploadLimits,
  shouldAlwaysSkipRepositoryUploadPath,
  shouldReadRepositoryUploadPath,
} from "@open-maintainer/shared";
import { useRef, useState } from "react";

export function LocalRepoPicker({ error }: { error?: string | undefined }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function importFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }
    setStatus("Importing selected repository...");
    try {
      const selected = Array.from(files);
      const rootName = rootDirectoryName(selected);
      const ignoreRules = await readRootIgnoreRules(selected, rootName);
      const uploaded: RepositoryUploadFile[] = [];
      let uploadedBytes = 0;
      for (const file of selected) {
        if (uploaded.length >= repositoryUploadLimits.maxFiles) {
          break;
        }
        const relativePath = repoRelativePath(file);
        const repoPath = stripRootDirectory(relativePath, rootName);
        if (
          !repoPath ||
          file.size > repositoryUploadLimits.maxFileBytes ||
          shouldSkipPath(repoPath, ignoreRules) ||
          !shouldReadRepositoryUploadPath(repoPath)
        ) {
          continue;
        }
        if (uploadedBytes + file.size > repositoryUploadLimits.maxTotalBytes) {
          continue;
        }
        uploadedBytes += file.size;
        uploaded.push({
          path: repoPath,
          content: await file.text(),
        });
      }
      if (uploaded.length === 0) {
        setStatus("No readable repository files were selected.");
        return;
      }

      const uploadBody = JSON.stringify({ name: rootName, files: uploaded });
      const response = await fetch("/local-repos/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: uploadBody,
      });
      if (!response.ok) {
        setStatus(uploadFailureMessage(response.status));
        return;
      }
      const payload = (await response.json()) as { repo?: { id?: unknown } };
      const repoId =
        typeof payload.repo?.id === "string" ? payload.repo.id : "";
      window.location.assign(
        repoId ? `/?repo=${encodeURIComponent(repoId)}` : "/",
      );
    } catch {
      setStatus("Could not import the selected repository.");
    } finally {
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }

  return (
    <div className="local-form">
      <form action="/local-repos" className="mounted-path-form" method="post">
        <label>
          <span>Mounted repo path</span>
          <input name="repoRoot" placeholder="/app" />
        </label>
        <button type="submit">Add mounted repo</button>
      </form>
      <input
        {...directoryInputAttributes}
        aria-label="Choose local repository"
        className="file-input"
        multiple
        onChange={(event) => void importFiles(event.currentTarget.files)}
        ref={inputRef}
        type="file"
      />
      <button type="button" onClick={() => inputRef.current?.click()}>
        Upload repo files
      </button>
      {status ? <p className="note">{status}</p> : null}
      {error ? (
        <p className="error">Could not add that local repository.</p>
      ) : null}
    </div>
  );
}

function uploadFailureMessage(status: number): string {
  if (status === 413) {
    return "Selected repository is too large for browser upload. In Docker Compose, add the mounted repo path /app instead.";
  }
  if (status === 422) {
    return "Selected repository exceeded the dashboard upload limits.";
  }
  return "Could not import the selected repository.";
}

const directoryInputAttributes = {
  directory: "",
  webkitdirectory: "",
} as Record<string, string>;

function repoRelativePath(file: File): string {
  const fileWithDirectory = file as File & { webkitRelativePath?: string };
  return (fileWithDirectory.webkitRelativePath ?? file.name).replaceAll(
    "\\",
    "/",
  );
}

function rootDirectoryName(files: File[]): string {
  const firstPath = repoRelativePath(files[0] as File);
  return firstPath.split("/").filter(Boolean)[0] ?? "uploaded-repo";
}

function stripRootDirectory(relativePath: string, rootName: string): string {
  const prefix = `${rootName}/`;
  return relativePath.startsWith(prefix)
    ? relativePath.slice(prefix.length)
    : relativePath;
}

async function readRootIgnoreRules(
  files: File[],
  rootName: string,
): Promise<RepositoryIgnoreRule[]> {
  const ignoreFiles = await Promise.all(
    files
      .map((file) => ({
        file,
        path: stripRootDirectory(repoRelativePath(file), rootName),
      }))
      .filter(({ path }) =>
        repositoryIgnoreFileNames.some((name) => path === name),
      )
      .map(async ({ file, path }) => ({ path, content: await file.text() })),
  );
  return buildRepositoryIgnoreRules(ignoreFiles);
}

function shouldSkipPath(
  relativePath: string,
  ignoreRules: RepositoryIgnoreRule[],
): boolean {
  return (
    shouldAlwaysSkipRepositoryUploadPath(relativePath) ||
    isRepositoryPathIgnored(relativePath, ignoreRules)
  );
}
